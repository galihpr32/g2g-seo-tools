/**
 * Bifrost — gaming news listener.
 *
 * Daily / 6-hourly cron:
 *   1. Seed default RSS sources (Tier 1) on first run for this owner.
 *   2. Fetch each active source's RSS feed, dedup new items into news_items.
 *   3. Run Haiku extraction on un-extracted items: pull game names + news_type.
 *   4. Match extracted games against Knowledge Base (categories) — flag matches.
 *   5. Aggregate over rolling 7-day window. When a game crosses the
 *      conservative threshold (≥3 articles + KB matched), queue an
 *      agent_action so Saga can pick it up into the pipeline.
 *
 * Cost-aware:
 *   - RSS fetching = free
 *   - Haiku extraction ≈ $0.001 per article (~50 articles/day = $1.50/month)
 *   - Hard cap on Haiku calls per run = 25 (set with BIFROST_MAX_EXTRACTIONS_PER_RUN)
 *   - FireCrawl is NOT called from here. The "deep dive" endpoint handles
 *     manual scrapes when the user wants richer content for one article.
 */

import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/service'
import { fetchRssFeed, type RssItem } from '@/lib/news/rss-parser'
import { logClaudeUsage } from '@/lib/api-logger'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const HAIKU = 'claude-haiku-4-5-20251001'

// Tier 1 default sources — created on first run if the owner has no
// news_sources rows yet. Users can add/disable these in the UI.
const TIER1_DEFAULTS = [
  { name: 'IGN',       rss_url: 'https://feeds.ign.com/ign/games-all',         homepage_url: 'https://www.ign.com',          category: 'general' },
  { name: 'Polygon',   rss_url: 'https://www.polygon.com/rss/index.xml',       homepage_url: 'https://www.polygon.com',      category: 'general' },
  { name: 'PC Gamer',  rss_url: 'https://www.pcgamer.com/rss/',                homepage_url: 'https://www.pcgamer.com',      category: 'general' },
  { name: 'Eurogamer', rss_url: 'https://www.eurogamer.net/?format=rss',       homepage_url: 'https://www.eurogamer.net',    category: 'general' },
  { name: 'Game Rant', rss_url: 'https://gamerant.com/feed/',                  homepage_url: 'https://gamerant.com',         category: 'general' },
] as const

const HAIKU_MAX_TOKENS                    = 800
const BIFROST_MAX_EXTRACTIONS_PER_RUN     = 25     // hard cap to enforce $5/month budget
const SIGNAL_THRESHOLD_ARTICLES           = 3      // conservative: ≥3 articles in 7d
const SIGNAL_LOOKBACK_DAYS                = 7

// ─── Game extraction tool schema ──────────────────────────────────────────────
interface ExtractedGame {
  game_name:      string
  news_type:      string   // release | event | update | esports | leak | review | sale | other
  mentions_count: number
}

const extractTool: Anthropic.Tool = {
  name: 'submit_game_extractions',
  description: 'Submit the games mentioned in the article + the type of news.',
  input_schema: {
    type: 'object',
    properties: {
      games: {
        type: 'array',
        description: 'Each unique game / franchise mentioned in the article. Empty array if no games are mentioned (e.g. industry-only news, hardware reviews). DO NOT invent games not in the text.',
        items: {
          type: 'object',
          properties: {
            game_name:      { type: 'string', description: 'Canonical game / franchise name (e.g. "Helldivers 2", "Marvel Rivals", "Genshin Impact"). Trim spin-off / version qualifiers when same franchise (e.g. "Pokémon" not "Pokémon Scarlet").' },
            news_type:      { type: 'string', enum: ['release', 'event', 'update', 'esports', 'leak', 'review', 'sale', 'other'], description: 'release = new game/DLC launch. event = live event/season/tournament. update = patch/balance change. esports = competition/tournament. leak = unofficial datamine. review = retail review/critique. sale = discount/promotion. other = doesnt fit.' },
            mentions_count: { type: 'integer', description: 'How many times this game is mentioned in the article (rough count; min 1).' },
          },
          required: ['game_name', 'news_type', 'mentions_count'],
        },
      },
    },
    required: ['games'],
  },
}

async function extractGamesFromArticle(
  db: ReturnType<typeof createServiceClient>,
  ownerId: string,
  item: { id: string; title: string; excerpt: string },
): Promise<{ ok: true; games: ExtractedGame[] } | { ok: false; error: string }> {
  const prompt = `Extract games mentioned in this gaming news article. Use the submit_game_extractions tool.

TITLE: ${item.title}

EXCERPT: ${item.excerpt || '(no excerpt — title only)'}

Return ONLY games actually named in the title or excerpt. If the article is about hardware, industry layoffs, or general topics with no specific game named, return games: [].`

  try {
    const response = await anthropic.messages.create({
      model:       HAIKU,
      max_tokens:  HAIKU_MAX_TOKENS,
      tools:       [extractTool],
      tool_choice: { type: 'tool', name: 'submit_game_extractions' },
      messages:    [{ role: 'user', content: prompt }],
    })

    logClaudeUsage(db, ownerId, {
      model:       HAIKU,
      endpoint:    'bifrost_extract',
      triggeredBy: 'agent_odin',     // closest existing trigger; Bifrost not yet a TriggerSource type value
      usage:       response.usage,
      extra:       { news_item_id: item.id },
    })

    const toolUse = response.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      return { ok: false, error: `Claude did not call submit_game_extractions (stop=${response.stop_reason})` }
    }

    const toolInput = toolUse.input as { games?: ExtractedGame[] }
    return { ok: true, games: (toolInput.games ?? []).slice(0, 10) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function normalizeGameName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// ─── Main runner ──────────────────────────────────────────────────────────────
export async function runBifrost(ownerId: string): Promise<{
  ok:           boolean
  summary:      string
  itemsNew:     number
  itemsExtracted: number
  actionsQueued: number
  warnings:     string[]
}> {
  const db = createServiceClient()
  const warnings: string[] = []
  const startedAt = new Date()

  // Open a run row for audit
  const { data: runRow } = await db
    .from('bifrost_runs')
    .insert({ owner_user_id: ownerId, started_at: startedAt.toISOString(), status: 'running' })
    .select('id')
    .single()
  const runId = runRow?.id as string | undefined

  // ── 1. Seed Tier 1 sources if owner has none ──────────────────────────────
  const { data: existingSources } = await db
    .from('news_sources')
    .select('id, name, rss_url, is_active, last_fetched_at')
    .eq('owner_user_id', ownerId)

  if (!existingSources || existingSources.length === 0) {
    const seeds = TIER1_DEFAULTS.map(s => ({
      owner_user_id: ownerId,
      name:          s.name,
      rss_url:       s.rss_url,
      homepage_url:  s.homepage_url,
      category:      s.category,
      is_active:     true,
    }))
    await db.from('news_sources').insert(seeds)
  }

  const { data: activeSources } = await db
    .from('news_sources')
    .select('id, name, rss_url, last_fetched_at')
    .eq('owner_user_id', ownerId)
    .eq('is_active', true)

  const sources = activeSources ?? []
  let itemsNew      = 0
  let itemsExtracted = 0
  let actionsQueued = 0

  // ── 2. Pull RSS for each active source ────────────────────────────────────
  const allNewItems: Array<{ id: string; title: string; excerpt: string }> = []

  for (const src of sources) {
    const items: RssItem[] | null = await fetchRssFeed(src.rss_url, 30)
    if (!items) {
      warnings.push(`${src.name}: RSS fetch failed`)
      continue
    }

    // Dedup by URL (insert-many with conflict-ignore)
    const rows = items.map(it => ({
      owner_user_id:      ownerId,
      source_id:          src.id,
      source_name:        src.name,
      url:                it.link,
      title:              it.title,
      excerpt:            it.description,
      published_at:       it.pubDate,
      extraction_status:  'pending' as const,
    }))

    // Use upsert with ignoreDuplicates pattern (PostgREST supports onConflict + ignoreDuplicates)
    const { data: inserted, error: insertErr } = await db
      .from('news_items')
      .upsert(rows, { onConflict: 'owner_user_id,url', ignoreDuplicates: true })
      .select('id, title, excerpt')

    if (insertErr) {
      warnings.push(`${src.name}: insert failed: ${insertErr.message}`)
      continue
    }

    if (inserted) {
      itemsNew += inserted.length
      // Only NEW (just-inserted) rows are returned when ignoreDuplicates is true.
      for (const r of inserted) allNewItems.push({ id: r.id, title: r.title, excerpt: r.excerpt ?? '' })
    }

    await db
      .from('news_sources')
      .update({
        last_fetched_at: new Date().toISOString(),
        last_item_count: items.length,
        updated_at:      new Date().toISOString(),
      })
      .eq('id', src.id)
  }

  // ── 3. Run Haiku extraction on pending items (cap to BUDGET) ──────────────
  // Pull pending items (the just-inserted batch may be partial, so requery
  // by status for cross-run resilience — if a previous run got cut short,
  // it'll resume here).
  const { data: pendingItems } = await db
    .from('news_items')
    .select('id, title, excerpt')
    .eq('owner_user_id', ownerId)
    .eq('extraction_status', 'pending')
    .order('published_at', { ascending: false })
    .limit(BIFROST_MAX_EXTRACTIONS_PER_RUN)

  for (const item of pendingItems ?? []) {
    const result = await extractGamesFromArticle(db, ownerId, item)
    if (!result.ok) {
      await db
        .from('news_items')
        .update({ extraction_status: 'failed', extraction_error: result.error })
        .eq('id', item.id)
      warnings.push(`Extraction failed for "${item.title.slice(0, 60)}…": ${result.error}`)
      continue
    }

    // Persist extractions
    if (result.games.length > 0) {
      const extractionRows = result.games.map(g => ({
        owner_user_id:   ownerId,
        news_item_id:    item.id,
        game_name:       g.game_name,
        game_name_norm:  normalizeGameName(g.game_name),
        news_type:       g.news_type,
        mentions_count:  g.mentions_count,
        kb_matched:      false,    // populated next
        kb_category_id:  null,
      }))

      await db
        .from('news_game_extractions')
        .upsert(extractionRows, { onConflict: 'news_item_id,game_name_norm' })

      // Mark KB matches
      const norms = Array.from(new Set(extractionRows.map(r => r.game_name_norm)))
      if (norms.length > 0) {
        const { data: kbItems } = await db
          .from('knowledge_base_items')
          .select('id, name')
          .eq('owner_user_id', ownerId)
          .eq('category', 'category')
        for (const kb of kbItems ?? []) {
          const kbNorm = normalizeGameName(String(kb.name ?? ''))
          if (norms.includes(kbNorm)) {
            await db
              .from('news_game_extractions')
              .update({ kb_matched: true, kb_category_id: kb.id })
              .eq('news_item_id', item.id)
              .eq('game_name_norm', kbNorm)
          }
        }
      }
    }

    await db
      .from('news_items')
      .update({ extraction_status: 'done' })
      .eq('id', item.id)
    itemsExtracted++
  }

  // ── 4. Threshold scan: queue agent_actions for games crossing threshold ───
  // For each game with ≥3 articles in last 7d AND kb_matched=true, queue ONE
  // agent_action (idempotent — skip if we already queued in last 24h).
  const cutoff = new Date(Date.now() - SIGNAL_LOOKBACK_DAYS * 86400000).toISOString()
  const { data: hotExtractions } = await db
    .from('news_game_extractions')
    .select('game_name, game_name_norm, news_type, kb_matched, kb_category_id, news_item_id, created_at')
    .eq('owner_user_id', ownerId)
    .eq('kb_matched', true)
    .gte('created_at', cutoff)

  const byGame = new Map<string, {
    name: string; types: Map<string, number>; articleCount: number; categoryId: string | null
  }>()
  for (const e of hotExtractions ?? []) {
    const key = e.game_name_norm
    const cur = byGame.get(key) ?? { name: e.game_name, types: new Map(), articleCount: 0, categoryId: e.kb_category_id }
    cur.articleCount++
    cur.types.set(e.news_type ?? 'other', (cur.types.get(e.news_type ?? 'other') ?? 0) + 1)
    byGame.set(key, cur)
  }

  // Recent Bifrost-queued actions to avoid duplicate notifications within 24h
  const dedupeCutoff = new Date(Date.now() - 24 * 86400000 / 24).toISOString()
  const { data: recentActions } = await db
    .from('agent_actions')
    .select('data')
    .eq('owner_user_id', ownerId)
    .eq('agent_key', 'odin')          // we stamp Bifrost actions as agent_key='odin' with source flag
    .gte('created_at', dedupeCutoff)
  const recentGameKeys = new Set<string>()
  for (const a of recentActions ?? []) {
    const d = a.data as { source?: string; game_name_norm?: string }
    if (d?.source === 'bifrost' && d.game_name_norm) recentGameKeys.add(d.game_name_norm)
  }

  for (const [norm, info] of byGame) {
    if (info.articleCount < SIGNAL_THRESHOLD_ARTICLES) continue
    if (recentGameKeys.has(norm)) continue   // already queued today

    const dominantType = [...info.types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other'
    const description  = `Bifrost detected ${info.articleCount} articles about ${info.name} in the last ${SIGNAL_LOOKBACK_DAYS} days (dominant news type: ${dominantType}). Active editorial buzz suggests rising commercial intent.`

    const { error: insertErr } = await db
      .from('agent_actions')
      .insert({
        owner_user_id: ownerId,
        agent_key:     'odin',                   // re-use odin slot — bifrost source flag in data
        site_slug:     'g2g',
        action_type:   'add_action_item',
        title:         `📰 News buzz: ${info.name} — ${info.articleCount} articles in ${SIGNAL_LOOKBACK_DAYS}d`,
        description,
        priority:      info.articleCount >= 5 ? 'high' : 'medium',
        data: {
          source:           'bifrost',
          game_name:        info.name,
          game_name_norm:   norm,
          news_type:        dominantType,
          article_count:    info.articleCount,
          news_type_breakdown: Object.fromEntries(info.types),
          kb_category_id:   info.categoryId,
          lookback_days:    SIGNAL_LOOKBACK_DAYS,
          handoff_to:       'bragi',
          payload: {
            keyword:        info.name.toLowerCase(),
            page_url:       null,
            search_volume:  null,
            source_agent:   'bifrost',
            brief_type:     'category_page',
            context:        `Bifrost news buzz: ${info.articleCount} articles in 7d, dominant type: ${dominantType}`,
          },
        },
      })

    if (insertErr) {
      warnings.push(`Action queue failed for "${info.name}": ${insertErr.message}`)
    } else {
      actionsQueued++
    }
  }

  // ── 5. Close run row ──────────────────────────────────────────────────────
  const summary = `Polled ${sources.length} source${sources.length !== 1 ? 's' : ''}. ` +
                  `${itemsNew} new article${itemsNew !== 1 ? 's' : ''} ingested. ` +
                  `${itemsExtracted} extracted via Haiku. ` +
                  `${actionsQueued} game${actionsQueued !== 1 ? 's' : ''} queued to pipeline.` +
                  (warnings.length ? ` ${warnings.length} warning${warnings.length !== 1 ? 's' : ''}.` : '')

  if (runId) {
    await db
      .from('bifrost_runs')
      .update({
        finished_at:     new Date().toISOString(),
        status:          warnings.length === 0 ? 'success' : 'partial',
        sources_polled:  sources.length,
        items_new:       itemsNew,
        items_extracted: itemsExtracted,
        actions_queued:  actionsQueued,
        warnings,
        summary,
      })
      .eq('id', runId)
  }

  return { ok: true, summary, itemsNew, itemsExtracted, actionsQueued, warnings }
}
