// ─── Hermod v2: Domain Evaluator ─────────────────────────────────────────────
// Replaces the SEMrush dependency that hit 403 / quota limits.
//
// Per-domain pipeline:
//   1. Skip-list filter (social media, marketplaces, our own domain)
//   2. Cache lookup in `outreach_domain_scores` (14-day TTL)
//   3. FireCrawl scrape of:
//      • homepage  (https://{domain})
//      • /about    (best-effort)
//      • /write-for-us|/contribute|/guest-post (best-effort, signals openness)
//      Each scrape uses `firecrawl_url_cache` (7-day TTL) so repeat eval calls
//      don't burn FireCrawl credits.
//   4. Haiku tool_use → 5-dim score (0-10 each):
//        niche_score    — gaming-related?
//        quality_score  — well-written + recently updated?
//        outreach_score — open to guest posts / has contact?
//        audience_score — likely gamer / G2G ICP audience?
//        trust_score    — not spam / PBN / AI-generated slop?
//      Plus: outreach_angle, has_write_for_us, contact_email, notes
//   5. Persist to `outreach_domain_scores` with 14-day TTL.
//
// Weighting (overall_score, 0-10):
//     niche      0.30
//     quality    0.25
//     outreach   0.25
//     audience   0.10
//     trust      0.10
//
// Threshold: caller decides (recommended: ≥6.5 to queue for pitch).
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { scrapePage, type CrawledPage } from '@/lib/firecrawl/client'
import { logClaudeUsage } from '@/lib/api-logger'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const EVAL_MODEL = 'claude-haiku-4-5-20251001'

// ── Constants ────────────────────────────────────────────────────────────────

/** Domains to auto-skip — social media, marketplaces, walled gardens.
 *  Match is performed via `domain.endsWith(skip)` so subdomains are caught. */
export const HERMOD_SKIP_DOMAINS: readonly string[] = [
  // Social
  'reddit.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'discord.com',
  'discord.gg',
  'facebook.com',
  'fb.com',
  'instagram.com',
  'pinterest.com',
  'linkedin.com',
  'threads.net',
  'tumblr.com',
  'snapchat.com',
  // Q&A / forums (mostly user-gen, no editorial outreach)
  'quora.com',
  'stackexchange.com',
  'stackoverflow.com',
  // Marketplaces / our competitors / generic walled gardens
  'amazon.com', 'amazon.co.uk', 'ebay.com',
  'medium.com',           // hard to outreach individual authors
  'wikipedia.org',
  'wikia.com', 'fandom.com',
  // ── Gaming-marketplace direct competitors ────────────────────────────
  // We'd never write a guestpost on a competitor's site. Hardcoded here
  // (instead of relying on the user-managed `competitors` table) because
  // these are universally-known competitors — every G2G/OG operator
  // recognizes them. Hardcoding is also defense-in-depth: even if the
  // competitors table is empty for a freshly-onboarded brand, Hermod
  // still excludes them.
  'g2g.com', 'offgamers.com',
  'overgear.com',
  'playerauctions.com',
  'eldorado.gg',
  'g2a.com',
  'kinguin.net',
  'mmoga.com',
  'igvault.com', 'igvault.io',
  'gameflip.com',
  'dmarket.com',
  'mmoexp.com',
  'leveldash.com',
  'ssegold.com',
  'mygames4.com',
  'cdkeys.com',
  'instant-gaming.com',
  // Search engines / portals (you can't pitch Google)
  'google.com', 'bing.com', 'yahoo.com', 'duckduckgo.com',
  // Video / streaming
  'twitch.tv', 'vimeo.com',
  // App stores
  'apps.apple.com', 'play.google.com',
]

/** Common write-for-us / contribute paths to probe. First hit wins. */
const WRITE_FOR_US_PATHS = [
  '/write-for-us',
  '/contribute',
  '/guest-post',
  '/guest-posts',
  '/submit',
  '/submissions',
  '/contact',
] as const

const SCORE_WEIGHTS = {
  niche:    0.30,
  quality:  0.25,
  outreach: 0.25,
  audience: 0.10,
  trust:    0.10,
} as const

const OVERALL_DECIMALS = 2

// ── Public types ─────────────────────────────────────────────────────────────

export interface DomainScore {
  domain:           string
  sourceKeyword:    string | null
  nicheScore:       number       // 0-10
  qualityScore:     number       // 0-10
  outreachScore:    number       // 0-10
  audienceScore:    number       // 0-10
  trustScore:       number       // 0-10
  overallScore:     number       // 0-10 (weighted)
  outreachAngle:    string
  hasWriteForUs:    boolean
  contactEmail:     string | null
  notes:            string
  scrapedUrls:      string[]
  evaluatedAt:      string       // ISO
  expiresAt:        string       // ISO
  cached:           boolean      // true when read from DB cache
}

export interface EvaluateOptions {
  /** Force re-evaluate even if a fresh cached score exists. */
  forceRefresh?: boolean
  /** Suppress writing to firecrawl_url_cache (used in tests). */
  skipFirecrawlCache?: boolean
}

// ── Skip check ───────────────────────────────────────────────────────────────

/** Returns true if domain matches any skip-list entry (own or subdomain). */
export function isSkipDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '')
  return HERMOD_SKIP_DOMAINS.some(skip => d === skip || d.endsWith('.' + skip))
}

// ── DB helpers ───────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type DB = SupabaseClient<any>

/** Read a non-expired cached score row. Returns null if missing or expired. */
export async function getCachedScore(
  db:        DB,
  ownerId:   string,
  domain:    string,
  siteSlug:  string = 'g2g',
): Promise<DomainScore | null> {
  const { data } = await db
    .from('outreach_domain_scores')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('domain', domain.toLowerCase())
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (!data) return null

  return {
    domain:        data.domain,
    sourceKeyword: data.source_keyword ?? null,
    nicheScore:    Number(data.niche_score ?? 0),
    qualityScore:  Number(data.quality_score ?? 0),
    outreachScore: Number(data.outreach_score ?? 0),
    audienceScore: Number(data.audience_score ?? 0),
    trustScore:    Number(data.trust_score ?? 0),
    overallScore:  Number(data.overall_score ?? 0),
    outreachAngle: data.outreach_angle ?? '',
    hasWriteForUs: Boolean(data.has_write_for_us),
    contactEmail:  data.contact_email ?? null,
    notes:         data.notes ?? '',
    scrapedUrls:   (data.scraped_urls ?? []) as string[],
    evaluatedAt:   data.evaluated_at,
    expiresAt:     data.expires_at,
    cached:        true,
  }
}

/** Read a 7-day-fresh FireCrawl cache row by URL. */
async function readFirecrawlCache(db: DB, url: string): Promise<CrawledPage | null> {
  const { data } = await db
    .from('firecrawl_url_cache')
    .select('payload, scraped_at')
    .eq('url', url)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()
  if (!data?.payload) return null
  try {
    return data.payload as CrawledPage
  } catch {
    return null
  }
}

/** Upsert into firecrawl_url_cache. */
async function writeFirecrawlCache(db: DB, ownerId: string, url: string, payload: CrawledPage): Promise<void> {
  await db
    .from('firecrawl_url_cache')
    .upsert({
      url,
      payload,
      scraped_at:           new Date().toISOString(),
      expires_at:           new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      first_owner_user_id:  ownerId,
    }, { onConflict: 'url' })
}

/** Cached scrape — reads from firecrawl_url_cache then falls back to FireCrawl. */
async function scrapeWithCache(
  db:        DB,
  ownerId:   string,
  url:       string,
  skipCache: boolean,
): Promise<CrawledPage | null> {
  if (!skipCache) {
    const hit = await readFirecrawlCache(db, url)
    if (hit) return hit
  }
  const page = await scrapePage(url)
  if (!page) return null
  if (!skipCache) {
    await writeFirecrawlCache(db, ownerId, url, page).catch(err =>
      console.error('[hermod-eval] firecrawl cache write failed:', err)
    )
  }
  return page
}

// ── Email extraction ─────────────────────────────────────────────────────────

const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi
const NOREPLY_PATTERNS = /^(no.?reply|donotreply|noreply|do.?not.?reply|postmaster|abuse|hostmaster|mailer.?daemon)@/i

/** Pull the most "outreach-friendly" email from page text(s). Prefers
 *  editor@/press@/contact@; rejects no-reply / role-mailer addresses. */
export function extractContactEmail(...texts: string[]): string | null {
  const candidates = new Set<string>()
  for (const t of texts) {
    if (!t) continue
    const matches = t.match(EMAIL_REGEX)
    if (matches) for (const m of matches) candidates.add(m.toLowerCase())
  }
  if (!candidates.size) return null

  const preferred = ['editor@', 'editorial@', 'press@', 'pitch@', 'contact@', 'hello@', 'hi@', 'partnerships@', 'collab']
  const ordered = Array.from(candidates)
    .filter(e => !NOREPLY_PATTERNS.test(e))
    .sort((a, b) => {
      const score = (e: string) => preferred.findIndex(p => e.startsWith(p) || e.includes(p))
      const sa = score(a)
      const sb = score(b)
      if (sa === -1 && sb === -1) return a.length - b.length
      if (sa === -1) return 1
      if (sb === -1) return -1
      return sa - sb
    })
  return ordered[0] ?? null
}

// ── Haiku evaluation ─────────────────────────────────────────────────────────

const evalTool: Anthropic.Tool = {
  name: 'submit_domain_score',
  description: 'Submit a 5-dimension outreach evaluation for a domain.',
  input_schema: {
    type: 'object',
    properties: {
      niche_score: {
        type: 'number',
        description: 'Gaming-relevance, 0-10. 10 = gaming-only publication; 5 = general-tech that covers gaming; 0 = unrelated (cooking, finance, etc.).',
      },
      quality_score: {
        type: 'number',
        description: 'Editorial quality, 0-10. 10 = polished, recent, original; 5 = average blog with mixed depth; 0 = AI-generated slop / SEO churn.',
      },
      outreach_score: {
        type: 'number',
        description: 'Openness to outreach, 0-10. 10 = explicit "Write for us" page + editor email; 5 = generic contact form; 0 = no contact info or paywalled.',
      },
      audience_score: {
        type: 'number',
        description: 'Audience-fit for a peer-to-peer gaming marketplace (G2G), 0-10. 10 = active gamer audience that buys/sells in-game stuff; 0 = audience unrelated to gaming commerce.',
      },
      trust_score: {
        type: 'number',
        description: 'Trust signals, 0-10. 10 = clear authorship + about page + no spam signals; 5 = anonymous but legit-looking; 0 = PBN, scam-y, hidden ownership, suspicious ad density.',
      },
      outreach_angle: {
        type: 'string',
        description: 'One-sentence pitch angle tailored to this domain — what specific value G2G can offer them based on what they cover. ≤ 240 chars.',
      },
      has_write_for_us: {
        type: 'boolean',
        description: 'True ONLY if the scraped pages explicitly mention guest posts, contributions, or "write for us"-style submissions.',
      },
      contact_email: {
        type: 'string',
        description: 'Editorial / press / partnerships contact email if visible on scraped pages. Empty string if not found.',
      },
      notes: {
        type: 'string',
        description: 'Free-form rationale, 2-4 sentences. Cite specific evidence from the scraped content (page titles, copy, signals).',
      },
    },
    required: [
      'niche_score',
      'quality_score',
      'outreach_score',
      'audience_score',
      'trust_score',
      'outreach_angle',
      'has_write_for_us',
      'contact_email',
      'notes',
    ],
  },
}

interface HaikuRawScore {
  niche_score:      number
  quality_score:    number
  outreach_score:   number
  audience_score:   number
  trust_score:      number
  outreach_angle:   string
  has_write_for_us: boolean
  contact_email:    string
  notes:            string
}

function clamp10(n: unknown): number {
  const x = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(10, x))
}

function computeOverall(s: {
  nicheScore: number; qualityScore: number; outreachScore: number;
  audienceScore: number; trustScore: number;
}): number {
  const raw =
    s.nicheScore    * SCORE_WEIGHTS.niche    +
    s.qualityScore  * SCORE_WEIGHTS.quality  +
    s.outreachScore * SCORE_WEIGHTS.outreach +
    s.audienceScore * SCORE_WEIGHTS.audience +
    s.trustScore    * SCORE_WEIGHTS.trust
  return Number(raw.toFixed(OVERALL_DECIMALS))
}

// ── Main evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate a domain end-to-end. Reads cache when fresh, otherwise scrapes
 * + scores via Haiku and writes the result back to outreach_domain_scores.
 *
 * Returns null only when the domain is on the skip-list — the caller should
 * treat that as "auto-skipped, do not pitch".
 */
export async function evaluateDomain(
  db:            DB,
  ownerId:       string,
  domain:        string,
  sourceKeyword: string | null,
  opts:          EvaluateOptions = {},
  siteSlug:      string = 'g2g',
): Promise<DomainScore | null> {
  const cleanDomain = domain.toLowerCase().replace(/^www\./, '').replace(/\/$/, '')
  if (!cleanDomain || cleanDomain.includes(' ')) return null

  // 1. Skip-list filter.
  if (isSkipDomain(cleanDomain)) return null

  // 2. Cache check (scoped to siteSlug — G2G and OG score same domain separately).
  if (!opts.forceRefresh) {
    const cached = await getCachedScore(db, ownerId, cleanDomain, siteSlug)
    if (cached) return cached
  }

  // 3. Scrape — homepage is mandatory; /about + /write-for-us are best-effort.
  const baseUrl = `https://${cleanDomain}`
  const scrapedUrls: string[] = []
  const homepage = await scrapeWithCache(db, ownerId, baseUrl, !!opts.skipFirecrawlCache)
  if (!homepage) {
    // Couldn't even get the homepage. Persist a low-confidence row so we
    // don't keep retrying for 14 days, and return it.
    return await persistEvaluation(db, ownerId, cleanDomain, sourceKeyword, {
      nicheScore:    0,
      qualityScore:  0,
      outreachScore: 0,
      audienceScore: 0,
      trustScore:    0,
      outreachAngle: 'Domain unreachable — homepage scrape failed.',
      hasWriteForUs: false,
      contactEmail:  null,
      notes:         'Could not scrape homepage. Domain may be parked, blocking bots, or temporarily down.',
      scrapedUrls:   [],
    }, siteSlug)
  }
  scrapedUrls.push(baseUrl)

  // /about — single best-effort attempt.
  const aboutUrl = `${baseUrl}/about`
  const aboutPage = await scrapeWithCache(db, ownerId, aboutUrl, !!opts.skipFirecrawlCache).catch(() => null)
  if (aboutPage && aboutPage.markdown) scrapedUrls.push(aboutUrl)

  // Write-for-us discovery: try paths in order, stop at first hit.
  // Quick heuristic — if the homepage already mentions "write for us"-style
  // copy, prefer the link it points at; otherwise try the canonical paths.
  let writeForUsPage: CrawledPage | null = null
  let writeForUsUrl: string | null = null
  for (const path of WRITE_FOR_US_PATHS) {
    const url = `${baseUrl}${path}`
    const p = await scrapeWithCache(db, ownerId, url, !!opts.skipFirecrawlCache).catch(() => null)
    // FireCrawl returns null for 404s / non-200, so any non-null page is a hit.
    if (p && (p.markdown?.length ?? 0) > 200) {
      writeForUsPage = p
      writeForUsUrl  = url
      scrapedUrls.push(url)
      break
    }
  }

  // 4. Build prompt context.
  const ctxParts: string[] = []
  ctxParts.push(`DOMAIN: ${cleanDomain}`)
  if (sourceKeyword) ctxParts.push(`DISCOVERED VIA KEYWORD: "${sourceKeyword}"`)

  ctxParts.push('', '── HOMEPAGE ──')
  if (homepage.title) ctxParts.push(`Title: ${homepage.title}`)
  if (homepage.description) ctxParts.push(`Meta description: ${homepage.description}`)
  if (homepage.h1.length) ctxParts.push(`H1s: ${homepage.h1.slice(0, 5).join(' | ')}`)
  if (homepage.h2.length) ctxParts.push(`H2s: ${homepage.h2.slice(0, 8).join(' | ')}`)
  ctxParts.push(`Content excerpt: ${(homepage.markdown ?? '').slice(0, 2500)}`)

  if (aboutPage) {
    ctxParts.push('', '── ABOUT PAGE ──', (aboutPage.markdown ?? '').slice(0, 1500))
  }

  if (writeForUsPage) {
    ctxParts.push('', `── ${writeForUsUrl} (WRITE-FOR-US / SUBMISSIONS PAGE) ──`)
    ctxParts.push((writeForUsPage.markdown ?? '').slice(0, 1500))
  } else {
    ctxParts.push('', '── WRITE-FOR-US PAGE ──', '(none of /write-for-us, /contribute, /guest-post, /submit, /contact returned content)')
  }

  // Pre-extract any visible emails as a hint to Haiku — but let Haiku confirm.
  const allText = [
    homepage.markdown ?? '',
    aboutPage?.markdown ?? '',
    writeForUsPage?.markdown ?? '',
  ].join('\n')
  const detectedEmail = extractContactEmail(allText)
  if (detectedEmail) ctxParts.push('', `Detected email candidate: ${detectedEmail} (verify it's the right contact)`)

  const prompt = `You are evaluating ${cleanDomain} as an outreach prospect for G2G.com — a peer-to-peer gaming marketplace where players buy/sell in-game items, currency, accounts, and gaming services.

Score the site on 5 dimensions (0-10 each). Be conservative — most random sites are 4-6, not 8-10. Reserve 9-10 for clear best-fit prospects.

The 5 dimensions:
  • niche_score    — How gaming-related is this site's content?
  • quality_score  — How polished, recent, and original is the editorial?
  • outreach_score — How open does the site appear to outreach (write-for-us, editor contact, partnerships)?
  • audience_score — How well does the audience match G2G's ICP (gamers who transact)?
  • trust_score    — Does the site read as trustworthy (real authorship, not PBN/SEO-churn)?

Also extract:
  • outreach_angle    — A specific, custom pitch angle for THIS site (≤ 240 chars).
  • has_write_for_us  — Set true ONLY if the scraped content explicitly invites guest posts / contributions.
  • contact_email     — Editorial/press email if visible. Empty string otherwise.
  • notes             — 2-4 sentences citing concrete evidence from the scraped pages.

Site context follows. Call submit_domain_score.

${ctxParts.join('\n')}`

  let raw: HaikuRawScore
  try {
    const res = await anthropic.messages.create({
      model:       EVAL_MODEL,
      max_tokens:  1024,
      tools:       [evalTool],
      tool_choice: { type: 'tool', name: 'submit_domain_score' },
      messages:    [{ role: 'user', content: prompt }],
    })

    logClaudeUsage(db, ownerId, {
      model:       EVAL_MODEL,
      endpoint:    'hermod_domain_eval',
      triggeredBy: 'agent_hermod',
      usage:       res.usage,
      extra:       { domain: cleanDomain, source_keyword: sourceKeyword },
    })

    const toolUse = res.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error(`Haiku did not call submit_domain_score (stop=${res.stop_reason})`)
    }
    raw = toolUse.input as HaikuRawScore
  } catch (err) {
    // LLM failure — persist a stub so we don't retry for 14d, but mark zeroed.
    return await persistEvaluation(db, ownerId, cleanDomain, sourceKeyword, {
      nicheScore:    0,
      qualityScore:  0,
      outreachScore: 0,
      audienceScore: 0,
      trustScore:    0,
      outreachAngle: '',
      hasWriteForUs: false,
      contactEmail:  detectedEmail,
      notes:         `LLM evaluation failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      scrapedUrls,
    }, siteSlug)
  }

  const haikuEmail = (raw.contact_email ?? '').trim().toLowerCase()
  const finalEmail = haikuEmail || detectedEmail || null

  return await persistEvaluation(db, ownerId, cleanDomain, sourceKeyword, {
    nicheScore:    clamp10(raw.niche_score),
    qualityScore:  clamp10(raw.quality_score),
    outreachScore: clamp10(raw.outreach_score),
    audienceScore: clamp10(raw.audience_score),
    trustScore:    clamp10(raw.trust_score),
    outreachAngle: String(raw.outreach_angle ?? '').slice(0, 280),
    hasWriteForUs: Boolean(raw.has_write_for_us) || !!writeForUsPage,
    contactEmail:  finalEmail,
    notes:         String(raw.notes ?? '').slice(0, 1200),
    scrapedUrls,
  }, siteSlug)
}

// ── Persist (upsert) ─────────────────────────────────────────────────────────

interface PersistInput {
  nicheScore:    number
  qualityScore:  number
  outreachScore: number
  audienceScore: number
  trustScore:    number
  outreachAngle: string
  hasWriteForUs: boolean
  contactEmail:  string | null
  notes:         string
  scrapedUrls:   string[]
}

async function persistEvaluation(
  db:            DB,
  ownerId:       string,
  domain:        string,
  sourceKeyword: string | null,
  s:             PersistInput,
  siteSlug:      string = 'g2g',
): Promise<DomainScore> {
  const overallScore = computeOverall(s)
  const evaluatedAt  = new Date().toISOString()
  const expiresAt    = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

  const row = {
    owner_user_id:    ownerId,
    site_slug:        siteSlug,
    domain,
    source_keyword:   sourceKeyword,
    niche_score:      s.nicheScore,
    quality_score:    s.qualityScore,
    outreach_score:   s.outreachScore,
    audience_score:   s.audienceScore,
    trust_score:      s.trustScore,
    overall_score:    overallScore,
    outreach_angle:   s.outreachAngle,
    has_write_for_us: s.hasWriteForUs,
    contact_email:    s.contactEmail,
    notes:            s.notes,
    scraped_urls:     s.scrapedUrls,
    evaluated_at:     evaluatedAt,
    expires_at:       expiresAt,
  }

  const { error } = await db
    .from('outreach_domain_scores')
    .upsert(row, { onConflict: 'owner_user_id,site_slug,domain' })

  if (error) {
    console.error('[hermod-eval] upsert failed:', error.message)
  }

  return {
    domain,
    sourceKeyword,
    nicheScore:    s.nicheScore,
    qualityScore:  s.qualityScore,
    outreachScore: s.outreachScore,
    audienceScore: s.audienceScore,
    trustScore:    s.trustScore,
    overallScore,
    outreachAngle: s.outreachAngle,
    hasWriteForUs: s.hasWriteForUs,
    contactEmail:  s.contactEmail,
    notes:         s.notes,
    scrapedUrls:   s.scrapedUrls,
    evaluatedAt,
    expiresAt,
    cached:        false,
  }
}

// ── Public threshold helper ──────────────────────────────────────────────────

export const HERMOD_SCORE_THRESHOLDS = {
  /** Strict: only top-tier, highly relevant prospects. */
  strict:   7.5,
  /** Balanced: default — solid match without being too narrow. */
  balanced: 6.5,
  /** Loose: pitch broadly, accept lower-quality fits. */
  loose:    5.5,
} as const

export type HermodThreshold = keyof typeof HERMOD_SCORE_THRESHOLDS

export function meetsThreshold(score: DomainScore, threshold: HermodThreshold = 'balanced'): boolean {
  return score.overallScore >= HERMOD_SCORE_THRESHOLDS[threshold]
}
