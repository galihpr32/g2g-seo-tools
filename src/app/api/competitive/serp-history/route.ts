import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 30

/**
 * GET /api/competitive/serp-history?days=90&keyword=&country_code=
 *
 * Returns all serp_snapshots within the date window, grouped by snapshot_date,
 * with computed Share of Voice per day. Powers the History tab on the SERP
 * Tracker page so users can see every tracking run they've made — useful for
 * (a) justifying tracking spend in reports, (b) spotting SoV trends over time,
 * (c) debugging "why isn't my data in the monthly report" questions.
 *
 * Optional filters:
 *   days         — lookback window (default 90, max 365)
 *   keyword      — filter to a specific tracked keyword
 *   country_code — filter to a specific market (us / id / etc.)
 */

interface SnapshotRow {
  keyword:        string
  search_volume:  number | null
  results:        Array<{ domain?: string; position?: number; url?: string; title?: string }>
  snapshot_date:  string
  location_code:  number | null
  language_code:  string | null
  created_at?:    string
}

interface HistoryDay {
  snapshot_date:    string
  keyword_count:    number
  total_sv:         number
  top_domains:      Array<{ domain: string; sov_pct: number; keywords_in_top10: number }>
  keywords:         Array<{ keyword: string; search_volume: number | null }>
}

const CTR_CURVE: Record<number, number> = {
  1: 0.284, 2: 0.146, 3: 0.099, 4: 0.073, 5: 0.057,
  6: 0.045, 7: 0.036, 8: 0.030, 9: 0.025, 10: 0.022,
}

function normalizeDomain(d: string): string {
  return d.replace(/^www\./, '').toLowerCase()
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { searchParams } = new URL(req.url)
  const days        = Math.min(Math.max(parseInt(searchParams.get('days') ?? '90'), 1), 365)
  const keyword     = searchParams.get('keyword')      ?? null
  const countryCode = searchParams.get('country_code') ?? null

  const sinceIso = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)

  // ── Pull all snapshots in window ────────────────────────────────────────
  let query = db
    .from('serp_snapshots')
    .select('keyword, search_volume, results, snapshot_date, location_code, language_code')
    .eq('owner_user_id', ownerId)
    .gte('snapshot_date', sinceIso)
    .order('snapshot_date', { ascending: false })
    .order('keyword',       { ascending: true })

  if (keyword) query = query.eq('keyword', keyword)
  // If a specific country requested, filter by location_code (DataForSEO numeric)
  if (countryCode) {
    const map: Record<string, number> = { us: 2840, id: 2360, br: 2076, mx: 2484, th: 2764, vn: 2704 }
    const loc = map[countryCode.toLowerCase()]
    if (loc) query = query.eq('location_code', loc)
  }

  const { data: rows, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const snapshots = (rows ?? []) as SnapshotRow[]

  // ── Group by snapshot_date and compute per-day SoV ──────────────────────
  const byDate = new Map<string, SnapshotRow[]>()
  for (const s of snapshots) {
    const arr = byDate.get(s.snapshot_date) ?? []
    arr.push(s)
    byDate.set(s.snapshot_date, arr)
  }

  const days_out: HistoryDay[] = []
  for (const [date, daySnaps] of byDate) {
    const rawSov   = new Map<string, number>()
    const kwInTop10 = new Map<string, number>()
    let totalSv = 0
    for (const snap of daySnaps) {
      const vol = snap.search_volume ?? 0
      totalSv += vol
      for (const r of snap.results ?? []) {
        if (!r.domain) continue
        const pos = r.position ?? 99
        if (pos > 10) continue
        const dom = normalizeDomain(r.domain)
        const ctr = CTR_CURVE[pos] ?? 0
        rawSov.set(dom, (rawSov.get(dom) ?? 0) + ctr * vol)
        kwInTop10.set(dom, (kwInTop10.get(dom) ?? 0) + 1)
      }
    }

    const totalRaw = Array.from(rawSov.values()).reduce((a, b) => a + b, 0)
    const top_domains = Array.from(rawSov.entries())
      .map(([domain, raw]) => ({
        domain,
        sov_pct:           totalRaw > 0 ? Math.round((raw / totalRaw) * 1000) / 10 : 0,
        keywords_in_top10: kwInTop10.get(domain) ?? 0,
      }))
      .sort((a, b) => b.sov_pct - a.sov_pct)
      .slice(0, 5)

    days_out.push({
      snapshot_date: date,
      keyword_count: daySnaps.length,
      total_sv:      totalSv,
      top_domains,
      keywords:      daySnaps.map(s => ({ keyword: s.keyword, search_volume: s.search_volume })),
    })
  }

  // Sort by date descending (most recent first)
  days_out.sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date))

  return NextResponse.json({
    days:           days_out,
    total_runs:     snapshots.length,
    distinct_dates: byDate.size,
    distinct_keywords: new Set(snapshots.map(s => s.keyword)).size,
    window_days:    days,
    since:          sinceIso,
  })
}
