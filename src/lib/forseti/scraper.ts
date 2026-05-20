// ─── Forseti Reddit scraper ─────────────────────────────────────────────────
//
// Fetches subreddit posts, classifies + scores severity, upserts into
// forseti_threads while preserving manual overrides.
//
// Sprint FORSETI.PULLPUSH.1 — Reddit started blocking anonymous fetches from
// cloud-provider IPs (Vercel, AWS) mid-2024, returning 403 even on public
// .json endpoints. Reddit OAuth requires corporate API registration which
// isn't always granted. So we route through PullPush.io (community-run
// successor to Pushshift) which scrapes Reddit from residential infra and
// exposes a free public JSON API.
//
// Fallback chain:
//   1. PullPush API (primary, works from Vercel)
//   2. Reddit .json   (fallback for dev local where residential IPs aren't blocked)
//   3. /api/forseti/ingest from a local poller script (Sprint FORSETI.INGEST)
//
// Shared library used by:
//   • Cron endpoint  (/api/cron/forseti-scraper)
//   • Manual button  (/api/forseti/scraper/run)
//   • Ingest endpoint (/api/forseti/ingest) — for the local-poller path

import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyComplaintCategory, scoreSeverity, keywordFilterMatches } from './classify'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SubredditConfig {
  id:                  string
  owner_user_id:       string
  site_slug:           string
  subreddit:           string
  enabled:             boolean
  keyword_filter:      string
  severity_preset:     'small_sub' | 'big_sub' | 'custom'
  sev5_min_upvotes:    number | null
  sev4_min_upvotes:    number | null
  sev5_min_comments:   number | null
  sev4_min_comments:   number | null
  status:              string
  last_polled_at:      string | null
}

export interface ScrapeResult {
  config_id:       string
  subreddit:       string
  ok:              boolean
  fetched:         number      // total posts seen in the listing
  matched:         number      // passed keyword filter
  inserted:        number      // brand new threads
  updated:         number      // existing threads re-synced (score updates)
  filtered:        number      // dropped by keyword filter
  alerts_needed:   string[]    // forseti_thread.id values where severity ≥ 4 and inserted=true
  source:          'pullpush' | 'reddit_json' | 'ingest'
  error?:          string
  duration_ms:     number
}

export interface RunOpts {
  /** Optionally scope to a single subreddit (manual button "Fetch this one"). */
  subreddit?: string
  /** Optionally scope to a single owner. Cron iterates all owners; manual scopes to caller. */
  ownerId?:   string
}

/**
 * Normalized post shape used internally. PullPush and Reddit return slightly
 * different field structures — we collapse them into this before processing.
 */
export interface NormalizedPost {
  /** Reddit's globally-unique submission ID (e.g. '1abcdef'), no t3_ prefix. */
  id:                 string
  title:              string
  selftext:           string
  author:             string | null
  score:              number
  num_comments:       number
  /** Unix seconds. */
  created_utc:        number
  /** Relative `/r/.../comments/...` path. */
  permalink:          string
  subreddit:          string
  /** Set to a non-null value when Reddit removed the post; we skip these. */
  removed_by_category?: string | null
}

// ─── Reddit + PullPush response types ──────────────────────────────────────

interface RedditChild {
  kind: string
  data: {
    id:            string
    name:          string
    title:         string
    selftext:      string
    permalink:     string
    url:           string
    author:        string
    score:         number
    num_comments:  number
    created_utc:   number
    subreddit:     string
    is_self:       boolean
    removed_by_category?: string | null
  }
}

interface RedditListing {
  kind: string
  data: { children: RedditChild[]; after: string | null }
}

interface PullPushSubmission {
  id:            string
  title:         string
  selftext:      string
  author:        string
  score:         number
  num_comments:  number
  created_utc:   number
  permalink:     string
  subreddit:     string
  removed_by_category?: string | null
}

interface PullPushResponse {
  data: PullPushSubmission[]
}

const REDDIT_USER_AGENT = process.env.FORSETI_USER_AGENT
  ?? 'g2g-seo-tools/1.0 (Forseti community-response tracker; contact: seo@g2g.com)'
const REDDIT_FETCH_TIMEOUT_MS = 12_000

// ─── Fetchers (PullPush primary, Reddit fallback) ──────────────────────────

/**
 * Sprint FORSETI.PULLPUSH.1 — Try PullPush first (works from Vercel datacenter
 * IPs since they scrape Reddit independently from residential infra). If
 * PullPush fails for any reason, fall back to Reddit's own .json endpoint
 * (which works from dev local but usually returns 403 from Vercel).
 *
 * Returns posts + which source actually served the data (for diagnostics).
 */
async function fetchSubredditPosts(subreddit: string): Promise<{
  posts:  NormalizedPost[]
  source: 'pullpush' | 'reddit_json'
}> {
  // Try PullPush first
  try {
    const posts = await fetchFromPullPush(subreddit)
    return { posts, source: 'pullpush' }
  } catch (err) {
    console.warn(`[forseti-scraper] PullPush fetch for r/${subreddit} failed, trying Reddit fallback:`, err instanceof Error ? err.message : String(err))
  }
  // Fall back to Reddit's own JSON
  const posts = await fetchFromRedditJson(subreddit)
  return { posts, source: 'reddit_json' }
}

async function fetchFromPullPush(subreddit: string): Promise<NormalizedPost[]> {
  // Sprint FORSETI.PULLPUSH.1 — PullPush /reddit/search/submission endpoint.
  // sort_type=created_utc + sort=desc + size=100 mirrors Reddit's /new listing.
  const url = `https://api.pullpush.io/reddit/search/submission/?subreddit=${encodeURIComponent(subreddit)}&size=100&sort=desc&sort_type=created_utc`
  const controller = new AbortController()
  const timeoutId  = setTimeout(() => controller.abort(), REDDIT_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': REDDIT_USER_AGENT, 'Accept': 'application/json' },
      signal:  controller.signal,
    })
    if (!res.ok) throw new Error(`PullPush HTTP ${res.status}`)
    const data = await res.json() as PullPushResponse
    return (data.data ?? []).map(p => normalizePullPushPost(p))
  } finally {
    clearTimeout(timeoutId)
  }
}

async function fetchFromRedditJson(subreddit: string): Promise<NormalizedPost[]> {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json?limit=100`
  const controller = new AbortController()
  const timeoutId  = setTimeout(() => controller.abort(), REDDIT_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': REDDIT_USER_AGENT, 'Accept': 'application/json' },
      signal:  controller.signal,
    })
    if (!res.ok) {
      const status = res.status
      const msg = status === 403
        ? 'Reddit blocked the request (HTTP 403 — Vercel IP likely blocked, PullPush primary should work)'
        : status === 404
        ? 'Subreddit not found (HTTP 404)'
        : `Reddit returned HTTP ${status}`
      throw new Error(msg)
    }
    const listing = await res.json() as RedditListing
    return (listing.data?.children ?? [])
      .filter(c => c.kind === 't3')
      .map(c => normalizeRedditChild(c))
  } finally {
    clearTimeout(timeoutId)
  }
}

function normalizePullPushPost(p: PullPushSubmission): NormalizedPost {
  return {
    id:                  p.id,
    title:               p.title ?? '',
    selftext:            p.selftext ?? '',
    author:              p.author ?? null,
    score:               Number(p.score) || 0,
    num_comments:        Number(p.num_comments) || 0,
    created_utc:         Number(p.created_utc) || 0,
    permalink:           p.permalink ?? '',
    subreddit:           p.subreddit ?? '',
    removed_by_category: p.removed_by_category ?? null,
  }
}

function normalizeRedditChild(c: RedditChild): NormalizedPost {
  return {
    id:                  c.data.id,
    title:               c.data.title ?? '',
    selftext:            c.data.selftext ?? '',
    author:              c.data.author ?? null,
    score:               Number(c.data.score) || 0,
    num_comments:        Number(c.data.num_comments) || 0,
    created_utc:         Number(c.data.created_utc) || 0,
    permalink:           c.data.permalink ?? '',
    subreddit:           c.data.subreddit ?? '',
    removed_by_category: c.data.removed_by_category ?? null,
  }
}

// ─── Main runner ────────────────────────────────────────────────────────────

export async function runForsetiScraper(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:   SupabaseClient<any, any, any>,
  opts: RunOpts,
): Promise<ScrapeResult[]> {
  let q = db
    .from('forseti_subreddit_configs')
    .select('*')
    .eq('enabled', true)
  if (opts.ownerId)  q = q.eq('owner_user_id', opts.ownerId)
  if (opts.subreddit) q = q.eq('subreddit',    opts.subreddit)

  const { data: configs, error } = await q
  if (error) throw new Error(`config load failed: ${error.message}`)
  if (!configs || configs.length === 0) return []

  const results: ScrapeResult[] = []
  for (const config of configs as SubredditConfig[]) {
    const result = await scrapeOneConfig(db, config)
    results.push(result)
  }
  return results
}

// ─── Per-config scraper ─────────────────────────────────────────────────────

async function scrapeOneConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:     SupabaseClient<any, any, any>,
  config: SubredditConfig,
): Promise<ScrapeResult> {
  const start = Date.now()

  let posts:  NormalizedPost[] = []
  let source: 'pullpush' | 'reddit_json' = 'pullpush'

  try {
    const fetched = await fetchSubredditPosts(config.subreddit)
    posts  = fetched.posts
    source = fetched.source
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await db.from('forseti_subreddit_configs').update({
      status:         'error',
      last_error:     errMsg,
      last_polled_at: new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    }).eq('id', config.id)
    return {
      config_id:     config.id,
      subreddit:     config.subreddit,
      ok:            false,
      fetched:       0,
      matched:       0,
      inserted:      0,
      updated:       0,
      filtered:      0,
      alerts_needed: [],
      source:        'pullpush',
      error:         errMsg,
      duration_ms:   Date.now() - start,
    }
  }

  const processed = await processPostsForConfig(db, config, posts)
  // Mark config polled successfully.
  await db.from('forseti_subreddit_configs').update({
    status:               'ok',
    last_error:           null,
    last_polled_at:       new Date().toISOString(),
    last_polled_threads:  processed.matched,
    total_threads:        ((config as unknown as { total_threads?: number }).total_threads ?? 0) + processed.inserted,
    updated_at:           new Date().toISOString(),
  }).eq('id', config.id)

  return {
    config_id:     config.id,
    subreddit:     config.subreddit,
    ok:            true,
    fetched:       posts.length,
    matched:       processed.matched,
    inserted:      processed.inserted,
    updated:       processed.updated,
    filtered:      processed.filtered,
    alerts_needed: processed.alerts_needed,
    source,
    duration_ms:   Date.now() - start,
  }
}

// ─── Post processor (shared with /api/forseti/ingest) ──────────────────────

export interface ProcessResult {
  matched:       number
  inserted:      number
  updated:       number
  filtered:      number
  alerts_needed: string[]
}

/**
 * Sprint FORSETI.INGEST — factored out so the /api/forseti/ingest endpoint
 * (called by a local poller running from residential IP) can run the exact
 * same classify/score/upsert logic without re-fetching anything.
 */
export async function processPostsForConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:     SupabaseClient<any, any, any>,
  config: SubredditConfig,
  posts:  NormalizedPost[],
): Promise<ProcessResult> {
  const result: ProcessResult = { matched: 0, inserted: 0, updated: 0, filtered: 0, alerts_needed: [] }

  for (const post of posts) {
    if (post.removed_by_category) continue   // skip deleted/removed

    // Keyword filter (for big subs).
    if (!keywordFilterMatches(config.keyword_filter, post.title, post.selftext)) {
      result.filtered++
      continue
    }
    result.matched++

    const auto_category = classifyComplaintCategory(post.title, post.selftext)
    const auto_severity = scoreSeverity({
      upvotes:       post.score,
      comment_count: post.num_comments,
      title:         post.title,
      body:          post.selftext,
      preset:        config.severity_preset,
      custom: {
        sev5_min_upvotes:  config.sev5_min_upvotes,
        sev4_min_upvotes:  config.sev4_min_upvotes,
        sev5_min_comments: config.sev5_min_comments,
        sev4_min_comments: config.sev4_min_comments,
      },
    })

    const nowIso       = new Date().toISOString()
    const postedIso    = post.created_utc > 0 ? new Date(post.created_utc * 1000).toISOString() : nowIso
    const permalink    = post.permalink ? `https://www.reddit.com${post.permalink}` : `https://www.reddit.com/r/${post.subreddit}/comments/${post.id}/`
    const bodySnippet  = (post.selftext ?? '').slice(0, 4000)

    const { data: existing } = await db
      .from('forseti_threads')
      .select('id')
      .eq('owner_user_id', config.owner_user_id)
      .eq('reddit_id',     post.id)
      .maybeSingle()

    if (existing) {
      await db.from('forseti_threads').update({
        op_post_score:    post.score,
        op_comment_count: post.num_comments,
        auto_category,
        auto_severity,
        last_synced_at:   nowIso,
        updated_at:       nowIso,
      }).eq('id', existing.id)
      result.updated++
    } else {
      const { data: inserted, error: insertErr } = await db.from('forseti_threads').insert({
        owner_user_id:    config.owner_user_id,
        site_slug:        config.site_slug,
        config_id:        config.id,
        reddit_id:        post.id,
        reddit_url:       permalink,
        subreddit:        post.subreddit || config.subreddit,
        thread_title:     post.title.slice(0, 500),
        thread_permalink: permalink,
        op_username:      post.author,
        op_post_score:    post.score,
        op_comment_count: post.num_comments,
        op_post_body:     bodySnippet,
        op_post_at:       postedIso,
        auto_category,
        auto_severity,
        status:           'spotted',
        first_seen_at:    nowIso,
        last_synced_at:   nowIso,
      }).select('id').single()

      if (insertErr) {
        console.warn(`[forseti-scraper] insert failed for ${post.id}: ${insertErr.message}`)
        continue
      }
      result.inserted++
      if (auto_severity >= 4 && inserted?.id) result.alerts_needed.push(inserted.id as string)
    }
  }

  return result
}
