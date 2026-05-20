'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { COMPLAINT_CATEGORIES } from '@/lib/forseti/classify'

// ─── /forseti — Triage Queue ────────────────────────────────────────────────
//
// Main daily-driver page for community-response workflow. Tab-sectioned
// queue (Spotted / Mine / Awaiting OP / Resolved 7d / All), subreddit
// filter, inline category + severity override, "Run all scrapers now"
// button. Click row → /forseti/[id] for full thread detail + response.

type Tab = 'spotted' | 'mine' | 'awaiting' | 'resolved' | 'all'

interface Thread {
  id:                       string
  reddit_id:                string
  reddit_url:               string
  subreddit:                string
  thread_title:             string
  op_username:              string | null
  op_post_score:            number
  op_comment_count:         number
  op_post_body:             string | null
  op_post_at:               string | null
  auto_category:            string
  manual_category_override: string | null
  effective_category:       string
  auto_severity:            number
  manual_severity_override: number | null
  effective_severity:       number
  status:                   string
  assignee_user_id:         string | null
  first_seen_at:            string
}

interface Counts { spotted: number; mine: number; awaiting: number; resolved: number }

export default function ForsetiTriagePage() {
  const [threads,    setThreads]    = useState<Thread[]>([])
  const [counts,     setCounts]     = useState<Counts>({ spotted: 0, mine: 0, awaiting: 0, resolved: 0 })
  const [subreddits, setSubreddits] = useState<string[]>([])
  const [tab,        setTab]        = useState<Tab>('spotted')
  const [subFilter,  setSubFilter]  = useState<string>('')
  const [search,     setSearch]     = useState('')
  const [loading,    setLoading]    = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)
  const [scraping,   setScraping]   = useState(false)
  const [scrapeMsg,  setScrapeMsg]  = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const params = new URLSearchParams()
        params.set('tab', tab)
        if (subFilter)     params.set('subreddit', subFilter)
        if (search.trim()) params.set('q', search.trim())
        const res  = await fetch(`/api/forseti/threads?${params}`)
        const data = await res.json()
        if (cancelled) return
        setThreads(data.threads ?? [])
        setCounts(data.counts ?? { spotted: 0, mine: 0, awaiting: 0, resolved: 0 })
        setSubreddits(data.subreddits ?? [])
      } catch { if (!cancelled) setThreads([]) }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [tab, subFilter, search, refreshTick])

  async function runScrapeAll() {
    setScraping(true); setScrapeMsg(null)
    try {
      const res = await fetch('/api/forseti/scraper/run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) {
        setScrapeMsg(`❌ ${data.error ?? 'Failed'}`)
      } else {
        const s = data.summary
        setScrapeMsg(`✅ ${s.configs} sub${s.configs === 1 ? '' : 's'} polled · ${s.inserted} new · ${s.updated} updated${s.alerts_fired > 0 ? ` · ${s.alerts_fired} alerts fired` : ''}`)
        setRefreshTick(t => t + 1)
      }
    } catch (e) {
      setScrapeMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }
    setScraping(false)
  }

  async function patchThread(id: string, patch: Partial<Thread>) {
    const res = await fetch(`/api/forseti/threads?id=${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(patch),
    })
    if (res.ok) setRefreshTick(t => t + 1)
  }

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">⚖ Forseti · Triage Queue</h1>
          <p className="text-sm text-gray-400 mt-1">
            Community-response tracker. Reddit threads about us, auto-classified by complaint
            category and severity. Reply on Reddit then log the action here for accountability.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/forseti/history" className="px-3 py-2 text-sm text-gray-300 hover:text-white border border-gray-700 rounded-lg">History</Link>
          <Link href="/forseti/settings" className="px-3 py-2 text-sm text-gray-300 hover:text-white border border-gray-700 rounded-lg">Settings</Link>
          <button
            onClick={runScrapeAll}
            disabled={scraping}
            className="px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
          >
            {scraping ? '⏳ Fetching…' : '🔄 Run all scrapers'}
          </button>
        </div>
      </div>

      {scrapeMsg && (
        <div className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-200">
          {scrapeMsg}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 text-sm border-b border-gray-800">
        <TabButton current={tab} value="spotted"  count={counts.spotted}  label="Spotted"     onClick={setTab} />
        <TabButton current={tab} value="mine"     count={counts.mine}     label="Mine"        onClick={setTab} />
        <TabButton current={tab} value="awaiting" count={counts.awaiting} label="Awaiting OP" onClick={setTab} />
        <TabButton current={tab} value="resolved" count={counts.resolved} label="Resolved 7d" onClick={setTab} />
        <TabButton current={tab} value="all"      count={null}            label="All"         onClick={setTab} />
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          value={subFilter}
          onChange={e => setSubFilter(e.target.value)}
          className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200"
        >
          <option value="">All subreddits ({subreddits.length})</option>
          {subreddits.map(s => <option key={s} value={s}>r/{s}</option>)}
        </select>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search title…"
          className="bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-purple-500 flex-1 min-w-[200px]"
        />
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : threads.length === 0 ? (
        <EmptyState tab={tab} hasSubreddits={subreddits.length > 0} />
      ) : (
        <div className="space-y-2">
          {threads.map(t => (
            <ThreadCard key={t.id} t={t} onPatch={p => patchThread(t.id, p)} />
          ))}
        </div>
      )}
    </div>
  )
}

function TabButton({ current, value, count, label, onClick }: {
  current: Tab
  value: Tab
  count: number | null
  label: string
  onClick: (t: Tab) => void
}) {
  const active = current === value
  return (
    <button
      onClick={() => onClick(value)}
      className={`px-3 py-2 -mb-px border-b-2 transition ${
        active ? 'border-purple-500 text-white font-medium' : 'border-transparent text-gray-400 hover:text-gray-200'
      }`}
    >
      {label}
      {count !== null && (
        <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded ${active ? 'bg-purple-700/40 text-purple-100' : 'bg-gray-800 text-gray-400'}`}>
          {count}
        </span>
      )}
    </button>
  )
}

function EmptyState({ tab, hasSubreddits }: { tab: Tab; hasSubreddits: boolean }) {
  if (!hasSubreddits) {
    return (
      <div className="rounded-lg border border-dashed border-gray-800 p-8 text-center text-gray-500 space-y-2">
        <p>No subreddits configured yet.</p>
        <Link href="/forseti/settings" className="inline-block mt-2 px-3 py-1.5 bg-purple-700 hover:bg-purple-600 text-white text-sm rounded">
          → Configure subreddits
        </Link>
      </div>
    )
  }
  const msgs: Record<Tab, string> = {
    spotted:  'No spotted threads. Either the scraper is up to date or no new complaints today.',
    mine:     'Nothing assigned to you right now.',
    awaiting: 'No threads awaiting OP response.',
    resolved: 'No threads resolved in the past 7 days.',
    all:      'No threads in this view.',
  }
  return <div className="rounded-lg border border-dashed border-gray-800 p-8 text-center text-gray-500">{msgs[tab]}</div>
}

function ThreadCard({ t, onPatch }: { t: Thread; onPatch: (p: Partial<Thread>) => void }) {
  const sevColor = useMemo(() => ({
    5: 'border-red-600    bg-red-500/10    text-red-300',
    4: 'border-orange-600 bg-orange-500/10 text-orange-300',
    3: 'border-amber-700  bg-amber-500/10  text-amber-300',
    2: 'border-gray-700   bg-gray-800/40   text-gray-300',
    1: 'border-gray-800   bg-gray-900/40   text-gray-500',
  }[t.effective_severity as 1|2|3|4|5]), [t.effective_severity])

  const sevIcon = t.effective_severity >= 5 ? '🔥' : t.effective_severity >= 4 ? '⚠' : t.effective_severity >= 3 ? '!' : '·'

  // Pin `now` to mount-time using lazy initial state. "X hours ago" drifts
  // across navigations — acceptable for a triage queue that refreshes every
  // hour from the scraper anyway.
  const [now] = useState<number>(() => Date.now())
  const hoursAgo = t.op_post_at
    ? Math.round((now - new Date(t.op_post_at).getTime()) / 3600_000)
    : null

  const statusBadge = {
    spotted:     '🟡 Spotted',
    drafted:     '📝 Drafted',
    sent:        '📤 Sent',
    op_replied:  '💬 OP Replied',
    resolved:    '✅ Resolved',
    escalated:   '⤴ Escalated',
    ignored:     '🚫 Ignored',
    deleted_by_op: '🗑 Deleted by OP',
  }[t.status] ?? t.status

  return (
    <div className={`rounded-lg border p-3 ${sevColor}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[11px] mb-1">
            <span className="px-1.5 py-0.5 rounded border border-current uppercase tracking-wide font-semibold">
              {sevIcon} SEV {t.effective_severity}
            </span>
            <span>📈 {t.op_post_score} up · 💬 {t.op_comment_count} cmt</span>
            <span className="text-gray-500">r/{t.subreddit}</span>
            {hoursAgo !== null && <span className="text-gray-500">· {hoursAgo}h ago</span>}
          </div>
          <Link href={`/forseti/${t.id}`} className="block">
            <h3 className="text-sm font-semibold text-white hover:text-purple-300 transition-colors line-clamp-2">
              {t.thread_title}
            </h3>
          </Link>
          {t.op_username && <p className="text-[11px] text-gray-500 mt-0.5">u/{t.op_username}</p>}
          {t.op_post_body && (
            <p className="text-xs text-gray-400 mt-1.5 line-clamp-2">{t.op_post_body}</p>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs flex-wrap">
        {/* Inline category override */}
        <label className="flex items-center gap-1">
          <span className="text-gray-500">Category:</span>
          <select
            value={t.manual_category_override ?? t.auto_category}
            onChange={e => onPatch({ manual_category_override: e.target.value })}
            className="bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200"
          >
            {COMPLAINT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {t.manual_category_override && (
            <button
              onClick={() => onPatch({ manual_category_override: null as unknown as string })}
              title="Reset to auto-classified"
              className="text-gray-500 hover:text-gray-300 text-[10px] underline"
            >
              auto
            </button>
          )}
        </label>

        {/* Inline severity override */}
        <label className="flex items-center gap-1">
          <span className="text-gray-500">Sev:</span>
          <select
            value={t.manual_severity_override ?? t.auto_severity}
            onChange={e => onPatch({ manual_severity_override: parseInt(e.target.value, 10) as 1|2|3|4|5 })}
            className="bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200 w-12"
          >
            {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          {t.manual_severity_override != null && (
            <button
              onClick={() => onPatch({ manual_severity_override: null })}
              title="Reset to auto-scored"
              className="text-gray-500 hover:text-gray-300 text-[10px] underline"
            >
              auto
            </button>
          )}
        </label>

        <span className="text-gray-500 ml-1">Status: {statusBadge}</span>

        <div className="ml-auto flex items-center gap-2">
          <a href={t.reddit_url} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-purple-300">
            Open Reddit ↗
          </a>
          <Link href={`/forseti/${t.id}`} className="text-purple-300 hover:text-purple-200 font-medium">
            View detail →
          </Link>
        </div>
      </div>
    </div>
  )
}
