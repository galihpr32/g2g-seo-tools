// ── Friday KPI action plan synthesizer ──────────────────────────────────────
//
// Sprint FRIDAY.KPI.GRAPH.2 — synthesizes 3 prioritized actions for "next week"
// by pulling signals from across the pantheon:
//
//   • Mimir memories     — recent high-importance lessons that need action
//   • Forseti threads    — sev-4+ unresolved community complaints
//   • Hugin queries      — top growing long-tail keywords to capture
//   • Loki findings      — competitive moves we're losing on
//   • SERP movers        — biggest position drops in tracked_keywords
//
// Each signal becomes a structured candidate. Haiku synthesizes 3 actions
// from the top candidates, citing which agent(s) flagged each one. Manual
// overrides via friday_kpi_action_overrides table take precedence.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

export interface ActionPlanItem {
  index:     number      // 0, 1, 2 — slot position
  text:      string      // the action sentence (manual override OR auto-synth)
  sources:   string[]    // agent names that contributed: 'mimir' | 'forseti' | 'hugin' | 'loki' | 'serp'
  is_manual: boolean     // true if overridden by user
}

export interface ActionPlanInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>
  ownerId:   string
  siteSlug:  string
  weekIso:   string       // '2026-W21'
}

// ─── Signal collectors ──────────────────────────────────────────────────────

interface Signal {
  source:   'mimir' | 'forseti' | 'hugin' | 'loki' | 'serp'
  weight:   number   // 1-10, higher = more urgent
  summary:  string   // 1-line summary for Haiku
  evidence: string   // extra context (cluster, product, query, etc.)
}

async function collectMimirSignals(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>, ownerId: string,
): Promise<Signal[]> {
  try {
    const { data } = await db
      .from('mimir_memories')
      .select('memory_type, summary, content, importance, category, product_name, created_at')
      .eq('owner_user_id', ownerId)
      .gte('importance', 7)
      .gte('created_at', new Date(Date.now() - 14 * 86_400_000).toISOString())
      .order('importance', { ascending: false })
      .limit(10)
    return (data ?? []).map(m => ({
      source:   'mimir' as const,
      weight:   Number(m.importance) || 5,
      summary:  String(m.summary ?? m.content ?? '').slice(0, 200),
      evidence: [m.memory_type, m.category, m.product_name].filter(Boolean).join(' · '),
    }))
  } catch { return [] }
}

async function collectForsetiSignals(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>, ownerId: string, siteSlug: string,
): Promise<Signal[]> {
  try {
    const { data } = await db
      .from('forseti_threads')
      .select('thread_title, auto_category, auto_severity, manual_severity_override, status, subreddit, op_post_score')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .in('status', ['spotted', 'awaiting_op'])
      .gte('first_seen_at', new Date(Date.now() - 7 * 86_400_000).toISOString())
      .limit(20)
    return (data ?? [])
      .filter(t => {
        const sev = t.manual_severity_override ?? t.auto_severity
        return sev >= 4
      })
      .map(t => ({
        source:   'forseti' as const,
        weight:   ((t.manual_severity_override ?? t.auto_severity) as number) + 3,
        summary:  String(t.thread_title ?? '').slice(0, 200),
        evidence: `r/${t.subreddit} · ${t.auto_category} · sev-${t.manual_severity_override ?? t.auto_severity}`,
      }))
  } catch { return [] }
}

async function collectHuginSignals(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>, ownerId: string, siteSlug: string,
): Promise<Signal[]> {
  try {
    const { data } = await db
      .from('hugin_queries')
      .select('query, growth_pct, total_impressions, status, period_days')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .eq('period_days', 30)
      .eq('status', 'discovered')
      .not('growth_pct', 'is', null)
      .gte('growth_pct', 50)
      .order('growth_pct', { ascending: false })
      .limit(10)
    return (data ?? []).map(h => ({
      source:   'hugin' as const,
      weight:   Math.min(10, Math.floor((h.growth_pct ?? 50) / 20) + 4),
      summary:  `"${h.query}" growing ${Math.round(h.growth_pct ?? 0)}% MoM (${h.total_impressions ?? 0} impressions)`,
      evidence: `long-tail · 30d period`,
    }))
  } catch { return [] }
}

async function collectSerpMovers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>, ownerId: string, siteSlug: string,
): Promise<Signal[]> {
  try {
    // Pull recent SERP snapshots, compare latest vs 14d ago for biggest drops
    const since = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10)
    const { data: snaps } = await db
      .from('tier_serp_snapshots')
      .select('product_tier_id, keyword, market, snapshot_date, our_position')
      .eq('owner_user_id', ownerId)
      .gte('snapshot_date', since)
      .order('snapshot_date', { ascending: false })
      .limit(2000)
    if (!snaps || snaps.length === 0) return []
    const { data: products } = await db
      .from('product_tiers')
      .select('id, product_name')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
    const nameById = new Map((products ?? []).map(p => [p.id, p.product_name as string]))

    type Bucket = { latest?: number; latestDate?: string; prior?: number }
    const buckets = new Map<string, Bucket>()
    for (const s of snaps) {
      const k = `${s.product_tier_id}|${s.keyword}|${s.market}`
      const b = buckets.get(k) ?? {}
      if (!b.latest && s.our_position) { b.latest = s.our_position; b.latestDate = s.snapshot_date }
      else if (b.latest && !b.prior && s.our_position && s.snapshot_date < (b.latestDate ?? '')) {
        b.prior = s.our_position
      }
      buckets.set(k, b)
    }
    const movers: Signal[] = []
    for (const [k, b] of buckets) {
      if (b.latest == null || b.prior == null) continue
      const delta = b.latest - b.prior   // positive = position got worse (dropped)
      if (delta < 3) continue   // only flag drops of 3+ positions
      const [pid, keyword, market] = k.split('|')
      const productName = nameById.get(pid) ?? '(unknown)'
      movers.push({
        source:   'serp',
        weight:   Math.min(10, 4 + Math.floor(delta / 3)),
        summary:  `"${keyword}" dropped ${Math.round(delta)} positions on ${productName} (${market})`,
        evidence: `${b.prior?.toFixed(1)} → ${b.latest?.toFixed(1)}`,
      })
    }
    return movers.sort((a, b) => b.weight - a.weight).slice(0, 8)
  } catch { return [] }
}

// ─── Haiku synthesizer ──────────────────────────────────────────────────────

async function synthesizeWithHaiku(signals: Signal[]): Promise<ActionPlanItem[]> {
  if (signals.length === 0) {
    return [
      { index: 0, text: 'No urgent signals detected this week. Focus on the existing roadmap.', sources: [], is_manual: false },
      { index: 1, text: 'Review the upcoming briefs queue for content opportunities.',         sources: [], is_manual: false },
      { index: 2, text: 'Audit Discovery mode for new untracked GSC queries worth claiming.', sources: [], is_manual: false },
    ]
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    // No Haiku — fallback: return top 3 signals as raw actions
    return signals.slice(0, 3).map((s, i) => ({
      index: i,
      text: `${s.summary} → investigate this week.`,
      sources: [s.source],
      is_manual: false,
    }))
  }
  const anthropic = new Anthropic({ apiKey })

  const signalsBlock = signals.slice(0, 15).map((s, i) =>
    `[${i + 1}] (${s.source}, weight ${s.weight}) ${s.summary} — ${s.evidence}`
  ).join('\n')

  const prompt = `You're a SEO ops analyst writing 3 action items for next week's stand-up.

You have ${signals.length} signals from various agents. Pick the TOP 3 that should drive action next week. For each, write ONE sentence (max 200 chars) that:
1. States the issue clearly
2. Cites the source(s) (e.g., "Loki flagged...", "Mimir notes...")
3. Includes a specific suggested action

Signals available:
${signalsBlock}

Output ONLY a JSON array of 3 objects: [{"text": "...", "sources": ["agent_name", ...]}]. Sources are from: mimir, forseti, hugin, loki, serp. Output JSON only, no prose.`

  try {
    const res = await anthropic.messages.create({
      model:       HAIKU_MODEL,
      max_tokens:  800,
      temperature: 0.4,
      messages:    [{ role: 'user', content: prompt }],
    })
    const text = res.content.find(c => c.type === 'text')?.text ?? '[]'
    const match = text.match(/\[[\s\S]*\]/)
    const parsed = match ? JSON.parse(match[0]) as Array<{ text: string; sources: string[] }> : []
    return parsed.slice(0, 3).map((p, i) => ({
      index:     i,
      text:      String(p.text ?? '').slice(0, 400),
      sources:   Array.isArray(p.sources) ? p.sources.slice(0, 5) : [],
      is_manual: false,
    }))
  } catch (err) {
    console.warn('[friday-kpi action synth] Haiku failed, using top-3 raw signals:', err instanceof Error ? err.message : String(err))
    return signals.slice(0, 3).map((s, i) => ({
      index: i,
      text: `${s.summary} → investigate this week.`,
      sources: [s.source],
      is_manual: false,
    }))
  }
}

// ─── Public entry ──────────────────────────────────────────────────────────

/**
 * Build the 3-item action plan for next week. Reads manual overrides first,
 * fills empty slots from Haiku synthesis of cross-agent signals.
 */
export async function buildActionPlan(input: ActionPlanInput): Promise<ActionPlanItem[]> {
  const { db, ownerId, siteSlug, weekIso } = input

  // 1. Manual overrides take precedence
  const { data: overrides } = await db
    .from('friday_kpi_action_overrides')
    .select('action_index, action_text')
    .eq('owner_user_id', ownerId)
    .eq('week_iso', weekIso)
    .eq('brand', siteSlug)
  const overrideMap = new Map<number, string>()
  for (const o of (overrides ?? [])) overrideMap.set(o.action_index as number, o.action_text as string)

  // 2. Collect signals from all agents in parallel
  const [mimirSig, forsetiSig, huginSig, serpSig] = await Promise.all([
    collectMimirSignals(db, ownerId),
    collectForsetiSignals(db, ownerId, siteSlug),
    collectHuginSignals(db, ownerId, siteSlug),
    collectSerpMovers(db, ownerId, siteSlug),
  ])
  const allSignals = [...mimirSig, ...forsetiSig, ...huginSig, ...serpSig]
    .sort((a, b) => b.weight - a.weight)

  // 3. Haiku synthesizes 3 actions
  const autoPlan = await synthesizeWithHaiku(allSignals)

  // 4. Merge: override > auto
  const plan: ActionPlanItem[] = []
  for (let i = 0; i < 3; i++) {
    const override = overrideMap.get(i)
    if (override) {
      plan.push({ index: i, text: override, sources: [], is_manual: true })
    } else {
      plan.push(autoPlan[i] ?? { index: i, text: '(no action)', sources: [], is_manual: false })
    }
  }
  return plan
}
