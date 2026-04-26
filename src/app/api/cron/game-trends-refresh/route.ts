import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { getTopGamesByPlayers } from '@/lib/steam/client'
import { getKeywordDifficulty, getGoogleTrends } from '@/lib/dataforseo/client'

export const maxDuration = 300

/**
 * GET /api/cron/game-trends-refresh
 *
 * Refreshes `game_trends_cache` so Odin doesn't depend on a human opening
 * the Trends UI to keep its data fresh. Runs once daily.
 *
 * Auth: Bearer ${CRON_SECRET} — same pattern as other cron routes.
 *
 * Same fetch+upsert logic as /api/trends/games but uses service client
 * (RLS bypass) and runs unconditionally (no cache short-circuit).
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const startedAt = Date.now()
  const warnings: string[] = []

  try {
    // 1. Steam top games
    const steamGames = await getTopGamesByPlayers(40)
    if (!steamGames.length) {
      return NextResponse.json({ error: 'Steam data unavailable' }, { status: 503 })
    }

    // 2. DataForSEO bulk search volumes
    const allKeywords = steamGames.flatMap(g => [
      g.name.toLowerCase(),
      `${g.name.toLowerCase()} buy`,
    ])
    const volumeMap: Record<string, number> = await getKeywordDifficulty(allKeywords, 2840, 'en')
      .catch(err => {
        warnings.push(`DataForSEO bulk volume failed: ${err instanceof Error ? err.message : String(err)}`)
        return {}
      })

    // 3. Google Trends for top 5
    const top5Names = steamGames.slice(0, 5).map(g => g.name)
    const trendPoints = await getGoogleTrends(top5Names, 2840, 'en', 'past_30_days')
      .catch(err => {
        warnings.push(`DataForSEO Google Trends failed: ${err instanceof Error ? err.message : String(err)}`)
        return []
      })

    // 4. G2G recommended check via SEMrush
    const semrushKey = process.env.SEMRUSH_API_KEY ?? ''
    const recommendedSet = new Set<number>()
    if (semrushKey && semrushKey !== 'placeholder') {
      try {
        const params = new URLSearchParams({
          type: 'domain_organic',
          key:  semrushKey,
          domain: 'g2g.com',
          database: 'us',
          display_limit: '2000',
          display_sort:  'tr_desc',
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
            const hasRanking = g2gKeywords.some(kw =>
              kw.includes(nameLower) ||
              nameLower.includes(kw.replace(' buy', '').replace(' sell', ''))
            )
            if (hasRanking) recommendedSet.add(game.appid)
          }
        } else {
          warnings.push('SEMrush returned ERROR — skipping recommended check')
        }
      } catch (err) {
        warnings.push(`SEMrush enrichment failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 5. Build + upsert
    const rows = steamGames.map(game => {
      const volKey    = game.name.toLowerCase()
      const buyVolKey = `${game.name.toLowerCase()} buy`
      const trendForGame = trendPoints.map(p => ({
        date:  p.date,
        value: p.values[game.name] ?? 0,
      })).filter(p => p.value > 0)

      return {
        steam_appid:       game.appid,
        name:              game.name,
        developer:         game.developer,
        genre:             game.genre,
        players_2weeks:    game.players2weeks,
        players_forever:   game.playersForever,
        avg_playtime_2w:   game.avgPlaytime2w,
        search_volume:     volumeMap[volKey]    ?? 0,
        buy_search_volume: volumeMap[buyVolKey] ?? 0,
        search_trend:      trendForGame.length ? trendForGame : null,
        g2g_recommended:   recommendedSet.has(game.appid),
        g2g_position:      null,
        cached_at:         new Date().toISOString(),
      }
    })

    const { error: upsertErr } = await db
      .from('game_trends_cache')
      .upsert(rows, { onConflict: 'steam_appid' })

    if (upsertErr) {
      throw new Error(`game_trends_cache upsert failed: ${upsertErr.message}`)
    }

    const durationMs = Date.now() - startedAt
    return NextResponse.json({
      ok:           true,
      gamesRefreshed: rows.length,
      recommendedHits: recommendedSet.size,
      durationMs,
      warnings,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg, warnings }, { status: 500 })
  }
}
