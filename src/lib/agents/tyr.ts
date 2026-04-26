import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/service'
import { notifyTyrEvent } from '@/lib/slack/notify'

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
 * Mimir can flag persistent errors.
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

interface ScoreBreakdown {
  coverage:           number   // 0-10
  intent_match:       number   // 0-10
  keyword_grounding:  number   // 0-10
  faq_realism:        number   // 0-10
  redflags:           string[]
  reasoning:          string
}

const judgeTool: Anthropic.Tool = {
  name: 'submit_brief_review',
  description: 'Submit the structured quality review for an SEO brief.',
  input_schema: {
    type: 'object',
    properties: {
      coverage: {
        type: 'integer',
        description: '0-10. Does the outline cover the sub-intents a real user searching this keyword would expect? 10=comprehensive, 5=missing key angles, 0=off-topic.',
      },
      intent_match: {
        type: 'integer',
        description: '0-10. Does the H1 + meta description match the commercial/transactional intent? Penalise generic "welcome to" or off-intent phrasing.',
      },
      keyword_grounding: {
        type: 'integer',
        description: '0-10. Are target_keywords legitimate variants/LSI terms, or filler ("buy X cheap", "X for sale", "X 2024" repeated)? 10=organic variation, 5=some padding, 0=spam.',
      },
      faq_realism: {
        type: 'integer',
        description: '0-10. Are FAQ questions things real users actually search ("People also ask" style)? Penalise if questions are pretextual or contain unverifiable claims (e.g. "instant 5-minute delivery" without source).',
      },
      redflags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific issues with the brief — short imperative phrases. Examples: "FAQ #2 hallucinates 5-minute delivery (unverifiable)", "outline section 3 is generic boilerplate".',
      },
      reasoning: {
        type: 'string',
        description: '1-2 sentence overall justification.',
      },
    },
    required: ['coverage', 'intent_match', 'keyword_grounding', 'faq_realism', 'redflags', 'reasoning'],
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
        breakdown = await judgeBrief(brief)
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

      const total = breakdown.coverage + breakdown.intent_match + breakdown.keyword_grounding + breakdown.faq_realism
      const score = Math.round((total / 40) * 100)
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

async function judgeBrief(brief: BriefRow): Promise<ScoreBreakdown> {
  const prompt = `You are a strict SEO content quality reviewer for G2G.com (a peer-to-peer gaming marketplace).

Evaluate the following brief and call submit_brief_review with structured scores.

PRIMARY KEYWORD: "${brief.primary_keyword ?? '(missing)'}"
TARGET PAGE: ${brief.page ?? '(missing)'}
BRIEF TYPE: ${brief.brief_type ?? 'on_page'}

CONTENT DRAFT:
${brief.content_draft ?? '(empty)'}

CONTENT OUTLINE:
${JSON.stringify(brief.content_outline, null, 2)}

TARGET KEYWORDS (new_keywords):
${JSON.stringify(brief.new_keywords, null, 2)}

FAQ SUGGESTIONS:
${JSON.stringify(brief.faq_suggestions, null, 2)}

Scoring rules — be strict, not generous:
- A score of 7-8 means "solid, ready to publish".
- A score of 9-10 should be rare and reserved for briefs that demonstrably nail intent + grounding.
- Penalise: generic intros ("What is X?" as section 1 for clearly transactional intent), padded keyword lists ("buy X cheap" + "cheap X" + "X cheap" all listed), FAQs with unverifiable claims (specific timings, prices, guarantees not in the brief context).
- Reward: outlines that lead with what the user came for (price/listings/trust), keywords with semantic variation, FAQs that mirror real "People also ask" patterns.

In redflags, be specific — name the section, FAQ number, or keyword. Vague redflags ("could be better") are useless.`

  const res = await anthropic.messages.create({
    model:       MODEL,
    max_tokens:  1024,
    tools:       [judgeTool],
    tool_choice: { type: 'tool', name: 'submit_brief_review' },
    messages:    [{ role: 'user', content: prompt }],
  })

  const toolUse = res.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error(`Claude did not call submit_brief_review (stop_reason=${res.stop_reason})`)
  }

  const raw = toolUse.input as Record<string, unknown>
  const num = (v: unknown) => Math.max(0, Math.min(10, Math.round(Number(v) || 0)))
  const arr = (v: unknown) => Array.isArray(v) ? v.map(String) : []

  return {
    coverage:          num(raw.coverage),
    intent_match:      num(raw.intent_match),
    keyword_grounding: num(raw.keyword_grounding),
    faq_realism:       num(raw.faq_realism),
    redflags:          arr(raw.redflags),
    reasoning:         String(raw.reasoning ?? ''),
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
