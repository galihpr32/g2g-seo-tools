import { createServiceClient } from '@/lib/supabase/service'
import { slugify } from '@/lib/agents/site-helpers'

/**
 * Saga Aggregator — Signal Grouping Engine
 *
 * Runs automatically after Detection agents (Heimdall / Loki / Odin) complete.
 * Groups their agent_actions by derived topic_slug and upserts into
 * `seo_opportunities` — the central pipeline entity.
 *
 * Design principles:
 *  - Idempotent: each action_id appears at most once per signal array
 *  - Non-destructive: only appends new signals, never removes existing ones
 *  - Fast: one bulk read of existing opps, then individual upserts (Supabase
 *    doesn't support JSONB-aware bulk upsert, so we loop — acceptable for
 *    the typical run size of ~50–200 actions)
 *
 * Topic slug derivation:
 *  - Heimdall: URL path segment after /categories/ (e.g. "fortnite")
 *  - Loki: keyword slugified (e.g. "fortnite-v-bucks")
 *  - Odin: game_name slugified (e.g. "fortnite")
 *
 * Signals from multiple agents for the same slug accumulate on one row so
 * the Opportunities page can show "⚠️ Heimdall + 🔍 Loki both flagged Fortnite"
 * and let the user pick the next action (brief, outreach, dismiss).
 */

export interface AggregatorResult {
  opportunitiesCreated: number
  opportunitiesUpdated: number
  opportunitiesSkipped: number   // skipped by dedup window (already worked recently)
  signalsProcessed:     number
  summary:              string
}

interface SignalEntry {
  action_id:  string
  agent_key:  string
  created_at: string
  [key: string]: unknown
}

interface OpportunityRow {
  id:               string
  topic:            string
  topic_slug:       string
  target_url:       string | null
  heimdall_signals: SignalEntry[]
  loki_signals:     SignalEntry[]
  odin_signals:     SignalEntry[]
  signal_count:     number
  total_sv:         number
  status:           string
  updated_at:       string
}

// ── Dedup window config ──────────────────────────────────────────────────────
// Controls how long an opp's last status protects it from re-detection. After
// this window, fresh signals can re-create the opp (re-rank-drop / re-trend).
const DEDUP_WINDOW_DAYS = {
  published:  30,   // already shipped → don't surface for 30d (gives time to measure)
  dismissed:  7,    // user said no → respect that for a week, then can re-surface
}

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000
}

// ── Topic slug derivation ────────────────────────────────────────────────────

/**
 * Extract a topic slug from a Heimdall URL.
 *   "https://g2g.com/categories/fortnite"   → "fortnite"
 *   "https://g2g.com/categories/wow-gold/"  → "wow-gold"
 *   "/categories/roblox-robux"              → "roblox-robux"
 */
function topicSlugFromUrl(url: string): string | null {
  const parts = url
    .replace(/^https?:\/\/[^/]+/, '')  // strip origin
    .split('/')
    .filter(Boolean)

  // Prefer the segment immediately after "categories"
  const catIdx = parts.indexOf('categories')
  const segment = catIdx >= 0 && parts[catIdx + 1]
    ? parts[catIdx + 1]
    : parts[parts.length - 1]

  return segment ? segment.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') : null
}

/**
 * Convert a slug back to a display topic name.
 *   "fortnite-v-bucks" → "Fortnite V-bucks"
 */
function topicFromSlug(slug: string): string {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// ── Signal deduplication ────────────────────────────────────────────────────

/**
 * Merge incoming signals into existing array, deduplicating by action_id.
 */
function mergeSignals(existing: SignalEntry[], incoming: SignalEntry[]): SignalEntry[] {
  if (!incoming.length) return existing
  const seenIds = new Set(existing.map(s => s.action_id))
  const fresh   = incoming.filter(s => !seenIds.has(s.action_id))
  return fresh.length ? [...existing, ...fresh] : existing
}

// ── Main aggregator ─────────────────────────────────────────────────────────

export async function runSagaAggregator(
  ownerId:     string,
  siteSlug:    string,
  windowHours: number = 72,   // look back 3 days by default
): Promise<AggregatorResult> {
  const db      = createServiceClient()
  const sinceIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()

  // ── 1. Pull recent detection signals ──────────────────────────────────────
  const { data: actions, error: actErr } = await db
    .from('agent_actions')
    .select('id, agent_key, action_type, data, created_at')
    .eq('owner_user_id', ownerId)
    .in('agent_key', ['heimdall', 'loki', 'odin'])
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })

  if (actErr) throw new Error(`Saga aggregator: agent_actions query failed: ${actErr.message}`)

  const rawActions = (actions ?? []) as Array<{
    id:          string
    agent_key:   string
    action_type: string
    data:        Record<string, unknown> | null
    created_at:  string
  }>

  if (rawActions.length === 0) {
    return { opportunitiesCreated: 0, opportunitiesUpdated: 0, opportunitiesSkipped: 0, signalsProcessed: 0, summary: 'No recent signals to aggregate.' }
  }

  // ── 2. Derive topic_slug per action and group ─────────────────────────────
  interface TopicGroup {
    topic:            string
    topic_slug:       string
    target_url:       string | null
    heimdallSignals:  SignalEntry[]
    lokiSignals:      SignalEntry[]
    odinSignals:      SignalEntry[]
    totalSv:          number
  }

  const groups = new Map<string, TopicGroup>()

  for (const action of rawActions) {
    const d          = action.data ?? {}
    let   topicSlug: string | null = null
    let   topic:     string | null = null
    let   targetUrl: string | null = null

    if (action.agent_key === 'heimdall') {
      const page = String(d.page ?? '')
      if (!page) continue
      topicSlug = topicSlugFromUrl(page)
      topic     = topicSlug ? topicFromSlug(topicSlug) : null
      targetUrl = page

    } else if (action.agent_key === 'loki') {
      const kw = String(d.keyword ?? '')
      if (!kw) continue
      topicSlug = slugify(kw)
      topic     = kw.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

    } else if (action.agent_key === 'odin') {
      const game = String(d.game_name ?? '')
      if (!game) continue
      topicSlug = slugify(game)
      topic     = game
    }

    if (!topicSlug || !topic) continue

    const group = groups.get(topicSlug) ?? {
      topic,
      topic_slug:      topicSlug,
      target_url:      targetUrl,
      heimdallSignals: [],
      lokiSignals:     [],
      odinSignals:     [],
      totalSv:         0,
    }

    const signal: SignalEntry = {
      action_id:  action.id,
      agent_key:  action.agent_key,
      created_at: action.created_at,
      ...d,
    }

    if      (action.agent_key === 'heimdall') group.heimdallSignals.push(signal)
    else if (action.agent_key === 'loki')     group.lokiSignals.push(signal)
    else if (action.agent_key === 'odin')     group.odinSignals.push(signal)

    // Track max search volume seen across signals for this topic
    const sv = Number(d.search_volume ?? 0)
    if (sv > group.totalSv) group.totalSv = sv

    // Prefer Heimdall URL as canonical target (has a concrete page to fix)
    if (!group.target_url && targetUrl) group.target_url = targetUrl

    groups.set(topicSlug, group)
  }

  if (groups.size === 0) {
    return { opportunitiesCreated: 0, opportunitiesUpdated: 0, opportunitiesSkipped: 0, signalsProcessed: rawActions.length, summary: 'Signals processed but no valid topics derived.' }
  }

  // ── 3. Fetch existing opportunities to merge into ─────────────────────────
  const { data: existingRows } = await db
    .from('seo_opportunities')
    .select('id, topic_slug, target_url, heimdall_signals, loki_signals, odin_signals, signal_count, total_sv, status, updated_at')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .in('topic_slug', Array.from(groups.keys()))

  const existingBySlug = new Map(
    ((existingRows ?? []) as OpportunityRow[]).map(o => [o.topic_slug, o])
  )

  // ── 4. Upsert each group ──────────────────────────────────────────────────
  let opportunitiesCreated = 0
  let opportunitiesUpdated = 0
  let opportunitiesSkipped = 0   // dedup
  const now = new Date().toISOString()

  for (const [topicSlug, group] of groups.entries()) {
    let existing = existingBySlug.get(topicSlug)

    // ── Dedup window ─────────────────────────────────────────────────────
    // If the topic was recently 'published' or 'dismissed', skip merging /
    // recreating. After the window, fresh signals are allowed to re-detect
    // by treating the existing row as if it didn't exist (creates a new opp).
    if (existing) {
      const ageDays = daysSince(existing.updated_at)
      if (existing.status === 'published' && ageDays < DEDUP_WINDOW_DAYS.published) {
        console.log(`[saga/aggregator] dedup skip: ${topicSlug} published ${ageDays.toFixed(1)}d ago`)
        opportunitiesSkipped++
        continue
      }
      if (existing.status === 'dismissed' && ageDays < DEDUP_WINDOW_DAYS.dismissed) {
        console.log(`[saga/aggregator] dedup skip: ${topicSlug} dismissed ${ageDays.toFixed(1)}d ago`)
        opportunitiesSkipped++
        continue
      }
      // Past the window — re-detect by creating a NEW opp. We clear `existing`
      // so the merge branch falls through to the insert branch below.
      if (existing.status === 'published' || existing.status === 'dismissed') {
        console.log(`[saga/aggregator] dedup expired: ${topicSlug} (${existing.status}, ${ageDays.toFixed(1)}d) — re-detecting as new opp`)
        existing = undefined
      }
    }

    if (existing) {
      // Merge — preserve existing signals, append only new ones
      const mergedHeimdall = mergeSignals(existing.heimdall_signals ?? [], group.heimdallSignals)
      const mergedLoki     = mergeSignals(existing.loki_signals     ?? [], group.lokiSignals)
      const mergedOdin     = mergeSignals(existing.odin_signals     ?? [], group.odinSignals)
      const totalSignals   = mergedHeimdall.length + mergedLoki.length + mergedOdin.length

      // Only update if we actually added new signals
      const newSignalCount = totalSignals - (existing.signal_count ?? 0)
      if (newSignalCount <= 0) continue

      const { error: updErr } = await db
        .from('seo_opportunities')
        .update({
          heimdall_signals: mergedHeimdall,
          loki_signals:     mergedLoki,
          odin_signals:     mergedOdin,
          signal_count:     totalSignals,
          total_sv:         Math.max(existing.total_sv ?? 0, group.totalSv),
          target_url:       existing.target_url ?? group.target_url ?? null,
          updated_at:       now,
          last_signal_at:   now,
        })
        .eq('id', existing.id)

      if (!updErr) opportunitiesUpdated++

    } else {
      // Insert fresh opportunity
      const totalSignals = group.heimdallSignals.length + group.lokiSignals.length + group.odinSignals.length

      const { error: insErr } = await db
        .from('seo_opportunities')
        .insert({
          owner_user_id:    ownerId,
          site_slug:        siteSlug,
          topic:            group.topic,
          topic_slug:       topicSlug,
          target_url:       group.target_url,
          heimdall_signals: group.heimdallSignals,
          loki_signals:     group.lokiSignals,
          odin_signals:     group.odinSignals,
          keyword_universe: [],
          signal_count:     totalSignals,
          total_sv:         group.totalSv,
          status:           'new',
          created_at:       now,
          updated_at:       now,
          last_signal_at:   now,
        })

      if (!insErr) opportunitiesCreated++
    }
  }

  const parts = [
    opportunitiesCreated > 0 ? `${opportunitiesCreated} new opportunit${opportunitiesCreated === 1 ? 'y' : 'ies'}` : null,
    opportunitiesUpdated > 0 ? `${opportunitiesUpdated} updated` : null,
    opportunitiesSkipped > 0 ? `${opportunitiesSkipped} skipped (recent work)` : null,
    `from ${rawActions.length} signals across ${groups.size} topics`,
  ].filter(Boolean)

  return {
    opportunitiesCreated,
    opportunitiesUpdated,
    opportunitiesSkipped,
    signalsProcessed: rawActions.length,
    summary: parts.join(' · ') || 'Nothing new to aggregate.',
  }
}
