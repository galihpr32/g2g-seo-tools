// ─── KB Rule Extractor ───────────────────────────────────────────────────────
//
// Monthly cron pulls last 30d of brief outcomes, classifies each as winner /
// loser, and asks Sonnet to extract patterns common to winners but absent
// from losers. Results land in kb_rule_proposals for human review.
//
// Why this matters:
//   Bragi reads from knowledge_base_items at brief generation time. The
//   richer + more battle-tested the KB, the better the next brief. Without
//   a feedback loop, KB stays static and Bragi never improves. This module
//   IS the feedback loop.
//
// Definitions:
//   winner    = brief published ≥30d ago, target keyword now ranks ≤ 8
//   loser     = brief published ≥30d ago, target keyword still > 25 OR no movement vs baseline
//   ambiguous = published <30d (too early), or position 9-25 (mid-zone)
//
// Token budget: 1 cron run = 1 Sonnet call (~$0.10-0.30 depending on sample size).
// Cron runs monthly per site, so total ~$2-6/year. Negligible.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const EXTRACTOR_MODEL = 'claude-sonnet-4-6'

export interface ExtractedProposal {
  title:        string                                      // ≤80 chars, imperative
  rule_text:    string                                      // 1-3 sentences, the rule itself
  pattern_kind: 'winning' | 'cautionary' | 'tone' | 'format' | 'generic'
  confidence:   1 | 2 | 3 | 4 | 5                          // Sonnet's gut feeling
  /** Suggested KB target — Sonnet picks the best fit; user can override.
   *  null when Sonnet can't confidently pick one. */
  suggested_kb_field: 'dos' | 'donts' | 'writing_rules' | 'format' | 'tone' | 'notes' | null
  /** Brief IDs that informed this proposal (subset of winners passed in) */
  source_brief_ids:  string[]
  source_loser_ids:  string[]
}

// ─── Brief outcome classification ───────────────────────────────────────────

interface BriefForExtraction {
  id:               string
  primary_keyword:  string | null
  brief_type:       string | null
  page:             string | null
  content_outline:  unknown
  faq_suggestions:  unknown
  new_keywords:     unknown
  content_draft:    string | null
  final_content:    string | null
  tyr_score:        number | null
  tyr_breakdown:    unknown
  published_at:     string | null
  // outcome fields (joined from brief_outcomes / Ranking Impact)
  outcome_class:    'winner' | 'loser' | 'ambiguous'
  current_position: number | null
}

/** Classify a brief based on its outcome data. */
function classifyOutcome(opts: {
  publishedAt:    string | null
  curPosition:    number | null
  baselinePos:    number | null
}): { class: 'winner' | 'loser' | 'ambiguous'; reason: string } {
  if (!opts.publishedAt) return { class: 'ambiguous', reason: 'never_published' }

  const ageDays = (Date.now() - new Date(opts.publishedAt).getTime()) / 86400_000
  if (ageDays < 30) return { class: 'ambiguous', reason: 'too_early' }

  if (opts.curPosition == null) return { class: 'ambiguous', reason: 'no_ranking_data' }

  if (opts.curPosition <= 8) return { class: 'winner', reason: `landed_pos_${opts.curPosition}` }

  if (opts.curPosition > 25) return { class: 'loser', reason: `stuck_pos_${opts.curPosition}` }

  // Mid-zone (9-25): only call winner/loser if we have baseline movement signal
  if (opts.baselinePos != null) {
    const delta = opts.baselinePos - opts.curPosition         // positive = improved
    if (delta >= 5)  return { class: 'winner', reason: `improved_${delta}_to_${opts.curPosition}` }
    if (delta <= -5) return { class: 'loser',  reason: `dropped_${Math.abs(delta)}_to_${opts.curPosition}` }
  }
  return { class: 'ambiguous', reason: 'mid_zone' }
}

/** Pull last 30d of briefs + their outcome data, classify each. */
async function loadBriefSamples(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  ownerId: string,
  siteSlug: string,
): Promise<BriefForExtraction[]> {
  // Window: published 30-90 days ago (so we have 30+ days of post-publish data)
  const since = new Date(Date.now() - 90 * 86400_000).toISOString()
  const before = new Date(Date.now() - 30 * 86400_000).toISOString()

  const { data: briefs } = await db
    .from('seo_content_briefs')
    .select('id, primary_keyword, brief_type, page, content_outline, faq_suggestions, new_keywords, content_draft, final_content, tyr_score, tyr_breakdown, published_at, site_slug')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('status', 'published')
    .gte('published_at', since)
    .lte('published_at', before)
    .limit(60)

  if (!briefs || briefs.length === 0) return []

  // brief_outcomes schema is fixed-checkpoints: pos_0 (publish baseline) +
  // pos_30 / pos_60 / pos_90 (later snapshots). "Current position" =
  // most-recent non-null among pos_90 → pos_60 → pos_30. "Baseline" = pos_0.
  const briefIds = briefs.map(b => b.id)
  const { data: outcomes } = await db
    .from('brief_outcomes')
    .select('brief_id, pos_0, pos_30, pos_60, pos_90')
    .in('brief_id', briefIds)

  const latestByBrief = new Map<string, { current: number | null; baseline: number | null }>()
  for (const o of outcomes ?? []) {
    const cur = (o.pos_90 ?? o.pos_60 ?? o.pos_30) as number | null
    latestByBrief.set(String(o.brief_id), {
      current:  cur != null ? Number(cur) : null,
      baseline: o.pos_0 != null ? Number(o.pos_0) : null,
    })
  }

  return briefs.map(b => {
    const o = latestByBrief.get(String(b.id)) ?? { current: null, baseline: null }
    const cls = classifyOutcome({
      publishedAt: b.published_at as string | null,
      curPosition: o.current,
      baselinePos: o.baseline,
    })
    return {
      id:               String(b.id),
      primary_keyword:  b.primary_keyword as string | null,
      brief_type:       b.brief_type      as string | null,
      page:             b.page            as string | null,
      content_outline:  b.content_outline,
      faq_suggestions:  b.faq_suggestions,
      new_keywords:     b.new_keywords,
      content_draft:    b.content_draft   as string | null,
      final_content:    b.final_content   as string | null,
      tyr_score:        b.tyr_score       as number | null,
      tyr_breakdown:    b.tyr_breakdown,
      published_at:     b.published_at    as string | null,
      outcome_class:    cls.class,
      current_position: o.current,
    }
  })
}

// ─── Sonnet extraction ───────────────────────────────────────────────────────

function summarizeBriefForPrompt(b: BriefForExtraction): string {
  // Compact representation — keep prompt token-efficient.
  const outline = Array.isArray(b.content_outline)
    ? (b.content_outline as { heading?: string }[]).slice(0, 8).map(s => s.heading).filter(Boolean).join(' | ')
    : ''
  const faqs = Array.isArray(b.faq_suggestions)
    ? (b.faq_suggestions as { question?: string }[]).slice(0, 4).map(f => f.question).filter(Boolean).join(' | ')
    : ''
  const draftStart = b.final_content?.slice(0, 800) ?? b.content_draft?.slice(0, 800) ?? ''
  return `id: ${b.id}
keyword: ${b.primary_keyword ?? '(unknown)'}
type: ${b.brief_type ?? 'on_page'}  page: ${b.page ?? ''}
tyr: ${b.tyr_score ?? '?'}/100
outline: ${outline}
faqs: ${faqs}
content opening: ${draftStart.replace(/\n/g, ' ').slice(0, 500)}`
}

const PROMPT = `You are MIMIR's archivist — extract reusable patterns from past content briefs to feed back into the SEO knowledge base.

Below you have two groups:
  WINNERS — briefs that landed in top 8 within 30 days of publish (or improved 5+ positions)
  LOSERS  — briefs still stuck >25 after 30+ days (or dropped 5+ positions)

Your task: identify 3-7 patterns where WINNERS share something LOSERS don't (or vice versa for cautionary patterns). Be SPECIFIC — patterns must reference observable structural / linguistic / topical features, not generic SEO advice.

OUTPUT FORMAT — strict JSON array. Each element:
{
  "title": "Short imperative title (≤80 chars)",
  "rule_text": "1-3 sentences. Specific, evidence-grounded. e.g. 'Top-ranking gold pages include a price-history visualization in the first 600 words; pages without it stagnated past pos 15.'",
  "pattern_kind": "winning" | "cautionary" | "tone" | "format" | "generic",
  "confidence": 1-5,
  "suggested_kb_field": "dos" | "donts" | "writing_rules" | "format" | "tone" | "notes" | null,
  "source_brief_ids": ["uuid1","uuid2","uuid3"],
  "source_loser_ids": ["uuid4","uuid5"]
}

RULES:
- Each pattern must cite at least 2 winner ids in source_brief_ids (or 2 loser ids in source_loser_ids for cautionary patterns).
- AVOID generic "use keyword in H1" / "write detailed FAQs" platitudes — those are already in the KB.
- Confidence:
  5 = unmistakable, ≥4 winners share + ≥2 losers lack
  4 = strong, 3+ winners share
  3 = plausible, 2+ winners share
  2 = speculative
  1 = weak hunch — only include if interesting
- pattern_kind:
  winning     = specific feature winners share
  cautionary  = specific feature losers share that we should avoid
  tone        = voice / register pattern
  format      = structural pattern (e.g. ordered list at top, comparison table, etc.)
  generic     = falls back when none of the above
- Output ONLY the JSON array. No prose, no markdown fences.`

interface BatchInput {
  winners: BriefForExtraction[]
  losers:  BriefForExtraction[]
}

export async function extractPatterns(opts: BatchInput): Promise<ExtractedProposal[]> {
  if (opts.winners.length < 2) return []   // not enough signal

  const winnersBlock = opts.winners.slice(0, 12).map(b => `[WINNER]\n${summarizeBriefForPrompt(b)}`).join('\n---\n')
  const losersBlock  = opts.losers.slice(0, 8).map(b => `[LOSER]\n${summarizeBriefForPrompt(b)}`).join('\n---\n')
  const userMsg = `${winnersBlock}\n\n=== LOSERS ===\n${losersBlock}`

  const res = await anthropic.messages.create({
    model:      EXTRACTOR_MODEL,
    max_tokens: 3000,
    system:     PROMPT,
    messages:   [{ role: 'user', content: userMsg }],
  })

  const text = res.content[0]?.type === 'text' ? res.content[0].text.trim() : ''
  // Strip optional fence
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    console.warn('[kb-extractor] Sonnet returned non-JSON:', cleaned.slice(0, 300))
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map(p => ({
      title:              String(p.title ?? '').slice(0, 80).trim(),
      rule_text:          String(p.rule_text ?? '').trim(),
      pattern_kind:       (['winning','cautionary','tone','format','generic'].includes(p.pattern_kind as string) ? p.pattern_kind : 'generic') as ExtractedProposal['pattern_kind'],
      confidence:         clampInt(p.confidence, 1, 5) as ExtractedProposal['confidence'],
      suggested_kb_field: (['dos','donts','writing_rules','format','tone','notes'].includes(p.suggested_kb_field as string) ? p.suggested_kb_field : null) as ExtractedProposal['suggested_kb_field'],
      source_brief_ids:   Array.isArray(p.source_brief_ids) ? (p.source_brief_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      source_loser_ids:   Array.isArray(p.source_loser_ids) ? (p.source_loser_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    }))
    .filter(p => p.title && p.rule_text && (p.source_brief_ids.length >= 2 || p.source_loser_ids.length >= 2))
}

function clampInt(n: unknown, lo: number, hi: number): number {
  const v = Number(n)
  if (Number.isNaN(v)) return lo
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

// ─── Main entry — used by cron + manual trigger ─────────────────────────────

export async function runKbExtraction(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any, any, any>
  ownerId:   string
  siteSlug:  string
}): Promise<{ proposalsWritten: number; winners: number; losers: number; ambiguous: number; warning?: string }> {
  const briefs = await loadBriefSamples(opts.db, opts.ownerId, opts.siteSlug)
  const winners   = briefs.filter(b => b.outcome_class === 'winner')
  const losers    = briefs.filter(b => b.outcome_class === 'loser')
  const ambiguous = briefs.filter(b => b.outcome_class === 'ambiguous')

  if (winners.length < 2) {
    return {
      proposalsWritten: 0,
      winners: winners.length,
      losers: losers.length,
      ambiguous: ambiguous.length,
      warning: `Not enough winners (${winners.length}) for pattern extraction. Need ≥2.`,
    }
  }

  const proposals = await extractPatterns({ winners, losers })
  if (proposals.length === 0) {
    return {
      proposalsWritten: 0,
      winners: winners.length,
      losers: losers.length,
      ambiguous: ambiguous.length,
      warning: 'Sonnet returned 0 actionable patterns. Try widening the brief window or letting more time pass.',
    }
  }

  // Persist proposals
  const rows = proposals.map(p => ({
    owner_user_id:    opts.ownerId,
    site_slug:        opts.siteSlug,
    title:            p.title,
    rule_text:        p.rule_text,
    pattern_kind:     p.pattern_kind,
    source:           'cron_extractor' as const,
    source_brief_ids: p.source_brief_ids.filter(id => winners.some(w => w.id === id)),
    source_loser_ids: p.source_loser_ids.filter(id => losers.some(l => l.id === id)),
    confidence:       p.confidence,
    suggested_kb_field: p.suggested_kb_field,
    status:           'pending' as const,
  }))

  const { error } = await opts.db
    .from('kb_rule_proposals')
    .insert(rows)
  if (error) throw new Error(`Failed to persist proposals: ${error.message}`)

  return {
    proposalsWritten: proposals.length,
    winners: winners.length,
    losers: losers.length,
    ambiguous: ambiguous.length,
  }
}
