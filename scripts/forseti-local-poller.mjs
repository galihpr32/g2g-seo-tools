#!/usr/bin/env node
// ─── Forseti local poller (residential-IP fallback) ─────────────────────────
//
// Sprint FORSETI.INGEST — Run this script from a residential IP (your Mac,
// home VPS, etc.) when PullPush.io is unreliable and Reddit blocks our
// Vercel datacenter. It polls Reddit's own .json endpoint (which still
// works from residential IPs) and POSTs the result to our ingest endpoint.
//
// USAGE:
//
//   1. Set env vars (or put in a .env file beside this script):
//
//      FORSETI_APP_URL=https://g2g-seo-tools.vercel.app
//      FORSETI_INGEST_TOKEN=<paste same value as on Vercel env>
//      FORSETI_SUBREDDITS=G2G_com,offgamers     # comma-separated
//
//   2. One-off test:
//
//      node scripts/forseti-local-poller.mjs
//
//   3. Schedule hourly with launchd (Mac):
//
//      Edit ~/Library/LaunchAgents/com.g2g.forseti-poller.plist:
//
//      <?xml version="1.0" encoding="UTF-8"?>
//      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
//      <plist version="1.0">
//      <dict>
//        <key>Label</key>            <string>com.g2g.forseti-poller</string>
//        <key>ProgramArguments</key>
//        <array>
//          <string>/usr/local/bin/node</string>
//          <string>/Users/YOU/path/to/forseti-local-poller.mjs</string>
//        </array>
//        <key>StartInterval</key>    <integer>3600</integer>
//        <key>EnvironmentVariables</key>
//        <dict>
//          <key>FORSETI_APP_URL</key>       <string>https://g2g-seo-tools.vercel.app</string>
//          <key>FORSETI_INGEST_TOKEN</key>  <string>YOUR_TOKEN_HERE</string>
//          <key>FORSETI_SUBREDDITS</key>    <string>G2G_com,offgamers</string>
//        </dict>
//        <key>StandardOutPath</key>  <string>/tmp/forseti-poller.log</string>
//        <key>StandardErrorPath</key><string>/tmp/forseti-poller.err</string>
//      </dict>
//      </plist>
//
//      Then load:  launchctl load ~/Library/LaunchAgents/com.g2g.forseti-poller.plist
//      Unload:     launchctl unload ~/Library/LaunchAgents/com.g2g.forseti-poller.plist
//
//   4. Or Linux crontab:
//
//      crontab -e
//      5 * * * * cd /path/to && FORSETI_APP_URL=... FORSETI_INGEST_TOKEN=... FORSETI_SUBREDDITS=G2G_com node forseti-local-poller.mjs >> ~/forseti.log 2>&1
//
// REDDIT USER-AGENT: per Reddit's API rules, use a unique descriptive UA
// when scraping. Don't share the default value across projects.

const APP_URL      = process.env.FORSETI_APP_URL
const INGEST_TOKEN = process.env.FORSETI_INGEST_TOKEN
const SUBREDDITS   = (process.env.FORSETI_SUBREDDITS ?? '').split(',').map(s => s.trim()).filter(Boolean)
const USER_AGENT   = process.env.FORSETI_USER_AGENT ?? 'forseti-local-poller/1.0 (by /u/your_reddit_user)'

if (!APP_URL || !INGEST_TOKEN) {
  console.error('ERROR: Set FORSETI_APP_URL and FORSETI_INGEST_TOKEN env vars.')
  process.exit(1)
}
if (SUBREDDITS.length === 0) {
  console.error('ERROR: Set FORSETI_SUBREDDITS env var (comma-separated, e.g. "G2G_com,offgamers")')
  process.exit(1)
}

// ─── Map Reddit's .json shape → our NormalizedPost shape ────────────────────
function normalizeRedditChild(child) {
  const d = child.data
  return {
    id:                  d.id,
    title:               d.title ?? '',
    selftext:            d.selftext ?? '',
    author:              d.author ?? null,
    score:               Number(d.score) || 0,
    num_comments:        Number(d.num_comments) || 0,
    created_utc:         Number(d.created_utc) || 0,
    permalink:           d.permalink ?? '',
    subreddit:           d.subreddit ?? '',
    removed_by_category: d.removed_by_category ?? null,
  }
}

async function fetchReddit(subreddit) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json?limit=100`
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Reddit returned HTTP ${res.status} for r/${subreddit}`)
  }
  const json = await res.json()
  const children = (json.data?.children ?? []).filter(c => c.kind === 't3')
  return children.map(normalizeRedditChild)
}

async function pushToIngest(subreddit, posts) {
  const res = await fetch(`${APP_URL.replace(/\/+$/, '')}/api/forseti/ingest`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({ subreddit, posts }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Ingest HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  return JSON.parse(text)
}

async function pollOne(subreddit) {
  const t0 = Date.now()
  try {
    const posts  = await fetchReddit(subreddit)
    const result = await pushToIngest(subreddit, posts)
    const summary = result.summary ?? {}
    console.log(
      `[${new Date().toISOString()}] r/${subreddit}: ${posts.length} fetched → ${summary.inserted ?? 0} new · ${summary.updated ?? 0} updated · ${summary.filtered ?? 0} filtered · ${summary.alerts_fired ?? 0} alerts · ${Date.now() - t0}ms`,
    )
    return { subreddit, ok: true, ...summary }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] r/${subreddit} FAILED: ${err.message}`)
    return { subreddit, ok: false, error: err.message }
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] Forseti poller starting for ${SUBREDDITS.length} sub(s): ${SUBREDDITS.join(', ')}`)
  const results = []
  for (const sub of SUBREDDITS) {
    // Sequential with 2s pause between subs to stay polite (way under Reddit's
    // 60 req/min limit, even with multiple subs).
    // eslint-disable-next-line no-await-in-loop
    const r = await pollOne(sub)
    results.push(r)
    if (sub !== SUBREDDITS[SUBREDDITS.length - 1]) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(res => setTimeout(res, 2000))
    }
  }
  const okCount = results.filter(r => r.ok).length
  console.log(`[${new Date().toISOString()}] Done. ${okCount}/${results.length} subs OK.`)
  process.exit(okCount === results.length ? 0 : 1)
}

main().catch(err => {
  console.error(`[${new Date().toISOString()}] Poller crashed:`, err)
  process.exit(2)
})
