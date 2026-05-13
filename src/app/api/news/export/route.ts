import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { writeTabbedSnapshot, dateStampedTabName } from '@/lib/news-export/sheet-writer'
import {
  buildArticleGameRows,
  buildGameRollupRows,
  buildGameTrendsRows,
} from '@/lib/news-export/row-builders'

export const maxDuration = 120

/**
 * POST /api/news/export
 *
 * Builds the 3 row sets (Article×Game, Game Rollup, Game Trends) for the
 * current owner × site and writes them as 3 fresh date-stamped tabs in the
 * configured Google Sheet.
 *
 * Body (optional): { days?: number }   — default 14
 *
 * Auth modes:
 *   - Session auth (UI button)
 *   - Bearer CRON_SECRET (weekly cron) — pass `owner_user_id` + `site_slug` in body
 */
export async function POST(req: Request) {
  let ownerId:  string
  let siteSlug: string

  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  if (cronAuth) {
    const body = await req.json().catch(() => ({})) as { owner_user_id?: string; site_slug?: string; days?: number }
    if (!body.owner_user_id || !body.site_slug) {
      return NextResponse.json({ error: 'cron mode requires owner_user_id + site_slug in body' }, { status: 400 })
    }
    ownerId  = body.owner_user_id
    siteSlug = body.site_slug
  } else {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    ownerId  = await getEffectiveOwnerId(supabase, user.id)
    siteSlug = resolveSiteSlugFromRequest(req)
  }

  const body = await req.clone().json().catch(() => ({})) as { days?: number }
  const days = Math.min(Math.max(body.days ?? 14, 1), 60)

  const db = createServiceClient()

  // ── 1. Load config ──────────────────────────────────────────────────────
  const { data: cfg } = await db
    .from('news_export_config')
    .select('spreadsheet_id, weekly_cron_enabled')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .maybeSingle()

  if (!cfg?.spreadsheet_id) {
    return NextResponse.json({
      error: 'No Sheet configured for this brand. Set one at /settings/news-export.',
    }, { status: 400 })
  }

  // ── 2. Build rows in parallel ───────────────────────────────────────────
  const t0 = Date.now()
  let articleRows:  string[][] = []
  let rollupRows:   string[][] = []
  let trendsRows:   string[][] = []
  try {
    ;[articleRows, rollupRows, trendsRows] = await Promise.all([
      buildArticleGameRows(db, ownerId, days),
      buildGameRollupRows(db, ownerId, siteSlug, days),
      buildGameTrendsRows(db),
    ])
  } catch (e) {
    return NextResponse.json({ error: `Row build failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 })
  }

  // ── 3. Write 3 tabs ────────────────────────────────────────────────────
  const now = new Date()
  const tabs: Array<{ tab_name: string; rows: number }> = []
  const errors: string[] = []
  try {
    const r1 = await writeTabbedSnapshot(cfg.spreadsheet_id, dateStampedTabName('News-Articles', now), articleRows)
    tabs.push({ tab_name: r1.tab_name, rows: r1.rows_written })
  } catch (e) { errors.push(`News-Articles: ${e instanceof Error ? e.message : String(e)}`) }
  try {
    const r2 = await writeTabbedSnapshot(cfg.spreadsheet_id, dateStampedTabName('News-Games', now), rollupRows)
    tabs.push({ tab_name: r2.tab_name, rows: r2.rows_written })
  } catch (e) { errors.push(`News-Games: ${e instanceof Error ? e.message : String(e)}`) }
  try {
    const r3 = await writeTabbedSnapshot(cfg.spreadsheet_id, dateStampedTabName('Trends', now), trendsRows)
    tabs.push({ tab_name: r3.tab_name, rows: r3.rows_written })
  } catch (e) { errors.push(`Trends: ${e instanceof Error ? e.message : String(e)}`) }

  const rowsTotal = tabs.reduce((s, t) => s + t.rows, 0)
  const elapsedMs = Date.now() - t0
  const status = errors.length === 0 ? 'success' : (tabs.length > 0 ? 'partial' : 'error')
  const summary = `${tabs.length}/${tabs.length + errors.length} tabs · ${rowsTotal} rows · ${(elapsedMs / 1000).toFixed(1)}s${errors.length ? ` · errors: ${errors.length}` : ''}`

  // ── 4. Record last run ──────────────────────────────────────────────────
  await db
    .from('news_export_config')
    .update({
      last_exported_at: now.toISOString(),
      last_run_status:  status,
      last_run_summary: summary,
      updated_at:       now.toISOString(),
    })
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  return NextResponse.json({
    ok: errors.length === 0,
    tabs,
    rows_total: rowsTotal,
    elapsed_ms: elapsedMs,
    errors,
    sheet_id:   cfg.spreadsheet_id,
  })
}
