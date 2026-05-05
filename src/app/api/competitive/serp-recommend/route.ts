import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { smartScrape, type CrawledPage } from '@/lib/firecrawl/client'
import Anthropic from '@anthropic-ai/sdk'
import { logClaudeUsage, logApiUsage } from '@/lib/api-logger'
import { costForCall } from '@/lib/anthropic-pricing'

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL     = 'claude-sonnet-4-6'
const MAX_TOKENS = 4096

// ──────────────────────────────────────────────────────────────────────────────
// Manual SERP-to-content-ideas flow.
//
// Triggered from the SERP Tracker History tab. For a given snapshot_date:
//   1. Load all serp_snapshots for that day
//   2. Pick top 3 unique competitor URLs across all keywords (dedup)
//   3. FireCrawl-scrape each URL (with 7-day cache via firecrawl_url_cache)
//   4. Call Sonnet with: keyword list + per-keyword top-10 + scraped content
//   5. Sonnet returns 4 categorised idea types
//   6. Persist to serp_recommendations for revisit
// ──────────────────────────────────────────────────────────────────────────────

interface SerpResultEntry {
  domain?:   string
  position?: number
  url?:      string
  title?:    string
}

interface SerpSnapshotRow {
  keyword:       string
  search_volume: number | null
  results:       SerpResultEntry[]
}

interface ScrapedSummary {
  url:         string
  domain:      string
  title:       string
  description: string
  h1:          string[]
  h2:          string[]
  wordCount:   number
  intro:       string  // first ~400 chars of body
}

interface ContentIdea {
  id:                   string   // local uuid for client correlation (push button)
  type:                 'title_pattern' | 'content_depth' | 'new_keyword' | 'quick_win'
  title:                string   // 1-line headline
  body:                 string   // 2-4 sentence rationale
  target_keyword:       string
  target_url:           string | null   // G2G URL to optimise (or new path suggestion)
  suggested_brief_type: 'optimize_existing' | 'new_page' | 'category_page' | 'blog_post'
  evidence:             string   // short snippet citing competitor data the idea is based on
}

const G2G_DOMAIN = 'g2g.com'
function normalizeDomain(d: string): string {
  return d.replace(/^www\./, '').toLowerCase()
}

const RATE_LIMIT_PER_DAY = 5  // per workspace owner

async function loadCachedOrScrape(
  db: ReturnType<typeof createServiceClient>,
  url: string,
  ownerId: string,
  supabaseLogger: Parameters<typeof logApiUsage>[0],
): Promise<{ data: Partial<CrawledPage> | null; cached: boolean }> {
  // Check cache (7-day window)
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString()
  const { data: cached } = await db
    .from('firecrawl_url_cache')
    .select('payload')
    .eq('url', url)
    .gte('scraped_at', cutoff)
    .maybeSingle()

  if (cached?.payload) {
    return { data: cached.payload as Partial<CrawledPage>, cached: true }
  }

  // Cache miss — call FireCrawl
  const fresh = await smartScrape(url)
  if (fresh) {
    logApiUsage(supabaseLogger, ownerId, {
      api: 'firecrawl', endpoint: 'scrape', triggeredBy: 'url_analysis',
      metadata: { url, source: 'serp_recommend' },
    })
    // Upsert cache (replace older entry for same URL)
    await db.from('firecrawl_url_cache').upsert({
      url,
      payload:    fresh,
      scraped_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      first_owner_user_id: ownerId,
    }, { onConflict: 'url' })
  }
  return { data: fresh, cached: false }
}

const recommendTool: Anthropic.Tool = {
  name: 'submit_serp_content_ideas',
  description: 'Submit categorised SERP-derived content ideas.',
  input_schema: {
    type: 'object',
    properties: {
      ideas: {
        type: 'array',
        description: 'Array of content ideas. Aim for 6-10 across the four categories. Quality > quantity — every idea must be actionable and tied to evidence from the SERP/scraped content.',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['title_pattern', 'content_depth', 'new_keyword', 'quick_win'],
              description: 'Category. title_pattern = competitor title framing G2G should test. content_depth = sections G2G is missing. new_keyword = keyword competitors target that we don\'t. quick_win = G2G ranks 11-30, optimisable to top 10.',
            },
            title: {
              type: 'string',
              description: '1-line headline of the idea (under 80 chars).',
            },
            body: {
              type: 'string',
              description: '2-4 sentences explaining the idea + recommended action.',
            },
            target_keyword: {
              type: 'string',
              description: 'The primary keyword this idea targets. For new_keyword type, this is the new keyword discovered.',
            },
            target_url: {
              type: ['string', 'null'],
              description: 'G2G URL to optimise (for optimize_existing types). Null if a new page should be created — the suggested_brief_type will then be new_page or category_page.',
            },
            suggested_brief_type: {
              type: 'string',
              enum: ['optimize_existing', 'new_page', 'category_page', 'blog_post'],
              description: 'What kind of brief Bragi should generate when this idea is pushed.',
            },
            evidence: {
              type: 'string',
              description: 'Short citation: which competitor / what their content showed / why this matters. <= 200 chars.',
            },
          },
          required: ['type', 'title', 'body', 'target_keyword', 'suggested_brief_type', 'evidence'],
        },
      },
    },
    required: ['ideas'],
  },
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await request.json().catch(() => ({})) as { snapshot_date?: string }
  const snapshotDate = body.snapshot_date
  if (!snapshotDate || !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
    return NextResponse.json({ error: 'snapshot_date (YYYY-MM-DD) required' }, { status: 400 })
  }

  // ── Rate limit: max 5 analyses per workspace per day ──────────────────────
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const { count: todayCount } = await db
    .from('serp_recommendations')
    .select('id', { count: 'exact', head: true })
    .eq('owner_user_id', ownerId)
    .gte('generated_at', todayStart.toISOString())

  if ((todayCount ?? 0) >= RATE_LIMIT_PER_DAY) {
    return NextResponse.json({
      error: `Rate limit hit — ${RATE_LIMIT_PER_DAY} analyses per workspace per day. Try again tomorrow, or open a previous run from history.`,
      retryAfter: 'next-day',
    }, { status: 429 })
  }

  // ── Load snapshots for the date ───────────────────────────────────────────
  const { data: snaps } = await db
    .from('serp_snapshots')
    .select('keyword, search_volume, results')
    .eq('owner_user_id', ownerId)
    .eq('snapshot_date', snapshotDate)

  const snapshots = (snaps ?? []) as SerpSnapshotRow[]
  if (snapshots.length === 0) {
    return NextResponse.json({ error: `No SERP snapshots for ${snapshotDate}` }, { status: 404 })
  }

  // ── Pick top 3 unique competitor URLs across all keywords ─────────────────
  // Strategy: take position 1-3 from each keyword's results, dedupe by URL,
  // skip G2G's own URLs (we don't need to scrape ourselves), cap total at 5
  // to keep analysis fast + cost predictable.
  const urlSet  = new Map<string, { url: string; domain: string; positions: number[] }>()
  for (const s of snapshots) {
    for (const r of (s.results ?? []).slice(0, 3)) {
      if (!r.url || !r.domain) continue
      const dom = normalizeDomain(r.domain)
      if (dom === G2G_DOMAIN) continue
      const existing = urlSet.get(r.url)
      if (existing) existing.positions.push(r.position ?? 99)
      else urlSet.set(r.url, { url: r.url, domain: dom, positions: [r.position ?? 99] })
    }
  }
  const urlsToScrape = Array.from(urlSet.values()).slice(0, 5)

  // ── FireCrawl-scrape with cache ───────────────────────────────────────────
  const scrapedMap = new Map<string, ScrapedSummary>()
  let scrapeMisses = 0
  for (const u of urlsToScrape) {
    const { data, cached } = await loadCachedOrScrape(db, u.url, ownerId, supabase)
    if (!cached) scrapeMisses++
    if (!data) continue
    scrapedMap.set(u.url, {
      url:         u.url,
      domain:      u.domain,
      title:       (data.title ?? '').slice(0, 200),
      description: (data.description ?? '').slice(0, 200),
      h1:          (data.h1 ?? []).slice(0, 5),
      h2:          (data.h2 ?? []).slice(0, 12),
      wordCount:   data.wordCount ?? 0,
      intro:       (data.markdown ?? '').slice(0, 400),
    })
  }

  // ── Build the Sonnet prompt ───────────────────────────────────────────────
  // Compress payload aggressively — Sonnet handles this fine, no need for
  // verbose XML. Goal: enough signal for the 4 idea types without context bloat.
  const keywordBlock = snapshots.map(s => {
    const top10 = (s.results ?? [])
      .filter(r => r.position && r.position <= 10)
      .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
      .map(r => `    ${r.position}. ${r.domain}${normalizeDomain(r.domain ?? '') === G2G_DOMAIN ? ' ← OUR site' : ''} | "${(r.title ?? '').slice(0, 80)}" | ${r.url}`)
      .join('\n')
    const g2gPos = (s.results ?? []).find(r => normalizeDomain(r.domain ?? '') === G2G_DOMAIN)?.position
    const g2gNote = g2gPos == null ? '(G2G NOT in top 10)'
                  : g2gPos <= 10 ? `(G2G #${g2gPos})`
                  : `(G2G #${g2gPos} — quick-win candidate)`
    return `### Keyword: "${s.keyword}" (${(s.search_volume ?? 0).toLocaleString()} SV) ${g2gNote}\n${top10 || '    (no top-10 data)'}`
  }).join('\n\n')

  const scrapedBlock = Array.from(scrapedMap.values()).map(p => `
URL: ${p.url}
Domain: ${p.domain}
Title: ${p.title}
Meta: ${p.description}
H1s: ${p.h1.join(' | ') || '(none)'}
H2s: ${p.h2.join(' | ') || '(none)'}
Word count: ${p.wordCount}
Intro snippet: ${p.intro}`).join('\n---\n') || '(no scraped content available)'

  const prompt = `You are an SEO content strategist analysing competitor SERPs for G2G (a gaming marketplace).

For the snapshot date ${snapshotDate}, here are the keywords we tracked + their top-10 results:

${keywordBlock}

I also scraped the following top competitor pages (top 1-3 across these keywords). Use these to ground your recommendations in REAL competitor content, not just titles:

${scrapedBlock}

Generate 6-10 actionable content ideas across these FOUR categories ONLY:

1. **title_pattern** — Patterns observed in competitor titles that G2G should test.
   • Look for repeated framing words (e.g. "cheap", "safe", "instant", "verified")
   • Look for structural patterns (e.g. "Buy [X] - [trust signal] | [brand]")
   • Output: specific G2G title rewrite suggestion.

2. **content_depth** — Sections / topics G2G's page is likely missing.
   • Compare scraped competitor H1/H2/word-count to what G2G needs.
   • Output: 2-3 specific section additions ("How to Buy", "Account Safety", "Pricing FAQ").

3. **new_keyword** — Keywords competitors clearly target that aren't in our tracking list.
   • Mine competitor titles + H1s for keyword phrases not present in our keyword list.
   • Output: keyword + suggested target URL or new page path.

4. **quick_win** — Keywords where G2G is at position 11-30, optimisable to top 10.
   • Look at the keyword headers above for "(G2G #11 — quick-win candidate)" markers.
   • Output: specific optimisation (e.g. "add FAQ schema", "internal link from /currencies").

REQUIREMENTS
- Every idea MUST cite specific evidence (competitor name + what they're doing).
- DO NOT propose ideas that aren't backed by the data above.
- Prefer fewer high-quality ideas over many speculative ones.
- For target_url: use a real existing G2G URL when known (from the SERP results above), else propose a clean URL path like /categories/[slug].

Use the submit_serp_content_ideas tool to return the structured array.`

  // ── Call Sonnet ────────────────────────────────────────────────────────────
  let parsedIdeas: ContentIdea[] = []
  let usage: Anthropic.Usage | undefined

  try {
    const response = await anthropic.messages.create({
      model:       MODEL,
      max_tokens:  MAX_TOKENS,
      tools:       [recommendTool],
      tool_choice: { type: 'tool', name: 'submit_serp_content_ideas' },
      messages:    [{ role: 'user', content: prompt }],
    })
    usage = response.usage
    logClaudeUsage(db, ownerId, {
      model:       MODEL,
      endpoint:    'serp_recommend',
      triggeredBy: 'agent_loki',
      usage:       response.usage,
      extra:       { snapshot_date: snapshotDate, scraped_urls: urlsToScrape.length },
    })

    const toolUse = response.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error(`Claude did not call submit_serp_content_ideas tool (stop=${response.stop_reason})`)
    }

    const toolInput = toolUse.input as { ideas?: Array<Omit<ContentIdea, 'id'>> }
    parsedIdeas = (toolInput.ideas ?? []).map((i, idx) => ({
      id: `${snapshotDate}-${idx}-${Math.random().toString(36).slice(2, 8)}`,
      ...i,
      target_url: i.target_url ?? null,
    }))
  } catch (err) {
    return NextResponse.json({
      error: `Sonnet analysis failed: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 500 })
  }

  // ── Cost estimate ──────────────────────────────────────────────────────────
  const sonnetUsd     = usage ? costForCall(MODEL, usage.input_tokens, usage.output_tokens) : 0
  const firecrawlUsd  = scrapeMisses * 0.0015   // rough — Firecrawl Standard ≈ $1.50 / 1k scrapes
  const costUsd       = +(sonnetUsd + firecrawlUsd).toFixed(4)

  // ── Persist run ────────────────────────────────────────────────────────────
  const { data: saved } = await db
    .from('serp_recommendations')
    .insert({
      owner_user_id:  ownerId,
      snapshot_date:  snapshotDate,
      model:          MODEL,
      scrape_count:   urlsToScrape.length,
      scrape_misses:  scrapeMisses,
      cost_usd:       costUsd,
      ideas:          parsedIdeas,
      pushed_links:   [],
    })
    .select('id')
    .single()

  return NextResponse.json({
    ok:           true,
    id:           saved?.id ?? null,
    ideas:        parsedIdeas,
    diagnostics: {
      keywords_analysed: snapshots.length,
      urls_scraped:      urlsToScrape.length,
      cache_hits:        urlsToScrape.length - scrapeMisses,
      cache_misses:      scrapeMisses,
      cost_usd:          costUsd,
      model:             MODEL,
      remaining_today:   Math.max(0, RATE_LIMIT_PER_DAY - (todayCount ?? 0) - 1),
    },
  })
}

/**
 * GET /api/competitive/serp-recommend?date=YYYY-MM-DD
 *
 * Returns existing recommendations for a given snapshot_date (or all
 * recommendations if no date param). Used to revisit past Sonnet runs
 * without paying to regenerate.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const date = new URL(req.url).searchParams.get('date')

  let q = db
    .from('serp_recommendations')
    .select('id, snapshot_date, generated_at, model, scrape_count, scrape_misses, cost_usd, ideas, pushed_links')
    .eq('owner_user_id', ownerId)
    .order('generated_at', { ascending: false })
    .limit(50)

  if (date) q = q.eq('snapshot_date', date)

  const { data: rows, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ runs: rows ?? [] })
}
