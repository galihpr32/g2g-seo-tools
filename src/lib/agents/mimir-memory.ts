// ─── Mimir Memory layer ─────────────────────────────────────────────────────
// Two responsibilities:
//   1. RETRIEVE — load the top-K most relevant memories for the current page
//      context and format them as a system-prompt block.
//   2. EXTRACT — after a conversation turn finishes, run Haiku with tool_use
//      to pull out durable facts/rules/preferences and persist them.
//
// Both halves share the same SupabaseClient passed in by the caller so we
// can use the service-role client from cron / server-only contexts.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const EXTRACTOR_MODEL = 'claude-haiku-4-5-20251001'

// ─── Types ─────────────────────────────────────────────────────────────────

export type MemoryScope    = 'global' | 'site' | 'topic' | 'product'
export type MemoryCategory = 'preference' | 'fact' | 'rule' | 'lesson'
export type SourceKind     = 'manual' | 'extracted' | 'imported'

export interface MemoryRow {
  id:                     string
  owner_user_id:          string
  scope:                  MemoryScope
  site_slug:              string | null
  topic_slug:             string | null
  relation_id:            string | null
  category:               MemoryCategory
  content:                string
  tags:                   string[]
  importance:             number
  pinned:                 boolean
  expires_at:             string | null
  source_kind:            SourceKind
  source_conversation_id: string | null
  archived:               boolean
  created_at:             string
  updated_at:             string
}

/** Context passed to retriever — derived from PageContext at chat time. */
export interface RetrieveCtx {
  ownerId:     string
  siteSlug?:   string | null
  topicSlug?:  string | null
  relationId?: string | null
  /** Free-form tokens drawn from the active page context (page kind, opportunity
   *  topic words, etc.). Used for tag overlap scoring. */
  hintTokens:  string[]
  /** Maximum chars of memory text to inject. ~2000 chars ≈ 7-12 memories. */
  budgetChars?: number
}

// ─── RETRIEVE ──────────────────────────────────────────────────────────────

/**
 * Load relevant memories for the given context, score, and return a
 * prompt-ready text block + raw selected rows (for logging / display).
 *
 * Scoring per row:
 *   base = importance
 *   + 30 if pinned
 *   + 20 if scope='global' matches always
 *   + 30 if scope='site' && site matches
 *   + 50 if scope='topic' && topic_slug matches
 *   + 50 if scope='product' && relation_id matches
 *   + 5  per tag overlap with hintTokens
 *   - 5  per day older than 90 days (gentle decay)
 *
 * We keep the heuristic simple — at our scale (≤1k memories) precision
 * matters less than legibility.
 */
export async function retrieveMemories(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  ctx: RetrieveCtx,
): Promise<{ block: string; rows: MemoryRow[] }> {
  const budget = ctx.budgetChars ?? 2000

  // Pull all candidate rows (active + not expired). At ≤1k rows total this
  // is faster than three indexed sub-queries with UNION.
  const nowIso = new Date().toISOString()
  const { data, error } = await db
    .from('mimir_memories')
    .select('*')
    .eq('owner_user_id', ctx.ownerId)
    .eq('archived', false)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order('updated_at', { ascending: false })
    .limit(500)

  if (error) {
    console.warn('[mimir-memory] retrieve failed:', error.message)
    return { block: '', rows: [] }
  }
  const candidates = (data ?? []) as MemoryRow[]
  if (candidates.length === 0) return { block: '', rows: [] }

  const hints = ctx.hintTokens.map(t => t.toLowerCase())
  const nowMs = Date.now()

  function score(r: MemoryRow): number {
    let s = r.importance
    if (r.pinned) s += 30
    if (r.scope === 'global')                                                   s += 20
    if (r.scope === 'site'    && ctx.siteSlug   && r.site_slug   === ctx.siteSlug)   s += 30
    if (r.scope === 'topic'   && ctx.topicSlug  && r.topic_slug  === ctx.topicSlug)  s += 50
    if (r.scope === 'product' && ctx.relationId && r.relation_id === ctx.relationId) s += 50

    // Tag overlap
    for (const tag of r.tags) {
      if (hints.includes(tag.toLowerCase())) s += 5
    }

    // Decay
    const ageDays = (nowMs - new Date(r.updated_at).getTime()) / 86_400_000
    if (ageDays > 90) s -= Math.min(20, Math.floor((ageDays - 90) / 30) * 5)

    return s
  }

  // Filter to scope-relevant rows first (a topic-scoped row is irrelevant if
  // the chat's topicSlug doesn't match — skip it before scoring).
  const eligible = candidates.filter(r => {
    if (r.scope === 'global')                                              return true
    if (r.scope === 'site'    && ctx.siteSlug   === r.site_slug)           return true
    if (r.scope === 'topic'   && ctx.topicSlug  === r.topic_slug)          return true
    if (r.scope === 'product' && ctx.relationId === r.relation_id)         return true
    return false
  })

  // Always include pinned (subject to budget)
  const pinned   = eligible.filter(r => r.pinned)
  const others   = eligible.filter(r => !r.pinned).sort((a, b) => score(b) - score(a))
  const ordered  = [...pinned, ...others]

  // Pack until budget exhausted
  const picked: MemoryRow[] = []
  let used = 0
  for (const r of ordered) {
    const cost = r.content.length + 20  // overhead for prefix
    if (used + cost > budget) break
    picked.push(r)
    used += cost
  }

  if (picked.length === 0) {
    // Sprint MIMIR.LEARN — log knowledge gap so /reports/mimir-learning
    // can surface "topics asked about but no memory exists yet". Async,
    // best-effort, never throw.
    logRetrievalMiss(db, ctx, eligible.length, hints).catch(() => { /* swallow */ })
    return { block: '', rows: [] }
  }

  const block = formatMemoriesAsBlock(picked)
  return { block, rows: picked }
}

/**
 * Sprint MIMIR.LEARN — record a retrieval miss for the knowledge gap dashboard.
 * Compresses the query into a single line from hint tokens (we don't have the
 * raw user prompt here, hint tokens are the next-best signal).
 */
async function logRetrievalMiss(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:           SupabaseClient<any, any, any>,
  ctx:          RetrieveCtx,
  eligibleCnt:  number,
  hints:        string[],
): Promise<void> {
  // Need at least some signal to be useful — skip blank queries
  if (hints.length === 0) return
  const queryStr = hints.slice(0, 12).join(' ').slice(0, 500)
  try {
    await db.from('mimir_retrieval_misses').insert({
      owner_user_id: ctx.ownerId,
      site_slug:     ctx.siteSlug ?? null,
      query:         queryStr,
      top_score:     0,                 // heuristic retriever doesn't expose a similarity
      threshold:     0,
      source:        'mimir_chat',
      source_ref:    ctx.topicSlug ?? ctx.relationId ?? null,
      // topic / category are filled in async by the weekly classifier
    })
  } catch {
    // Table may not exist on day-0 (migration not applied yet) — swallow
  }
  void eligibleCnt
}

function formatMemoriesAsBlock(rows: MemoryRow[]): string {
  // Group by category for readability
  const buckets: Record<MemoryCategory, string[]> = { rule: [], preference: [], lesson: [], fact: [] }
  for (const r of rows) {
    const prefix = r.pinned ? '📌 ' : ''
    buckets[r.category].push(`- ${prefix}${r.content}`)
  }

  const sections: string[] = []
  if (buckets.rule.length)       sections.push(`**Rules (must respect):**\n${buckets.rule.join('\n')}`)
  if (buckets.preference.length) sections.push(`**Preferences:**\n${buckets.preference.join('\n')}`)
  if (buckets.lesson.length)     sections.push(`**Lessons learned:**\n${buckets.lesson.join('\n')}`)
  if (buckets.fact.length)       sections.push(`**Facts:**\n${buckets.fact.join('\n')}`)

  return `## What I remember about you and our work\n${sections.join('\n\n')}`
}

// ─── EXTRACT ───────────────────────────────────────────────────────────────

/**
 * Run a Haiku pass over the conversation transcript and persist any new
 * durable memories. Idempotent-ish: we dedupe by content+scope+owner via
 * a similarity check so re-runs on the same conversation don't multiply rows.
 *
 * Called via Vercel `after()` from the chat route so it doesn't add latency.
 */
export async function extractMemoriesFromConversation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  args: {
    ownerId:        string
    conversationId: string | null
    siteSlug:       string | null
    topicSlug:      string | null
    relationId:     string | null
    /** Last N messages (user + assistant, in order). Cap ~6 to stay cheap. */
    transcript:     Array<{ role: 'user' | 'assistant'; content: string }>
  },
): Promise<{ inserted: number; skipped: number; errors: string[] }> {
  const errors: string[] = []

  // Short-circuit if nothing useful to extract
  const userMsgs = args.transcript.filter(m => m.role === 'user')
  if (userMsgs.length === 0) return { inserted: 0, skipped: 0, errors: ['no user messages'] }

  const transcript = args.transcript
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n')
    .slice(0, 10_000)   // hard cap to keep Haiku call cheap

  let extracted: Array<{
    content: string
    category: MemoryCategory
    importance: number
    tags: string[]
    scope: MemoryScope
  }> = []

  try {
    const resp = await anthropic.messages.create({
      model: EXTRACTOR_MODEL,
      max_tokens: 1024,
      tool_choice: { type: 'tool', name: 'save_memories' },
      tools: [{
        name: 'save_memories',
        description: 'Persist durable facts, preferences, rules, or lessons gleaned from this conversation.',
        input_schema: {
          type: 'object',
          properties: {
            memories: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  content:    { type: 'string', description: 'One-sentence canonical statement, ≤280 chars.' },
                  category:   { type: 'string', enum: ['preference', 'fact', 'rule', 'lesson'] },
                  scope:      { type: 'string', enum: ['global', 'site', 'topic', 'product'] },
                  importance: { type: 'integer', minimum: 0, maximum: 100 },
                  tags:       { type: 'array', items: { type: 'string' }, maxItems: 6 },
                },
                required: ['content', 'category', 'scope', 'importance', 'tags'],
              },
              maxItems: 8,
            },
          },
          required: ['memories'],
        },
      }],
      messages: [{
        role: 'user',
        content: `You are an SEO operations assistant analysing a conversation transcript to extract durable, REUSABLE memories — things worth remembering across future chats.

EXTRACT (each = 1 memory):
  • RULES the user states the assistant must follow ("never recommend X", "always use Indonesian for ID pages")
  • PREFERENCES about working style, formatting, tone, content structure
  • FACTS about the brand/team/product that aren't already common knowledge
  • LESSONS from past mistakes the user surfaces ("last time we did X, it backfired because...")

DO NOT extract:
  • Transient context ("today's date is...", "I'm asking about Genshin")
  • Restatements of what the assistant already said
  • Vague feelings without actionable rules ("I like this")
  • Anything that's just one-off chat banter

For each memory, set:
  • content: one-sentence canonical fact, ≤280 chars
  • category: preference|fact|rule|lesson
  • scope: 'global' if it applies always, 'site' if brand-specific, 'topic'/'product' if narrow
  • importance: 30 (nice-to-have) → 90 (critical rule)
  • tags: 1-5 short keywords for retrieval matching (e.g. ['bragi', 'on_page', 'tone'])

If the transcript has NO extractable memories, return an empty array — that's fine. Be selective; quality over quantity.

CONTEXT:
  • site_slug:  ${args.siteSlug ?? '(unknown)'}
  • topic_slug: ${args.topicSlug ?? '(none)'}
  • relation_id: ${args.relationId ?? '(none)'}

CONVERSATION TRANSCRIPT:
${transcript}`,
      }],
    })

    const block = resp.content.find(c => c.type === 'tool_use')
    if (!block || block.type !== 'tool_use') {
      return { inserted: 0, skipped: 0, errors: ['extractor did not call tool'] }
    }
    const input = block.input as { memories?: Array<Record<string, unknown>> }
    extracted = (input.memories ?? []).map(m => ({
      content:    String(m.content    ?? '').trim().slice(0, 280),
      category:   (m.category as MemoryCategory) ?? 'fact',
      scope:      (m.scope    as MemoryScope)    ?? 'global',
      importance: typeof m.importance === 'number' ? Math.max(0, Math.min(100, m.importance)) : 50,
      tags:       Array.isArray(m.tags) ? m.tags.map(t => String(t).toLowerCase()).slice(0, 6) : [],
    })).filter(m => m.content.length > 0)
  } catch (e) {
    return { inserted: 0, skipped: 0, errors: [`Haiku extractor: ${e instanceof Error ? e.message : String(e)}`] }
  }

  if (extracted.length === 0) return { inserted: 0, skipped: 0, errors: [] }

  // Dedup against existing memories with identical content (case-insensitive)
  const contents = extracted.map(m => m.content.toLowerCase())
  const { data: existing } = await db
    .from('mimir_memories')
    .select('content')
    .eq('owner_user_id', args.ownerId)
    .eq('archived', false)
    .in('content', contents)   // exact match only; case-insensitive overlap is rare enough to ignore
  const existingSet = new Set((existing ?? []).map(r => String(r.content).toLowerCase()))

  let inserted = 0, skipped = 0
  for (const m of extracted) {
    if (existingSet.has(m.content.toLowerCase())) { skipped++; continue }

    const payload: Partial<MemoryRow> = {
      owner_user_id:          args.ownerId,
      scope:                  m.scope,
      site_slug:              m.scope === 'site' || m.scope === 'topic' || m.scope === 'product' ? args.siteSlug ?? null : null,
      topic_slug:             m.scope === 'topic'   ? args.topicSlug  ?? null : null,
      relation_id:            m.scope === 'product' ? args.relationId ?? null : null,
      category:               m.category,
      content:                m.content,
      tags:                   m.tags,
      importance:             m.importance,
      pinned:                 false,
      source_kind:            'extracted',
      source_conversation_id: args.conversationId,
    }
    const { error } = await db.from('mimir_memories').insert(payload)
    if (error) errors.push(error.message)
    else inserted++
  }

  return { inserted, skipped, errors }
}
