// ─── Google Sheets client (service account) ───────────────────────────────────
// Required env vars:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  — e.g. seo-tools@your-project.iam.gserviceaccount.com
//   GOOGLE_PRIVATE_KEY            — the private key from the JSON keyfile (with \n escaped)
//
// Setup:
//   1. Create a service account in Google Cloud Console
//   2. Download the JSON key, copy client_email → GOOGLE_SERVICE_ACCOUNT_EMAIL
//      and private_key → GOOGLE_PRIVATE_KEY
//   3. Share the Google Sheet with the service account email (Editor permission for write-back)
//
// Sheet column layout (1-indexed):
//   A (1) — Brand Name       (product name)
//   B (2) — Category
//   C (3) — Relation ID
//   D (4) — Main Keyword     (agent fills this in)
//   E (5) — Secondary Keyword(agent fills this in)
//   F (6) — EN File Name     (agent writes Google Doc URL here)
//   G (7) — Status           (agent updates: "To Do" → "Generated")
//   H (8) — ID File Name     (Indonesian version — not touched by agent)
//   I (9) — ID Status        (Indonesian version — not touched by agent)

import { google } from 'googleapis'

// Column indices (1-based, for Sheets A1 notation)
export const SHEET_COLS = {
  productName:      'A',
  category:         'B',
  relationId:       'C',
  mainKeyword:      'D',
  secondaryKeyword: 'E',
  enFileName:       'F',
  status:           'G',
} as const

// Status values used in the sheet
export const SHEET_STATUS = {
  TODO:      'To Do',
  GENERATED: 'Generated',
  FAILED:    'Failed',
  UPLOADING: 'Uploading',
  UPLOADED:  'Uploaded',
} as const

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const key   = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')

  if (!email || !key) throw new Error('Google service account credentials not configured')

  return new google.auth.JWT({
    email,
    key,
    // Full spreadsheets scope for read + write back
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
}

export interface ProductRow {
  productName:       string
  category:          string
  relationId:        string
  mainKeyword:       string   // may be empty — agent fills it in
  secondaryKeyword:  string   // may be empty — agent fills it in
  enFileName:        string   // may be empty or existing Google Doc URL
  sheetStatus:       string   // "To Do", "Generated", etc.
  rowIndex:          number   // 1-based row number in the sheet
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Read product rows from the Google Sheet.
 * By default only returns rows where Status = "To Do".
 * Pass `allStatuses: true` to return every non-empty row.
 */
// ── Header-based column resolver ──────────────────────────────────────────────
// Maps each ProductRow field to a list of acceptable header strings (case-
// insensitive substring match). Tolerates extra columns (e.g. "Request Date",
// "ID File Name") and reordering, so users don't have to keep their sheet
// in lockstep with the code.
const HEADER_PATTERNS: Record<keyof Omit<ProductRow, 'rowIndex'>, string[]> = {
  productName:      ['product name', 'brand name', 'product', 'name'],
  category:         ['category', 'cat'],
  relationId:       ['relation id', 'relation_id', 'relationid', 'product id', 'pid'],
  mainKeyword:      ['main keyword', 'primary keyword'],
  secondaryKeyword: ['secondary keyword', 'secondary keywords'],
  enFileName:       ['en file', 'english file', 'en doc', 'doc url', 'google doc'],
  // CRITICAL: prefer "Status" headers that don't say "ID" / "Indonesian"
  sheetStatus:      ['en status', 'status'],
}

interface ColumnIndex { [field: string]: number }

function resolveColumns(headerRow: string[]): ColumnIndex {
  const norm = headerRow.map(h => (h ?? '').toString().trim().toLowerCase())
  const out: ColumnIndex = {}

  for (const [field, patterns] of Object.entries(HEADER_PATTERNS)) {
    let bestIdx = -1
    let bestScore = 0
    for (let i = 0; i < norm.length; i++) {
      const cell = norm[i]
      if (!cell) continue
      // Skip Indonesian-status columns when resolving the EN status field
      if (field === 'sheetStatus' && (cell.includes('id ') || cell.includes('indonesian'))) continue
      for (const pat of patterns) {
        if (cell === pat) {
          // Exact match wins immediately
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

export async function readProductSheet(
  spreadsheetId: string,
  sheetName     = 'Sheet1',
  startRow      = 2,          // skip header row
  maxRows       = 500,
  allStatuses   = false,
): Promise<ProductRow[]> {
  const auth   = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  // Read header row + body. Using A:Z (26 cols) lets us tolerate any sheet
  // width up to a reasonable cap; readProductSheet then resolves columns by
  // header text instead of fixed positions.
  const headerRange = `${sheetName}!A1:Z1`
  const bodyRange   = `${sheetName}!A${startRow}:Z${startRow + maxRows - 1}`

  const [headerRes, bodyRes] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: headerRange }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: bodyRange }),
  ])

  const headerRow = (headerRes.data.values?.[0] ?? []) as string[]
  const colIdx    = resolveColumns(headerRow)

  // If header doesn't yield a relationId column (sheet has no header or names
  // we don't recognise), fall back to the legacy positional read so we keep
  // backwards compatibility with old sheets.
  const useHeaderMode = colIdx.relationId !== undefined && colIdx.productName !== undefined
  const rows = bodyRes.data.values ?? []

  const cell = (row: unknown[], field: keyof Omit<ProductRow, 'rowIndex'>): string => {
    const idx = useHeaderMode
      ? (colIdx[field] ?? -1)
      : ({ productName: 0, category: 1, relationId: 2, mainKeyword: 3, secondaryKeyword: 4, enFileName: 5, sheetStatus: 6 }[field])
    if (idx === undefined || idx < 0) return ''
    return (row[idx] ?? '').toString().trim()
  }

  return rows
    .map((row, i) => ({
      productName:      cell(row, 'productName'),
      category:         cell(row, 'category'),
      relationId:       cell(row, 'relationId'),
      mainKeyword:      cell(row, 'mainKeyword'),
      secondaryKeyword: cell(row, 'secondaryKeyword'),
      enFileName:       cell(row, 'enFileName'),
      sheetStatus:      cell(row, 'sheetStatus') || SHEET_STATUS.TODO,
      rowIndex:         startRow + i,
    }))
    .filter(r => r.productName && r.relationId)
    .filter(r => allStatuses || r.sheetStatus === SHEET_STATUS.TODO)
}

// ── Write-back ────────────────────────────────────────────────────────────────

export interface ProductRowUpdate {
  mainKeyword?:      string
  secondaryKeyword?: string
  enFileName?:       string   // Google Doc URL
  status?:           string   // SHEET_STATUS.*
}

/**
 * Write updated fields back to a specific row in the sheet.
 * Only updates the columns that are provided (partial update).
 */
export async function writeProductRow(
  spreadsheetId: string,
  sheetName:     string,
  rowIndex:      number,        // 1-based
  update:        ProductRowUpdate,
): Promise<void> {
  const auth   = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const requests: Promise<unknown>[] = []

  if (update.mainKeyword !== undefined) {
    requests.push(
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range:          `${sheetName}!D${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[update.mainKeyword]] },
      })
    )
  }

  if (update.secondaryKeyword !== undefined) {
    requests.push(
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range:          `${sheetName}!E${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[update.secondaryKeyword]] },
      })
    )
  }

  if (update.enFileName !== undefined) {
    requests.push(
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range:          `${sheetName}!F${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[update.enFileName]] },
      })
    )
  }

  if (update.status !== undefined) {
    requests.push(
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range:          `${sheetName}!G${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[update.status]] },
      })
    )
  }

  // Run all partial updates in parallel
  await Promise.all(requests)
}

/**
 * Batch write multiple rows at once (more efficient than individual calls).
 * Each item must include rowIndex so we know where to write.
 */
export async function batchWriteProductRows(
  spreadsheetId: string,
  sheetName:     string,
  rows: (ProductRowUpdate & { rowIndex: number })[],
): Promise<void> {
  if (!rows.length) return

  const auth   = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const data = rows.flatMap(row => {
    const updates = []
    if (row.mainKeyword      !== undefined) updates.push({ range: `${sheetName}!D${row.rowIndex}`, values: [[row.mainKeyword]] })
    if (row.secondaryKeyword !== undefined) updates.push({ range: `${sheetName}!E${row.rowIndex}`, values: [[row.secondaryKeyword]] })
    if (row.enFileName       !== undefined) updates.push({ range: `${sheetName}!F${row.rowIndex}`, values: [[row.enFileName]] })
    if (row.status           !== undefined) updates.push({ range: `${sheetName}!G${row.rowIndex}`, values: [[row.status]] })
    return updates
  })

  if (!data.length) return

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data,
    },
  })
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Get the spreadsheet ID from a full Google Sheets URL */
export function extractSpreadsheetId(url: string): string | null {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return match ? match[1] : null
}
