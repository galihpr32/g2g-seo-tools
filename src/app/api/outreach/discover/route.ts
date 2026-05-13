import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getSerpData } from '@/lib/dataforseo/client'
import {
  evaluateDomain,
  isSkipDomain,
  meetsThreshold,
  HERMOD_SCORE_THRESHOLDS,
  type DomainScore,
  type HermodThreshold,
} from '@/lib/agents/hermod-domain-eval'
import { logApiUsage } from '@/lib/api-logger'

// Hermod v2 — replaces the old SEMrush-backed discovery flow.
//
// Pipeline:
//   1. Pull top 10 organic results for the keyword from DataForSEO SERP Live.
//   2. Drop social media / marketplace / walled-garden domains automatically.
//   3. For each remaining domain, run the Hermod evaluator (FireCrawl scrape
//      + Haiku 5-dim score). Results are cached for 14 days in
//      outreach_domain_scores so a re-search hitting the same domains is
//      effectively free.
//   4. Filter by score threshold (default: balanced, ≥ 6.5).
//   5. Mark which prospects are already in the outreach tracker.
//
// Long-running by design — the evaluator runs Haiku per domain, so the lambda
// budget is bumped to 60s. Caller should expect 15-45s for an uncached search.

export const maxDuration = 60

interface CandidateOut {
  domain:           string
  rankingUrl:       string
  position:         number
  // Hermod v2 score fields
  overallScore:     number
  nicheScore:       number
  qualityScore:     number
  outreachScore:    number
  audienceScore:    number
  trustScore:       number
  outreachAngle:    string
  hasWriteForUs:    boolean
  contactEmail:     string | null
  notes:            string
  cached:           boolean
  evaluatedAt:      string
  // Legacy fields kept for backward-compat with existing UI
  organicTraffic:   number
  organicKeywords:  number
  authorityScore:   number
  // Tracker status
  inTracker:        boolean
  trackerStatus:    string | null
  belowThreshold:   boolean
}

// GET /api/outreach/discover?keyword=...&threshold=balanced&locationCode=2840&languageCode=en
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const url           = new URL(req.url)
  const keyword       = url.searchParams.get('keyword')?.trim() ?? ''
  const thresholdName = (url.searchParams.get('threshold') ?? 'balanced') as HermodThreshold
  // Default location/language: US/en (gaming + outreach typically EN-first).
  // Caller can override (e.g. 2360 / 'id' for the Indonesian SERP).
  const locationCode = parseInt(url.searchParams.get('locationCode') ?? '2840', 10)
  const languageCode = url.searchParams.get('languageCode') ?? 'en'
  const includeBelowThreshold = url.searchParams.get('includeBelow') === '1'
  // Site slug — which brand is doing the outreach discovery.
  // Reads from query param first, then active-site cookie, defaults to 'g2g'.
  const cookieSite = req.headers.get('cookie')?.match(/active-site=([^;]+)/)?.[1] ?? 'g2g'
  const siteSlug   = url.searchParams.get('site') ?? cookieSite

  if (!keyword) {
    return NextResponse.json({ error: 'keyword is required' }, { status: 400 })
  }
  if (!(thresholdName in HERMOD_SCORE_THRESHOLDS)) {
    return NextResponse.json({ error: `Invalid threshold "${thresholdName}". Use: ${Object.keys(HERMOD_SCORE_THRESHOLDS).join(', ')}` }, { status: 400 })
  }

  // ── 1. SERP top 10 from DataForSEO ─────────────────────────────────────────
  let serpData
  try {
    serpData = await getSerpData(keyword, locationCode, languageCode, 10)
  } catch (e) {
    return NextResponse.json({ error: `DataForSEO error: ${String(e)}` }, { status: 500 })
  }

  logApiUsage(db, ownerId, {
    api:         'dataforseo',
    endpoint:    'serp/google/organic/live/advanced',
    triggeredBy: 'agent_hermod',
    metadata:    { source: 'outreach_discover', keyword, locationCode, languageCode },
  })

  const organic = serpData.organicResults ?? []
  if (!organic.length) {
    return NextResponse.json({
      candidates: [],
      keyword,
      threshold: thresholdName,
      thresholdValue: HERMOD_SCORE_THRESHOLDS[thresholdName],
      total: 0,
      autoSkipped: 0,
      belowThreshold: 0,
      message: 'DataForSEO returned no organic results — keyword may be too obscure or the search location/language combo has no SERP.',
    })
  }

  // ── 2. Auto-skip social media / marketplaces (cheap pre-filter) ───────────
  // Multi-brand defense: pull EVERY active site_configs row so G2G excludes
  // offgamers.com (and vice versa) — we'd never pitch a sister site.
  const { data: allSites } = await db
    .from('site_configs')
    .select('favicon_domain')
    .eq('is_active', true)
  const ownDomains = new Set<string>(
    (allSites ?? []).map(s => String(s.favicon_domain).toLowerCase()).filter(Boolean)
  )
  // Belt-and-braces — make sure the current site's own domain is in there
  const { data: siteConfig } = await db
    .from('site_configs')
    .select('favicon_domain')
    .eq('slug', siteSlug)
    .maybeSingle()
  if (siteConfig?.favicon_domain) ownDomains.add(String(siteConfig.favicon_domain).toLowerCase())

  let autoSkipped = 0
  const filteredOrganic = organic
    .filter(r => {
      if (!r.domain) return false
      const dom = r.domain.toLowerCase().replace(/^www\./, '')
      // Skip if matches any own-brand domain (exact or subdomain)
      for (const own of ownDomains) {
        if (dom === own || dom.endsWith('.' + own)) return false
      }
      return true
    })
    .filter(r => {
      if (isSkipDomain(r.domain)) {
        autoSkipped++
        return false
      }
      return true
    })
    // Keep only top 10 unique domains
    .reduce<typeof organic>((acc, r) => {
      if (!acc.some(x => x.domain === r.domain)) acc.push(r)
      return acc
    }, [])
    .slice(0, 10)

  // ── 3. Evaluate in parallel (cache makes repeat domains ~free) ────────────
  const evaluations = await Promise.all(
    filteredOrganic.map(async (r): Promise<{ serp: typeof r; score: DomainScore | null }> => {
      try {
        const score = await evaluateDomain(db, ownerId, r.domain, keyword, {}, siteSlug)
        return { serp: r, score }
      } catch (err) {
        console.error('[outreach/discover] eval failed for', r.domain, err)
        return { serp: r, score: null }
      }
    })
  )

  // ── 4. Build response ─────────────────────────────────────────────────────
  // Pull current tracker rows to flag in-pipeline domains
  const evaluated = evaluations
    .filter((e): e is { serp: typeof e.serp; score: DomainScore } => !!e.score)
  const domains = evaluated.map(e => e.score.domain)

  const { data: existing } = await db
    .from('outreach_prospects')
    .select('domain, status')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .in('domain', domains.length ? domains : ['__never__'])

  const existingMap = new Map((existing ?? []).map(r => [r.domain, r.status]))

  let belowCount = 0
  const candidates: CandidateOut[] = evaluated
    .map(({ serp, score }) => {
      const passes = meetsThreshold(score, thresholdName)
      if (!passes) belowCount++
      return {
        domain:          score.domain,
        rankingUrl:      serp.url ?? '',
        position:        serp.rank_absolute ?? 0,

        overallScore:    score.overallScore,
        nicheScore:      score.nicheScore,
        qualityScore:    score.qualityScore,
        outreachScore:   score.outreachScore,
        audienceScore:   score.audienceScore,
        trustScore:      score.trustScore,
        outreachAngle:   score.outreachAngle,
        hasWriteForUs:   score.hasWriteForUs,
        contactEmail:    score.contactEmail,
        notes:           score.notes,
        cached:          score.cached,
        evaluatedAt:     score.evaluatedAt,

        // Legacy compatibility — set to 0/empty since we no longer pull SEMrush data
        organicTraffic:  0,
        organicKeywords: 0,
        authorityScore:  0,

        inTracker:       existingMap.has(score.domain),
        trackerStatus:   existingMap.get(score.domain) ?? null,
        belowThreshold:  !passes,
      }
    })
    .filter(c => includeBelowThreshold || !c.belowThreshold)
    // Sort high → low score, ties broken by SERP position
    .sort((a, b) => b.overallScore - a.overallScore || a.position - b.position)

  return NextResponse.json({
    candidates,
    keyword,
    threshold:      thresholdName,
    thresholdValue: HERMOD_SCORE_THRESHOLDS[thresholdName],
    total:          candidates.length,
    autoSkipped,                 // social-media etc. dropped before eval
    belowThreshold: belowCount,  // evaluated but below threshold (hidden unless includeBelow=1)
    locationCode,
    languageCode,
  })
}
