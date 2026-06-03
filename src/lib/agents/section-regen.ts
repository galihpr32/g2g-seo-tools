// ─── Per-section brief regenerator ─────────────────────────────────────────
//
// Full Bragi regenerate is a 15-30s LLM call that rebuilds outline + FAQ +
// keywords + draft. When the issue is localized (e.g. only FAQ thin), that's
// wasteful — both in time and Anthropic spend.
//
// This module rebuilds JUST the requested section, preserving everything
// else. ~2-5s + ~$0.001 per call. Driven by Tyr's auto-suggestion when the
// breakdown indicates a single weak dimension.
//
// Sections:
//   outline       — content_outline (array of {heading, points[]})
//   faq           — faq_suggestions (array of {question, suggested_answer})
//   meta          — content_draft (header block: H1, meta description, intent)
//   keywords      — new_keywords (array of {keyword, volume})

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const SECTION_REGEN_MODEL = 'claude-sonnet-4-6'

export type RegenSection = 'outline' | 'faq' | 'meta' | 'keywords'

interface BriefSnapshot {
  primary_keyword: string | null
  brief_type:      string | null
  page:            string | null
  content_outline: unknown
  faq_suggestions: unknown
  new_keywords:    unknown
  content_draft:   string | null
  tyr_breakdown:   unknown
}

// ─── Section-specific prompts ───────────────────────────────────────────────

function buildOutlinePrompt(b: BriefSnapshot, userNotes: string): string {
  const existingFaqs = JSON.stringify(b.faq_suggestions ?? [], null, 2).slice(0, 1500)
  // Sprint #356 — also pull GEO dim feedback. Outline is the section that
  // controls H2 phrasing, citable stats placement, and entity naming, so
  // these GEO scores all map back to "regenerate the outline".
  const tyrFeedback = extractTyrFeedback(b.tyr_breakdown, [
    'coverage', 'heading_structure', 'eeat_signals', 'internal_links',
    'geo_answer_shape', 'geo_citable_stats', 'geo_entity_naming',
  ])
  return `Regenerate the CONTENT OUTLINE for this SEO content brief.

PRIMARY KEYWORD: ${b.primary_keyword ?? '(unknown)'}
BRIEF TYPE: ${b.brief_type ?? 'on_page'}
PAGE: ${b.page ?? ''}

EXISTING FAQ (do NOT change — keep alignment):
${existingFaqs}

TYR FEEDBACK ON OUTLINE / STRUCTURE:
${tyrFeedback || '(no specific feedback)'}

USER NOTES:
${userNotes || '(none)'}

RULES (SEO):
- Single H1 (use existing primary keyword as base)
- 4-6 H2 sections, each with 2-4 sub-bullets
- Cover commercial intent + value props + safety/trust + comparison + FAQ-feeder section
- Suggest internal-link targets where relevant
- DO NOT include FAQ section in outline (FAQ is separate)

RULES (GEO — AI-assistant citation readiness):
- ★ Phrase EVERY H2 as either a question ("How long does delivery take?")
  OR a clear factual claim ("Delivery completes in under 15 minutes for
  92% of orders"). Generic labels ("Our Service", "Why Choose Us") are
  banned — LLMs skip them.
- ★ Plan ≥3 citable data points across the sub-bullets (percentages,
  durations, counts, certifications). LLMs cite specific numbers; they
  ignore vague claims like "fast and reliable".
- ★ Name FULL proper entities (game titles, currencies, regions) — never
  use pronouns or "the in-game currency" when "Blade & Soul NEO Gold"
  would work. LLMs index entity mentions.

OUTPUT: strict JSON array, no fences:
[
  { "heading": "H2 title", "points": ["sub-bullet 1", "sub-bullet 2"] },
  ...
]`
}

function buildFaqPrompt(b: BriefSnapshot, userNotes: string): string {
  const existingOutline = JSON.stringify(b.content_outline ?? [], null, 2).slice(0, 1500)
  // Sprint #356 — pull GEO FAQ-quotability feedback in addition to classic FAQ quality.
  const tyrFeedback = extractTyrFeedback(b.tyr_breakdown, ['faq_quality', 'geo_faq_quotability'])
  return `Regenerate the FAQ section for this SEO content brief.

PRIMARY KEYWORD: ${b.primary_keyword ?? '(unknown)'}
BRIEF TYPE: ${b.brief_type ?? 'on_page'}
PAGE: ${b.page ?? ''}

EXISTING OUTLINE (FAQ should COMPLEMENT this, not duplicate):
${existingOutline}

TYR FEEDBACK ON FAQ:
${tyrFeedback || '(no specific feedback)'}

USER NOTES:
${userNotes || '(none)'}

RULES (SEO):
- 5-8 FAQs that match real "People Also Ask" patterns
- Each Q is a natural question a buyer would type
- Each A is 1-3 sentences, factual, non-promotional, non-hallucinated
- Include at least 1 question about pricing, 1 about safety/legality, 1 about delivery time
- DO NOT make up specific prices unless the user notes have them

RULES (GEO — AI-assistant quotability):
- ★ Every question must start with How / What / When / Why / Is / Can —
  direct, user-typeable phrasing. NO multi-clause framed questions
  ("In what way could a buyer potentially...") — LLMs skip those.
- ★ Each suggested_answer should be 1-3 short sentences. LLMs quote
  concise answers; long essay answers get truncated or skipped.
- ★ Name the full entity in answers (e.g. "Blade & Soul NEO Gold",
  not "this currency") so AI assistants can index the mention.

OUTPUT: strict JSON array, no fences:
[
  { "question": "How long does delivery take?", "suggested_answer": "Most orders complete within 24 hours; some during peak times..." },
  ...
]`
}

function buildMetaPrompt(b: BriefSnapshot, userNotes: string): string {
  const existingOutline = JSON.stringify(b.content_outline ?? [], null, 2).slice(0, 1000)
  const tyrFeedback = extractTyrFeedback(b.tyr_breakdown, ['meta_description', 'intent_match'])
  return `Regenerate the H1 + META DESCRIPTION + INTENT block for this SEO content brief.

PRIMARY KEYWORD: ${b.primary_keyword ?? '(unknown)'}
BRIEF TYPE: ${b.brief_type ?? 'on_page'}
PAGE: ${b.page ?? ''}

EXISTING OUTLINE (meta should align with this):
${existingOutline}

TYR FEEDBACK ON META / INTENT:
${tyrFeedback || '(no specific feedback)'}

USER NOTES:
${userNotes || '(none)'}

RULES:
- H1: 50-65 chars, primary keyword first, action-oriented
- Meta description: 150-160 chars, primary keyword present, clear CTA, value prop
- Intent: 1 line — "transactional / commercial / informational" + buyer profile

OUTPUT: strict JSON object, no fences:
{ "h1": "...", "meta_description": "...", "intent": "transactional — ..." }`
}

function buildKeywordsPrompt(b: BriefSnapshot, userNotes: string): string {
  const existingOutline = JSON.stringify(b.content_outline ?? [], null, 2).slice(0, 1000)
  const tyrFeedback = extractTyrFeedback(b.tyr_breakdown, ['keyword_strategy'])
  return `Regenerate the SECONDARY / LSI keyword list for this SEO content brief.

PRIMARY KEYWORD: ${b.primary_keyword ?? '(unknown)'}
PAGE: ${b.page ?? ''}

OUTLINE (keywords should support outline themes):
${existingOutline}

TYR FEEDBACK ON KEYWORDS:
${tyrFeedback || '(no specific feedback)'}

USER NOTES:
${userNotes || '(none)'}

RULES:
- 8-15 secondary keywords (LSI variants, long-tail, related queries)
- Mix of commercial + informational intent
- DO include the primary keyword's plural / variant forms
- DO NOT include keywords with volume < 50/month (estimate if unknown)
- Volume null is acceptable — DON'T fabricate numbers

OUTPUT: strict JSON array, no fences:
[
  { "keyword": "buy wow gold", "volume": 1900 },
  { "keyword": "wow gold cheap safe", "volume": 320 },
  ...
]`
}

// Extract Tyr breakdown comments for the dimensions relevant to this section
function extractTyrFeedback(tyrBreakdown: unknown, relevantDimensions: string[]): string {
  if (!tyrBreakdown || typeof tyrBreakdown !== 'object') return ''
  const breakdown = tyrBreakdown as { dimensions?: Record<string, { score: number; comment: string }> }
  if (!breakdown.dimensions) return ''
  const lines: string[] = []
  for (const dim of relevantDimensions) {
    const d = breakdown.dimensions[dim]
    if (d) lines.push(`  - ${dim} (${d.score}/10): ${d.comment}`)
  }
  return lines.join('\n')
}

// ─── Public — regenerate one section ───────────────────────────────────────

export async function regenerateSection(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any, any, any>
  briefId:   string
  section:   RegenSection
  userNotes?: string
}): Promise<{ ok: true; updatedField: string; newValue: unknown } | { ok: false; error: string }> {
  const { db, briefId, section, userNotes = '' } = opts

  // 1. Load existing brief
  const { data: brief, error: loadErr } = await db
    .from('seo_content_briefs')
    .select('primary_keyword, brief_type, page, content_outline, faq_suggestions, new_keywords, content_draft, tyr_breakdown')
    .eq('id', briefId)
    .maybeSingle()

  if (loadErr || !brief) {
    return { ok: false, error: loadErr?.message ?? 'Brief not found' }
  }

  // 2. Build section-specific prompt
  const promptBuilder: Record<RegenSection, (b: BriefSnapshot, n: string) => string> = {
    outline:  buildOutlinePrompt,
    faq:      buildFaqPrompt,
    meta:     buildMetaPrompt,
    keywords: buildKeywordsPrompt,
  }
  const prompt = promptBuilder[section](brief as BriefSnapshot, userNotes)

  // 3. Call Sonnet
  let raw: string
  try {
    const res = await anthropic.messages.create({
      model:      SECTION_REGEN_MODEL,
      max_tokens: section === 'meta' ? 600 : 2200,
      messages:   [{ role: 'user', content: prompt }],
    })
    raw = res.content[0]?.type === 'text' ? res.content[0].text : ''
  } catch (err) {
    return { ok: false, error: `Anthropic error: ${err instanceof Error ? err.message : String(err)}` }
  }

  // 4. Parse + validate
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return { ok: false, error: `Sonnet returned non-JSON for ${section}: ${cleaned.slice(0, 200)}` }
  }

  // 5. Map section → DB field + write
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }

  if (section === 'outline') {
    if (!Array.isArray(parsed)) return { ok: false, error: 'Outline must be array' }
    updates.content_outline = parsed
  } else if (section === 'faq') {
    if (!Array.isArray(parsed)) return { ok: false, error: 'FAQ must be array' }
    updates.faq_suggestions = parsed
  } else if (section === 'meta') {
    if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: 'Meta must be object' }
    const m = parsed as Record<string, unknown>
    // Stash into content_draft as a header block — preserve any existing draft body
    const existingDraft = String(brief.content_draft ?? '')
    const headerBlock = `H1: ${m.h1 ?? ''}\nMeta description: ${m.meta_description ?? ''}\nIntent: ${m.intent ?? ''}`
    // Replace the leading "H1: ... Intent: ..." block if present, otherwise prepend
    const headerRegex = /^H1:[\s\S]*?Intent:[^\n]*/
    updates.content_draft = headerRegex.test(existingDraft)
      ? existingDraft.replace(headerRegex, headerBlock)
      : `${headerBlock}\n\n${existingDraft}`
  } else if (section === 'keywords') {
    if (!Array.isArray(parsed)) return { ok: false, error: 'Keywords must be array' }
    updates.new_keywords = parsed
  }

  // Reset Tyr — the old review is now stale relative to the partial change
  updates.tyr_status     = null
  updates.tyr_score      = null
  updates.tyr_breakdown  = null
  updates.tyr_reviewed_at = null

  const { error: upErr } = await db
    .from('seo_content_briefs')
    .update(updates)
    .eq('id', briefId)

  if (upErr) return { ok: false, error: `DB update failed: ${upErr.message}` }

  return {
    ok:           true,
    updatedField: section === 'meta' ? 'content_draft' : `${section === 'faq' ? 'faq_suggestions' : section === 'keywords' ? 'new_keywords' : 'content_outline'}`,
    newValue:     parsed,
  }
}
