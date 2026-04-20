import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDomainKeywords } from '@/lib/semrush/client'

export const maxDuration = 30

/**
 * POST /api/competitive/keyword-gap
 * Body: { competitor_domain: string, database: string, limit?: number }
 *
 * Fetches organic keywords for both G2G and the competitor from SEMrush,
 * then returns three buckets:
 *   - gaps:    competitor ranks top 30, G2G doesn't rank at all
 *   - behind:  both rank, but competitor is significantly ahead (diff >= 10)
 *   - winning: G2G ranks and competitor doesn't (or G2G is ahead)
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const { competitor_domain, database = 'us', limit = 500 } = body

  if (!competitor_domain?.trim()) {
    return NextResponse.json({ error: 'competitor_domain is required' }, { status: 400 })
  }

  const G2G_DOMAIN = 'g2g.com'

  try {
    // Fetch both domains in parallel — SEMrush domain_organic
    const [g2gKws, competitorKws] = await Promise.all([
      getDomainKeywords(G2G_DOMAIN, database, limit),
      getDomainKeywords(competitor_domain.trim(), database, limit),
    ])

    // Build lookup maps: keyword → {position, url, searchVolume, cpc}
    const g2gMap = new Map(g2gKws.map(k => [k.keyword.toLowerCase(), k]))
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

    // Iterate competitor keywords
    for (const [kw, compData] of compMap) {
      if (compData.position > 30) continue  // only care about top 30 comp positions

      const g2gData = g2gMap.get(kw)
      const row: GapRow = {
        keyword:             kw,
        searchVolume:        compData.searchVolume,
        cpc:                 compData.cpc,
        g2g_position:        g2gData?.position ?? null,
        competitor_position: compData.position,
        position_diff:       g2gData ? (g2gData.position - compData.position) : null,
        g2g_url:             g2gData?.url ?? null,
        competitor_url:      compData.url,
      }

      if (!g2gData) {
        gaps.push(row)      // G2G doesn't rank at all
      } else if (g2gData.position - compData.position >= 10) {
        behind.push(row)    // G2G is 10+ positions behind
      } else if (g2gData.position < compData.position) {
        winning.push(row)   // G2G is winning this keyword
      }
    }

    // Also find keywords G2G ranks for that competitor doesn't (within top 30)
    for (const [kw, g2gData] of g2gMap) {
      if (g2gData.position > 30) continue
      if (!compMap.has(kw)) {
        winning.push({
          keyword:             kw,
          searchVolume:        g2gData.searchVolume,
          cpc:                 g2gData.cpc,
          g2g_position:        g2gData.position,
          competitor_position: null,
          position_diff:       null,
          g2g_url:             g2gData.url,
          competitor_url:      null,
        })
      }
    }

    // Sort each bucket by search volume desc
    const byVolume = (a: GapRow, b: GapRow) => b.searchVolume - a.searchVolume
    gaps.sort(byVolume)
    behind.sort((a, b) => (b.position_diff ?? 0) - (a.position_diff ?? 0))  // biggest gap first
    winning.sort(byVolume)

    return NextResponse.json({
      competitor_domain: competitor_domain.trim(),
      g2g_domain: G2G_DOMAIN,
      database,
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
