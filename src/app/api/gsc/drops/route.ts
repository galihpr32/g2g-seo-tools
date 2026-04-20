import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const maxDuration = 15

/**
 * GET /api/gsc/drops?site_url=...&date=YYYY-MM-DD
 *   → returns drops + queries for that snapshot date
 *
 * GET /api/gsc/drops?site_url=...&list_dates=true
 *   → returns sorted list of available snapshot dates in DB
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const siteUrl = searchParams.get('site_url')
  if (!siteUrl) return NextResponse.json({ error: 'site_url required' }, { status: 400 })

  // ── Mode: list available dates ───────────────────────────────────────────────
  if (searchParams.get('list_dates') === 'true') {
    const { data, error } = await supabase
      .from('gsc_ranking_drops')
      .select('snapshot_date')
      .eq('site_url', siteUrl)
      .order('snapshot_date', { ascending: false })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Deduplicate dates (Supabase doesn't have DISTINCT in PostgREST select easily)
    const seen = new Set<string>()
    const dates: string[] = []
    for (const row of data ?? []) {
      if (!seen.has(row.snapshot_date)) {
        seen.add(row.snapshot_date)
        dates.push(row.snapshot_date)
      }
    }
    return NextResponse.json({ dates })
  }

  // ── Mode: fetch drops for a specific date ────────────────────────────────────
  const date = searchParams.get('date')
  if (!date) return NextResponse.json({ error: 'date or list_dates required' }, { status: 400 })

  const { data: dbDrops, error: dropsError } = await supabase
    .from('gsc_ranking_drops')
    .select('*')
    .eq('site_url', siteUrl)
    .eq('snapshot_date', date)
    .order('clicks_drop', { ascending: false })

  if (dropsError) return NextResponse.json({ error: dropsError.message }, { status: 500 })
  if (!dbDrops || dbDrops.length === 0) return NextResponse.json({ drops: [], queries: [] })

  const pages = dbDrops.map(d => d.page)
  const { data: dbQueries } = await supabase
    .from('gsc_ranking_drop_queries')
    .select('*')
    .eq('site_url', siteUrl)
    .eq('snapshot_date', date)
    .in('page', pages)
    .order('clicks', { ascending: false })

  // Shape drops into the PageDropWithQueries format expected by the client
  const queryMap = new Map<string, { query: string; clicks: number; impressions: number; ctr: number; position: number }[]>()
  for (const q of dbQueries ?? []) {
    if (!queryMap.has(q.page)) queryMap.set(q.page, [])
    queryMap.get(q.page)!.push({
      query: q.query,
      clicks: q.clicks,
      impressions: q.impressions,
      ctr: q.ctr,
      position: q.position,
    })
  }

  const drops = dbDrops.map(d => ({
    page:                d.page,
    currentClicks:       d.clicks_now,
    previousClicks:      d.clicks_prev,
    clicksDrop:          d.clicks_drop,
    currentImpressions:  d.impressions_now,
    previousImpressions: d.impressions_prev,
    impressionsDrop:     d.impressions_drop,
    currentPosition:     d.position_now,
    previousPosition:    d.position_prev,
    positionChange:      d.position_diff,
    queries:             queryMap.get(d.page) ?? [],
  }))

  return NextResponse.json({ drops, queries: dbQueries ?? [] })
}
