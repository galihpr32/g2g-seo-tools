'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { COMPLAINT_CATEGORIES } from '@/lib/forseti/classify'

// ─── /forseti/history — Retrospective table ─────────────────────────────────

interface Row {
  id:                 string
  reddit_url:         string
  subreddit:          string
  thread_title:       string
  op_username:        string | null
  op_post_score:      number
  op_comment_count:   number
  effective_category: string
  effective_severity: number
  status:             string
  assignee_user_id:   string | null
  first_seen_at:      string
  responded_at:       string | null
  resolved_at:        string | null
}

const PRESETS = [
  { label: 'Today',       days: 1 },
  { label: 'This week',   days: 7 },
  { label: 'This month',  days: 30 },
  { label: 'Last 90d',    days: 90 },
  { label: 'All time',    days: 0 },
]

export default function ForsetiHistoryPage() {
  const [rows,        setRows]        = useState<Row[]>([])
  const [subreddits,  setSubreddits]  = useState<string[]>([])
  const [loading,     setLoading]     = useState(true)
  const [days,        setDays]        = useState(30)
  const [subFilter,   setSubFilter]   = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [categoryF,   setCategoryF]   = useState('')
  const [search,      setSearch]      = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const params = new URLSearchParams()
        params.set('tab', 'all')
        params.set('limit', '500')
        if (subFilter)    params.set('subreddit', subFilter)
        if (statusFilter) params.set('status',    statusFilter)
        if (search.trim()) params.set('q', search.trim())
        const res  = await fetch(`/api/forseti/threads?${params}`)
        const data = await res.json()
        if (cancelled) return
        let filtered = (data.threads ?? []) as Row[]
        if (days > 0) {
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
          filtered = filtered.filter(r => new Date(r.first_seen_at).getTime() >= cutoff)
        }
        if (categoryF) {
          filtered = filtered.filter(r => r.effective_category === categoryF)
        }
        setRows(filtered)
        setSubreddits(data.subreddits ?? [])
      } catch { if (!cancelled) setRows([]) }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [days, subFilter, statusFilter, categoryF, search])

  const stats = useMemo(() => {
    const responded = rows.filter(r => r.responded_at).length
    const total     = rows.length
    const responseRate = total > 0 ? Math.round((responded / total) * 100) : 0
    const avgRespMs = (() => {
      const samples = rows
        .filter(r => r.responded_at)
        .map(r => new Date(r.responded_at!).getTime() - new Date(r.first_seen_at).getTime())
      if (samples.length === 0) return null
      return Math.round(samples.reduce((s, n) => s + n, 0) / samples.length)
    })()
    return { total, responded, responseRate, avgRespMs }
  }, [rows])

  function exportCsv() {
    const headers = ['Date', 'Title', 'OP', 'Subreddit', 'Severity', 'Category', 'Status', 'Upvotes', 'Comments', 'Time to respond (h)', 'Reddit URL']
    const lines = [headers.join(',')]
    for (const r of rows) {
      const ttr = r.responded_at
        ? Math.round((new Date(r.responded_at).getTime() - new Date(r.first_seen_at).getTime()) / 3600_000)
        : ''
      const row = [
        new Date(r.first_seen_at).toISOString().slice(0, 10),
        `"${(r.thread_title ?? '').replace(/"/g, '""').slice(0, 200)}"`,
        r.op_username ?? '',
        `r/${r.subreddit}`,
        r.effective_severity,
        r.effective_category,
        r.status,
        r.op_post_score,
        r.op_comment_count,
        ttr,
        r.reddit_url,
      ]
      lines.push(row.join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href     = URL.createObjectURL(blob)
    a.download = `forseti-history-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">⚖ Forseti · History</h1>
          <p className="text-sm text-gray-400 mt-1">Retrospective view of all threads tracked. Filter and export for audit.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/forseti" className="px-3 py-2 text-sm text-gray-300 hover:text-white border border-gray-700 rounded-lg">Triage</Link>
          <button onClick={exportCsv} className="px-3 py-2 bg-emerald-700/40 hover:bg-emerald-700/60 border border-emerald-600/50 text-sm text-emerald-100 rounded-lg">📥 Export CSV</button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <Kpi label="Total"          value={String(stats.total)} />
        <Kpi label="Responded"      value={`${stats.responded} (${stats.responseRate}%)`} />
        <Kpi label="Avg respond time" value={stats.avgRespMs == null ? '—' : `${(stats.avgRespMs / 3600_000).toFixed(1)}h`} />
        <Kpi label="Showing window" value={days === 0 ? 'all time' : `last ${days}d`} />
      </div>

      {/* Filter row */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-gray-500">Date range:</span>
          {PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => setDays(p.days)}
              className={`px-2 py-1 rounded border ${days === p.days ? 'border-purple-500 bg-purple-700/30 text-purple-100' : 'border-gray-700 text-gray-400 hover:text-white'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search title…"
            className="bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-purple-500 flex-1 min-w-[200px]"
          />
          <select value={subFilter} onChange={e => setSubFilter(e.target.value)} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200">
            <option value="">All subs</option>
            {subreddits.map(s => <option key={s} value={s}>r/{s}</option>)}
          </select>
          <select value={categoryF} onChange={e => setCategoryF(e.target.value)} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200">
            <option value="">All categories</option>
            {COMPLAINT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200">
            <option value="">All statuses</option>
            <option value="spotted">Spotted</option>
            <option value="drafted">Drafted</option>
            <option value="sent">Sent</option>
            <option value="op_replied">OP Replied</option>
            <option value="resolved">Resolved</option>
            <option value="escalated">Escalated</option>
            <option value="ignored">Ignored</option>
          </select>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-800 p-8 text-center text-gray-500">No threads match these filters.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-900/70 text-gray-400 uppercase tracking-wide text-[10px]">
              <tr>
                <Th>Date</Th>
                <Th>Title</Th>
                <Th>Sub</Th>
                <Th>Sev</Th>
                <Th>Category</Th>
                <Th>Status</Th>
                <Th className="text-right">Up</Th>
                <Th className="text-right">Cmt</Th>
                <Th>TTR</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t border-gray-800 hover:bg-gray-900/40">
                  <Td>{new Date(r.first_seen_at).toLocaleDateString()}</Td>
                  <Td>
                    <Link href={`/forseti/${r.id}`} className="text-gray-200 hover:text-purple-300 line-clamp-1 max-w-md inline-block">
                      {r.thread_title}
                    </Link>
                  </Td>
                  <Td className="text-gray-400">r/{r.subreddit}</Td>
                  <Td className={r.effective_severity >= 4 ? 'text-red-300 font-semibold' : r.effective_severity >= 3 ? 'text-amber-300' : 'text-gray-300'}>
                    {r.effective_severity}
                  </Td>
                  <Td className="text-gray-300">{r.effective_category}</Td>
                  <Td className="text-gray-400">{r.status}</Td>
                  <Td className="text-right text-gray-400">{r.op_post_score}</Td>
                  <Td className="text-right text-gray-400">{r.op_comment_count}</Td>
                  <Td className="text-gray-400">
                    {r.responded_at
                      ? `${((new Date(r.responded_at).getTime() - new Date(r.first_seen_at).getTime()) / 3600_000).toFixed(1)}h`
                      : '—'}
                  </Td>
                  <Td>
                    <a href={r.reddit_url} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-purple-300">↗</a>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-xl font-bold text-white mt-0.5">{value}</p>
    </div>
  )
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-left font-medium ${className}`}>{children}</th>
}
function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>
}
