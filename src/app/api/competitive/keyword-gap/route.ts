import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getDomainRankedKeywords } from '@/lib/dataforseo/client'

export const maxDuration = 60

type CompPos = { domain: string; position: number | null; url: string | null }

type GapRow = {
  keyword: string
  searchVolume: number
  cpc: number
  g2g_position: number | null
  g2g_url: string | null
  competitors: CompPos[]
  best_competitor_position: number | null
  position_diff: number | null
}

type PosDist = { top3: number; pos4_10: number; pos11_20: number; pos21_30: number }

function calcPosDist(map: Map<string, { position?: number }>): PosDist {
  let top3 = 0, pos4_10 = 0, pos11_20 = 0, pos21_30 = 0
  for (const [, d] of map) {
    const pos = d.position ?? 999
    if      (pos <= 3)  top3++
    else if (pos <= 10) pos4_10++
    else if (pos <= 20) pos11_20++
    else if (pos <= 30) pos21_30++
  }
  return { top3, pos4_10, pos11_20, pos21_30 }
}

/**
 * POST /api/competitive/keyword-gap
 *
 * Body: {
 *   competitor_domains?: string[]   ← preferred (multi-domain, up to 4)
 *   competitor_domain?:  string     ← backward compat (single domain)
 *   location_code?: number
 *   language_code?: string
 *   limit?: number
 * }
 *
 * Returns three keyword buckets + Venn overlap data + position distribution:
 *   - gaps:    competitor(s) rank top 30, G2G doesn't rank at all
 *   - behind:  both rank, but best competitor is 10+ positions ahead of G2G
 *   - winning: G2G ranks, competitor doesn't (or G2G is ahead of all)
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const {
    competitor_domain,
    competitor_domains: rawDomains,
    location_code = 2840,
    language_code = 'en',
    limit = 500,
  } = body

  // Support both single and multi-domain (max 4 competitors)
  const competitorDomains: string[] = (
    Array.isArray(rawDomains) && rawDomains.length > 0
      ? rawDomains
      : competitor_domain ? [competitor_domain] : []
  ).map((d: string) => d.trim()).filter(Boolean).slice(0, 4)

  if (competitorDomains.length === 0) {
    return NextResponse.json({ error: 'competitor_domain is required' }, { status: 400 })
  }

  const G2G_DOMAIN = 'g2g.com'
  const db = createServiceClient()
  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { data: exclusionRows } = await db
    .from('keyword_exclusions')
    .select('pattern, match_type')
    .eq('owner_user_id', ownerId)

  const exclusions = exclusionRows ?? []

  function isExcluded(keyword: string): boolean {
    const kw = keyword.toLowerCase()
    for (const { pattern, match_type } of exclusions) {
      const p = pattern.toLowerCase()
      if (match_type === 'exact'       && kw === p)          return true
      if (match_type === 'starts_with' && kw.startsWith(p))  return true
      if (match_type === 'contains'    && kw.includes(p))    return true
    }
    return false
  }

  try {
    // Fetch G2G + all competitors in parallel
    const [g2gKws, ...allCompKws] = await Promise.all([
      getDomainRankedKeywords(G2G_DOMAIN, location_code, language_code, limit),
      ...competitorDomains.map(d => getDomainRankedKeywords(d, location_code, language_code, limit)),
    ])

    const g2gMap = new Map(g2gKws.map(k => [k.keyword.toLowerCase(), k]))
    const compMaps = competitorDomains.map((domain, i) => ({
      domain,
      map: new Map(allCompKws[i].map(k => [k.keyword.toLowerCase(), k])),
    }))

    // Collect all top-30 keywords from every source
    const allKeywords = new Set<string>()
    for (const [kw, d] of g2gMap) { if ((d.position ?? 999) <= 30) allKeywords.add(kw) }
    for (const { map } of compMaps) {
      for (const [kw, d] of map) { if ((d.position ?? 999) <= 30) allKeywords.add(kw) }
    }

    const gaps: GapRow[]    = []
    const behind: GapRow[]  = []
    const winning: GapRow[] = []
    let excluded_count = 0

    for (const kw of allKeywords) {
      if (isExcluded(kw)) { excluded_count++; continue }

      const g2gData = g2gMap.get(kw)
      const g2gPos  = g2gData?.position ?? null
      const g2gTop30 = (g2gPos ?? 999) <= 30

      const competitors: CompPos[] = compMaps.map(({ domain, map }) => {
        const d = map.get(kw)
        return { domain, position: d?.position ?? null, url: d?.url ?? null }
      })

      const compPositions = competitors.map(c => c.position).filter((p): p is number => p !== null)
      const bestCompPos   = compPositions.length > 0 ? Math.min(...compPositions) : 999
      const anyCompTop30  = bestCompPos <= 30
      const bestCompPosOrNull = anyCompTop30 ? bestCompPos : null

      // Pick search volume from any available source
      const searchVolume = g2gData?.volume
        ?? compMaps.map(({ map }) => map.get(kw)?.volume).find(v => v != null)
        ?? 0

      const row: GapRow = {
        keyword:                 kw,
        searchVolume,
        cpc:                     0,
        g2g_position:            g2gPos,
        g2g_url:                 g2gData?.url ?? null,
        competitors,
        best_competitor_position: bestCompPosOrNull,
        position_diff:           g2gPos !== null && bestCompPosOrNull !== null
          ? g2gPos - bestCompPosOrNull : null,
      }

      if (!g2gTop30 && anyCompTop30) {
        gaps.push(row)
      } else if (g2gTop30 && anyCompTop30 && g2gPos! - bestCompPos >= 10) {
        behind.push(row)
      } else if (g2gTop30 && (!anyCompTop30 || g2gPos! < bestCompPos)) {
        winning.push(row)
      }
    }

    // Sort buckets
    const byVolume = (a: GapRow, b: GapRow) => b.searchVolume - a.searchVolume
    gaps.sort(byVolume)
    behind.sort((a, b) => (b.position_diff ?? 0) - (a.position_diff ?? 0))
    winning.sort(byVolume)

    // ── Venn overlap data ─────────────────────────────────────────────────────
    const g2gTop30Set = new Set<string>()
    for (const [kw, d] of g2gMap) { if ((d.position ?? 999) <= 30) g2gTop30Set.add(kw) }

    const venn = compMaps.map(({ domain, map }) => {
      const compTop30Set = new Set<string>()
      for (const [kw, d] of map) { if ((d.position ?? 999) <= 30) compTop30Set.add(kw) }

      let g2g_only = 0, comp_only = 0, shared = 0
      for (const kw of g2gTop30Set) { compTop30Set.has(kw) ? shared++ : g2g_only++ }
      for (const kw of compTop30Set) { if (!g2gTop30Set.has(kw)) comp_only++ }

      const overlap_pct = (g2g_only + comp_only + shared) > 0
        ? Math.round(shared / (g2g_only + comp_only + shared) * 100) : 0

      return { domain, g2g_only, comp_only, shared, overlap_pct }
    })

    // ── Position distribution ─────────────────────────────────────────────────
    const position_distribution = {
      g2g: calcPosDist(g2gMap),
      competitors: Object.fromEntries(
        compMaps.map(({ domain, map }) => [domain, calcPosDist(map)])
      ),
    }

    const summary = {
      g2g_total: g2gKws.length,
      competitor_totals: Object.fromEntries(
        compMaps.map(({ domain }, i) => [domain, allCompKws[i].length])
      ),
      // backward compat: single-domain alias
      competitor_total: allCompKws[0]?.length ?? 0,
      gaps:    gaps.length,
      behind:  behind.length,
      winning: winning.length,
    }

    return NextResponse.json({
      competitor_domains: competitorDomains,
      competitor_domain:  competitorDomains[0],  // primary (backward compat)
      g2g_domain: G2G_DOMAIN,
      location_code,
      language_code,
      excluded_count,
      exclusions_active: exclusions.length,
      summary,
      venn,
      position_distribution,
      gaps:    gaps.slice(0, 200),
      behind:  behind.slice(0, 200),
      winning: winning.slice(0, 100),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
