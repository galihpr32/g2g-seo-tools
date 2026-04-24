import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getDomainRankedKeywords } from '@/lib/dataforseo/client'

export const maxDuration = 30

/**
 * POST /api/competitive/keyword-gap
 * Body: { competitor_domain: string, location_code?: number, language_code?: string, limit?: number }
 *
 * Fetches organic keywords for both G2G and the competitor via DataForSEO,
 * applies keyword exclusion filters (brand names, etc.), then returns three buckets:
 *   - gaps:    competitor ranks top 30, G2G doesn't rank at all
 *   - behind:  both rank, but competitor is significantly ahead (diff >= 10)
 *   - winning: G2G ranks and competitor doesn't (or G2G is ahead)
 *
 * Also returns excluded_count so the UI can show how many were filtered.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const {
    competitor_domain,
    location_code = 2840,  // default: United States
    language_code = 'en',
    limit = 500,
  } = body

  if (!competitor_domain?.trim()) {
    return NextResponse.json({ error: 'competitor_domain is required' }, { status: 400 })
  }

  const G2G_DOMAIN = 'g2g.com'

  // Load keyword exclusions for this user
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
    // Fetch both domains in parallel via DataForSEO
    const [g2gKws, competitorKws] = await Promise.all([
      getDomainRankedKeywords(G2G_DOMAIN, location_code, language_code, limit),
      getDomainRankedKeywords(competitor_domain.trim(), location_code, language_code, limit),
    ])

    // Build lookup maps: keyword → {position, url, volume}
    const g2gMap  = new Map(g2gKws.map(k => [k.keyword.toLowerCase(), k]))
    const compMap = new Map(competitorKws.map(k => [k.keyword.toLowerCase(), k]))

    type GapRow = {
      keyword: string
      searchVolume: number
      cpc: number
      g2g_position: number | null
      competitor_position: number | null
      position_diff: number | null
      g2g_url: string | null
      competitor_url: string | null
    }

    const gaps: GapRow[]    = []
    const behind: GapRow[]  = []
    const winning: GapRow[] = []
    let excluded_count = 0

    // Iterate competitor keywords
    for (const [kw, compData] of compMap) {
      if ((compData.position ?? 999) > 30) continue

      if (isExcluded(kw)) { excluded_count++; continue }

      const g2gData = g2gMap.get(kw)
      const row: GapRow = {
        keyword:             kw,
        searchVolume:        compData.volume ?? 0,
        cpc:                 0,
        g2g_position:        g2gData?.position ?? null,
        competitor_position: compData.position ?? null,
        position_diff:       g2gData && compData.position
          ? (g2gData.position - compData.position) : null,
        g2g_url:             g2gData?.url ?? null,
        competitor_url:      compData.url ?? null,
      }

      if (!g2gData) {
        gaps.push(row)
      } else if (g2gData.position - (compData.position ?? 0) >= 10) {
        behind.push(row)
      } else if (g2gData.position < (compData.position ?? 999)) {
        winning.push(row)
      }
    }

    // Keywords G2G ranks for that competitor doesn't (within top 30)
    for (const [kw, g2gData] of g2gMap) {
      if ((g2gData.position ?? 999) > 30) continue
      if (compMap.has(kw)) continue
      if (isExcluded(kw)) { excluded_count++; continue }

      winning.push({
        keyword:             kw,
        searchVolume:        g2gData.volume ?? 0,
        cpc:                 0,
        g2g_position:        g2gData.position ?? null,
        competitor_position: null,
        position_diff:       null,
        g2g_url:             g2gData.url ?? null,
        competitor_url:      null,
      })
    }

    // Sort each bucket
    const byVolume = (a: GapRow, b: GapRow) => b.searchVolume - a.searchVolume
    gaps.sort(byVolume)
    behind.sort((a, b) => (b.position_diff ?? 0) - (a.position_diff ?? 0))
    winning.sort(byVolume)

    return NextResponse.json({
      competitor_domain: competitor_domain.trim(),
      g2g_domain: G2G_DOMAIN,
      location_code,
      language_code,
      excluded_count,
      exclusions_active: exclusions.length,
      summary: {
        g2g_total: g2gKws.length,
        competitor_total: competitorKws.length,
        gaps: gaps.length,
        behind: behind.length,
        winning: winning.length,
      },
      gaps:    gaps.slice(0, 200),
      behind:  behind.slice(0, 200),
      winning: winning.slice(0, 100),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
