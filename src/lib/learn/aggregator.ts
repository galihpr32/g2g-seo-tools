// ─── Brief Review Learning Loop ─────────────────────────────────────────────
// Combines:
//   - Haiku classifier (Sprint LEARN.4): bucket reviewer freetext into known
//     reason categories
//   - Weekly aggregator (Sprint LEARN.5): cluster by bucket, propose KB rules
//   - Autopublish threshold recommender (Sprint LEARN.6): based on Tyr-score
//     distribution of human-approved briefs, suggest lower threshold

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = 'claude-haiku-4-5-20251001'

const REASON_BUCKETS = [
  'tone', 'factuality', 'structure', 'length', 'brand_voice',
  'forbidden_claim', 'keyword_intent', 'completeness', 'category_template',
  'other',
] as const
type Bucket = (typeof REASON_BUCKETS)[number]

// ─── 1. Classifier ──────────────────────────────────────────────────────────

export async function classifyUnclassifiedReasons(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:      SupabaseClient<any, any, any>,
  ownerId: string,
  maxRows: number = 50,
): Promise<{ classified: number; failed: number }> {
  const { data: rows } = await db
    .from('brief_review_feedback')
    .select('id, reason_freetext, diff_summary, section_label')
    .eq('owner_user_id', ownerId)
    .is('reason_classified', null)
    .not('reason_freetext', 'is', null)
    .order('created_at', { ascending: false })
    .limit(maxRows)

  if (!rows?.length) return { classified: 0, failed: 0 }

  let classified = 0, failed = 0
  for (const r of rows) {
    try {
      const bucket = await classifyOne(String(r.reason_freetext ?? ''), String(r.section_label ?? ''), String(r.diff_summary ?? ''))
      await db.from('brief_review_feedback').update({ reason_classified: bucket }).eq('id', r.id)
      classified++
    } catch {
      failed++
    }
  }
  return { classified, failed }
}

async function classifyOne(freetext: string, sectionLabel: string, diffSummary: string): Promise<Bucket> {
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 256,
    tool_choice: { type: 'tool', name: 'classify_reason' },
    tools: [{
      name: 'classify_reason',
      description: 'Classify a brief reviewer\'s edit reason into one bucket.',
      input_schema: {
        type: 'object',
        properties: {
          bucket: { type: 'string', enum: [...REASON_BUCKETS] },
        },
        required: ['bucket'],
      },
    }],
    messages: [{
      role: 'user',
      content: `Classify this brief edit reason into one bucket. Pick the single best match.

Buckets:
- tone: tone/style issue (commercial, formal, casual)
- factuality: factual claim wrong or unverified
- structure: section ordering/layout issue
- length: too long or too short
- brand_voice: doesn't match brand voice rules
- forbidden_claim: contains a banned claim (CS time, refund %, etc.)
- keyword_intent: target keyword has wrong intent for this page
- completeness: missing required info
- category_template: doesn't follow the category-specific template
- other: doesn't fit any of the above

SECTION: ${sectionLabel}
DIFF: ${diffSummary}
REVIEWER REASON: ${freetext}`,
    }],
  })

  const block = resp.content.find(c => c.type === 'tool_use')
  if (!block || block.type !== 'tool_use') return 'other'
  const input = block.input as { bucket?: string }
  const b = String(input.bucket ?? 'other').toLowerCase()
  return (REASON_BUCKETS as readonly string[]).includes(b) ? (b as Bucket) : 'other'
}

// ─── 2. Aggregator — proposes rules from clustered feedback ─────────────────

export interface AggregatorResult {
  proposals_created: number
  clusters_seen:     number
  feedback_scanned:  number
  errors:            string[]
}

export async function runLearningAggregator(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
  windowDays: number = 7,
): Promise<AggregatorResult> {
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString()

  // 1. Ensure classification is up to date for this owner
  await classifyUnclassifiedReasons(db, ownerId, 100)

  // 2. Pull classified feedback in window
  const { data: feedback } = await db
    .from('brief_review_feedback')
    .select('section_label, ai_version, human_version, diff_summary, reason_classified, severity, brief_id')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .gte('created_at', sinceIso)
    .not('reason_classified', 'is', null)
  const rows = feedback ?? []
  if (rows.length === 0) {
    return { proposals_created: 0, clusters_seen: 0, feedback_scanned: 0, errors: [] }
  }

  // 3. Cluster by reason_classified
  const clusters = new Map<string, typeof rows>()
  for (const r of rows) {
    const k = String(r.reason_classified ?? 'other')
    const arr = clusters.get(k) ?? []
    arr.push(r)
    clusters.set(k, arr)
  }

  const errors: string[] = []
  let proposalsCreated = 0

  for (const [bucket, items] of clusters) {
    // Skip thin clusters — not enough signal to propose a rule
    if (items.length < 2) continue
    try {
      const proposed = await proposeRuleFromCluster(bucket as Bucket, items)
      if (!proposed) continue

      const { error } = await db.from('kb_rule_proposals').insert({
        owner_user_id:    ownerId,
        site_slug:        siteSlug,
        title:            proposed.title,
        rule_text:        proposed.rule_text,
        pattern_kind:     proposed.pattern_kind,
        source:           'review_feedback',
        source_brief_ids: Array.from(new Set(items.map(i => String(i.brief_id)).filter(Boolean))),
        confidence:       proposed.confidence,
        status:           'pending',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      if (error) errors.push(`${bucket}: ${error.message}`)
      else proposalsCreated++
    } catch (e) {
      errors.push(`${bucket}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    proposals_created: proposalsCreated,
    clusters_seen:     clusters.size,
    feedback_scanned:  rows.length,
    errors,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function proposeRuleFromCluster(bucket: Bucket, items: any[]): Promise<{ title: string; rule_text: string; pattern_kind: string; confidence: number } | null> {
  // Compact representation: top 5 (ai → human) deltas for Haiku
  const samples = items.slice(0, 5).map(i => `[${i.section_label}] AI: "${(i.ai_version ?? '').slice(0, 200)}" → HUMAN: "${(i.human_version ?? '').slice(0, 200)}"`).join('\n\n')

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 768,
    tool_choice: { type: 'tool', name: 'propose_rule' },
    tools: [{
      name: 'propose_rule',
      description: 'Propose a KB rule based on a cluster of human edits.',
      input_schema: {
        type: 'object',
        properties: {
          title:        { type: 'string', description: 'Short rule title (≤80 chars).' },
          rule_text:    { type: 'string', description: '1-3 sentence rule the AI should follow next time.' },
          pattern_kind: { type: 'string', enum: ['winning', 'cautionary', 'exclusion', 'tone', 'format', 'generic'] },
          confidence:   { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: ['title', 'rule_text', 'pattern_kind', 'confidence'],
      },
    }],
    messages: [{
      role: 'user',
      content: `Below are ${items.length} cases where a human reviewer edited an AI-generated brief, all classified under bucket "${bucket}". Find the COMMON pattern and propose ONE KB rule that, if Bragi had followed it, would have prevented these edits.

Return propose_rule with:
- title: short summary
- rule_text: 1-3 sentence rule, written as instruction TO the AI (e.g. "When generating intro for {category}, lead with player value before mentioning the marketplace.")
- pattern_kind: 'cautionary' for "don't do X" rules, 'tone'/'format' for style, 'winning' for "always do X"
- confidence: 1-5 (5 = very strong signal, all samples agree)

If samples are too varied to find a clear pattern, return confidence ≤ 2.

SAMPLES:
${samples}`,
    }],
  })

  const block = resp.content.find(c => c.type === 'tool_use')
  if (!block || block.type !== 'tool_use') return null
  const input = block.input as { title?: string; rule_text?: string; pattern_kind?: string; confidence?: number }

  return {
    title:        String(input.title ?? '').slice(0, 80),
    rule_text:    String(input.rule_text ?? '').slice(0, 600),
    pattern_kind: String(input.pattern_kind ?? 'generic'),
    confidence:   Math.max(1, Math.min(5, Number(input.confidence ?? 1))),
  }
}

// ─── 3. Autopublish threshold recommender ───────────────────────────────────

export interface ThresholdRec {
  tier_level:        0 | 1 | 2
  current_threshold: number
  suggested_threshold: number | null
  approved_count:    number
  pass_pct_at_current: number
  pass_pct_at_suggested: number | null
  sample_window_days: number
  rationale:         string
}

export async function recommendAutopublishThresholds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
  windowDays: number = 30,
): Promise<ThresholdRec[]> {
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString()

  const { data: cfgs } = await db
    .from('tyr_autopublish_config')
    .select('tier_level, min_tyr_score')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tiers = (cfgs ?? []) as any[]

  const recs: ThresholdRec[] = []
  for (const cfg of tiers) {
    const tier = Number(cfg.tier_level) as 0 | 1 | 2
    const current = Number(cfg.min_tyr_score)

    // Pull all briefs in window that were human-approved (status published/reviewed/auto_approved)
    const { data: briefs } = await db
      .from('seo_content_briefs')
      .select('id, tyr_score, status')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .in('status', ['published', 'reviewed', 'auto_approved'])
      .gte('created_at', sinceIso)
      .not('tyr_score', 'is', null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = (briefs ?? []) as any[]

    if (list.length < 5) {
      recs.push({
        tier_level:           tier,
        current_threshold:    current,
        suggested_threshold:  null,
        approved_count:       list.length,
        pass_pct_at_current:  0,
        pass_pct_at_suggested: null,
        sample_window_days:   windowDays,
        rationale:            `Not enough samples yet (${list.length} approved briefs in ${windowDays}d, need ≥5)`,
      })
      continue
    }

    // Compute pass rate at current threshold
    const passNow = list.filter(b => Number(b.tyr_score) >= current).length
    const passPctNow = Math.round((passNow / list.length) * 100)

    // Try lower thresholds (5-point decrements) — pick the lowest that still
    // passes ≥90% of approved briefs. That's a safe "we can lower it" suggestion.
    let suggested: number | null = null
    let passAtSuggested: number | null = null
    for (let trial = current - 5; trial >= 50; trial -= 5) {
      const passTrial = list.filter(b => Number(b.tyr_score) >= trial).length
      const pct = (passTrial / list.length) * 100
      if (pct >= 90) {
        suggested = trial
        passAtSuggested = Math.round(pct)
      } else break  // monotonic — no point going lower
    }

    const rationale = suggested
      ? `Based on ${list.length} approved briefs in last ${windowDays}d: ${passAtSuggested}% would still pass at ${suggested}, vs ${passPctNow}% at current ${current}. Lowering frees up auto-approval for more borderline-but-acceptable briefs.`
      : `Current threshold ${current} already at safe minimum (≥90% of approvals pass). No suggestion.`

    recs.push({
      tier_level:           tier,
      current_threshold:    current,
      suggested_threshold:  suggested,
      approved_count:       list.length,
      pass_pct_at_current:  passPctNow,
      pass_pct_at_suggested: passAtSuggested,
      sample_window_days:   windowDays,
      rationale,
    })
  }

  return recs
}
