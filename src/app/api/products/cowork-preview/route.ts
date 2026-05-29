import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { readProductSheet } from '@/lib/google/sheets'

export const maxDuration = 30

/**
 * GET /api/products/cowork-preview
 *
 * Sprint COWORK.PREVIEW — Read-only sheet scan for rows with col E = 'Cowork'.
 *
 * Why this exists:
 *   The existing 5-min Anthropic cron only processes col E = 'yes' (see
 *   isPendingTrigger in lib/google/sheets.ts). Rows marked 'Cowork' are
 *   skipped — that's the design from HANDOFF_COWORK_INTEGRATION.md, where
 *   a separate Cowork-session schedule will eventually consume them.
 *
 *   In the meantime, Galih wants visibility: "I marked 5 rows Cowork —
 *   show me they're queued and ready to be picked up." This endpoint gives
 *   that view without touching the protected files in the handoff:
 *     • Zero Anthropic API calls
 *     • Zero writes to product_content_queue
 *     • Zero changes to runPendingForOwner / cron / auto-upload
 *
 *   Pure read of the sheet, formatted for the UI.
 *
 * Response:
 *   {
 *     ok: true,
 *     spreadsheet_id: string,
 *     sheet_name:     string,
 *     count:          number,
 *     rows: Array<{
 *       relation_id:  string,
 *       product_name: string,
 *       category:     string,
 *       request_date: string,
 *       sheet_row:    number,
 *       trigger_raw:  string,    // 'Cowork', 'cowork', etc — for inspection
 *     }>,
 *     other_counts: {            // sheet-wide stats for context
 *       yes_pending:  number,    // rows waiting for the Anthropic cron
 *       generated:    number,    // already done
 *       errors:       number,
 *       total_rows:   number,
 *     }
 *   }
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  // Load sheet config (same pattern as runPendingForOwner)
  const { data: cfg } = await db
    .from('product_sheet_config')
    .select('spreadsheet_id, sheet_name')
    .eq('owner_user_id', ownerId)
    .single()

  if (!cfg?.spreadsheet_id) {
    return NextResponse.json({
      ok:    true,
      reason: 'no_sheet_config',
      count: 0,
      rows:  [],
      other_counts: { yes_pending: 0, generated: 0, errors: 0, total_rows: 0 },
    })
  }

  const spreadsheetId = cfg.spreadsheet_id
  const sheetName     = cfg.sheet_name ?? 'Sheet1'

  // Reuse the existing reader — gives us back the header-aware row map
  // with createNow (col E) already populated.
  let rows
  try {
    rows = await readProductSheet(spreadsheetId, sheetName, 2, 500)
  } catch (e) {
    return NextResponse.json({
      ok:    false,
      error: `Google Sheets read error: ${e instanceof Error ? e.message : String(e)}`,
    }, { status: 502 })
  }

  // Tally the four states present in col E. We do this once on the same
  // pass to keep the round-trip cheap — UI gets context for the Cowork
  // count ("3 of 200 rows are Cowork-queued").
  let yesPending = 0
  let generated  = 0
  let errors     = 0

  const coworkRows: Array<{
    relation_id:  string
    product_name: string
    category:     string
    request_date: string
    sheet_row:    number
    trigger_raw:  string
  }> = []

  const trimLower = (s: string) => (s ?? '').toString().trim().toLowerCase()

  for (const r of rows) {
    const v = trimLower(r.createNow)
    if (v === 'cowork') {
      coworkRows.push({
        relation_id:  r.relationId,
        product_name: r.productName,
        category:     r.category,
        request_date: r.requestDate,
        sheet_row:    r.rowIndex,
        trigger_raw:  r.createNow,
      })
    } else if (v === 'yes' || v === 'y') {
      yesPending++
    } else if (v.includes('generated')) {
      generated++
    } else if (v.startsWith('error')) {
      errors++
    }
  }

  return NextResponse.json({
    ok:              true,
    spreadsheet_id:  spreadsheetId,
    sheet_name:      sheetName,
    count:           coworkRows.length,
    rows:            coworkRows,
    other_counts: {
      yes_pending: yesPending,
      generated,
      errors,
      total_rows:  rows.length,
    },
  })
}
