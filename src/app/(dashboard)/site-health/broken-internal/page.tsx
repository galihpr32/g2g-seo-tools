'use client'

/**
 * /site-health/broken-internal
 *
 * Sprint: SKILL.BROKENLINK.1
 * Skill:  searchfit-seo:broken-links
 *
 * On-demand internal broken-link audit. Checks URLs collected from:
 *   • seo_content_briefs.page
 *   • tier_serp_snapshots.our_url (most recent per keyword)
 *
 * Kill switch: SKILL_BROKENLINK_AUDIT_ENABLED (API returns 503 when false).
 */

import { useState, useEffect, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type UrlCategory = 'broken' | 'redirect' | 'ok' | 'error'

interface CheckResult {
  url:            string
  status:         number | null
  status_text:    string
  category:       UrlCategory
  source:         'seo_content_briefs' | 'tier_serp_snapshots'
  source_label:   string
  fix_suggestion: string
}

interface AuditRecord {
  id:             string
  audited_at:     string
  total_checked:  number
  broken_count:   number
  redirect_count: number
  ok_count:       number
  urls_collected: number
  results:        CheckResult[]
}

interface ApiResponse {
  ok:          boolean
  skill?:      string
  record?:     AuditRecord | null
  attribution?: string
  error?:       string
  disabled?:    boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins  = Math.floor(diff / 60_000)
  if (mins < 2)    return 'just now'
  if (mins < 60)   return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)    return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const CATEGORY_STYLES: Record<UrlCategory, { badge: string; border: string; dot: string }> = {
  broken:   { badge: 'bg-red-900/50 text-red-300 border-red-800/50',     border: 'border-l-red-500',   dot: 'bg-red-500'    },
  error:    { badge: 'bg-orange-900/50 text-orange-300 border-orange-800/50', border: 'border-l-orange-500', dot: 'bg-orange-500' },
  redirect: { badge: 'bg-amber-900/50 text-amber-300 border-amber-800/50', border: 'border-l-amber-500', dot: 'bg-amber-500'   },
  ok:       { badge: 'bg-emerald-900/50 text-emerald-300 border-emerald-800/50', border: 'border-l-emerald-600', dot: 'bg-emerald-500' },
}

const SOURCE_LABELS: Record<CheckResult['source'], string> = {
  seo_content_briefs:    'Content Brief',
  tier_serp_snapshots:   'SERP Tracker',
}

type FilterTab = 'all' | 'broken' | 'redirect' | 'ok'

// ── ResultRow ─────────────────────────────────────────────────────────────────

function ResultRow({ r }: { r: CheckResult }) {
  const [expanded, setExpanded] = useState(false)
  const s = CATEGORY_STYLES[r.category]

  return (
    <div
      className={`border-l-2 ${s.border} bg-gray-900/60 rounded-r-lg border border-gray-800/60 overflow-hidden`}
    >
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-800/40 transition"
      >
        {/* Status badge */}
        <span className={`flex-shrink-0 text-xs font-mono font-bold px-2 py-0.5 rounded border ${s.badge} mt-0.5`}>
          {r.status ?? r.status_text}
        </span>

        {/* URL + label */}
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-200 font-mono truncate">{r.url}</p>
          <p className="text-xs text-gray-500 mt-0.5 truncate">{r.source_label}</p>
        </div>

        {/* Source badge */}
        <span className="flex-shrink-0 text-[10px] text-gray-500 bg-gray-800 border border-gray-700 px-2 py-0.5 rounded hidden sm:block">
          {SOURCE_LABELS[r.source]}
        </span>

        {/* Chevron */}
        <svg
          className={`w-4 h-4 text-gray-600 flex-shrink-0 mt-0.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 pb-3 pt-1 border-t border-gray-800/50 text-xs space-y-2">
          <div className="flex items-start gap-2">
            <span className="text-gray-500 flex-shrink-0 w-24">Full URL:</span>
            <a
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 break-all transition"
            >
              {r.url}
            </a>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-gray-500 flex-shrink-0 w-24">Response:</span>
            <span className="text-gray-300 font-mono">{r.status_text}</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-gray-500 flex-shrink-0 w-24">Source:</span>
            <span className="text-gray-300">{SOURCE_LABELS[r.source]} — <span className="italic">{r.source_label}</span></span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-gray-500 flex-shrink-0 w-24 flex-shrink-0">Fix:</span>
            <span className="text-amber-300/90">{r.fix_suggestion}</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BrokenInternalPage() {
  const [record,   setRecord]   = useState<AuditRecord | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [running,  setRunning]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [disabled, setDisabled] = useState(false)
  const [filter,   setFilter]   = useState<FilterTab>('all')

  // Load latest audit on mount
  const loadLatest = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch('/api/site-health/broken-internal')
      const data = await res.json() as ApiResponse
      if (data.disabled) { setDisabled(true); return }
      if (data.ok) setRecord(data.record ?? null)
    } catch { /* silent */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadLatest() }, [loadLatest])

  async function handleRun() {
    setRunning(true)
    setError(null)
    try {
      const res  = await fetch('/api/site-health/broken-internal', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ site: 'g2g' }),
      })
      const data = await res.json() as ApiResponse
      if (data.disabled) { setDisabled(true); return }
      if (!data.ok) {
        setError(data.error ?? 'Audit failed')
      } else if (data.record) {
        setRecord(data.record)
        setFilter('all')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setRunning(false)
    }
  }

  // ── Filtered results ────────────────────────────────────────────────────────
  const allResults = record?.results ?? []
  const filtered   = filter === 'all'
    ? allResults
    : filter === 'broken'
      ? allResults.filter(r => r.category === 'broken' || r.category === 'error')
      : allResults.filter(r => r.category === filter)

  const tabs: { key: FilterTab; label: string; count: number; style: string }[] = [
    {
      key:   'all',
      label: 'All',
      count: allResults.length,
      style: 'text-gray-300',
    },
    {
      key:   'broken',
      label: '🔴 Broken / Error',
      count: (record?.broken_count ?? 0),
      style: 'text-red-300',
    },
    {
      key:   'redirect',
      label: '🟡 Redirects',
      count: record?.redirect_count ?? 0,
      style: 'text-amber-300',
    },
    {
      key:   'ok',
      label: '🟢 OK',
      count: record?.ok_count ?? 0,
      style: 'text-emerald-300',
    },
  ]

  if (disabled) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <p className="text-gray-500 text-sm">Broken Internal Links audit is currently disabled by your administrator.</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <span>🔴</span> Broken Internal Links
          </h1>
          <p className="text-gray-400 text-sm mt-1">
            Audits internal URLs from Content Briefs and SERP Tracker. Powered by the{' '}
            <span className="text-indigo-400 font-mono text-xs">searchfit-seo:broken-links</span> skill.
          </p>
        </div>
        <button
          onClick={handleRun}
          disabled={running || loading}
          className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900 disabled:text-indigo-600 text-white text-sm font-semibold rounded-lg transition flex-shrink-0"
        >
          {running ? (
            <>
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Running audit…
            </>
          ) : (
            '▶ Run Audit'
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-4">
          <p className="text-red-300 text-sm font-medium">Audit failed</p>
          <p className="text-red-400/80 text-xs mt-1">{error}</p>
        </div>
      )}

      {/* Running progress */}
      {running && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">Checking internal URLs…</p>
          <p className="text-gray-600 text-xs">Up to 200 URLs, batched 10 at a time. This takes ~30–50 s.</p>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !running && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-gray-600 border-t-gray-400 rounded-full animate-spin" />
        </div>
      )}

      {/* No data yet */}
      {!loading && !running && !record && !error && (
        <div className="bg-gray-900 rounded-xl border border-dashed border-gray-700 p-10 flex flex-col items-center gap-3 text-center">
          <span className="text-4xl">🔍</span>
          <p className="text-gray-300 font-medium">No audit run yet</p>
          <p className="text-gray-500 text-sm max-w-sm">
            Click <strong>Run Audit</strong> to HEAD-check all internal URLs from your Content Briefs and SERP Tracker.
          </p>
        </div>
      )}

      {/* Results */}
      {record && !loading && !running && (
        <div className="space-y-4">

          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Checked',   value: record.total_checked,  col: 'text-gray-200'    },
              { label: 'Broken',    value: record.broken_count,   col: 'text-red-300'     },
              { label: 'Redirects', value: record.redirect_count, col: 'text-amber-300'   },
              { label: 'OK',        value: record.ok_count,       col: 'text-emerald-300' },
            ].map(c => (
              <div key={c.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className={`text-2xl font-bold ${c.col}`}>{c.value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{c.label}</p>
              </div>
            ))}
          </div>

          {/* Audit meta */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
            <span>
              <span className="text-gray-400">Last run:</span>{' '}
              {timeAgo(record.audited_at)}{' '}
              <span className="text-gray-600">({new Date(record.audited_at).toLocaleString()})</span>
            </span>
            <span>
              <span className="text-gray-400">URLs collected:</span> {record.urls_collected}
            </span>
            <span className="text-gray-600 text-[10px]">
              Note: G2G SPA pages return HTTP 200 for the shell even for invalid slugs — HTTP-level broken links only.
            </span>
          </div>

          {/* Filter tabs */}
          <div className="flex flex-wrap gap-1.5">
            {tabs.map(t => (
              <button
                key={t.key}
                onClick={() => setFilter(t.key)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition flex items-center gap-1.5 ${
                  filter === t.key
                    ? 'bg-indigo-600 border-indigo-500 text-white font-semibold'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
              >
                <span className={t.style}>{t.label}</span>
                <span className="bg-gray-700/60 px-1.5 py-0.5 rounded-full text-[10px] text-gray-300">
                  {t.count}
                </span>
              </button>
            ))}
          </div>

          {/* Results list */}
          {filtered.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
              <p className="text-gray-400 text-sm">No results in this category.</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {filtered.map((r, i) => (
                <ResultRow key={`${r.url}-${i}`} r={r} />
              ))}
            </div>
          )}

          {/* Attribution */}
          <p className="text-xs text-gray-600 pt-1">
            Generated via Anthropic skill: searchfit-seo:broken-links
          </p>
        </div>
      )}
    </div>
  )
}
