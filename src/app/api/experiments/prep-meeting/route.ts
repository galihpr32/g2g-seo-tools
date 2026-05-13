import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 90

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const PREP_MODEL = 'claude-sonnet-4-6'

/**
 * POST /api/experiments/prep-meeting
 *
 * End-of-month prep: for every active 'continue' experiment, build an
 * evidence card containing:
 *   - baseline / current / target values (already in DB)
 *   - movement summary (how far we've come, how far we still need to go)
 *   - Sonnet recommendation: continue / stop / inconclusive
 *   - 1-paragraph rationale citing the specific evidence
 *
 * Used by Head before the monthly stop/continue meeting (Workflow #4 step
 * 4.4). Turns a 60-minute discussion into a 30-minute review.
 *
 * Cost: ~$0.05-0.20 per run depending on # active experiments.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const body     = await req.json().catch(() => ({}))
  const siteSlug = resolveSiteSlugFromRequest(req, body)
  const db       = createServiceClient()

  // Pull active experiments (start + continue) with enough metric context
  // to make a recommendation
  const { data: experiments, error: expErr } = await db
    .from('experiments')
    .select('id, title, hypothesis, success_metric, baseline_value, target_value, current_value, linked_keywords, period_started, status')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .in('status', ['start', 'continue'])
    .order('updated_at', { ascending: false })
    .limit(20)

  if (expErr) return NextResponse.json({ error: expErr.message }, { status: 500 })
  if (!experiments || experiments.length === 0) {
    return NextResponse.json({ ok: true, evidenceCards: [], message: 'No active experiments.' })
  }

  // Build a single batch prompt — one Sonnet call analyzes all experiments
  // at once and returns one card per experiment in JSON. Cheaper than
  // per-experiment calls + lets Sonnet cross-reference patterns.
  const expBlock = experiments.map(e => {
    const movement = (e.baseline_value != null && e.current_value != null)
      ? Number(e.baseline_value) - Number(e.current_value)
      : null
    const towardTarget = (e.target_value != null && e.current_value != null && e.baseline_value != null)
      ? ((Number(e.baseline_value) - Number(e.current_value)) / (Number(e.baseline_value) - Number(e.target_value))) * 100
      : null
    return `id: ${e.id}
status: ${e.status}
title: ${e.title}
hypothesis: ${e.hypothesis ?? '(none)'}
success_metric: ${e.success_metric ?? '(none)'}
baseline → target: ${e.baseline_value ?? '?'} → ${e.target_value ?? '?'}
current: ${e.current_value ?? '(no data yet)'}
movement: ${movement != null ? (movement > 0 ? `improved ${movement.toFixed(1)}` : `regressed ${Math.abs(movement).toFixed(1)}`) : 'n/a'}
toward_target: ${towardTarget != null ? `${towardTarget.toFixed(0)}% of the way` : 'n/a'}
since: ${e.period_started}
linked_keywords: ${(e.linked_keywords as string[] ?? []).slice(0, 5).join(', ') || '(none)'}`
  }).join('\n\n---\n\n')

  const prompt = `You are MIMIR preparing the end-of-month experiment review for a fellow SEO team. Below are ${experiments.length} active experiments. For EACH, return an evidence card with a recommendation.

DECISION RULES:
  • CONTINUE — current_value is moving toward target (≥ 25% of the way) AND period_started < 60 days ago
  • STOP — clear signal of failure: current_value moved AWAY from target by >5% baseline, OR period_started > 90 days ago without ≥40% progress, OR success_metric clearly missed
  • INCONCLUSIVE — not enough data (current_value null, or period_started < 14 days), OR within ±10% of baseline with no clear signal

OUTPUT — strict JSON array, no fences, no prose:
[
  {
    "id": "<exact uuid from input>",
    "recommendation": "continue" | "stop" | "inconclusive",
    "rationale": "<1 paragraph, 2-4 sentences, specific. Cite the actual numbers. e.g. 'Current avg pos 11.3, baseline was 14.6, target 8 — 47% of the way after 6 weeks. Trajectory healthy. Continue.'>",
    "confidence": 1-5
  }
]

EXPERIMENTS:
${expBlock}`

  let cards: Array<{ id: string; recommendation: 'continue' | 'stop' | 'inconclusive'; rationale: string; confidence: number }> = []
  try {
    const res = await anthropic.messages.create({
      model:      PREP_MODEL,
      max_tokens: 2500,
      messages:   [{ role: 'user', content: prompt }],
    })
    const text = res.content[0]?.type === 'text' ? res.content[0].text.trim() : ''
    const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) throw new Error('Expected array')
    cards = parsed
      .filter((p: unknown): p is Record<string, unknown> => typeof p === 'object' && p !== null && 'id' in p && 'recommendation' in p)
      .map(p => ({
        id:             String(p.id),
        recommendation: (['continue','stop','inconclusive'].includes(p.recommendation as string) ? p.recommendation : 'inconclusive') as 'continue' | 'stop' | 'inconclusive',
        rationale:      String(p.rationale ?? '').trim(),
        confidence:     Math.max(1, Math.min(5, Number(p.confidence) || 3)),
      }))
  } catch (err) {
    return NextResponse.json({
      ok:    false,
      error: `Mimir prep failed: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 502 })
  }

  // Cross-reference cards back to experiment metadata for the response
  const enriched = experiments.map(e => {
    const card = cards.find(c => c.id === String(e.id))
    return {
      experiment: {
        id:             String(e.id),
        title:          String(e.title),
        status:         String(e.status),
        baseline_value: e.baseline_value as number | null,
        target_value:   e.target_value   as number | null,
        current_value:  e.current_value  as number | null,
        period_started: String(e.period_started),
      },
      card: card ?? {
        id: String(e.id),
        recommendation: 'inconclusive' as const,
        rationale: 'Mimir didn\'t produce a card for this experiment.',
        confidence: 1,
      },
    }
  })

  return NextResponse.json({
    ok:             true,
    evidenceCards:  enriched,
    summary: {
      continueCount:    cards.filter(c => c.recommendation === 'continue').length,
      stopCount:        cards.filter(c => c.recommendation === 'stop').length,
      inconclusiveCount: cards.filter(c => c.recommendation === 'inconclusive').length,
    },
    when: new Date().toISOString(),
  })
}
