// ─── Brief review diff capture ──────────────────────────────────────────────
// Compare AI-original brief draft vs human-edited version, emit
// brief_review_feedback rows per changed section. Called from the brief PATCH
// endpoint on save.
//
// Section model — we segment the brief into addressable labels:
//   meta_title, meta_description, h1, intro,
//   section:0 … section:N (H2 blocks),
//   faq:0 … faq:N
//
// Diff granularity is section-level (not character-level) for two reasons:
//   1. Aggregator clusters by reason — too granular = noise
//   2. Reviewer reason prompt fits ONE bucket per section, not per word

import type { SupabaseClient } from '@supabase/supabase-js'

export interface SectionedBrief {
  meta_title?:       string | null
  meta_description?: string | null
  h1?:               string | null
  intro?:            string | null
  sections?:         string[] | null
  faqs?:             Array<{ q?: string; a?: string }> | null
}

export interface ChangedSection {
  section_label:  string
  ai_version:     string
  human_version:  string
  diff_summary:   string
  severity:       'minor' | 'major' | 'critical'
}

/** Tokenize for simple diff comparison + magnitude estimation. */
function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const sa = new Set(a)
  const sb = new Set(b)
  const inter = new Set([...sa].filter(x => sb.has(x))).size
  const union = new Set([...sa, ...sb]).size
  return union > 0 ? inter / union : 0
}

function describeChange(ai: string, human: string): { summary: string; severity: ChangedSection['severity'] } {
  if (!ai && human)    return { summary: `Section added (${human.length} chars)`, severity: 'major' }
  if (ai && !human)    return { summary: `Section removed (was ${ai.length} chars)`, severity: 'critical' }
  if (ai === human)    return { summary: 'No change', severity: 'minor' }

  const aiTokens = tokenize(ai)
  const huTokens = tokenize(human)
  const sim = jaccard(aiTokens, huTokens)
  const lenChange = ((huTokens.length - aiTokens.length) / Math.max(aiTokens.length, 1)) * 100

  let severity: ChangedSection['severity']
  if (sim >= 0.85)      severity = 'minor'
  else if (sim >= 0.55) severity = 'major'
  else                  severity = 'critical'

  // Lightweight summary — full Haiku description happens in the classifier step
  const lenPart = lenChange > 30  ? `expanded ${Math.round(lenChange)}%`
               : lenChange < -30  ? `cut ${Math.round(-lenChange)}%`
               :                     ''
  const simPart = sim < 0.85
    ? `${Math.round((1 - sim) * 100)}% rewrite`
    : 'minor edits'
  const parts = [simPart, lenPart].filter(Boolean)
  return {
    summary:  parts.join(' · '),
    severity,
  }
}

/**
 * Compute changed sections between AI original and current draft.
 * Returns one entry per section that differs.
 *
 * Section extraction follows the SEO brief shape (intro + 8 sections + faqs +
 * meta), but is tolerant of legacy shapes — anything not present in ai_original
 * is skipped.
 */
export function computeChangedSections(
  aiOriginal: SectionedBrief,
  human:      SectionedBrief,
): ChangedSection[] {
  const changes: ChangedSection[] = []

  function emit(label: string, ai: string | null | undefined, hu: string | null | undefined) {
    const aiStr = String(ai ?? '').trim()
    const huStr = String(hu ?? '').trim()
    if (aiStr === huStr) return
    const { summary, severity } = describeChange(aiStr, huStr)
    changes.push({
      section_label: label,
      ai_version:    aiStr,
      human_version: huStr,
      diff_summary:  summary,
      severity,
    })
  }

  emit('meta_title',       aiOriginal.meta_title,       human.meta_title)
  emit('meta_description', aiOriginal.meta_description, human.meta_description)
  emit('h1',               aiOriginal.h1,               human.h1)
  emit('intro',            aiOriginal.intro,            human.intro)

  const aiSections = aiOriginal.sections ?? []
  const huSections = human.sections ?? []
  const maxSec = Math.max(aiSections.length, huSections.length)
  for (let i = 0; i < maxSec; i++) {
    emit(`section:${i}`, aiSections[i], huSections[i])
  }

  const aiFaqs = aiOriginal.faqs ?? []
  const huFaqs = human.faqs ?? []
  const maxFaq = Math.max(aiFaqs.length, huFaqs.length)
  for (let i = 0; i < maxFaq; i++) {
    const ai = aiFaqs[i] ? `${aiFaqs[i].q ?? ''}\n${aiFaqs[i].a ?? ''}` : ''
    const hu = huFaqs[i] ? `${huFaqs[i].q ?? ''}\n${huFaqs[i].a ?? ''}` : ''
    emit(`faq:${i}`, ai, hu)
  }

  return changes
}

/**
 * Persist captured changes to brief_review_feedback.
 *
 * Designed to be called from the brief save handler (PUT /api/content/briefs/[id])
 * AFTER the update has succeeded. Insert errors don't propagate — capture is
 * best-effort and should never block the human's edit.
 */
export async function captureReviewFeedback(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:           SupabaseClient<any, any, any>,
  args: {
    briefId:     string
    ownerId:     string
    siteSlug:    string
    reviewerId:  string | null
    aiOriginal:  SectionedBrief
    humanCurrent: SectionedBrief
    /** Optional pre-captured reasons keyed by section_label. */
    reasons?:    Record<string, string>
  },
): Promise<{ inserted: number; errors: string[] }> {
  const changes = computeChangedSections(args.aiOriginal, args.humanCurrent)
  if (changes.length === 0) return { inserted: 0, errors: [] }

  const errors: string[] = []
  let inserted = 0

  // Bulk-insert via single call when possible
  const rows = changes.map(c => ({
    owner_user_id:   args.ownerId,
    site_slug:       args.siteSlug,
    brief_id:        args.briefId,
    reviewer_id:     args.reviewerId,
    section_label:   c.section_label,
    ai_version:      c.ai_version,
    human_version:   c.human_version,
    diff_summary:    c.diff_summary,
    severity:        c.severity,
    reason_freetext: args.reasons?.[c.section_label] ?? null,
  }))

  const { error } = await db.from('brief_review_feedback').insert(rows)
  if (error) errors.push(error.message)
  else inserted = rows.length

  return { inserted, errors }
}
