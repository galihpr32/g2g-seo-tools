import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * GET /api/news/items?days=14&kbMatchedOnly=true&source=…
 *
 * Returns recent news items + their game extractions. Used by the
 * "📰 News Signals" tab on /content/trends.
 *
 * Also returns aggregate "by-game" rollup so the UI can render the
 * "X articles in Yd → push to pipeline" cards without client-side counting.
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { searchParams } = new URL(request.url)
  const days           = Math.min(Math.max(parseInt(searchParams.get('days') ?? '14'), 1), 60)
  const kbMatchedOnly  = searchParams.get('kbMatchedOnly') === 'true'
  const sourceFilter   = searchParams.get('source')   // source name or null

  const sinceIso = new Date(Date.now() - days * 86400000).toISOString()

  // ── Items ──────────────────────────────────────────────────────────────────
  let itemsQ = db
    .from('news_items')
    .select('id, source_name, url, title, excerpt, published_at, fetched_at, scraped_at, scraped_word_count, extraction_status')
    .eq('owner_user_id', ownerId)
    .gte('fetched_at', sinceIso)
    .order('published_at', { ascending: false, nullsFirst: false })
    .order('fetched_at',   { ascending: false })
    .limit(200)

  if (sourceFilter) itemsQ = itemsQ.eq('source_name', sourceFilter)

  const { data: items, error: itemsErr } = await itemsQ
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 })

  // ── Extractions ────────────────────────────────────────────────────────────
  const itemIds = (items ?? []).map(i => i.id)
  let extractions: Array<{
    news_item_id: string; game_name: string; game_name_norm: string
    news_type: string | null; mentions_count: number; kb_matched: boolean
  }> = []
  if (itemIds.length > 0) {
    const { data: extRows } = await db
      .from('news_game_extractions')
      .select('news_item_id, game_name, game_name_norm, news_type, mentions_count, kb_matched')
      .eq('owner_user_id', ownerId)
      .in('news_item_id', itemIds)
    extractions = (extRows ?? []) as typeof extractions
  }

  // ── By-game rollup ─────────────────────────────────────────────────────────
  // Aggregate game mentions across the window. Optionally restrict to KB-
  // matched games (filters out generic mentions like "FIFA" that aren't in
  // our keyword universe).
  interface GameRollupEntry {
    game_name:         string
    game_name_norm:    string
    article_count:     number
    kb_matched:        boolean
    type_breakdown:    Record<string, number>
    latest_titles:     string[]
  }
  const byGame = new Map<string, GameRollupEntry>()
  for (const e of extractions) {
    if (kbMatchedOnly && !e.kb_matched) continue
    const cur = byGame.get(e.game_name_norm) ?? {
      game_name:      e.game_name,
      game_name_norm: e.game_name_norm,
      article_count:  0,
      kb_matched:     e.kb_matched,
      type_breakdown: {},
      latest_titles:  [],
    }
    cur.article_count++
    if (e.kb_matched) cur.kb_matched = true
    const t = e.news_type ?? 'other'
    cur.type_breakdown[t] = (cur.type_breakdown[t] ?? 0) + 1
    byGame.set(e.game_name_norm, cur)
  }

  // Attach 3 latest titles per game
  const itemsById = new Map((items ?? []).map(i => [i.id, i]))
  for (const e of extractions) {
    const cur = byGame.get(e.game_name_norm)
    if (!cur) continue
    if (cur.latest_titles.length >= 3) continue
    const item = itemsById.get(e.news_item_id)
    if (item?.title) cur.latest_titles.push(item.title)
  }

  const games = Array.from(byGame.values()).sort((a, b) => b.article_count - a.article_count)

  // ── Latest run summary ─────────────────────────────────────────────────────
  const { data: latestRun } = await db
    .from('bifrost_runs')
    .select('id, started_at, finished_at, status, sources_polled, items_new, items_extracted, actions_queued, summary')
    .eq('owner_user_id', ownerId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({
    items:       items ?? [],
    extractions,
    games,
    window_days: days,
    latestRun:   latestRun ?? null,
  })
}
