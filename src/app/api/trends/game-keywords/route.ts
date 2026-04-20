import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getKeywordSuggestions, getGoogleTrends } from '@/lib/dataforseo/client'
import { logApiUsage } from '@/lib/api-logger'

export const maxDuration = 30

// GET /api/trends/game-keywords?game=Minecraft&appid=123
// Returns keyword suggestions + trend data for a specific game
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const gameName = searchParams.get('game') ?? ''
  if (!gameName) return NextResponse.json({ error: 'Missing game param' }, { status: 400 })

  try {
    // Fetch keyword suggestions + trends in parallel
    const [suggestions, trends] = await Promise.all([
      getKeywordSuggestions(gameName, 2840, 'en', 40),
      getGoogleTrends([gameName, `${gameName} buy`, `${gameName} coins`], 2840, 'en', 'past_12_months'),
    ])

    // Log usage
    await logApiUsage(supabase, user.id, 'dataforseo', 'game_keywords', 2)

    // Group keywords by intent pattern
    const buyKeywords   = suggestions.filter(k => /buy|purchase|get|cheap|price/.test(k.keyword))
    const gameKeywords  = suggestions.filter(k => !/buy|purchase|get|cheap|price/.test(k.keyword))

    return NextResponse.json({
      game:         gameName,
      keywords:     suggestions,
      buyKeywords,
      gameKeywords,
      trends,
    })
  } catch (e) {
    console.error('[trends/game-keywords] error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
