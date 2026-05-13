// ─── Google Sheets writer for news/trends export ────────────────────────────
// Adds a new date-stamped tab + writes the rows. Reuses the existing
// service-account auth from src/lib/google/sheets.ts.

import { google } from 'googleapis'

// Same auth pattern as src/lib/google/sheets.ts — kept inline rather than
// imported so this module is self-contained and easy to vendor elsewhere.
function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  let key     = process.env.GOOGLE_PRIVATE_KEY ?? ''
  if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1)
  key = key.replace(/\\n/g, '\n').trim()
  if (!email || !key) {
    throw new Error('Google service account credentials not configured (GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY env vars required)')
  }
  return new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
}

export interface WriteResult {
  tab_name:      string
  tab_id:        number
  rows_written:  number
}

/** Extract spreadsheet ID from a full URL or accept a bare ID. */
export function extractSpreadsheetId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  // Bare ID: 44-ish alphanumeric chars
  if (/^[a-zA-Z0-9_-]{30,}$/.test(trimmed)) return trimmed
  // Full URL: https://docs.google.com/spreadsheets/d/<ID>/edit...
  const m = trimmed.match(/\/d\/([a-zA-Z0-9_-]{20,})/)
  return m ? m[1] : null
}

/**
 * Create a new tab with the given name and write rows to it. If a tab with
 * that name already exists, suffix with `-2`, `-3`, etc. so we never
 * overwrite. First row of `rows` is rendered as the frozen, bold header.
 */
export async function writeTabbedSnapshot(
  spreadsheetId: string,
  baseTabName:   string,
  rows:          string[][],
): Promise<WriteResult> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  // ── 1. Find a unique tab name ─────────────────────────────────────────
  const { data: meta } = await sheets.spreadsheets.get({ spreadsheetId })
  const existingTabs = new Set((meta.sheets ?? []).map(s => s.properties?.title ?? ''))
  let tabName = baseTabName
  let suffix = 1
  while (existingTabs.has(tabName)) {
    suffix++
    tabName = `${baseTabName}-${suffix}`
  }

  // ── 2. Create the tab ─────────────────────────────────────────────────
  const { data: addRes } = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: tabName,
            gridProperties: {
              frozenRowCount: 1,
            },
          },
        },
      }],
    },
  })
  const tabId = addRes.replies?.[0]?.addSheet?.properties?.sheetId ?? 0

  // ── 3. Write rows ────────────────────────────────────────────────────
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range:        `${tabName}!A1`,
    valueInputOption: 'RAW',
    requestBody:  { values: rows },
  })

  // ── 4. Format header (bold + light grey bg) + auto-resize first 20 cols ─
  if (rows.length > 0) {
    const colCount = rows[0].length
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          // Bold header
          {
            repeatCell: {
              range: {
                sheetId: tabId,
                startRowIndex: 0,
                endRowIndex:   1,
                startColumnIndex: 0,
                endColumnIndex:   colCount,
              },
              cell: {
                userEnteredFormat: {
                  textFormat:      { bold: true },
                  backgroundColor: { red: 0.93, green: 0.93, blue: 0.95 },
                },
              },
              fields: 'userEnteredFormat(textFormat,backgroundColor)',
            },
          },
          // Auto-resize columns
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId:   tabId,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex:   Math.min(colCount, 20),
              },
            },
          },
        ],
      },
    })
  }

  return {
    tab_name:     tabName,
    tab_id:       tabId,
    rows_written: Math.max(0, rows.length - 1),   // exclude header from count
  }
}

/** Build a date-stamped tab name like 'News-Articles-2026-05-13'. */
export function dateStampedTabName(base: string, date: Date = new Date()): string {
  const iso = date.toISOString().slice(0, 10)
  return `${base}-${iso}`
}
