import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getTopGamesByPlayers } from '@/lib/steam/client'
import { getKeywordDifficulty } from '@/lib/dataforseo/client'
import { getGoogleTrends } from '@/lib/dataforseo/client'

export const maxDuration = 60

const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h

// GET /api/trends/games?refresh=true
export async function GET(req: Request) {
  const supabase  = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const forceRefresh = searchParams.get('refresh') === 'true'

  // ── Check cache freshness ──────────────────────────────────────────────────
  const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString()
  const { data: cached, error: cacheErr } = await supabase
    .from('game_trends_cache')
    .select('*')
    .gte('cached_at', cutoff)
    .order('players_2weeks', { ascending: false })
    .limit(50)

  if (!forceRefresh && !cacheErr && cached && cached.length >= 10) {
    return NextResponse.json({ games: cached, source: 'cache' })
  }

  // ── Fetch fresh data ───────────────────────────────────────────────────────
  // 1. Steam top games
  const steamGames = await getTopGamesByPlayers(40)
  if (!steamGames.length) {
    return NextResponse.json({ error: 'Steam data unavailable' }, { status: 503 })
  }

  // 2. DataForSEO: bulk search volumes for "[game]" and "[game] buy"
  const allKeywords = steamGames.flatMap(g => [
    g.name.toLowerCase(),
    `${g.name.toLowerCase()} buy`,
  ])
  const volumeMap = await getKeywordDifficulty(allKeywords, 2840, 'en').catch(() => ({}))

  // 3. DataForSEO Google Trends for top 5 games (batched, max 5 per request)
  const top5Names = steamGames.slice(0, 5).map(g => g.name)
  const trendPoints = await getGoogleTrends(top5Names, 2840, 'en', 'past_30_days').catch(() => [])

  // 4. G2G "Recommended" check via SEMrush
  //    We use SEMrush domain_organic to check if G2G ranks for "[game] buy/sell"
  //    To avoid too many API calls, we check top 20 games only using stored rankings
  const semrushKey = process.env.SEMRUSH_API_KEY ?? ''
  const recommendedSet = new Set<number>()

  if (semrushKey && semrushKey !== 'placeholder') {
    // Pull G2G's top 2000 keywords from SEMrush and cross-ref game names
    try {
      const params = new URLSearchParams({
        type: 'domain_organic',
        key: semrushKey,
        domain: 'g2g.com',
        database: 'us',
        display_limit: '2000',
        display_sort: 'tr_desc',
        export_columns: 'Ph,Po',
        export_escape: '1',
      })
      const res  = await fetch(`https://api.semrush.com/?${params}`)
      const text = await res.text()
      if (!text.startsWith('ERROR')) {
        const kwLines = text.trim().split('\n').slice(1)
        const g2gKeywords = kwLines.map(l => l.split(';')[0]?.replace(/"/g, '').toLowerCase() ?? '')

        for (const game of steamGames) {
          const nameLower = game.name.toLowerCase()
          const hasRanking = g2gKeywords.some(kw => kw.includes(nameLower) || nameLower.includes(kw.replace(' buy', '').replace(' sell', '')))
          if (hasRanking) recommendedSet.add(game.appid)
        }
      }
    } catch { /* silent — recommended check is best-effort */ }
  }

  // ── Assemble rows & upsert cache ──────────────────────────────────────────
  const rows = steamGames.map(game => {
    const volKey     = game.name.toLowerCase()
    const buyVolKey  = `${game.name.toLowerCase()} buy`
    const trendForGame = trendPoints.map(p => ({
      date:  p.date,
      value: p.values[game.name] ?? 0,
    })).filter(p => p.value > 0)

    return {
      steam_appid:      game.appid,
      name:             game.name,
      developer:        game.developer,
      genre:            game.genre,
      players_2weeks:   game.players2weeks,
      players_forever:  game.playersForever,
      avg_playtime_2w:  game.avgPlaytime2w,
      search_volume:    volumeMap[volKey]    ?? 0,
      buy_search_volume: volumeMap[buyVolKey] ?? 0,
      search_trend:     trendForGame.length ? trendForGame : null,
      g2g_recommended:  recommendedSet.has(game.appid),
      g2g_position:     null,
      cached_at:        new Date().toISOString(),
    }
  })

  // Upsert (fire-and-forget in background so we don't block response)
  supabase
    .from('game_trends_cache')
    .upsert(rows, { onConflict: 'steam_appid' })
    .then(({ error }) => {
      if (error) console.warn('[trends/games] cache upsert failed:', error.message)
    })

  // Return with image URLs (not stored in DB)
  const withImages = rows.map((r, i) => ({
    ...r,
    image_url: steamGames[i].imageUrl,
    price:     steamGames[i].price,
  }))

  return NextResponse.json({ games: withImages, source: 'fresh' })
}
