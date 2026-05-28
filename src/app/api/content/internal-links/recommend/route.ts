/**
 * /api/content/internal-links/recommend
 *
 * Sprint: SKILL.INTLINK.1
 * Skill:  searchfit-seo:internal-linking
 *
 * GET  — return latest saved recommendations for the active site.
 * POST — generate new strategic internal-linking recommendations via Claude
 *        Haiku, using the internal-linking skill methodology.
 *
 * Rate limit: 1 generation per 7 days per (owner, site), unless force=true.
 * Kill switch: SKILL_INTLINK_AUDIT_ENABLED (default true).
 *
 * Design rules (universal constraints):
 *   - DB-persisted output — no regeneration on page load.
 *   - Retry + 25 s timeout per attempt (max 3 attempts).
 *   - Attribution string embedded in every response.
 *   - Validation: each rec action must start with action verb.
 *   - Max 5 recommendations stored.
 *
 * The page passes the current link-analysis summary in the POST body so this
 * route does not need to re-query DataForSEO or the keyword_map tables.
 */

import { NextRequest, NextResponse } from 'next/server'
import Anthropic                     from '@anthropic-ai/sdk'
import { createClient }              from '@/lib/supabase/server'
import { createServiceClient }       from '@/lib/supabase/service'
import { getEffectiveOwnerId }       from '@/lib/workspace'

// ── Constants ─────────────────────────────────────────────────────────────────

const SKILL_NAME      = 'searchfit-seo:internal-linking'
const MODEL           = 'claude-haiku-4-5-20251001'
const MAX_TOKENS      = 1500
const TIMEOUT_MS      = 25_000
const MAX_ATTEMPTS    = 3
const BASE_BACKOFF_MS = 700
const MAX_RECS        = 5
const RATE_LIMIT_DAYS = 7

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Types ─────────────────────────────────────────────────────────────────────

interface IntlinkRecommendation {
  title:     string
  action:    string
  target:    string
  priority:  'high' | 'medium' | 'low'
  category:  'orphan_fix' | 'hub_spoke' | 'cluster_link' | 'anchor_text' | 'equity_flow'
}

// Action verbs that MUST start each recommendation (spec requirement)
const ACTION_VERBS = new Set([
  'create', 'optimize', 'add', 'update', 'publish', 'build', 'launch',
  'write', 'develop', 'implement', 'improve', 'expand', 'generate',
  'establish', 'increase', 'reduce', 'fix', 'audit', 'produce', 'start',
  'set', 'run', 'submit', 'earn', 'target', 'track', 'monitor', 'link',
  'connect', 'merge', 'consolidate', 'restructure', 'prioritize',
])

function isValidRec(r: unknown): r is IntlinkRecommendation {
  if (!r || typeof r !== 'object') return false
  const rec = r as Record<string, unknown>
  if (typeof rec.title  !== 'string' || !rec.title.trim())  return false
  if (typeof rec.action !== 'string' || !rec.action.trim()) return false
  if (typeof rec.target !== 'string')                        return false
  const firstWord = rec.action.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '')
  if (!ACTION_VERBS.has(firstWord)) return false
  return true
}

// ── Prompt builder ────────────────────────────────────────────────────────────

interface SiteSummary {
  totalCrawledPages: number
  orphanCount:       number
  opportunityCount:  number
  avgInlinks:        number
  wellLinked:        number
}

interface OrphanHint {
  keyword:  string
  url_slug: string
  inlinks:  number
}

interface OpportunityHint {
  from_keyword: string
  to_keyword:   string
  reason:       string
}

function buildPrompt(
  siteSlug:      string,
  summary:       SiteSummary,
  topOrphans:    OrphanHint[],
  topOpps:       OpportunityHint[],
): string {
  const brandInfo = siteSlug === 'g2g'
    ? 'G2G (g2g.com) — peer-to-peer gaming marketplace for buying/selling game accounts, in-game items, in-game currency, and carry services. Hub pages are game category pages (e.g. "buy Genshin Impact top up"). Cluster pages are sub-categories (specific items, characters, servers).'
    : siteSlug === 'offgamers'
      ? 'OffGamers (offgamers.com) — digital goods marketplace for gaming gift cards, top-ups, and game currencies.'
      : `${siteSlug} — gaming marketplace.`

  const orphanSection = topOrphans.length
    ? topOrphans.map(o => `  • "${o.keyword}" (${o.url_slug}) — ${o.inlinks} inbound links`).join('\n')
    : '  (none)'

  const oppSection = topOpps.length
    ? topOpps.map(o => `  • "${o.from_keyword}" → "${o.to_keyword}" [${o.reason}]`).join('\n')
    : '  (none)'

  return `You are an internal linking strategist advising ${brandInfo}

CURRENT INTERNAL LINK METRICS:
- Total crawled pages: ${summary.totalCrawledPages.toLocaleString()}
- Orphan pages (< 3 inlinks): ${summary.orphanCount}
- Link opportunities detected: ${summary.opportunityCount}
- Average inbound links per page: ${summary.avgInlinks.toFixed(1)}
- Well-linked pages: ${summary.wellLinked}

TOP ORPHAN PAGES (most in need of inbound links):
${orphanSection}

TOP LINK OPPORTUNITIES (missing pillar↔cluster links):
${oppSection}

Generate exactly 3–5 strategic internal-linking recommendations for this gaming marketplace.

STRICT RULES:
1. EVERY recommendation must start with an action verb (Add, Link, Create, Build, Consolidate, Restructure, Prioritize, etc.)
2. EVERY recommendation must reference a specific page type, cluster, or pattern from the data above
3. Tailor specifically to a gaming marketplace context — hub pages = major game categories, spokes = item types / servers / currencies
4. Focus on: fixing the highest-traffic orphan pages, completing pillar↔cluster link pairs, improving anchor text for game-specific queries, equity flow from high-inlink game hubs
5. Do NOT give generic advice like "add more links" without specifying which pages or clusters

Return ONLY a raw JSON array — no markdown, no code fences, no explanation:
[
  {
    "title": "Short imperative title (max 8 words)",
    "action": "Full recommendation starting with an action verb, with specific page types or keywords from the data",
    "target": "Which page(s) or cluster to focus on first (e.g. 'Genshin Impact hub page', 'all Top Up category pages')",
    "priority": "high",
    "category": "orphan_fix"
  }
]

Valid priority values: "high" | "medium" | "low"
Valid category values: "orphan_fix" | "hub_spoke" | "cluster_link" | "anchor_text" | "equity_flow"`
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — return latest saved recommendations
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (process.env.SKILL_INTLINK_AUDIT_ENABLED === 'false') {
    return NextResponse.json({ ok: false, disabled: true, skill: SKILL_NAME })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = req.nextUrl.searchParams.get('site') ?? 'g2g'
  const db       = createServiceClient()

  const { data, error } = await db
    .from('skill_intlink_recommendations')
    .select('id, generated_at, orphan_count, opportunity_count, total_pages, avg_inlinks, recommendations')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  return NextResponse.json({
    ok:          true,
    skill:       SKILL_NAME,
    record:      data ?? null,
    attribution: `Generated via Anthropic skill: ${SKILL_NAME} · Model: ${MODEL.replace('-20251001', '')}`,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — generate (or serve rate-limited cached) recommendations
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (process.env.SKILL_INTLINK_AUDIT_ENABLED === 'false') {
    return NextResponse.json({
      ok:       false,
      disabled: true,
      skill:    SKILL_NAME,
      error:    'Skill disabled via SKILL_INTLINK_AUDIT_ENABLED',
    }, { status: 503 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const body = await req.json().catch(() => ({})) as {
    site?:         string
    force?:        boolean
    summary?:      SiteSummary
    top_orphans?:  OrphanHint[]
    top_opps?:     OpportunityHint[]
  }
  const siteSlug = body.site ?? req.nextUrl.searchParams.get('site') ?? 'g2g'
  const forced   = body.force === true
  const db       = createServiceClient()

  // ── Rate limit check — 1x per 7 days ──────────────────────────────────────
  if (!forced) {
    const cutoff = new Date(Date.now() - RATE_LIMIT_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const { data: recent } = await db
      .from('skill_intlink_recommendations')
      .select('id, generated_at, orphan_count, opportunity_count, total_pages, avg_inlinks, recommendations')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .gte('generated_at', cutoff)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (recent) {
      return NextResponse.json({
        ok:          true,
        cached:      true,
        rate_limited: true,
        skill:       SKILL_NAME,
        record:      recent,
        message:     `Recommendations were generated ${Math.round((Date.now() - new Date(recent.generated_at as string).getTime()) / 86_400_000)} day(s) ago. Use force=true to regenerate.`,
        attribution: `Generated via Anthropic skill: ${SKILL_NAME} · Model: ${MODEL.replace('-20251001', '')}`,
      })
    }
  }

  // ── Validate we have enough data ──────────────────────────────────────────
  const summary    = body.summary
  const topOrphans = body.top_orphans  ?? []
  const topOpps    = body.top_opps     ?? []

  if (!summary || summary.totalCrawledPages < 1) {
    return NextResponse.json({
      ok:    false,
      skill: SKILL_NAME,
      error: 'No site data provided. Run a site audit first and wait for the internal links page to load.',
    }, { status: 400 })
  }

  // ── Build prompt + call Claude Haiku ──────────────────────────────────────
  const prompt = buildPrompt(siteSlug, summary, topOrphans, topOpps)

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
          system:     'You are an internal linking strategist. Output ONLY valid JSON as instructed — no markdown, no preamble.',
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

  // ── Parse + validate ───────────────────────────────────────────────────────
  let recs: IntlinkRecommendation[]
  try {
    const cleaned = rawOutput
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()

    const parsed = JSON.parse(cleaned) as unknown
    if (!Array.isArray(parsed)) throw new Error('Expected JSON array at root')

    recs = (parsed as unknown[]).filter(isValidRec).slice(0, MAX_RECS)
    if (recs.length === 0) {
      throw new Error('No valid recommendations survived validation (missing action verb)')
    }
  } catch (e) {
    return NextResponse.json({
      ok:    false,
      skill: SKILL_NAME,
      error: `Failed to parse skill output: ${e instanceof Error ? e.message : String(e)}`,
      raw:   rawOutput.slice(0, 300),
    }, { status: 500 })
  }

  // ── Persist ────────────────────────────────────────────────────────────────
  const { data: saved, error: saveErr } = await db
    .from('skill_intlink_recommendations')
    .insert({
      owner_user_id:    ownerId,
      site_slug:        siteSlug,
      orphan_count:     summary.orphanCount,
      opportunity_count: summary.opportunityCount,
      total_pages:      summary.totalCrawledPages,
      avg_inlinks:      summary.avgInlinks,
      recommendations:  recs,
    })
    .select('id, generated_at, orphan_count, opportunity_count, total_pages, avg_inlinks, recommendations')
    .single()

  if (saveErr) {
    return NextResponse.json({
      ok:    false,
      skill: SKILL_NAME,
      error: `DB save failed: ${saveErr.message}`,
    }, { status: 500 })
  }

  return NextResponse.json({
    ok:          true,
    cached:      false,
    skill:       SKILL_NAME,
    record:      saved,
    attribution: `Generated via Anthropic skill: ${SKILL_NAME} · Model: ${MODEL.replace('-20251001', '')}`,
  })
}
