import type { SupabaseClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { logClaudeUsage } from '@/lib/api-logger'

/**
 * Bifrost newsjacking classifier (Sprint 9.2)
 *
 * Bifrost surfaces gaming news with extracted game mentions. For outreach,
 * we want to know: which of these news items represent a "fresh hook" we
 * can pitch to outreach prospects targeting that game?
 *
 * Match heuristic:
 *  1. For each recent news_game_extraction (last 7d, kb_matched=true,
 *     news_type IN ('release','event','update','sale')) — these are the
 *     most newsjackable types
 *  2. Find outreach_prospects targeting matching topic / target_url that
 *     are status IN ('prospecting','contacted','negotiating')
 *  3. Tag prospect with `fresh_hook` JSONB pointing to the news item
 *
 * Haiku second-opinion: when ambiguous (e.g. "WoW expansion announcement"
 * matches both wow-gold and wow-boost prospects), Haiku picks the most
 * relevant or marks "skip — not a fit."
 *
 * Result: Specialist 2 sees "🔥 fresh hook: New WoW Patch dropped" inline
 * on the prospect card so they can prioritise sending NOW.
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = 'claude-haiku-4-5-20251001'

const NEWSJACKABLE_TYPES = new Set(['release', 'event', 'update', 'sale', 'esports', 'leak'])

interface FreshHook {
  news_item_id:    string
  news_url:        string
  title:           string
  game_name:       string
  news_type:       string
  hook_summary:    string  // Haiku one-liner
  matched_at:      string
}

export interface ClassifierResult {
  prospects_tagged:    number
  news_items_examined: number
  classifier_calls:    number
  warnings:            string[]
}

export async function runBifrostNewsjacker(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string
): Promise<ClassifierResult> {
  const result: ClassifierResult = {
    prospects_tagged:    0,
    news_items_examined: 0,
    classifier_calls:    0,
    warnings:            [],
  }

  // Pull recent KB-matched extractions
  const since = new Date(Date.now() - 7 * 86400_000).toISOString()
  const { data: extractions, error: exErr } = await db
    .from('news_game_extractions')
    .select(`
      id, news_item_id, game_name, game_name_norm, news_type, kb_matched,
      news_items!inner (id, title, url, published_at, excerpt)
    `)
    .eq('owner_user_id', ownerId)
    .eq('kb_matched', true)
    .gte('created_at', since)
    .limit(100)

  if (exErr) {
    result.warnings.push(`extractions query failed: ${exErr.message}`)
    return result
  }

  const candidates = (extractions ?? []).filter(e =>
    NEWSJACKABLE_TYPES.has(String(e.news_type ?? 'other'))
  )
  result.news_items_examined = candidates.length

  if (candidates.length === 0) return result

  // Pull active prospects
  const { data: prospects } = await db
    .from('outreach_prospects')
    .select('id, domain, topic, target_url, status, fresh_hook')
    .eq('owner_user_id', ownerId)
    .in('status', ['prospecting', 'contacted', 'negotiating', 'accepted'])
    .limit(500)

  if (!prospects?.length) return result

  // Match each candidate to prospects. Supabase typings represent the
  // joined `news_items` relation as an array even though it's 1:1 here, so
  // we normalise via unknown.
  for (const ex of candidates as unknown as Array<{
    id: string; news_item_id: string; game_name: string; game_name_norm: string;
    news_type: string;
    news_items: { id: string; title: string; url: string; published_at: string | null; excerpt: string | null }
                | Array<{ id: string; title: string; url: string; published_at: string | null; excerpt: string | null }>
  }>) {
    const ni = Array.isArray(ex.news_items) ? ex.news_items[0] : ex.news_items
    if (!ni) continue
    const gameKey = ex.game_name_norm.toLowerCase()

    const matches = (prospects as Array<{ id: string; topic: string | null; target_url: string | null; fresh_hook: unknown }>).filter(p => {
      const topicLow = String(p.topic ?? '').toLowerCase()
      const urlLow   = String(p.target_url ?? '').toLowerCase()
      return topicLow.includes(gameKey) || urlLow.includes(ex.game_name_norm)
    })

    if (matches.length === 0) continue

    // Haiku one-liner summary for the hook (single call covers all matches)
    let hookSummary: string
    try {
      hookSummary = await summariseHook(ni.title, ni.excerpt ?? '', ex.game_name, ex.news_type, db, ownerId, siteSlug)
      result.classifier_calls++
    } catch (err) {
      result.warnings.push(`Haiku summarise failed for "${ni.title}": ${err instanceof Error ? err.message : String(err)}`)
      hookSummary = `${ex.news_type} — ${ex.game_name}`
    }

    const hook: FreshHook = {
      news_item_id: ni.id,
      news_url:     ni.url,
      title:        ni.title,
      game_name:    ex.game_name,
      news_type:    ex.news_type,
      hook_summary: hookSummary,
      matched_at:   new Date().toISOString(),
    }

    // Tag each matching prospect — overwrite if older or same news_item
    for (const p of matches) {
      const existing = p.fresh_hook as FreshHook | null
      if (existing && existing.news_item_id === hook.news_item_id) continue   // already tagged with this hook
      const { error: updErr } = await db
        .from('outreach_prospects')
        .update({ fresh_hook: hook })
        .eq('id', p.id)
        .eq('owner_user_id', ownerId)
      if (!updErr) result.prospects_tagged++
      else result.warnings.push(`update prospect ${p.id} failed: ${updErr.message}`)
    }
  }

  return result
}

async function summariseHook(
  title:    string,
  excerpt:  string,
  game:     string,
  newsType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
): Promise<string> {
  const prompt = `You are turning a gaming news headline into a concise newsjacking hook for a marketplace SEO outreach pitch.

NEWS:
- Game: ${game}
- Type: ${newsType}
- Title: ${title}
- Excerpt: ${excerpt.slice(0, 400)}

Write ONE sentence (max 18 words) the outreach team can paste into an email subject line that references this news as a hook for backlink outreach. Don't start with "fresh hook" or any meta-prefix — just the hook itself.

Examples:
  - "New WoW Patch 11.0 just dropped — players are hunting for gold faster than ever"
  - "Steam Summer Sale starts Thursday — perfect time to reach buyers"
  - "League of Legends World Championship final this Saturday"

Output ONLY the hook sentence, nothing else.`

  const res = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: 80,
    messages:   [{ role: 'user', content: prompt }],
  })

  logClaudeUsage(db, ownerId, {
    model:       MODEL,
    endpoint:    'bifrost_newsjacking_summarise',
    triggeredBy: 'agent_hermod',
    usage:       res.usage,
    extra:       { game, news_type: newsType, site: siteSlug },
  })

  const text = res.content.find(b => b.type === 'text')
  if (!text || text.type !== 'text') return `${newsType} — ${game}`
  return text.text.trim().replace(/^["']+|["']+$/g, '').slice(0, 200)
}
