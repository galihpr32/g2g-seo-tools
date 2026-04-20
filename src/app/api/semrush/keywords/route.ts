import { NextResponse } from 'next/server'
import { getDomainKeywords, getDomainOverview } from '@/lib/semrush/client'

export const maxDuration = 30

// GET /api/semrush/keywords
// Returns { keywords: KeywordRanking[], overview: DomainOverview | null, error?: string }
export async function GET() {
  const apiKey = process.env.SEMRUSH_API_KEY
  if (!apiKey || apiKey === 'placeholder') {
    return NextResponse.json({
      keywords: [],
      overview: null,
      error: 'SEMrush API key not configured.',
    })
  }

  try {
    const [keywords, overview] = await Promise.all([
      getDomainKeywords('g2g.com', 'us', 100),
      getDomainOverview('g2g.com', 'us'),
    ])

    return NextResponse.json({ keywords, overview })
  } catch (e) {
    console.error('[semrush/keywords] error:', e)
    return NextResponse.json(
      { keywords: [], overview: null, error: String(e) },
      { status: 200 } // return 200 so UI shows the error inline
    )
  }
}
