/**
 * /api/reports/ai-visibility/recommend
 *
 * Sprint: SKILL.AI_VIS.1
 * Skill:  searchfit-seo:ai-visibility
 *
 * GET  — return latest saved recommendations for the active site.
 * POST — generate new recommendations via Claude Haiku using the
 *        ai-visibility skill methodology, validate, and persist.
 *
 * Kill switch: SKILL_AI_VIS_RECOMMENDATIONS_ENABLED (default true).
 *
 * Design rules (from universal constraints):
 *   - Output saved to DB — no regeneration on page load.
 *   - Retry + 25 s timeout per attempt (max 3 attempts).
 *   - Attribution string embedded in every response.
 *   - Validation: each rec must start with action verb + include measurable metric.
 *   - Max 5 recommendations stored.
 *   - Skip generation if snapshot_date matches latest saved (unless force=true).
 */

import { NextRequest, NextResponse } from 'next/server'
import Anthropic                     from '@anthropic-ai/sdk'
import { createClient }              from '@/lib/supabase/server'
import { createServiceClient }       from '@/lib/supabase/service'
import { buildAiVisibilityOverview } from '@/lib/agents/freyja'
import type { AiVisibilityOverview } from '@/lib/agents/freyja'

// ── Constants ─────────────────────────────────────────────────────────────────

const SKILL_NAME      = 'searchfit-seo:ai-visibility'
const MODEL           = 'claude-haiku-4-5-20251001'
const MAX_TOKENS      = 1200
const TIMEOUT_MS      = 25_000
const MAX_ATTEMPTS    = 3
const BASE_BACKOFF_MS = 700    // 700ms, 1.4s, 2.8s
const MAX_RECS        = 5
const WINDOW_DAYS     = 84     // match what the Freyja page shows by default

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Types ─────────────────────────────────────────────────────────────────────

interface Recommendation {
  title:     string
  action:    string
  metric:    string
  rationale: string
  priority:  'high' | 'medium' | 'low'
  dimension: 'content' | 'technical' | 'authority' | 'prompt_optimization'
}

// Action verbs that MUST start each recommendation (spec requirement)
const ACTION_VERBS = new Set([
  'create', 'optimize', 'add', 'update', 'publish', 'build', 'launch',
  'write', 'develop', 'implement', 'improve', 'expand', 'generate',
  'establish', 'increase', 'reduce', 'fix', 'audit', 'produce', 'start',
  'set', 'run', 'submit', 'earn', 'target', 'track', 'monitor',
])

function isValidRec(r: unknown): r is Recommendation {
  if (!r || typeof r !== 'object') return false
  const rec = r as Record<string, unknown>
  if (typeof rec.title   !== 'string' || !rec.title.trim())  return false
  if (typeof rec.action  !== 'string' || !rec.action.trim()) return false
  if (typeof rec.metric  !== 'string' || !rec.metric.trim()) return false
  // Must start with a recognised action verb
  const firstWord = rec.action.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '')
  if (!ACTION_VERBS.has(firstWord)) return false
  return true
}

// ── Prompt builder (ai-visibility skill methodology, G2G context) ─────────────

function buildPrompt(siteSlug: string, overview: AiVisibilityOverview, snapshotDate: string): string {
  const { totals, per_llm, trend } = overview

  // Trend direction from first → last data point
  const mentionsTrend =
    trend.length >= 2
      ? trend[trend.length - 1].mentions > trend[0].mentions
        ? 'increasing over the period'
        : trend[trend.length - 1].mentions < trend[0].mentions
          ? 'declining over the period'
          : 'flat'
      : 'insufficient data'

  // Top 3 sources by citations for the prompt context
  const topSources = per_llm
    .slice(0, 3)
    .map(p => {
      const wowCite = p.citations_wow_pct != null
        ? ` (WoW ${p.citations_wow_pct > 0 ? '+' : ''}${p.citations_wow_pct.toFixed(1)}%)`
        : ''
      return `  • ${p.label}: ${p.latest_mentions.toLocaleString()} mentions, ${p.latest_citations.toLocaleString()} citations${wowCite}`
    })
    .join('\n')

  const brandInfo =
    siteSlug === 'g2g'
      ? 'G2G (g2g.com) — peer-to-peer gaming marketplace for buying and selling game accounts, items, in-game currency, and services. Primary markets: United States and Indonesia.'
      : siteSlug === 'offgamers'
        ? 'OffGamers (offgamers.com) — digital goods marketplace specialising in gaming gift cards, top-ups, and game currencies.'
        : `${siteSlug} — gaming marketplace.`

  return `You are an AI visibility strategist advising ${brandInfo}

CURRENT AI VISIBILITY METRICS (snapshot date: ${snapshotDate}, window: last ${WINDOW_DAYS} days):
- Total Mentions across all LLM sources: ${totals.mentions.toLocaleString()}
- Total Citations: ${totals.citations.toLocaleString()}
- Distinct Cited Pages: ${totals.cited_pages.toLocaleString()}
- Mentions trend: ${mentionsTrend}
- Top sources by citations:
${topSources || '  (no source data yet)'}

Generate exactly 3–5 specific, actionable AI visibility recommendations for this brand.

STRICT RULES:
1. EVERY recommendation must start with an action verb (Create, Optimize, Add, Update, Publish, Build, Improve, Expand, Establish, Audit, etc.)
2. EVERY recommendation must include a measurable target (e.g. "publish 8 comparison articles", "increase citations by 20%", "add FAQ schema to 50 category pages")
3. Tailor specifically to a gaming marketplace context — no generic advice
4. Focus on: content gaps that LLMs under-cite, schema/structured data for products, community/review signals, comparison/alternative articles, FAQ coverage for common gamer queries
5. Do NOT suggest Wikipedia (requires notability gates), adding "website speed" without specifics, or anything already standard for e-commerce

Return ONLY a raw JSON array — no markdown, no code fences, no explanation:
[
  {
    "title": "Short imperative title (max 8 words)",
    "action": "Full recommendation starting with an action verb, with specific details relevant to ${siteSlug === 'g2g' ? 'G2G' : siteSlug}",
    "metric": "Measurable success target (quantity, percentage, or threshold)",
    "rationale": "1–2 sentences: why this specifically improves AI citation rate for this brand",
    "priority": "high",
    "dimension": "content"
  }
]

Valid priority values: "high" | "medium" | "low"
Valid dimension values: "content" | "technical" | "authority" | "prompt_optimization"`
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — return latest saved recommendations
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (process.env.SKILL_AI_VIS_RECOMMENDATIONS_ENABLED === 'false') {
    return NextResponse.json({ ok: false, disabled: true, skill: SKILL_NAME })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const siteSlug = req.nextUrl.searchParams.get('site') ?? 'g2g'
  const db       = createServiceClient()

  const { data, error } = await db
    .from('skill_ai_vis_recommendations')
    .select('id, snapshot_date, recommendations, generated_at')
    .eq('owner_user_id', user.id)
    .eq('site_slug', siteSlug)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    ok:         true,
    skill:      SKILL_NAME,
    record:     data ?? null,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — generate (or serve cached) recommendations
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (process.env.SKILL_AI_VIS_RECOMMENDATIONS_ENABLED === 'false') {
    return NextResponse.json({
      ok:       false,
      disabled: true,
      skill:    SKILL_NAME,
      error:    'Skill disabled via SKILL_AI_VIS_RECOMMENDATIONS_ENABLED',
    }, { status: 503 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const ownerId = user.id

  // ── Parse body ────────────────────────────────────────────────────────────
  const body = await req.json().catch(() => ({})) as {
    snapshot_date?: string
    site?:          string
    force?:         boolean
  }
  const siteSlug = body.site ?? req.nextUrl.searchParams.get('site') ?? 'g2g'
  const forced   = body.force === true
  const db       = createServiceClient()

  // ── 1. Load AI visibility overview ────────────────────────────────────────
  let overview: AiVisibilityOverview
  try {
    overview = await buildAiVisibilityOverview(db, ownerId, siteSlug, WINDOW_DAYS)
  } catch (e) {
    return NextResponse.json({
      ok:    false,
      skill: SKILL_NAME,
      error: `Failed to load AI visibility data: ${e instanceof Error ? e.message : String(e)}`,
    }, { status: 500 })
  }

  if (!overview.data_freshness.latest) {
    return NextResponse.json({
      ok:    false,
      skill: SKILL_NAME,
      error: 'No AI visibility snapshot data found. Import snapshots first via the Import section.',
    }, { status: 400 })
  }

  const snapshotDate = body.snapshot_date ?? overview.data_freshness.latest

  // ── 2. Cache check — skip if same snapshot_date already saved ─────────────
  if (!forced) {
    const { data: existing } = await db
      .from('skill_ai_vis_recommendations')
      .select('id, snapshot_date, recommendations, generated_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .eq('snapshot_date', snapshotDate)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existing) {
      return NextResponse.json({
        ok:     true,
        cached: true,
        skill:  SKILL_NAME,
        record: existing,
      })
    }
  }

  // ── 3. Build prompt ───────────────────────────────────────────────────────
  const prompt = buildPrompt(siteSlug, overview, snapshotDate)

  // ── 4. Call Claude Haiku with retry + 25 s timeout ────────────────────────
  let rawOutput: string | null = null
  let lastError: string        = 'Unknown error'

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, BASE_BACKOFF_MS * attempt))
    }
    try {
      const resp = await anthropic.messages.create(
        {
          model:      MODEL,
          max_tokens: MAX_TOKENS,
          system:     'You are an AI visibility strategist. Output ONLY valid JSON as instructed — no markdown, no preamble.',
          messages:   [{ role: 'user', content: prompt }],
        },
        { timeout: TIMEOUT_MS },
      )
      const text = resp.content.find(c => c.type === 'text')?.text ?? ''
      if (text.trim()) { rawOutput = text; break }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }

  if (!rawOutput) {
    return NextResponse.json({
      ok:    false,
      skill: SKILL_NAME,
      error: `Claude call failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}`,
    }, { status: 500 })
  }

  // ── 5. Parse + validate ───────────────────────────────────────────────────
  let recs: Recommendation[]
  try {
    // Strip accidental markdown code fences if model adds them
    const cleaned = rawOutput
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()

    const parsed = JSON.parse(cleaned) as unknown
    if (!Array.isArray(parsed)) throw new Error('Expected JSON array at root')

    recs = (parsed as unknown[]).filter(isValidRec).slice(0, MAX_RECS)

    if (recs.length === 0) {
      throw new Error('No valid recommendations survived validation (missing action verb or metric)')
    }
  } catch (e) {
    return NextResponse.json({
      ok:    false,
      skill: SKILL_NAME,
      error: `Failed to parse skill output: ${e instanceof Error ? e.message : String(e)}`,
      raw:   rawOutput.slice(0, 500),   // truncated for debugging, never expose full prompt
    }, { status: 500 })
  }

  // ── 6. Persist to DB ──────────────────────────────────────────────────────
  const { data: saved, error: saveErr } = await db
    .from('skill_ai_vis_recommendations')
    .insert({
      owner_user_id:   ownerId,
      site_slug:       siteSlug,
      snapshot_date:   snapshotDate,
      recommendations: recs,
    })
    .select('id, snapshot_date, recommendations, generated_at')
    .single()

  if (saveErr) {
    return NextResponse.json({
      ok:    false,
      skill: SKILL_NAME,
      error: `Saved to DB failed: ${saveErr.message}`,
    }, { status: 500 })
  }

  return NextResponse.json({
    ok:     true,
    cached: false,
    skill:  SKILL_NAME,
    record: saved,
  })
}
