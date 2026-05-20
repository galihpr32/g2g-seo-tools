// ─── Forseti Reddit scraper ─────────────────────────────────────────────────
//
// Fetches /r/[subreddit]/new.json (no OAuth needed for public subs — just a
// User-Agent header), classifies + scores severity per thread, upserts into
// forseti_threads while preserving manual overrides.
//
// Shared library used by:
//   • Cron endpoint  (/api/cron/forseti-scraper)
//   • Manual button  (/api/forseti/scraper/run)
//
// Both call runForsetiScraper(db, opts). The cron version iterates all
// configured owners; the manual version is scoped to one owner (and
// optionally one subreddit).

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
  error?:          string
  duration_ms:     number
}

export interface RunOpts {
  /** Optionally scope to a single subreddit (manual button "Fetch this one"). */
  subreddit?: string
  /** Optionally scope to a single owner. Cron iterates all owners; manual scopes to caller. */
  ownerId?:   string
}

// ─── Reddit JSON types ─────────────────────────────────────────────────────

interface RedditChild {
  kind: string
  data: {
    id:            string
    name:          string                 // 't3_xxx'
    title:         string
    selftext:      string                 // body text
    permalink:     string                 // /r/.../comments/xxx/
    url:           string                 // canonical post URL
    author:        string
    score:         number                 // upvotes
    num_comments:  number
    created_utc:   number                 // unix seconds
    subreddit:     string
    is_self:       boolean
    removed_by_category?: string | null   // 'deleted' | 'moderator' | etc.
  }
}

interface RedditListing {
  kind: string
  data: {
    children: RedditChild[]
    after:    string | null
  }
}

const REDDIT_USER_AGENT = process.env.FORSETI_USER_AGENT
  ?? 'g2g-seo-tools/1.0 (Forseti community-response tracker; contact: seo@g2g.com)'

const REDDIT_FETCH_TIMEOUT_MS = 12_000   // per-sub timeout

// ─── Main runner ────────────────────────────────────────────────────────────

/**
 * Run scraper for one or more configs. Returns a result row per config.
 * Failures on individual configs do not block the others.
 */
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
  // Sequential to keep memory + Reddit rate-limit predictable. r/G2G_com is
  // small (~1 sec fetch), 10 subs takes <15s total.
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
  const result: ScrapeResult = {
    config_id:     config.id,
    subreddit:     config.subreddit,
    ok:            false,
    fetched:       0,
    matched:       0,
    inserted:      0,
    updated:       0,
    filtered:      0,
    alerts_needed: [],
    duration_ms:   0,
  }

  let listing: RedditListing
  try {
    const url = `https://www.reddit.com/r/${encodeURIComponent(config.subreddit)}/new.json?limit=100`
    const controller = new AbortController()
    const timeoutId  = setTimeout(() => controller.abort(), REDDIT_FETCH_TIMEOUT_MS)
    const res = await fetch(url, {
      headers: { 'User-Agent': REDDIT_USER_AGENT, 'Accept': 'application/json' },
      signal:  controller.signal,
    })
    clearTimeout(timeoutId)
    if (!res.ok) {
      const status = res.status
      // 403 = private/quarantined, 404 = subreddit doesn't exist
      const errMsg = status === 403
        ? 'Subreddit is private or quarantined (HTTP 403)'
        : status === 404
        ? 'Subreddit not found (HTTP 404)'
        : `Reddit returned HTTP ${status}`
      await db.from('forseti_subreddit_configs').update({
        status:         'error',
        last_error:     errMsg,
        last_polled_at: new Date().toISOString(),
        updated_at:     new Date().toISOString(),
      }).eq('id', config.id)
      result.error       = errMsg
      result.duration_ms = Date.now() - start
      return result
    }
    listing = await res.json() as RedditListing
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    await db.from('forseti_subreddit_configs').update({
      status:         'error',
      last_error:     errMsg,
      last_polled_at: new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    }).eq('id', config.id)
    result.error       = errMsg
    result.duration_ms = Date.now() - start
    return result
  }

  const children = listing.data?.children ?? []
  result.fetched = children.length

  // Process each post.
  for (const child of children) {
    if (child.kind !== 't3') continue
    const post = child.data
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
    const postedIso    = new Date(post.created_utc * 1000).toISOString()
    const permalink    = post.permalink ? `https://www.reddit.com${post.permalink}` : post.url
    const bodySnippet  = (post.selftext ?? '').slice(0, 4000)

    // Upsert. The unique constraint (owner_user_id, reddit_id) protects against
    // duplicates. We need to preserve manual_*_override on re-poll, so we do a
    // SELECT first to check existence.
    const { data: existing } = await db
      .from('forseti_threads')
      .select('id, manual_category_override, manual_severity_override')
      .eq('owner_user_id', config.owner_user_id)
      .eq('reddit_id',     post.id)
      .maybeSingle()

    if (existing) {
      // Update: bump op_post_score + comment count + last_synced_at. Preserve
      // manual overrides + workflow status.
      await db.from('forseti_threads').update({
        op_post_score:      post.score,
        op_comment_count:   post.num_comments,
        auto_category:      auto_category,
        auto_severity:      auto_severity,
        last_synced_at:     nowIso,
        updated_at:         nowIso,
      }).eq('id', existing.id)
      result.updated++
    } else {
      // Insert new thread.
      const { data: inserted, error: insertErr } = await db.from('forseti_threads').insert({
        owner_user_id:    config.owner_user_id,
        site_slug:        config.site_slug,
        config_id:        config.id,
        reddit_id:        post.id,
        reddit_url:       permalink,
        subreddit:        post.subreddit,
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
      // Sev-4+ → queue for Slack alert. Caller fires alerts after batch.
      if (auto_severity >= 4 && inserted?.id) result.alerts_needed.push(inserted.id as string)
    }
  }

  // Mark config polled successfully.
  await db.from('forseti_subreddit_configs').update({
    status:               'ok',
    last_error:           null,
    last_polled_at:       new Date().toISOString(),
    last_polled_threads:  result.matched,
    total_threads:        (config as unknown as { total_threads: number }).total_threads + result.inserted,
    updated_at:           new Date().toISOString(),
  }).eq('id', config.id)

  result.ok          = true
  result.duration_ms = Date.now() - start
  return result
}
