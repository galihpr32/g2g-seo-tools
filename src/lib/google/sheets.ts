// ─── Google Sheets client (service account) ───────────────────────────────────
// Required env vars:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  — e.g. seo-tools@your-project.iam.gserviceaccount.com
//   GOOGLE_PRIVATE_KEY            — the private key from the JSON keyfile (with \n escaped)
//
// Setup:
//   1. Create a service account in Google Cloud Console
//   2. Download the JSON key, copy client_email → GOOGLE_SERVICE_ACCOUNT_EMAIL
//      and private_key → GOOGLE_PRIVATE_KEY
//   3. Share the Google Sheet with the service account email (Viewer permission)

import { google } from 'googleapis'

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const key   = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')

  if (!email || !key) throw new Error('Google service account credentials not configured')

  return new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
}

export interface ProductRow {
  productName:  string
  category:     string
  url:          string
  relationId:   string
  rowIndex:     number   // 1-based (for logging / reference)
}

// Read product rows from a Google Sheet
// Expects columns: Product Name | Category | URL | Relation ID
// (first row is header, skipped automatically)
export async function readProductSheet(
  spreadsheetId: string,
  sheetName     = 'Sheet1',
  startRow      = 2,        // skip header
  maxRows       = 500,
): Promise<ProductRow[]> {
  const auth   = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const range = `${sheetName}!A${startRow}:D${startRow + maxRows - 1}`

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  })

  const rows = res.data.values ?? []

  return rows
    .map((row, i) => ({
      productName: (row[0] ?? '').toString().trim(),
      category:    (row[1] ?? '').toString().trim(),
      url:         (row[2] ?? '').toString().trim(),
      relationId:  (row[3] ?? '').toString().trim(),
      rowIndex:    startRow + i,
    }))
    .filter(r => r.productName && r.relationId)
}

// Get the spreadsheet ID from a full Google Sheets URL
// e.g. https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit#gid=0
export function extractSpreadsheetId(url: string): string | null {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return match ? match[1] : null
}
