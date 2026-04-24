import { NextResponse } from 'next/server'
import { getDomainRankedKeywords, getDomainOverviewDFS } from '@/lib/dataforseo/client'

export const maxDuration = 30

// GET /api/semrush/keywords
// Returns { keywords: Keyword[], overview: Overview | null, error?: string }
export async function GET() {
  const hasCredentials = !!(
    process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD
  )

  if (!hasCredentials) {
    return NextResponse.json({
      keywords: [],
      overview: null,
      error: 'DataForSEO credentials not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.',
    })
  }

  try {
    const [dfsKeywords, overview] = await Promise.all([
      getDomainRankedKeywords('g2g.com', 2840, 'en', 200),
      getDomainOverviewDFS('g2g.com', 2840, 'en'),
    ])

    // Map DataForSEO ranked keywords to the Keyword shape the UI expects
    const keywords = dfsKeywords.map(k => ({
      keyword: k.keyword,
      position: k.position ?? 0,
      previousPosition: 0,  // not available from DFS ranked_keywords endpoint
      positionDiff: 0,       // not available — would need historical data
      searchVolume: k.volume ?? 0,
      cpc: 0,                // not returned by ranked_keywords
      url: k.url ?? '',
      trafficPercent: 0,     // not returned by ranked_keywords
    }))

    return NextResponse.json({ keywords, overview })
  } catch (e) {
    console.error('[semrush/keywords] error:', e)
    return NextResponse.json(
      { keywords: [], overview: null, error: String(e) },
      { status: 200 }
    )
  }
}
