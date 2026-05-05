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
export async function readProductSheet(
  spreadsheetId: string,
  sheetName     = 'Sheet1',
  startRow      = 2,          // skip header row
  maxRows       = 500,
  allStatuses   = false,
): Promise<ProductRow[]> {
  const auth   = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  // Read A through G (7 columns)
  const range = `${sheetName}!A${startRow}:G${startRow + maxRows - 1}`

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  })

  const rows = res.data.values ?? []

  return rows
    .map((row, i) => ({
      productName:      (row[0] ?? '').toString().trim(),
      category:         (row[1] ?? '').toString().trim(),
      relationId:       (row[2] ?? '').toString().trim(),
      mainKeyword:      (row[3] ?? '').toString().trim(),
      secondaryKeyword: (row[4] ?? '').toString().trim(),
      enFileName:       (row[5] ?? '').toString().trim(),
      sheetStatus:      (row[6] ?? '').toString().trim() || SHEET_STATUS.TODO,
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
