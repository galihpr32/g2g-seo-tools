import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/service'
import { notifyTyrEvent } from '@/lib/slack/notify'
import { logClaudeUsage } from '@/lib/api-logger'

/**
 * Tyr — Brief Quality Reviewer (Norse god of justice)
 *
 * Reads `seo_content_briefs` where status='agent_generated' AND tyr_reviewed_at IS NULL.
 * Scores each brief on 4 dimensions via Claude tool_use (0-10 each, total 0-40 → 0-100).
 *
 * Decision tree:
 *   score ≥ minScore                  → status='reviewed' (auto-promote)
 *   minScore-borderlineWindow ≤ score → status='draft' + tyr_status='borderline' + path-suggestion notes
 *                                        (writer fixes, clicks "Re-judge" to re-review)
 *   score < (minScore-borderlineWindow) → status='draft' + tyr_status='failed' + queue regenerate_brief
 *                                          action so user can approve a fresh draft pass
 *
 * Rate-limit: maxBriefsPerDay (default 30). Counts briefs reviewed since
 * 00:00 in user's timezone (config.timezone, fallback Asia/Jakarta).
 *
 * Failure handling: if Claude call itself errors, brief stays at
 * 'agent_generated' (preserves progress). tyr_status='error' is recorded so
 * Vor can flag persistent errors.
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = 'claude-haiku-4-5-20251001'

export interface TyrConfig {
  minScore:          number   // default 80
  borderlineWindow:  number   // default 10 → borderline = [70..79], pass ≥ 80
  maxBriefsPerDay:   number   // default 30
  timezone:          string   // default 'Asia/Jakarta' for daily quota window
}

export const TYR_DEFAULTS: TyrConfig = {
  minScore:         80,
  borderlineWindow: 10,
  maxBriefsPerDay:  30,
  timezone:         'Asia/Jakarta',
}

interface BriefRow {
  id:               string
  owner_user_id:    string
  primary_keyword:  string | null
  page:             string | null
  brief_type:       string | null
  content_outline:  unknown
  content_draft:    string | null
  faq_suggestions:  unknown
  new_keywords:     unknown
  notes:            string | null
  tyr_score:        number | null
}

// ── Score model — 8 dimensions × 10 = 80 max → normalised to 0-100 ─────────-
// Each dimension carries a score AND a per-dimension comment so the brief
// detail UI can explain WHY each score is what it is (SEMrush SWA-style).
//
// Backwards-compat: legacy `coverage` / `intent_match` / `keyword_grounding`
// / `faq_realism` flat number fields are kept on the breakdown and mirror
// the new `dimensions[*].score` for downstream consumers (Vor analyser, FE
// score badge) that haven't migrated yet.

export interface DimensionScore {
  score:    number          // 0-10
  comment:  string          // per-dimension explanation
}

export interface Suggestion {
  priority: 'high' | 'medium' | 'low'
  text:     string
}

interface ScoreBreakdown {
  // Per-dimension structured scores (8 of them — see below)
  dimensions: {
    coverage:           DimensionScore   // sub-intent coverage
    intent_match:       DimensionScore   // H1 + meta vs search intent
    heading_structure:  DimensionScore   // outline hierarchy quality
    keyword_strategy:   DimensionScore   // primary + LSI variants strategy
    eeat_signals:       DimensionScore   // E-E-A-T plan (trust, expertise, etc.)
    faq_quality:        DimensionScore   // FAQ realism + value
    meta_description:   DimensionScore   // meta crafting (length, keyword, CTA)
    internal_links:     DimensionScore   // does the brief plan internal linking?
  }
  strengths:    string[]      // 2-3 things the brief gets right
  weaknesses:   string[]      // 2-4 specific issues
  suggestions:  Suggestion[]  // prioritised actionable improvements
  redflags:     string[]      // legacy flat list — mirrors weaknesses for back-compat
  reasoning:    string        // 1-2 sentence overall verdict

  // Legacy flat scores — kept for back-compat (tooltip badge etc.)
  coverage:          number
  intent_match:      number
  keyword_grounding: number
  faq_realism:       number
}

const dimensionSpec = (description: string) => ({
  type: 'object',
  properties: {
    score:   { type: 'integer', description: '0-10 score for this dimension. Be strict — 7-8 means "solid, ready". 9-10 should be rare.' },
    comment: { type: 'string',  description: 'One specific sentence explaining the score. Cite outline section, FAQ #, or keyword.' },
  },
  required: ['score', 'comment'],
  description,
})

const judgeTool: Anthropic.Tool = {
  name: 'submit_brief_review',
  description: 'Submit the comprehensive quality review for an SEO brief — 8 dimensions, strengths, weaknesses, prioritised suggestions.',
  input_schema: {
    type: 'object',
    properties: {
      coverage:          dimensionSpec('Does the outline cover the sub-intents a real user searching this keyword expects? Penalise generic "What is X" intros for clearly transactional intent.'),
      intent_match:      dimensionSpec('Does the H1 + meta description match the commercial/transactional intent? Penalise off-intent phrasing.'),
      heading_structure: dimensionSpec('Outline hierarchy quality. Single H1, well-named H2s, no skipped levels (H1→H3), descriptive (not generic). 4-6 H2s ideal.'),
      keyword_strategy:  dimensionSpec('Primary keyword + LSI/variants strategy. Are target_keywords legitimate semantic variations or filler ("buy X cheap" + "cheap X" + "X cheap")? 10=organic variation across intent angles, 5=some padding, 0=spam.'),
      eeat_signals:      dimensionSpec('E-E-A-T plan: does the brief incorporate trust signals (buyer protection, ratings, secure transactions, refund policy, expert/staff voice, authoritative sourcing)? For commercial gaming marketplace, focus on TRUST + EXPERIENCE.'),
      faq_quality:       dimensionSpec('FAQs: are questions things real users search ("People also ask" style)? Are answers grounded (no hallucinated specifics like "5-minute delivery" without source)? 3-5 questions ideal.'),
      meta_description:  dimensionSpec('Meta description: 150-160 chars, includes primary keyword, has clear CTA. Penalise generic / over-stuffed.'),
      internal_links:    dimensionSpec('Does the brief plan internal links to related categories / pillar pages / supporting content? Internal linking is critical for topical authority.'),

      strengths: {
        type: 'array',
        items: { type: 'string' },
        description: '2-3 specific things the brief gets RIGHT. Cite section/keyword. Example: "FAQ #1 ‘How long does delivery take?’ matches a high-intent People Also Ask query".',
      },
      weaknesses: {
        type: 'array',
        items: { type: 'string' },
        description: '2-4 specific issues. Cite section/FAQ/keyword. Example: "Outline section 3 ‘How to Buy’ is generic boilerplate — needs marketplace-specific steps with screenshots planned".',
      },
      suggestions: {
        type: 'array',
        description: '3-6 prioritised, actionable improvements. High = blocks publish. Medium = polish before publish. Low = nice-to-have.',
        items: {
          type: 'object',
          properties: {
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            text:     { type: 'string', description: 'One imperative sentence. Example: "Replace H2 #4 with a Comparison Table section showing seller ratings vs price."' },
          },
          required: ['priority', 'text'],
        },
      },
      redflags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Backwards-compat: same as weaknesses, kept for legacy consumers. You can mirror weaknesses here.',
      },
      reasoning: {
        type: 'string',
        description: '1-2 sentence overall verdict. What\'s the headline takeaway?',
      },
    },
    required: ['coverage', 'intent_match', 'heading_structure', 'keyword_strategy', 'eeat_signals', 'faq_quality', 'meta_description', 'internal_links', 'strengths', 'weaknesses', 'suggestions', 'redflags', 'reasoning'],
  },
}

function dayStartIsoForTz(timezone: string): string {
  // Compute the start-of-day timestamp in the user's TZ, return as UTC ISO.
  // Used for "briefs reviewed today" quota query.
  const now = new Date()
  const tzNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }))
  tzNow.setHours(0, 0, 0, 0)
  const offsetMs = now.getTime() - new Date(now.toLocaleString('en-US', { timeZone: timezone })).getTime()
  return new Date(tzNow.getTime() + offsetMs).toISOString()
}

export async function runTyr(
  ownerId: string,
  siteSlug: string,
  runId: string,
  config: Partial<TyrConfig> = {}
): Promise<{ summary: string; actionsQueued: number }> {
  const { minScore, borderlineWindow, maxBriefsPerDay, timezone } =
    { ...TYR_DEFAULTS, ...config }
  const db = createServiceClient()
  const warnings: string[] = []
  let reviewed = 0
  let promoted = 0
  let borderline = 0
  let failed = 0
  let errored = 0
  let actionsQueued = 0

  try {
    // 1. Quota: count briefs already reviewed today
    const startOfDayIso = dayStartIsoForTz(timezone)
    const { count: reviewedToday, error: countErr } = await db
      .from('seo_content_briefs')
      .select('id', { count: 'exact', head: true })
      .eq('owner_user_id', ownerId)
      .gte('tyr_reviewed_at', startOfDayIso)

    if (countErr) throw new Error(`quota count failed: ${countErr.message}`)

    const remaining = Math.max(0, maxBriefsPerDay - (reviewedToday ?? 0))
    if (remaining === 0) {
      const summary = `Daily quota reached (${reviewedToday ?? 0}/${maxBriefsPerDay}). Skipping review until tomorrow.`
      warnings.push('quota_exhausted')
      await _finishRun(db, runId, ownerId, 'partial', summary, 0, 0, warnings)
      // Slack: alert that quota is exhausted (fire-and-forget)
      notifyTyrEvent({
        kind:          'quota_reached',
        reviewedCount: reviewedToday ?? 0,
        quota:         maxBriefsPerDay,
      }).catch(e => console.error('[tyr] quota notif failed:', e))
      return { summary, actionsQueued: 0 }
    }

    // 2. Fetch up to `remaining` briefs needing review
    const { data: briefs, error: briefsErr } = await db
      .from('seo_content_briefs')
      .select('id, owner_user_id, primary_keyword, page, brief_type, content_outline, content_draft, faq_suggestions, new_keywords, notes, tyr_score')
      .eq('owner_user_id', ownerId)
      .eq('status', 'agent_generated')
      .is('tyr_reviewed_at', null)
      .order('created_at', { ascending: true })
      .limit(remaining)

    if (briefsErr) throw new Error(`briefs query failed: ${briefsErr.message}`)
    if (!briefs?.length) {
      const summary = 'No briefs awaiting review.'
      await _finishRun(db, runId, ownerId, 'success', summary, 0, 0, warnings)
      return { summary, actionsQueued: 0 }
    }

    // 3. Review each brief
    for (const brief of briefs as BriefRow[]) {
      reviewed++

      let breakdown: ScoreBreakdown
      try {
        breakdown = await judgeBrief(brief, db, ownerId)
      } catch (err) {
        errored++
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[tyr] judge failed for brief ${brief.id}:`, msg)
        // Preserve progress: keep brief at agent_generated, log error in tyr_status
        await db
          .from('seo_content_briefs')
          .update({
            tyr_status:      'error',
            tyr_reviewed_at: new Date().toISOString(),
            notes:           appendNote(brief.notes, `[tyr] review failed: ${msg}. Brief left at agent_generated for retry next run.`),
          })
          .eq('id', brief.id)
        warnings.push(`brief ${brief.id.slice(0, 8)}: ${msg}`)
        continue
      }

      // Score = sum of 8 dimensions × 10 = 80 max → normalised to 0-100
      const dims  = breakdown.dimensions
      const total = dims.coverage.score
                  + dims.intent_match.score
                  + dims.heading_structure.score
                  + dims.keyword_strategy.score
                  + dims.eeat_signals.score
                  + dims.faq_quality.score
                  + dims.meta_description.score
                  + dims.internal_links.score
      const score = Math.round((total / 80) * 100)
      const failThreshold = minScore - borderlineWindow

      let newStatus: 'reviewed' | 'draft'
      let tyrStatus: 'reviewed' | 'borderline' | 'failed'
      let pathNote: string

      if (score >= minScore) {
        newStatus = 'reviewed'
        tyrStatus = 'reviewed'
        pathNote = `[tyr] Auto-promoted to reviewed (score ${score}/100, threshold ${minScore}). Reasoning: ${breakdown.reasoning}`
        promoted++
      } else if (score >= failThreshold) {
        newStatus = 'draft'
        tyrStatus = 'borderline'
        pathNote = [
          `[tyr] Borderline (score ${score}/100, needs ≥${minScore}). Issues:`,
          ...breakdown.redflags.map((r, i) => `  ${i + 1}. ${r}`),
          `Path forward:`,
          `  • Edit the brief to address the issues above.`,
          `  • Click "Re-judge" in Content Studio to re-review.`,
          `  • Or override status manually to 'reviewed' if you disagree with Tyr.`,
        ].join('\n')
        borderline++
      } else {
        newStatus = 'draft'
        tyrStatus = 'failed'
        pathNote = [
          `[tyr] Failed (score ${score}/100, needs ≥${failThreshold}). Issues:`,
          ...breakdown.redflags.map((r, i) => `  ${i + 1}. ${r}`),
          `Reasoning: ${breakdown.reasoning}`,
          `Path forward: a 'regenerate_brief' action has been queued — approve it to have Bragi re-draft from scratch with refined context.`,
        ].join('\n')
        failed++

        // Queue regenerate_brief action
        const { error: queueErr } = await db
          .from('agent_actions')
          .insert({
            owner_user_id: ownerId,
            agent_key:     'tyr',
            run_id:        runId,
            site_slug:     siteSlug,
            action_type:   'regenerate_brief',
            title:         `Regenerate brief — failed quality review (${score}/100): "${brief.primary_keyword ?? brief.page}"`,
            description:   `Tyr scored this brief ${score}/100 (threshold ${failThreshold}). Approve to discard the failed draft and have Bragi re-draft with refined context.`,
            priority:      'high',
            data: {
              brief_id:           brief.id,
              keyword:            brief.primary_keyword,
              page_url:           brief.page,
              brief_type:         brief.brief_type,
              tyr_score:          score,
              tyr_breakdown:      breakdown,
              regenerate_reason:  'low_score',
            },
          })
        if (queueErr) {
          console.error('[tyr] failed to queue regenerate_brief:', queueErr.message)
        } else {
          actionsQueued++
          // Slack: notify of failed brief
          notifyTyrEvent({
            kind:           'brief_failed',
            briefId:        brief.id,
            briefKeyword:   brief.primary_keyword ?? brief.page ?? undefined,
            briefScore:     score,
            briefThreshold: minScore,
          }).catch(e => console.error('[tyr] brief_failed notif failed:', e))
        }
      }

      // Update brief
      await db
        .from('seo_content_briefs')
        .update({
          status:           newStatus,
          tyr_score:        score,
          tyr_breakdown:    breakdown,
          tyr_status:       tyrStatus,
          tyr_reviewed_at:  new Date().toISOString(),
          notes:            appendNote(brief.notes, pathNote),
        })
        .eq('id', brief.id)
    }

    const summaryBase = `Reviewed ${reviewed} brief${reviewed !== 1 ? 's' : ''}: ${promoted} auto-promoted, ${borderline} borderline, ${failed} failed${errored ? `, ${errored} errors` : ''}.`
    const summary = warnings.length ? `${summaryBase} ⚠ ${warnings.join('; ')}` : summaryBase
    const status = warnings.length || errored > 0 ? 'partial' : 'success'

    // Slack: alert if borderline backlog accumulating (>5 still in borderline DB-wide)
    try {
      const { count: borderlineTotal } = await db
        .from('seo_content_briefs')
        .select('id', { count: 'exact', head: true })
        .eq('owner_user_id', ownerId)
        .eq('tyr_status', 'borderline')
        .eq('status', 'draft')
      if ((borderlineTotal ?? 0) >= 5) {
        notifyTyrEvent({
          kind: 'borderline_backlog',
          borderlineCount: borderlineTotal ?? 0,
        }).catch(e => console.error('[tyr] borderline_backlog notif failed:', e))
      }
    } catch { /* non-fatal */ }

    await _finishRun(db, runId, ownerId, status, summary, reviewed, actionsQueued, warnings)
    return { summary, actionsQueued }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    await _finishRun(db, runId, ownerId, 'error', msg, reviewed, actionsQueued, warnings, msg)
    throw err
  }
}

async function judgeBrief(
  brief: BriefRow,
  db?:   ReturnType<typeof createServiceClient>,
  ownerId?: string,
): Promise<ScoreBreakdown> {
  const prompt = `You are a senior SEO content quality reviewer for G2G.com — a peer-to-peer gaming marketplace (gift cards, in-game items, top-up, accounts) primarily targeting US.

Your job: comprehensive SWA-style review of the SEO brief below. Score 8 dimensions (each 0-10), then provide strengths, weaknesses, and prioritised suggestions. Cite SPECIFIC sections / FAQ numbers / keywords in every comment — vague feedback is useless.

PRIMARY KEYWORD: "${brief.primary_keyword ?? '(missing)'}"
TARGET PAGE:     ${brief.page ?? '(missing)'}
BRIEF TYPE:      ${brief.brief_type ?? 'on_page'}

CONTENT DRAFT:
${brief.content_draft ?? '(empty)'}

CONTENT OUTLINE (H2 structure):
${JSON.stringify(brief.content_outline, null, 2)}

TARGET KEYWORDS:
${JSON.stringify(brief.new_keywords, null, 2)}

FAQ SUGGESTIONS:
${JSON.stringify(brief.faq_suggestions, null, 2)}

REVIEW RUBRIC — score each dimension 0-10 (be strict, 7-8 = ready, 9-10 = rare excellence):

1. **coverage** — does the outline cover sub-intents users searching this keyword expect?
2. **intent_match** — H1 + meta align with commercial/transactional intent? Penalise generic "Welcome to" or off-intent phrasing.
3. **heading_structure** — single H1, 4-6 well-named H2s, no skipped levels (H1→H3), descriptive (not generic)
4. **keyword_strategy** — primary + LSI variants, semantic variation across intent angles. Penalise padded variants ("X cheap" + "cheap X" + "X cheap online").
5. **eeat_signals** — E-E-A-T plan: trust signals (buyer protection, ratings, secure payments, refund policy), staff/expert voice, authoritative sourcing. Critical for marketplace.
6. **faq_quality** — questions match real "People Also Ask"; answers grounded (no hallucinated specifics like "5-min delivery" without source).
7. **meta_description** — 150-160 chars, includes primary keyword, has clear CTA, not over-stuffed
8. **internal_links** — does the brief plan internal links (to related categories, pillar pages, supporting content)?

After scoring, provide:
- **strengths** (2-3): specific wins, cite section/FAQ. Example: "FAQ #3 'How long does delivery take?' matches a high-intent PAA query".
- **weaknesses** (2-4): specific issues. Example: "Outline section 4 'How to Buy' is generic — needs marketplace-specific steps with seller comparison".
- **suggestions** (3-6 prioritised): high = blocks publish, medium = polish before publish, low = nice-to-have.
- **redflags**: copy of weaknesses (back-compat).
- **reasoning**: 1-2 sentence overall verdict.

Call submit_brief_review with all fields.`

  const res = await anthropic.messages.create({
    model:       MODEL,
    max_tokens:  1024,
    tools:       [judgeTool],
    tool_choice: { type: 'tool', name: 'submit_brief_review' },
    messages:    [{ role: 'user', content: prompt }],
  })

  if (db && ownerId) {
    logClaudeUsage(db, ownerId, {
      model:       MODEL,
      endpoint:    'review_brief',
      triggeredBy: 'agent_tyr',
      usage:       res.usage,
      extra:       { brief_id: brief.id },
    })
  }

  const toolUse = res.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error(`Claude did not call submit_brief_review (stop_reason=${res.stop_reason})`)
  }

  const raw = toolUse.input as Record<string, unknown>
  const num = (v: unknown) => Math.max(0, Math.min(10, Math.round(Number(v) || 0)))
  const arr = (v: unknown) => Array.isArray(v) ? v.map(String) : []
  const dim = (v: unknown): DimensionScore => {
    const obj = (v ?? {}) as Record<string, unknown>
    return { score: num(obj.score), comment: String(obj.comment ?? '') }
  }
  const sugg = (v: unknown): Suggestion[] => {
    if (!Array.isArray(v)) return []
    return v.map(item => {
      const o = (item ?? {}) as Record<string, unknown>
      const p = String(o.priority ?? 'medium')
      const priority: Suggestion['priority'] = p === 'high' || p === 'low' ? p : 'medium'
      return { priority, text: String(o.text ?? '') }
    }).filter(s => s.text)
  }

  const dimensions = {
    coverage:          dim(raw.coverage),
    intent_match:      dim(raw.intent_match),
    heading_structure: dim(raw.heading_structure),
    keyword_strategy:  dim(raw.keyword_strategy),
    eeat_signals:      dim(raw.eeat_signals),
    faq_quality:       dim(raw.faq_quality),
    meta_description:  dim(raw.meta_description),
    internal_links:    dim(raw.internal_links),
  }

  return {
    dimensions,
    strengths:   arr(raw.strengths),
    weaknesses:  arr(raw.weaknesses),
    suggestions: sugg(raw.suggestions),
    redflags:    arr(raw.redflags).length ? arr(raw.redflags) : arr(raw.weaknesses),
    reasoning:   String(raw.reasoning ?? ''),

    // Legacy flat scores — mirror new dimensions for back-compat
    coverage:          dimensions.coverage.score,
    intent_match:      dimensions.intent_match.score,
    keyword_grounding: dimensions.keyword_strategy.score,
    faq_realism:       dimensions.faq_quality.score,
  }
}

function appendNote(existing: string | null, line: string): string {
  return existing ? `${existing}\n\n${line}` : line
}

async function _finishRun(
  db: ReturnType<typeof createServiceClient>,
  runId: string,
  ownerId: string,
  status: 'success' | 'error' | 'partial',
  summary: string,
  findingsCount: number,
  actionsQueued: number,
  warnings: string[],
  errorMessage?: string
) {
  await db
    .from('agent_runs')
    .update({
      status,
      summary,
      findings_count: findingsCount,
      actions_queued: actionsQueued,
      error_message:  errorMessage ?? (warnings.length ? warnings.join('; ') : null),
      finished_at:    new Date().toISOString(),
    })
    .eq('id', runId)

  await db
    .from('agents')
    .update({
      last_run_at:      new Date().toISOString(),
      last_run_status:  status,
      last_run_summary: summary,
    })
    .eq('owner_user_id', ownerId)
    .eq('agent_key', 'tyr')
}
