import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getSerpData } from '@/lib/dataforseo/client'
import { getCountryPreset } from '@/lib/country-config'

export const maxDuration = 60

// Estimated CTR curve by position (industry averages)
const CTR_CURVE: Record<number, number> = {
  1: 0.284, 2: 0.146, 3: 0.099, 4: 0.073, 5: 0.057,
  6: 0.045, 7: 0.036, 8: 0.030, 9: 0.025, 10: 0.022,
}
function estimatedCtr(position: number): number {
  return CTR_CURVE[position] ?? 0.01
}

// DataForSEO returns domains with www. prefix (e.g. "www.g2g.com") — normalize for consistent keys
function normalizeDomain(d: string): string { return d.replace(/^www\./, '') }

/**
 * POST /api/competitive/serp-track
 * Body: { keywords: string[], country_code: string, search_volumes?: Record<string,number> }
 *
 * For each keyword:
 *   1. Calls DataForSEO SERP live endpoint
 *   2. Stores result in serp_snapshots (upsert)
 *   3. Computes SoV per domain
 *
 * Returns: { snapshots: [...], sov: {domain: {score, keywords_in_top10, est_clicks}} }
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => ({}))
  const { keywords, country_code = 'us', search_volumes = {} } = body

  if (!Array.isArray(keywords) || keywords.length === 0) {
    return NextResponse.json({ error: 'keywords array is required' }, { status: 400 })
  }
  if (keywords.length > 20) {
    return NextResponse.json({ error: 'Max 20 keywords per run to manage API costs' }, { status: 400 })
  }

  const preset = getCountryPreset(country_code)
  const today  = new Date().toISOString().split('T')[0]

  // SoV accumulator: domain → { total_score, keywords_in_top10, est_clicks }
  const sovMap = new Map<string, { score: number; kwCount: number; estClicks: number }>()

  const snapshots: {
    keyword: string
    results: { domain: string; position: number; url: string; title: string }[]
    error?: string
  }[] = []

  // Run keywords sequentially to avoid rate limits
  for (const keyword of keywords.slice(0, 20)) {
    try {
      const serpData = await getSerpData(keyword, preset.dfsLocationCode, preset.dfsLanguageCode, 10)
      const vol = (search_volumes as Record<string, number>)[keyword.toLowerCase()] ?? 0

      const results = serpData.organicResults.map(r => ({
        domain:   normalizeDomain(r.domain),   // normalize www. prefix
        position: r.rank_absolute,
        url:      r.url,
        title:    r.title,
      }))

      snapshots.push({ keyword, results })

      // Accumulate SoV
      for (const r of results) {
        if (r.position > 10) continue
        const ctr       = estimatedCtr(r.position)
        const estClicks = vol * ctr
        const score     = ctr * 100  // SoV contribution = CTR%

        const existing = sovMap.get(r.domain) ?? { score: 0, kwCount: 0, estClicks: 0 }
        sovMap.set(r.domain, {
          score:     existing.score + score,
          kwCount:   existing.kwCount + 1,
          estClicks: existing.estClicks + estClicks,
        })
      }

      // Upsert snapshot to DB
      await supabase.from('serp_snapshots').upsert({
        owner_user_id: ownerId,
        keyword,
        location_code:  preset.dfsLocationCode,
        language_code:  preset.dfsLanguageCode,
        snapshot_date:  today,
        search_volume:  vol || null,
        results,
      }, { onConflict: 'owner_user_id,keyword,location_code,snapshot_date' })

    } catch (err) {
      snapshots.push({ keyword, results: [], error: String(err) })
    }
  }

  // Normalize SoV scores to percentages (total across all keywords)
  const totalScore = [...sovMap.values()].reduce((s, v) => s + v.score, 0)
  const sov: Record<string, { sov_pct: number; keywords_in_top10: number; est_clicks: number }> = {}
  for (const [domain, vals] of sovMap) {
    sov[domain] = {
      sov_pct:           totalScore > 0 ? Math.round((vals.score / totalScore) * 100 * 10) / 10 : 0,
      keywords_in_top10: vals.kwCount,
      est_clicks:        Math.round(vals.estClicks),
    }
  }

  return NextResponse.json({ snapshots, sov, country_code, date: today })
}

/**
 * GET /api/competitive/serp-track?country_code=us&date=YYYY-MM-DD
 * Returns stored snapshots for the given date + country
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { searchParams } = new URL(req.url)
  const country_code = searchParams.get('country_code') ?? 'us'
  const date = searchParams.get('date') ?? new Date().toISOString().split('T')[0]
  const preset = getCountryPreset(country_code)

  const { data, error } = await supabase
    .from('serp_snapshots')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('location_code', preset.dfsLocationCode)
    .eq('snapshot_date', date)
    .order('search_volume', { ascending: false, nullsFirst: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Recompute SoV from stored snapshots
  const sovMap = new Map<string, { score: number; kwCount: number; estClicks: number }>()
  for (const snap of data ?? []) {
    const vol = snap.search_volume ?? 0
    for (const r of (snap.results as { domain: string; position: number }[]) ?? []) {
      if (r.position > 10) continue
      const domain = normalizeDomain(r.domain)
      const ctr   = estimatedCtr(r.position)
      const score = ctr * 100
      const existing = sovMap.get(domain) ?? { score: 0, kwCount: 0, estClicks: 0 }
      sovMap.set(domain, {
        score:     existing.score + score,
        kwCount:   existing.kwCount + 1,
        estClicks: existing.estClicks + vol * ctr,
      })
    }
  }
  const totalScore = [...sovMap.values()].reduce((s, v) => s + v.score, 0)
  const sov: Record<string, { sov_pct: number; keywords_in_top10: number; est_clicks: number }> = {}
  for (const [domain, vals] of sovMap) {
    sov[domain] = {
      sov_pct:           totalScore > 0 ? Math.round((vals.score / totalScore) * 100 * 10) / 10 : 0,
      keywords_in_top10: vals.kwCount,
      est_clicks:        Math.round(vals.estClicks),
    }
  }

  return NextResponse.json({ snapshots: data ?? [], sov, country_code, date })
}
