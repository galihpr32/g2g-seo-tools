/**
 * /api/site-health/broken-internal
 *
 * Sprint: SKILL.BROKENLINK.1
 * Skill:  searchfit-seo:broken-links
 *
 * GET  — return the latest saved audit for the active site.
 * POST — run a fresh broken-link audit:
 *          1. Collect internal URLs from seo_content_briefs + tier_serp_snapshots
 *          2. HEAD-check each URL in batches (max 200, concurrent 10, 10s timeout)
 *          3. Categorise: broken (4xx/5xx) | redirect (3xx) | ok (2xx) | error
 *          4. Persist to skill_broken_audits
 *          5. Return the saved record
 *
 * Kill switch: SKILL_BROKENLINK_AUDIT_ENABLED (default true).
 *
 * Note on SPA pages (G2G): HEAD requests check the HTTP layer only.
 * G2G category pages return 200 for the SPA shell even for invalid game slugs,
 * so this tool catches genuine HTTP-level issues (decommissioned URLs, server
 * errors, redirect chains) but cannot detect client-side "game not found" 404s.
 *
 * Design rules (universal constraints):
 *   - DB-persisted output — no re-run on page load.
 *   - Attribution string embedded in every response.
 *   - Kill switch env var checked server-side.
 *   - Migration prefix: skill_<area>_<purpose>.sql ✓
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'
import { createServiceClient }       from '@/lib/supabase/service'
import { getEffectiveOwnerId }       from '@/lib/workspace'

export const maxDuration = 60

// ── Constants ─────────────────────────────────────────────────────────────────

const SKILL_NAME       = 'searchfit-seo:broken-links'
const MAX_URLS         = 200   // cap per audit run to stay within lambda budget
const CONCURRENCY      = 10   // parallel HEAD requests
const HEAD_TIMEOUT_MS  = 10_000

// ── Types ─────────────────────────────────────────────────────────────────────

type UrlCategory = 'broken' | 'redirect' | 'ok' | 'error'

interface UrlSource {
  url:          string
  source:       'seo_content_briefs' | 'tier_serp_snapshots'
  source_label: string   // brief primary_keyword or SERP keyword
}

interface CheckResult extends UrlSource {
  status:         number | null
  status_text:    string
  category:       UrlCategory
  fix_suggestion: string
}

// ── URL collection ─────────────────────────────────────────────────────────────

async function collectUrls(
  db: ReturnType<typeof createServiceClient>,
  ownerId: string,
  siteSlug: string,
): Promise<UrlSource[]> {
  const sources: UrlSource[] = []
  const seen = new Set<string>()

  // ── Source 1: seo_content_briefs.page ────────────────────────────────────
  const { data: briefs } = await db
    .from('seo_content_briefs')
    .select('id, page, primary_keyword, status')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .not('page', 'is', null)
    .neq('page', '')
    .in('status', ['draft', 'in_review', 'approved', 'published'])
    .order('updated_at', { ascending: false })
    .limit(150)

  for (const b of briefs ?? []) {
    const url = (b.page as string).trim()
    if (!url.startsWith('http')) continue
    if (seen.has(url)) continue
    seen.add(url)
    sources.push({
      url,
      source:       'seo_content_briefs',
      source_label: (b.primary_keyword as string) || url,
    })
  }

  // ── Source 2: tier_serp_snapshots.our_url (latest per keyword) ────────────
  // Pull the most recent snapshot per (product_tier_id, keyword) using a
  // DISTINCT ON to avoid duplicates. our_url is non-null only when we rank.
  const { data: snapshots } = await db
    .from('tier_serp_snapshots')
    .select('keyword, our_url, snapshot_date')
    .eq('owner_user_id', ownerId)
    .not('our_url', 'is', null)
    .neq('our_url', '')
    .order('snapshot_date', { ascending: false })
    .limit(300)   // fetch more, deduplicate below

  for (const s of snapshots ?? []) {
    const url = (s.our_url as string).trim()
    if (!url.startsWith('http')) continue
    if (seen.has(url)) continue
    seen.add(url)
    sources.push({
      url,
      source:       'tier_serp_snapshots',
      source_label: (s.keyword as string) || url,
    })
  }

  return sources.slice(0, MAX_URLS)
}

// ── HTTP check ────────────────────────────────────────────────────────────────

function fixSuggestion(
  status:      number | null,
  category:    UrlCategory,
  source:      UrlSource['source'],
  sourceLabel: string,
): string {
  const label = sourceLabel ? `"${sourceLabel}"` : 'this entry'

  if (category === 'ok') return 'No action needed.'

  if (category === 'redirect') {
    return source === 'seo_content_briefs'
      ? `Brief ${label}: update the \`page\` field to the final redirect destination (skip the chain).`
      : `Keyword ${label}: update the tracked URL to its final destination to avoid redirect overhead.`
  }

  if (category === 'broken') {
    const code = status ?? 0
    if (code === 404 || code === 410) {
      return source === 'seo_content_briefs'
        ? `Brief ${label}: page no longer exists (${code}). Archive/delete this brief or update \`page\` to a valid URL.`
        : `Keyword ${label}: ranked URL returns ${code}. Page was likely removed — add a 301 redirect or retire this keyword from the tracker.`
    }
    if (code >= 500) {
      return `${source === 'seo_content_briefs' ? 'Brief' : 'Keyword'} ${label}: server error (${code}) — check deployment status. May be transient; re-audit to confirm.`
    }
    return `${source === 'seo_content_briefs' ? 'Brief' : 'Keyword'} ${label}: unexpected status (${code ?? 'unknown'}) — investigate server-side and add a redirect or remove the reference.`
  }

  // error / timeout
  return `${source === 'seo_content_briefs' ? 'Brief' : 'Keyword'} ${label}: request timed out or failed — page may be unreachable. Re-audit after checking site connectivity.`
}

async function checkUrl(src: UrlSource): Promise<CheckResult> {
  let status: number | null = null
  let status_text = 'error'
  let category: UrlCategory = 'error'

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS)

    const res = await fetch(src.url, {
      method:   'HEAD',
      redirect: 'manual',   // capture 3xx without following
      signal:   controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; G2G-SEO-Tools/1.0; +https://g2g.com)',
      },
    })
    clearTimeout(timer)

    status      = res.status
    status_text = `${res.status} ${res.statusText || ''}`

    if (status >= 200 && status < 300) {
      category = 'ok'
    } else if (status >= 300 && status < 400) {
      category = 'redirect'
    } else if (status >= 400) {
      category = 'broken'
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      status_text = 'timeout'
    } else {
      status_text = e instanceof Error ? e.message.slice(0, 80) : 'error'
    }
    category = 'error'
  }

  return {
    ...src,
    status,
    status_text,
    category,
    fix_suggestion: fixSuggestion(status, category, src.source, src.source_label),
  }
}

async function checkBatch(sources: UrlSource[]): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const batch   = sources.slice(i, i + CONCURRENCY)
    const checked = await Promise.all(batch.map(checkUrl))
    results.push(...checked)
  }
  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — return latest saved audit
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (process.env.SKILL_BROKENLINK_AUDIT_ENABLED === 'false') {
    return NextResponse.json({ ok: false, disabled: true, skill: SKILL_NAME })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = req.nextUrl.searchParams.get('site') ?? 'g2g'
  const db       = createServiceClient()

  const { data, error } = await db
    .from('skill_broken_audits')
    .select('id, audited_at, total_checked, broken_count, redirect_count, ok_count, urls_collected, results')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('audited_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  return NextResponse.json({
    ok:          true,
    skill:       SKILL_NAME,
    record:      data ?? null,
    attribution: `Generated via Anthropic skill: ${SKILL_NAME}`,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — run a fresh audit
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (process.env.SKILL_BROKENLINK_AUDIT_ENABLED === 'false') {
    return NextResponse.json({
      ok:       false,
      disabled: true,
      skill:    SKILL_NAME,
      error:    'Skill disabled via SKILL_BROKENLINK_AUDIT_ENABLED',
    }, { status: 503 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body    = await req.json().catch(() => ({})) as { site?: string }
  const siteSlug = body.site ?? req.nextUrl.searchParams.get('site') ?? 'g2g'
  const db      = createServiceClient()

  // ── 1. Collect URLs ────────────────────────────────────────────────────────
  const sources        = await collectUrls(db, ownerId, siteSlug)
  const urlsCollected  = sources.length

  if (urlsCollected === 0) {
    return NextResponse.json({
      ok:    false,
      skill: SKILL_NAME,
      error: 'No internal URLs found. Add content briefs with a `page` URL or run the tier SERP tracker first.',
    }, { status: 400 })
  }

  // ── 2. HEAD-check URLs in concurrent batches ───────────────────────────────
  const results = await checkBatch(sources)

  // ── 3. Compute summary counters ────────────────────────────────────────────
  const broken_count   = results.filter(r => r.category === 'broken' || r.category === 'error').length
  const redirect_count = results.filter(r => r.category === 'redirect').length
  const ok_count       = results.filter(r => r.category === 'ok').length

  // ── 4. Persist ─────────────────────────────────────────────────────────────
  const { data: saved, error: saveErr } = await db
    .from('skill_broken_audits')
    .insert({
      owner_user_id:  ownerId,
      site_slug:      siteSlug,
      total_checked:  results.length,
      broken_count,
      redirect_count,
      ok_count,
      urls_collected: urlsCollected,
      results,
    })
    .select('id, audited_at, total_checked, broken_count, redirect_count, ok_count, urls_collected, results')
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
    skill:       SKILL_NAME,
    record:      saved,
    attribution: `Generated via Anthropic skill: ${SKILL_NAME}`,
  })
}
