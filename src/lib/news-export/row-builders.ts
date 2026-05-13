// ─── Row builders for the 3 export tabs ────────────────────────────────────
// Each builder queries the database, applies enrichments, and returns a
// 2D array of strings ready for Google Sheets. First row is always the header.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  sourceAuthority,
  importanceScore,
  trendDirection,
  actionSuggestion,
  gameBuzzScore,
} from './enrichment'

// ─── Common ────────────────────────────────────────────────────────────────

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return ''
  const t = s.trim()
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

function daysAgo(iso: string | null | undefined): number {
  if (!iso) return 999
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
}

// ─── Tab 1: Article × Game (flat detail) ───────────────────────────────────

export const ARTICLE_GAME_HEADER = [
  'Date Published',
  'Date Detected',
  'Source',
  'Source Authority',
  'Article Title',
  'Article URL',
  'Excerpt',
  'Game Name',
  'News Type',
  'Mention Count',
  'KB Match',
  'Importance Score',
] as const

export async function buildArticleGameRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:      SupabaseClient<any, any, any>,
  ownerId: string,
  days:    number = 14,
): Promise<string[][]> {
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString()

  // Pull recent items
  const { data: items } = await db
    .from('news_items')
    .select('id, source_name, url, title, excerpt, published_at, fetched_at')
    .eq('owner_user_id', ownerId)
    .gte('fetched_at', sinceIso)
    .order('published_at', { ascending: false })
    .limit(1000)

  if (!items?.length) return [Array.from(ARTICLE_GAME_HEADER)]

  const itemIds = items.map(i => i.id)
  const { data: extractions } = await db
    .from('news_game_extractions')
    .select('news_item_id, game_name, news_type, mentions_count, kb_matched')
    .in('news_item_id', itemIds)

  // Map article → extractions
  const byItem = new Map<string, Array<{ game_name: string; news_type: string | null; mentions_count: number; kb_matched: boolean }>>()
  for (const e of extractions ?? []) {
    const arr = byItem.get(e.news_item_id) ?? []
    arr.push({
      game_name:      String(e.game_name),
      news_type:      e.news_type ? String(e.news_type) : null,
      mentions_count: Number(e.mentions_count ?? 1),
      kb_matched:     !!e.kb_matched,
    })
    byItem.set(e.news_item_id, arr)
  }

  const rows: string[][] = [Array.from(ARTICLE_GAME_HEADER)]

  for (const item of items) {
    const exts = byItem.get(item.id) ?? []
    // If no game extracted, still emit 1 row so the article isn't lost
    if (exts.length === 0) {
      rows.push([
        fmtDate(item.published_at),
        fmtDate(item.fetched_at),
        String(item.source_name ?? ''),
        String(sourceAuthority(item.source_name)),
        truncate(item.title, 300),
        String(item.url),
        truncate(item.excerpt, 200),
        '',                        // game name
        '',                        // news type
        '',                        // mention count
        '',                        // kb match
        '',                        // importance score
      ])
      continue
    }
    for (const ext of exts) {
      const score = importanceScore({
        sourceName:   item.source_name,
        mentionCount: ext.mentions_count,
        kbMatched:    ext.kb_matched,
        publishedAt:  item.published_at,
      })
      rows.push([
        fmtDate(item.published_at),
        fmtDate(item.fetched_at),
        String(item.source_name ?? ''),
        String(sourceAuthority(item.source_name)),
        truncate(item.title, 300),
        String(item.url),
        truncate(item.excerpt, 200),
        ext.game_name,
        ext.news_type ?? '',
        String(ext.mentions_count),
        ext.kb_matched ? 'Yes' : 'No',
        String(score),
      ])
    }
  }

  return rows
}

// ─── Tab 2: Game Rollup (1 row per game, agregat) ──────────────────────────

export const GAME_ROLLUP_HEADER = [
  'Game Name',
  'Article Count',
  'Articles vs Prev Week',
  'Trend Direction',
  'Sources Cited',
  'Avg Source Authority',
  'News Type Breakdown',
  'Latest Article Date',
  'Days Since Latest',
  'Latest Headlines (top 3)',
  'KB Match',
  'G2G Product?',
  'G2G Relation ID',
  'Buzz Score',
  'Action Suggestion',
  'Action Reason',
] as const

export async function buildGameRollupRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
  days:     number = 14,
): Promise<string[][]> {
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString()
  const prevSinceIso = new Date(Date.now() - days * 2 * 86_400_000).toISOString()

  // Pull items + extractions for the CURRENT window
  const { data: currItems } = await db
    .from('news_items')
    .select('id, source_name, title, published_at')
    .eq('owner_user_id', ownerId)
    .gte('fetched_at', sinceIso)

  // Pull extractions for current window
  const currIds = (currItems ?? []).map(i => i.id)
  const { data: currExts } = currIds.length
    ? await db.from('news_game_extractions')
        .select('news_item_id, game_name, game_name_norm, news_type, kb_matched')
        .in('news_item_id', currIds)
    : { data: [] as Array<Record<string, unknown>> }

  // Previous-window for trend direction
  const { data: prevItems } = await db
    .from('news_items')
    .select('id')
    .eq('owner_user_id', ownerId)
    .gte('fetched_at', prevSinceIso)
    .lt('fetched_at', sinceIso)
  const prevIds = (prevItems ?? []).map((i: { id: string }) => i.id)
  const { data: prevExts } = prevIds.length
    ? await db.from('news_game_extractions')
        .select('game_name_norm')
        .in('news_item_id', prevIds)
    : { data: [] as Array<{ game_name_norm: string }> }

  const prevCountByGame = new Map<string, number>()
  for (const e of prevExts ?? []) {
    const k = String(e.game_name_norm)
    prevCountByGame.set(k, (prevCountByGame.get(k) ?? 0) + 1)
  }

  // Aggregate by game
  interface Bucket {
    game_name:       string
    game_name_norm:  string
    articles:        Set<string>
    sources:         Set<string>
    sourceAuthSum:   number
    sourceAuthN:     number
    types:           Record<string, number>
    kbMatched:       boolean
    latestPublished: string | null
    latestTitles:    { title: string; published: string | null }[]
  }
  const bucketByGame = new Map<string, Bucket>()
  const itemById = new Map((currItems ?? []).map(i => [i.id, i]))

  for (const e of currExts ?? []) {
    const norm = String(e.game_name_norm)
    let b = bucketByGame.get(norm)
    if (!b) {
      b = {
        game_name:       String(e.game_name),
        game_name_norm:  norm,
        articles:        new Set(),
        sources:         new Set(),
        sourceAuthSum:   0,
        sourceAuthN:     0,
        types:           {},
        kbMatched:       false,
        latestPublished: null,
        latestTitles:    [],
      }
      bucketByGame.set(norm, b)
    }
    const newsItemId = String(e.news_item_id)
    b.articles.add(newsItemId)
    if (e.kb_matched) b.kbMatched = true
    const type = e.news_type ? String(e.news_type) : 'other'
    b.types[type] = (b.types[type] ?? 0) + 1

    const item = itemById.get(newsItemId)
    if (item) {
      const src = String(item.source_name ?? '')
      if (src && !b.sources.has(src)) {
        b.sources.add(src)
        b.sourceAuthSum += sourceAuthority(src)
        b.sourceAuthN++
      }
      if (item.published_at && (!b.latestPublished || item.published_at > b.latestPublished)) {
        b.latestPublished = item.published_at
      }
      b.latestTitles.push({ title: String(item.title), published: item.published_at })
    }
  }

  // Cross-ref G2G catalog by fuzzy brand_name match
  const norms = Array.from(bucketByGame.keys())
  const { data: catalogRows } = norms.length
    ? await db
        .from('g2g_products')
        .select('relation_id, brand_name')
        .eq('is_active', true)
        .limit(2000)
    : { data: [] as Array<{ relation_id: string; brand_name: string }> }
  // Build a lowercased brand name → relation_id index
  const brandIndex = new Map<string, string>()
  for (const row of (catalogRows ?? []) as Array<{ relation_id: string; brand_name: string }>) {
    brandIndex.set(String(row.brand_name).toLowerCase(), String(row.relation_id))
  }

  const rows: string[][] = [Array.from(GAME_ROLLUP_HEADER)]

  for (const b of Array.from(bucketByGame.values()).sort((a, b2) => b2.articles.size - a.articles.size)) {
    const articleCount = b.articles.size
    const prevCount    = prevCountByGame.get(b.game_name_norm) ?? 0
    const arrow        = trendDirection(articleCount, prevCount)
    const avgAuth      = b.sourceAuthN > 0 ? b.sourceAuthSum / b.sourceAuthN : 0
    const buzz         = gameBuzzScore({
      articleCount,
      avgSourceAuth:     avgAuth,
      newsTypeBreakdown: b.types,
      kbMatched:         b.kbMatched,
    })

    // G2G coverage check: exact brand_name match (case-insensitive)
    const matchedRel = brandIndex.get(b.game_name.toLowerCase())
    const hasG2g = !!matchedRel

    const sinceLatest = daysAgo(b.latestPublished)
    const sug = actionSuggestion({ buzzScore: buzz, hasG2gCoverage: hasG2g, daysSinceLatest: sinceLatest })

    const latest3 = b.latestTitles
      .sort((x, y) => String(y.published ?? '').localeCompare(String(x.published ?? '')))
      .slice(0, 3)
      .map(t => `• ${t.title}`)
      .join('\n')

    const typeBreakdown = Object.entries(b.types)
      .sort((a, b2) => b2[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(', ')

    rows.push([
      b.game_name,
      String(articleCount),
      `${articleCount} (prev ${prevCount})`,
      arrow,
      Array.from(b.sources).join(', '),
      avgAuth.toFixed(1),
      typeBreakdown,
      fmtDate(b.latestPublished),
      String(sinceLatest),
      latest3,
      b.kbMatched ? 'Yes' : 'No',
      hasG2g ? 'Yes' : 'No',
      matchedRel ?? '',
      String(buzz),
      sug.action,
      sug.reason,
    ])
  }

  return rows
}

// ─── Tab 3: Game Trends (Odin / Steam data) ────────────────────────────────

export const GAME_TRENDS_HEADER = [
  'Game Name',
  'Steam AppID',
  'Developer',
  'Genre',
  'Players (2 weeks)',
  'Players (forever)',
  'Avg Playtime (2w)',
  'Search Volume (general)',
  'Search Volume (buy intent)',
  'Trend Direction (4w)',
  'G2G has Product?',
  'G2G Relation ID',
  'G2G Position',
  'Price (USD)',
  'Image URL',
  'Action Suggestion',
  'Action Reason',
] as const

// Note: game_trends_cache is brand-agnostic (Steam data shared across owners)
// so this builder doesn't need owner/site filters. When/if we per-tenant the
// cache, add those args back here.
export async function buildGameTrendsRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
): Promise<string[][]> {
  // game_trends_cache may or may not be scoped by owner; check both for safety
  const { data: trends } = await db
    .from('game_trends_cache')
    .select('*')
    .limit(500)

  if (!trends?.length) return [Array.from(GAME_TRENDS_HEADER)]

  // G2G catalog lookup
  const { data: catalogRows } = await db
    .from('g2g_products')
    .select('relation_id, brand_name')
    .eq('is_active', true)
    .limit(2000)
  const brandIndex = new Map<string, string>()
  for (const row of (catalogRows ?? []) as Array<{ relation_id: string; brand_name: string }>) {
    brandIndex.set(String(row.brand_name).toLowerCase(), String(row.relation_id))
  }

  const rows: string[][] = [Array.from(GAME_TRENDS_HEADER)]

  for (const t of trends) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trend = t as any
    const trendSeries: Array<{ date: string; value: number }> = Array.isArray(trend.search_trend) ? trend.search_trend : []
    // Trend direction = avg last 2 points vs avg first 2 points
    let trendArrow: '↑' | '↓' | '→' = '→'
    if (trendSeries.length >= 4) {
      const first = (trendSeries[0].value + trendSeries[1].value) / 2
      const last  = (trendSeries[trendSeries.length - 2].value + trendSeries[trendSeries.length - 1].value) / 2
      trendArrow = trendDirection(last, first)
    }

    const matchedRel = brandIndex.get(String(trend.name).toLowerCase())
    const hasG2g = !!matchedRel

    // Action: high search vol + no G2G → pitch; high vol + has G2G → optimize; low → ignore
    const sv = Number(trend.search_volume ?? 0)
    const buyVol = Number(trend.buy_search_volume ?? 0)
    let action: 'Pitch brief' | 'Monitor' | 'Ignore' = 'Ignore'
    let reason = 'Low search volume'
    if (sv >= 10000 && !hasG2g) {
      action = 'Pitch brief'
      reason = 'High SV + no G2G coverage'
    } else if (sv >= 5000 && hasG2g) {
      action = 'Pitch brief'
      reason = 'High SV on existing G2G product — refresh'
    } else if (buyVol >= 1000 && !hasG2g) {
      action = 'Pitch brief'
      reason = 'Buyer-intent SV signal'
    } else if (sv >= 2000) {
      action = 'Monitor'
      reason = 'Mid SV — watch for spike'
    }

    rows.push([
      String(trend.name ?? ''),
      String(trend.steam_appid ?? ''),
      String(trend.developer ?? ''),
      String(trend.genre ?? ''),
      String(trend.players_2weeks ?? ''),
      String(trend.players_forever ?? ''),
      String(trend.avg_playtime_2w ?? ''),
      String(sv),
      String(buyVol),
      trendArrow,
      hasG2g ? 'Yes' : 'No',
      matchedRel ?? '',
      String(trend.g2g_position ?? ''),
      String(trend.price ?? ''),
      String(trend.image_url ?? ''),
      action,
      reason,
    ])
  }

  return rows
}
