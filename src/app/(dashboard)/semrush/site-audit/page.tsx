'use client'

import { useState, useEffect, useCallback } from 'react'
import { LottieLoader } from '@/components/ui/LottieLoader'

// ── DFS check key map (matches server-side) ───────────────────────────────────
const ISSUE_CHECK_KEYS: Record<string, string> = {
  'Missing H1':               'no_h1_tag',
  'Missing title tag':        'no_title',
  'Missing meta description': 'no_description',
  'Duplicate title tags':     'duplicate_title',
  'Duplicate meta desc.':     'duplicate_description',
  'Missing image alt text':   'no_image_alt',
  'Redirect chains':          'redirect_chain',
  'Large page size':          'large_page_size',
  'Broken links':             'broken_links',
  'Broken resources':         'broken_resources',
}

interface IssuePage {
  url: string
  status_code: number | null
  onpage_score: number | null
  title: string | null
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface OnPageSummary {
  taskId: string
  crawlProgress: 'in_progress' | 'finished'
  pagesTotal: number
  pagesCrawled: number
  onpageScore: number
  noTitle: number
  noDescription: number
  noH1: number
  duplicateTitle: number
  duplicateDescription: number
  brokenLinks: number
  brokenResources: number
  is4xx: number
  is5xx: number
  largePageSize: number
  noImageAlt: number
  redirectChain: number
  isHttps: number
  linksInternal: number
  linksExternal: number
}

interface AuditTask {
  id: string
  task_id: string
  status: 'pending' | 'in_progress' | 'finished' | 'error'
  summary: OnPageSummary | null
  created_at: string
  finished_at: string | null
  error_message: string | null
}

// ── Issue groups ──────────────────────────────────────────────────────────────

type Severity = 'error' | 'warning' | 'notice'

interface Issue {
  label: string
  count: number
  severity: Severity
  description: string
}

function buildIssues(s: OnPageSummary): Issue[] {
  const all: Issue[] = [
    { label: 'Broken links',              count: s.brokenLinks,          severity: 'error',   description: 'Internal or external links returning 4xx/5xx responses.' },
    { label: 'Broken resources',          count: s.brokenResources,      severity: 'error',   description: 'Images, scripts, or stylesheets that fail to load.' },
    { label: '4xx pages',                 count: s.is4xx,                severity: 'error',   description: 'Pages returning client error responses (e.g. 404 Not Found).' },
    { label: '5xx pages',                 count: s.is5xx,                severity: 'error',   description: 'Pages returning server error responses.' },
    { label: 'Missing title tag',         count: s.noTitle,              severity: 'error',   description: 'Pages with no <title> element — critical for SEO.' },
    { label: 'Missing H1',                count: s.noH1,                 severity: 'warning', description: 'Pages with no H1 heading.' },
    { label: 'Missing meta description',  count: s.noDescription,        severity: 'warning', description: 'Pages with no meta description tag.' },
    { label: 'Duplicate title tags',      count: s.duplicateTitle,       severity: 'warning', description: 'Multiple pages sharing the same title.' },
    { label: 'Duplicate meta desc.',      count: s.duplicateDescription, severity: 'warning', description: 'Multiple pages sharing the same meta description.' },
    { label: 'Missing image alt text',    count: s.noImageAlt,           severity: 'warning', description: 'Images without alt attributes (hurts accessibility + SEO).' },
    { label: 'Redirect chains',           count: s.redirectChain,        severity: 'warning', description: 'Pages with 2+ consecutive redirects, wasting crawl budget.' },
    { label: 'Large page size',           count: s.largePageSize,        severity: 'notice',  description: 'Pages exceeding recommended size limit (affects speed).' },
  ]
  return all.filter(i => i.count > 0)
}

const SEV_COLORS: Record<Severity, { dot: string; badge: string; text: string }> = {
  error:   { dot: 'bg-red-500',    badge: 'bg-red-500/15 text-red-400 border-red-500/20',    text: 'text-red-400'    },
  warning: { dot: 'bg-amber-400',  badge: 'bg-amber-400/15 text-amber-400 border-amber-400/20', text: 'text-amber-400' },
  notice:  { dot: 'bg-blue-400',   badge: 'bg-blue-400/15 text-blue-400 border-blue-400/20',  text: 'text-blue-400'  },
}

// ── Score ring ────────────────────────────────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const r = 44
  const circ = 2 * Math.PI * r
  const fill = (score / 100) * circ
  const color = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444'
  return (
    <svg width="108" height="108" viewBox="0 0 108 108">
      <circle cx="54" cy="54" r={r} fill="none" stroke="#1f2937" strokeWidth="10" />
      <circle cx="54" cy="54" r={r} fill="none" stroke={color} strokeWidth="10"
        strokeDasharray={`${fill} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 54 54)" />
      <text x="54" y="54" textAnchor="middle" dominantBaseline="central"
        fontSize="22" fontWeight="bold" fill={color}>{Math.round(score)}</text>
      <text x="54" y="70" textAnchor="middle" fontSize="9" fill="#6b7280">/ 100</text>
    </svg>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SiteAuditPage() {
  const [task, setTask]         = useState<AuditTask | null | undefined>(undefined) // undefined = loading
  const [running, setRunning]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [polling, setPolling]   = useState(false)

  // Drill-down state: which issue label is expanded, and its page results
  const [expandedIssue, setExpandedIssue]     = useState<string | null>(null)
  const [issuePages, setIssuePages]           = useState<IssuePage[]>([])
  const [loadingIssue, setLoadingIssue]       = useState(false)

  async function toggleIssue(label: string) {
    if (expandedIssue === label) {
      setExpandedIssue(null)
      return
    }
    const checkKey = ISSUE_CHECK_KEYS[label]
    if (!checkKey) return
    setExpandedIssue(label)
    setIssuePages([])
    setLoadingIssue(true)
    try {
      const res = await fetch(`/api/site-audit/pages?check=${checkKey}`)
      const { pages } = await res.json()
      setIssuePages(pages ?? [])
    } catch { /* silent */ }
    finally { setLoadingIssue(false) }
  }

  // Load latest task on mount
  useEffect(() => {
    fetch('/api/site-audit')
      .then(r => r.json())
      .then(({ task: t }) => setTask(t ?? null))
      .catch(() => setTask(null))
  }, [])

  // Auto-poll while task is in-progress
  const pollTask = useCallback(async (rowId: string) => {
    setPolling(true)
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/site-audit?poll=${rowId}`)
        const { task: t } = await res.json()
        if (t?.status === 'finished' || t?.status === 'error') {
          setTask(t)
          setPolling(false)
          clearInterval(interval)
        }
      } catch { /* silent */ }
    }, 5_000)
    // Stop after 5 min regardless
    setTimeout(() => { clearInterval(interval); setPolling(false) }, 5 * 60 * 1_000)
  }, [])

  // Start an audit
  async function runAudit() {
    setRunning(true)
    setError(null)
    try {
      const res = await fetch('/api/site-audit', { method: 'POST' })
      const { task: t, error: e } = await res.json()
      if (e) { setError(e); return }
      setTask(t)
      if (t?.status === 'in_progress') {
        await pollTask(t.id)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setRunning(false)
    }
  }

  const summary = task?.status === 'finished' ? task.summary : null
  const issues  = summary ? buildIssues(summary) : []
  const errors   = issues.filter(i => i.severity === 'error')
  const warnings = issues.filter(i => i.severity === 'warning')
  const notices  = issues.filter(i => i.severity === 'notice')
  const isLoading = task === undefined || running

  return (
    <div className="p-8 max-w-5xl">

      {/* ── Header ── */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">🔧 Site Audit Digest</h1>
          <p className="text-gray-400 text-sm mt-1">Technical SEO health check via DataForSEO on-page audit</p>
        </div>
        <button
          onClick={runAudit}
          disabled={running || polling}
          className="flex-shrink-0 text-xs bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg transition font-medium flex items-center gap-1.5"
        >
          {running ? '⏳ Running…' : polling ? '🔄 Crawling…' : '▶ Run Audit'}
        </button>
      </div>

      {error && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* ── SEMrush section (placeholder) ── */}
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-6 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-blue-400 font-semibold text-sm">🚧 SEMrush Site Audit</span>
          <span className="text-[10px] text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">Coming soon</span>
        </div>
        <p className="text-gray-400 text-sm">
          Requires a SEMrush Project ID to be configured. Once set up, this section will show SEMrush campaign errors, warnings, and crawl health over time.
        </p>
        <a
          href="https://www.semrush.com/siteaudit/campaign/6047805/review/overview"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 mt-3 text-xs text-blue-400 hover:text-blue-300 transition"
        >
          📊 View in SEMrush →
        </a>
      </div>

      {/* ── DataForSEO section ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-6">
          <span className="text-base">🤖</span>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider">DataForSEO On-Page Audit</h2>
          {task?.finished_at && (
            <span className="text-[10px] text-gray-500 ml-auto">
              Last run: {new Date(task.finished_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          )}
        </div>

        {isLoading && (
          <div className="flex flex-col items-center py-12">
            <LottieLoader size={64} text={running ? 'Starting crawl… (~30–60s)' : polling ? 'Crawling g2g.com…' : 'Loading…'} />
          </div>
        )}

        {!isLoading && !task && (
          <div className="text-center py-12">
            <p className="text-3xl mb-3">🔍</p>
            <p className="text-white font-semibold mb-1">No audit yet</p>
            <p className="text-gray-400 text-sm mb-4">Run an audit to check g2g.com for technical SEO issues.</p>
            <button
              onClick={runAudit}
              className="text-xs bg-red-700 hover:bg-red-600 text-white px-4 py-2 rounded-lg font-medium transition"
            >
              ▶ Run First Audit
            </button>
          </div>
        )}

        {!isLoading && task?.status === 'in_progress' && (
          <div className="flex flex-col items-center py-12">
            <LottieLoader size={64} text="Crawling g2g.com — this usually takes 30–90 seconds" />
          </div>
        )}

        {!isLoading && task?.status === 'error' && (
          <div className="text-center py-8">
            <p className="text-red-400 font-semibold">Audit failed</p>
            <p className="text-gray-500 text-sm mt-1">{task.error_message ?? 'Unknown error'}</p>
          </div>
        )}

        {!isLoading && summary && (
          <div className="space-y-6">

            {/* Score + overview */}
            <div className="flex items-start gap-8">
              <div className="flex flex-col items-center gap-1">
                <ScoreRing score={summary.onpageScore} />
                <p className="text-[10px] text-gray-500 text-center">On-Page Score</p>
              </div>
              <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-gray-800 rounded-lg p-3 text-center">
                  <p className="text-xl font-bold text-white">{summary.pagesCrawled}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">Pages crawled</p>
                </div>
                <div className={`rounded-lg p-3 text-center ${errors.length > 0 ? 'bg-red-500/10 border border-red-500/20' : 'bg-gray-800'}`}>
                  <p className={`text-xl font-bold ${errors.length > 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {errors.reduce((s, i) => s + i.count, 0)}
                  </p>
                  <p className="text-[10px] text-gray-500 mt-0.5">Errors</p>
                </div>
                <div className={`rounded-lg p-3 text-center ${warnings.length > 0 ? 'bg-amber-400/10 border border-amber-400/20' : 'bg-gray-800'}`}>
                  <p className={`text-xl font-bold ${warnings.length > 0 ? 'text-amber-400' : 'text-green-400'}`}>
                    {warnings.reduce((s, i) => s + i.count, 0)}
                  </p>
                  <p className="text-[10px] text-gray-500 mt-0.5">Warnings</p>
                </div>
                <div className="bg-gray-800 rounded-lg p-3 text-center">
                  <p className="text-xl font-bold text-blue-400">
                    {notices.reduce((s, i) => s + i.count, 0)}
                  </p>
                  <p className="text-[10px] text-gray-500 mt-0.5">Notices</p>
                </div>
              </div>
            </div>

            {/* Link stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-800 rounded-lg p-3 flex items-center justify-between">
                <span className="text-xs text-gray-400">Internal links</span>
                <span className="text-sm font-semibold text-white">{summary.linksInternal.toLocaleString()}</span>
              </div>
              <div className="bg-gray-800 rounded-lg p-3 flex items-center justify-between">
                <span className="text-xs text-gray-400">External links</span>
                <span className="text-sm font-semibold text-white">{summary.linksExternal.toLocaleString()}</span>
              </div>
            </div>

            {/* Issues list */}
            {issues.length > 0 ? (
              <div>
                <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-3">Issues found</p>
                <div className="space-y-2">
                  {['error', 'warning', 'notice'].flatMap(sev =>
                    issues.filter(i => i.severity === sev).map(issue => {
                      const c = SEV_COLORS[issue.severity]
                      const canDrill = !!ISSUE_CHECK_KEYS[issue.label]
                      const isOpen   = expandedIssue === issue.label
                      return (
                        <div key={issue.label} className="rounded-lg overflow-hidden">
                          {/* Issue row */}
                          <div
                            onClick={() => canDrill && toggleIssue(issue.label)}
                            className={`flex items-start gap-3 bg-gray-800 px-4 py-3 ${canDrill ? 'cursor-pointer hover:bg-gray-750 transition-colors' : ''}`}
                          >
                            <div className={`w-2 h-2 rounded-full mt-1 flex-shrink-0 ${c.dot}`} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-white">{issue.label}</span>
                                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${c.badge}`}>
                                  {issue.count}
                                </span>
                              </div>
                              <p className="text-xs text-gray-500 mt-0.5">{issue.description}</p>
                            </div>
                            {canDrill && (
                              <span className="text-gray-500 text-xs mt-0.5 flex-shrink-0">
                                {isOpen ? '▲ hide' : '▼ see pages'}
                              </span>
                            )}
                          </div>

                          {/* Drill-down panel */}
                          {isOpen && (
                            <div className="bg-gray-850 border-t border-gray-700 px-4 py-3">
                              {loadingIssue ? (
                                <p className="text-xs text-gray-500 animate-pulse">Loading affected pages…</p>
                              ) : issuePages.length === 0 ? (
                                <p className="text-xs text-gray-500">No pages found (or audit data expired — re-run the audit).</p>
                              ) : (
                                <div className="space-y-1.5">
                                  {issuePages.map((p, idx) => (
                                    <div key={idx} className="flex items-center gap-3">
                                      <a
                                        href={p.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-blue-400 hover:text-blue-300 truncate flex-1 font-mono"
                                      >
                                        {p.url.replace('https://', '').replace('http://', '')}
                                      </a>
                                      {p.status_code && p.status_code !== 200 && (
                                        <span className="text-[10px] text-red-400 flex-shrink-0">{p.status_code}</span>
                                      )}
                                      {p.onpage_score != null && (
                                        <span className="text-[10px] text-gray-500 flex-shrink-0">
                                          score {Math.round(p.onpage_score)}
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
                <p className="text-green-400 font-semibold text-sm">✅ No issues found</p>
                <p className="text-gray-400 text-xs mt-1">g2g.com looks healthy across all {summary.pagesCrawled} crawled pages.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
