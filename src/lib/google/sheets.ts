// ─── Google Sheets client (service account) ───────────────────────────────────
// Required env vars:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  — e.g. seo-tools@your-project.iam.gserviceaccount.com
//   GOOGLE_PRIVATE_KEY            — the private key from the JSON keyfile (with \n escaped)
//
// Setup:
//   1. Create a service account in Google Cloud Console
//   2. Download the JSON key, copy client_email → GOOGLE_SERVICE_ACCOUNT_EMAIL
//      and private_key → GOOGLE_PRIVATE_KEY
//   3. Share the Google Sheet with the service account email (Editor permission)
//
// New 33-column layout (sheet-as-database, 2026-05-12 refactor):
//   A  Brand Name        ← BDT input
//   B  Category          ← BDT input
//   C  Relation ID       ← BDT input
//   D  Request Date      ← BDT input
//   E  Create now?       ← trigger col. "yes" → process. Writes back "Generated"
//                          or "Error: <stage-tagged>" on completion. Not retriggerable.
//   F  Main Keyword              ┐
//   G  Secondary Keyword         │
//   H  Meta Title                │
//   I  Meta Description          │
//   J  Meta Keyword              │   All AI-generated.
//   K  Marketing Title (H1)      │   Sheet is the canonical store —
//   L–S  Marketing Description   │   no Google Drive doc creation.
//        sections 1-8 (HTML)     │
//   T–AG FAQ 1-7 Q/A pairs       │
//        (Q in even col, A odd)  ┘
//
// Indonesian: separate sheet TAB ("ID") in the same spreadsheet, identical
// column layout. Tab auto-created on first run.

import { google } from 'googleapis'

// ── Column mapping (33 cols A-AG) ─────────────────────────────────────────────
export const SHEET_COLS = {
  productName:       'A',
  category:          'B',
  relationId:        'C',
  requestDate:       'D',
  createNow:         'E',
  mainKeyword:       'F',
  secondaryKeyword:  'G',
  metaTitle:         'H',
  metaDescription:   'I',
  metaKeyword:       'J',
  marketingTitle:    'K',
  // Marketing description: 8 sections, each cell is one H2 + body in HTML
  marketingSection1: 'L',
  marketingSection2: 'M',
  marketingSection3: 'N',
  marketingSection4: 'O',
  marketingSection5: 'P',
  marketingSection6: 'Q',
  marketingSection7: 'R',
  marketingSection8: 'S',
  // FAQ 1-7 split: Q in one cell, A in next. Min 5 wajib, 6+7 optional.
  faq1Q: 'T',  faq1A: 'U',
  faq2Q: 'V',  faq2A: 'W',
  faq3Q: 'X',  faq3A: 'Y',
  faq4Q: 'Z',  faq4A: 'AA',
  faq5Q: 'AB', faq5A: 'AC',
  faq6Q: 'AD', faq6A: 'AE',
  faq7Q: 'AF', faq7A: 'AG',
} as const

// Wildcard column index used everywhere we want to read/write the full row.
// A:AG = 33 cols.
export const SHEET_RANGE_FULL = 'A:AG'

// ── Trigger / status values written to col E ─────────────────────────────────
export const SHEET_STATUS = {
  YES:       'Yes',         // BDT writes this to trigger
  GENERATED: 'Generated',   // agent writes this on success
  // Errors are dynamic strings: `Error: ${stage-tagged message}`
} as const

const ERROR_PREFIX = 'Error:'

/** Returns true if a col-E cell value should trigger processing. */
export function isPendingTrigger(rawCellValue: string | null | undefined): boolean {
  const v = (rawCellValue ?? '').toString().trim().toLowerCase()
  return v === 'yes' || v === 'y'
}

/** Format an error-status string for col E. Truncates very long messages so
 *  the cell stays readable. */
export function formatErrorStatus(msg: string): string {
  const clean = msg.replace(/\s+/g, ' ').trim()
  const max = 280
  return `${ERROR_PREFIX} ${clean.length > max ? clean.slice(0, max - 1) + '…' : clean}`
}

// ── Auth helper ───────────────────────────────────────────────────────────────
function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  let key     = process.env.GOOGLE_PRIVATE_KEY ?? ''

  if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1)
  key = key.replace(/\\n/g, '\n').trim()

  if (!email || !key) {
    throw new Error('Google service account credentials not configured (GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY env vars required)')
  }
  if (!key.includes('BEGIN PRIVATE KEY') || !key.includes('END PRIVATE KEY')) {
    throw new Error(
      'GOOGLE_PRIVATE_KEY appears malformed: missing BEGIN/END PRIVATE KEY markers. ' +
      'Re-paste the exact private_key value from your service account JSON file, no surrounding quotes.',
    )
  }

  return new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
}

// ── Row interface ─────────────────────────────────────────────────────────────
export interface ProductRow {
  productName:        string
  category:           string
  relationId:         string
  requestDate:        string     // raw text from sheet, ISO-ish ("2026/05/07")
  createNow:          string     // raw value of col E — used for trigger check
  // AI-filled fields (initial read may be empty; populated after gen)
  mainKeyword:        string
  secondaryKeyword:   string
  metaTitle:          string
  metaDescription:    string
  metaKeyword:        string
  marketingTitle:     string
  marketingSections:  string[]   // length 8
  faqs:               Array<{ q: string; a: string }>  // length 5-7
  rowIndex:           number     // 1-based row number in the sheet
}

// ── Header pattern matching ───────────────────────────────────────────────────
// We do header-row matching (not strict column positions) so the user can
// reorder, hide, or rename columns slightly and we still find them.
const HEADER_PATTERNS: Record<string, string[]> = {
  productName:       ['brand name', 'product name', 'product', 'name'],
  category:          ['category', 'cat'],
  relationId:        ['relation id', 'relation_id', 'product id', 'pid'],
  requestDate:       ['request date', 'date'],
  createNow:         ['create now', 'create now?', 'generate', 'trigger'],
  mainKeyword:       ['main keyword', 'primary keyword'],
  secondaryKeyword:  ['secondary keyword', 'secondary keywords'],
  metaTitle:         ['meta title', 'meta title en'],
  metaDescription:   ['meta description', 'meta descriptions', 'meta descriptions en', 'meta desc'],
  metaKeyword:       ['meta keyword', 'meta keywords'],
  marketingTitle:    ['marketing title', 'h1', 'en marketing title'],
  marketingSection1: ['marketing description (1)', 'en marketing description (1)', 'h2 section1', 'section 1'],
  marketingSection2: ['marketing description (2)', 'en marketing description (2)', 'h2 section2', 'section 2'],
  marketingSection3: ['marketing description (3)', 'en marketing description (3)', 'h2 section3', 'section 3'],
  marketingSection4: ['marketing description (4)', 'en marketing description (4)', 'h2 section4', 'section 4'],
  marketingSection5: ['marketing description (5)', 'en marketing description (5)', 'h2 section5', 'section 5'],
  marketingSection6: ['marketing description (6)', 'en marketing description (6)', 'h2 section6', 'section 6'],
  marketingSection7: ['marketing description (7)', 'en marketing description (7)', 'h2 section7', 'section 7'],
  marketingSection8: ['marketing description (8)', 'en marketing description (8)', 'h2 section8', 'section 8'],
  // FAQ headers — we accept either single-cell "FAQ N" (legacy, Q+A together)
  // or split-cell "FAQ N Q" / "FAQ N A". The new flow always writes split.
  faq1Q: ['faq 1 q', 'faq 1 question', 'faq1q'],
  faq1A: ['faq 1 a', 'faq 1 answer', 'faq1a', 'faq 1'],
  faq2Q: ['faq 2 q', 'faq 2 question', 'faq2q'],
  faq2A: ['faq 2 a', 'faq 2 answer', 'faq2a', 'faq 2'],
  faq3Q: ['faq 3 q', 'faq 3 question', 'faq3q'],
  faq3A: ['faq 3 a', 'faq 3 answer', 'faq3a', 'faq 3'],
  faq4Q: ['faq 4 q', 'faq 4 question', 'faq4q'],
  faq4A: ['faq 4 a', 'faq 4 answer', 'faq4a', 'faq 4'],
  faq5Q: ['faq 5 q', 'faq 5 question', 'faq5q'],
  faq5A: ['faq 5 a', 'faq 5 answer', 'faq5a', 'faq 5'],
  faq6Q: ['faq 6 q', 'faq 6 question', 'faq6q'],
  faq6A: ['faq 6 a', 'faq 6 answer', 'faq6a', 'faq 6'],
  faq7Q: ['faq 7 q', 'faq 7 question', 'faq7q'],
  faq7A: ['faq 7 a', 'faq 7 answer', 'faq7a', 'faq 7'],
}

/** Resolve which column index (0-based) maps to each field, based on header row. */
function resolveColumns(headerRow: string[]): Record<string, number> {
  const norm = headerRow.map(h => (h ?? '').toString().trim().toLowerCase())
  const out: Record<string, number> = {}

  for (const [field, patterns] of Object.entries(HEADER_PATTERNS)) {
    let bestIdx = -1
    let bestScore = 0
    for (let i = 0; i < norm.length; i++) {
      const cell = norm[i]
      if (!cell) continue
      for (const pat of patterns) {
        if (cell === pat) {
          // exact match wins immediately
          bestIdx = i
          bestScore = 100
          break
        }
        if (cell.includes(pat) && pat.length > bestScore) {
          bestIdx = i
          bestScore = pat.length
        }
      }
      if (bestScore === 100) break
    }
    if (bestIdx !== -1) out[field] = bestIdx
  }
  return out
}

// ── Fallback positional mapping ───────────────────────────────────────────────
// When the sheet has no header (or unrecognized headers), assume the 33-col
// layout defined in SHEET_COLS. Useful for fresh sheets where the user hasn't
// added a header row yet, and for the auto-created ID tab.
function positionalIndex(field: string): number {
  // A=0, B=1, ..., Z=25, AA=26, AB=27, ..., AG=32
  const map: Record<string, number> = {
    productName: 0, category: 1, relationId: 2, requestDate: 3, createNow: 4,
    mainKeyword: 5, secondaryKeyword: 6,
    metaTitle: 7, metaDescription: 8, metaKeyword: 9,
    marketingTitle: 10,
    marketingSection1: 11, marketingSection2: 12, marketingSection3: 13,
    marketingSection4: 14, marketingSection5: 15, marketingSection6: 16,
    marketingSection7: 17, marketingSection8: 18,
    faq1Q: 19, faq1A: 20, faq2Q: 21, faq2A: 22,
    faq3Q: 23, faq3A: 24, faq4Q: 25, faq4A: 26,
    faq5Q: 27, faq5A: 28, faq6Q: 29, faq6A: 30,
    faq7Q: 31, faq7A: 32,
  }
  return map[field] ?? -1
}

// ── Read product rows ─────────────────────────────────────────────────────────

export async function readProductSheet(
  spreadsheetId: string,
  sheetName     = 'Sheet1',
  startRow      = 2,
  maxRows       = 500,
): Promise<ProductRow[]> {
  const auth   = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const headerRange = `${sheetName}!${SHEET_RANGE_FULL.split(':').map(c => `${c}1`).join(':')}`
  const bodyRange   = `${sheetName}!A${startRow}:AG${startRow + maxRows - 1}`

  const [headerRes, bodyRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: headerRange }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: bodyRange }),
  ])

  const headerRow = (headerRes.data.values?.[0] ?? []) as string[]
  const colIdx    = resolveColumns(headerRow)
  const useHeader = colIdx.productName !== undefined && colIdx.relationId !== undefined

  const cell = (row: unknown[], field: string): string => {
    const idx = useHeader ? (colIdx[field] ?? -1) : positionalIndex(field)
    if (idx < 0) return ''
    return (row[idx] ?? '').toString().trim()
  }

  const rows = bodyRes.data.values ?? []
  return rows
    .map((row, i): ProductRow => ({
      productName:      cell(row, 'productName'),
      category:         cell(row, 'category'),
      relationId:       cell(row, 'relationId'),
      requestDate:      cell(row, 'requestDate'),
      createNow:        cell(row, 'createNow'),
      mainKeyword:      cell(row, 'mainKeyword'),
      secondaryKeyword: cell(row, 'secondaryKeyword'),
      metaTitle:        cell(row, 'metaTitle'),
      metaDescription:  cell(row, 'metaDescription'),
      metaKeyword:      cell(row, 'metaKeyword'),
      marketingTitle:   cell(row, 'marketingTitle'),
      marketingSections: [
        cell(row, 'marketingSection1'),
        cell(row, 'marketingSection2'),
        cell(row, 'marketingSection3'),
        cell(row, 'marketingSection4'),
        cell(row, 'marketingSection5'),
        cell(row, 'marketingSection6'),
        cell(row, 'marketingSection7'),
        cell(row, 'marketingSection8'),
      ],
      faqs: [1, 2, 3, 4, 5, 6, 7].map(n => ({
        q: cell(row, `faq${n}Q`),
        a: cell(row, `faq${n}A`),
      })).filter(f => f.q || f.a),
      rowIndex: startRow + i,
    }))
    .filter(r => r.productName && r.relationId)
}

// ── Write-back ────────────────────────────────────────────────────────────────

/** All fields the agent can write back to a sheet row. Each is optional —
 *  partial updates supported. */
export interface ProductRowUpdate {
  // Status (col E) — set to SHEET_STATUS.GENERATED on success or a
  // formatErrorStatus() string on failure.
  createNow?:         string

  // Main payload — set by the AI generator.
  mainKeyword?:       string
  secondaryKeyword?:  string
  metaTitle?:         string
  metaDescription?:   string
  metaKeyword?:       string
  marketingTitle?:    string
  marketingSections?: string[]                          // 8 entries (HTML each)
  faqs?:              Array<{ q: string; a: string }>    // 5-7 entries
}

/** Convert a partial update into [range, value] pairs spanning cols A–AG. */
function updateToCells(
  sheetName: string,
  rowIndex:  number,
  u:         ProductRowUpdate,
): Array<{ range: string; values: string[][] }> {
  const out: Array<{ range: string; values: string[][] }> = []
  const push = (col: string, v: string) =>
    out.push({ range: `${sheetName}!${col}${rowIndex}`, values: [[v]] })

  if (u.createNow        !== undefined) push(SHEET_COLS.createNow,        u.createNow)
  if (u.mainKeyword      !== undefined) push(SHEET_COLS.mainKeyword,      u.mainKeyword)
  if (u.secondaryKeyword !== undefined) push(SHEET_COLS.secondaryKeyword, u.secondaryKeyword)
  if (u.metaTitle        !== undefined) push(SHEET_COLS.metaTitle,        u.metaTitle)
  if (u.metaDescription  !== undefined) push(SHEET_COLS.metaDescription,  u.metaDescription)
  if (u.metaKeyword      !== undefined) push(SHEET_COLS.metaKeyword,      u.metaKeyword)
  if (u.marketingTitle   !== undefined) push(SHEET_COLS.marketingTitle,   u.marketingTitle)

  if (u.marketingSections !== undefined) {
    const cols = [
      SHEET_COLS.marketingSection1, SHEET_COLS.marketingSection2,
      SHEET_COLS.marketingSection3, SHEET_COLS.marketingSection4,
      SHEET_COLS.marketingSection5, SHEET_COLS.marketingSection6,
      SHEET_COLS.marketingSection7, SHEET_COLS.marketingSection8,
    ]
    for (let i = 0; i < 8; i++) {
      push(cols[i], u.marketingSections[i] ?? '')
    }
  }

  if (u.faqs !== undefined) {
    const qCols = [SHEET_COLS.faq1Q, SHEET_COLS.faq2Q, SHEET_COLS.faq3Q, SHEET_COLS.faq4Q, SHEET_COLS.faq5Q, SHEET_COLS.faq6Q, SHEET_COLS.faq7Q]
    const aCols = [SHEET_COLS.faq1A, SHEET_COLS.faq2A, SHEET_COLS.faq3A, SHEET_COLS.faq4A, SHEET_COLS.faq5A, SHEET_COLS.faq6A, SHEET_COLS.faq7A]
    for (let i = 0; i < 7; i++) {
      const f = u.faqs[i] ?? { q: '', a: '' }
      push(qCols[i], f.q)
      push(aCols[i], f.a)
    }
  }

  return out
}

/** Write a partial update to a specific row. */
export async function writeProductRow(
  spreadsheetId: string,
  sheetName:     string,
  rowIndex:      number,
  update:        ProductRowUpdate,
): Promise<void> {
  const cells = updateToCells(sheetName, rowIndex, update)
  if (cells.length === 0) return

  const auth   = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: cells,
    },
  })
}

/** Batch write multiple row updates in one API call. */
export async function batchWriteProductRows(
  spreadsheetId: string,
  sheetName:     string,
  rows:          Array<ProductRowUpdate & { rowIndex: number }>,
): Promise<void> {
  if (!rows.length) return

  const data = rows.flatMap(r => updateToCells(sheetName, r.rowIndex, r))
  if (!data.length) return

  const auth   = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data,
    },
  })
}

// ── Tab management ───────────────────────────────────────────────────────────

/** Names commonly used for the Indonesian tab. Resolver matches any of these. */
const ID_TAB_NAMES = ['ID', 'Indonesian', 'Bahasa Indonesia', 'id'] as const

/**
 * Ensures an "ID" tab exists in the spreadsheet for Indonesian content. If
 * missing, creates it with the same 33-column header as the EN tab. Returns
 * the actual tab name found / created (caller passes this to writeProductRow).
 */
export async function ensureIdTab(
  spreadsheetId: string,
  enSheetName:   string,
): Promise<string> {
  const auth   = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  // List existing tabs
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  })
  const existing = (meta.data.sheets ?? [])
    .map(s => s.properties)
    .filter((p): p is { sheetId: number; title: string } => !!p?.title && p.sheetId !== undefined)

  // Match any of the known ID-tab names (case-insensitive)
  for (const wanted of ID_TAB_NAMES) {
    const match = existing.find(p => p.title.toLowerCase() === wanted.toLowerCase())
    if (match) return match.title
  }

  // Create new tab "ID"
  const targetName = 'ID'
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: targetName } } }],
    },
  })

  // Copy header row from EN tab to ID tab so columns stay aligned. We pull
  // A1:AG1 from the source and paste it into the new tab.
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${enSheetName}!A1:AG1`,
  })
  const headers = headerRes.data.values?.[0] ?? []

  if (headers.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${targetName}!A1:AG1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    })
  }

  return targetName
}

/** Find the row index in a target sheet (e.g. ID tab) matching a Relation ID.
 *  Returns -1 if no matching row found. Used so Indonesian write-back lines
 *  up with the same product even when the ID tab grows independently. */
export async function findRowByRelationId(
  spreadsheetId: string,
  sheetName:     string,
  relationId:    string,
  startRow:      number = 2,
  maxRows:       number = 500,
): Promise<number> {
  const auth   = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!${SHEET_COLS.relationId}${startRow}:${SHEET_COLS.relationId}${startRow + maxRows - 1}`,
  })
  const rows = res.data.values ?? []
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] ?? '').toString().trim() === relationId) {
      return startRow + i
    }
  }
  return -1
}

/** Append a new row to the bottom of a sheet. Used to add a new entry to the
 *  ID tab when no matching Relation ID exists yet. Returns the 1-based row
 *  index where the row was inserted. */
export async function appendProductRow(
  spreadsheetId: string,
  sheetName:     string,
  baseRow: {
    productName: string
    category:    string
    relationId:  string
    requestDate: string
  },
  update: ProductRowUpdate,
): Promise<number> {
  const auth   = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  // Build a 33-column row array with the base values + update values
  const cells: string[] = new Array(33).fill('')
  cells[positionalIndex('productName')]      = baseRow.productName
  cells[positionalIndex('category')]         = baseRow.category
  cells[positionalIndex('relationId')]       = baseRow.relationId
  cells[positionalIndex('requestDate')]      = baseRow.requestDate
  if (update.createNow         !== undefined) cells[positionalIndex('createNow')]         = update.createNow
  if (update.mainKeyword       !== undefined) cells[positionalIndex('mainKeyword')]       = update.mainKeyword
  if (update.secondaryKeyword  !== undefined) cells[positionalIndex('secondaryKeyword')]  = update.secondaryKeyword
  if (update.metaTitle         !== undefined) cells[positionalIndex('metaTitle')]         = update.metaTitle
  if (update.metaDescription   !== undefined) cells[positionalIndex('metaDescription')]   = update.metaDescription
  if (update.metaKeyword       !== undefined) cells[positionalIndex('metaKeyword')]       = update.metaKeyword
  if (update.marketingTitle    !== undefined) cells[positionalIndex('marketingTitle')]    = update.marketingTitle
  if (update.marketingSections !== undefined) {
    for (let i = 0; i < 8; i++) cells[positionalIndex(`marketingSection${i + 1}`)] = update.marketingSections[i] ?? ''
  }
  if (update.faqs !== undefined) {
    for (let i = 0; i < 7; i++) {
      const f = update.faqs[i] ?? { q: '', a: '' }
      cells[positionalIndex(`faq${i + 1}Q`)] = f.q
      cells[positionalIndex(`faq${i + 1}A`)] = f.a
    }
  }

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range:           `${sheetName}!A:AG`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [cells] },
  })

  // Sheets returns the updated range; parse out the 1-based row number
  const updatedRange = res.data.updates?.updatedRange ?? ''
  const m = updatedRange.match(/!A(\d+):/)
  return m ? parseInt(m[1], 10) : -1
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Get the spreadsheet ID from a full Google Sheets URL */
export function extractSpreadsheetId(url: string): string | null {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return match ? match[1] : null
}
