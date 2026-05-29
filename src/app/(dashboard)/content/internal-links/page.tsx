'use client'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { LottieLoader } from '@/components/ui/LottieLoader'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Summary {
  totalCrawledPages: number
  totalClusters: number
  orphanCount: number
  opportunityCount: number
  avgInlinks: number
  wellLinked: number
}

interface Suggestion {
  id: string
  keyword: string
  url_slug: string
  is_pillar: boolean
  map_topic: string
  cluster_group: string | null
}

interface Orphan {
  id: string
  keyword: string
  url_slug: string
  map_id: string
  map_topic: string
  is_pillar: boolean
  cluster_group: string | null
  resolved_path: string | null
  inlinks_count: number
  outlinks_count: number
  inlinks: { from: string; anchor: string | null; dofollow: boolean }[]
  suggestions: Suggestion[]
}

interface Opportunity {
  from_keyword: string
  from_slug: string
  from_path: string | null
  from_is_pillar: boolean
  to_keyword: string
  to_slug: string
  to_path: string | null
  to_is_pillar: boolean
  map_topic: string
  cluster_group: string | null
  reason: 'pillar_to_cluster' | 'cluster_to_pillar' | 'intra_group'
}

interface PageRow {
  url: string
  path: string
  inlinks_count: number
  links_internal: number
  status_code: number | null
  title: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const REASON_LABELS: Record<string, { label: string; color: string; icon: string }> = {
  pillar_to_cluster: { label: 'Pillar → Cluster', color: 'bg-red-900/40 text-red-300 border-red-800/50', icon: '🏛️' },
  cluster_to_pillar: { label: 'Cluster → Pillar', color: 'bg-orange-900/40 text-orange-300 border-orange-800/50', icon: '⬆️' },
  intra_group:       { label: 'Same group', color: 'bg-blue-900/40 text-blue-300 border-blue-800/50', icon: '↔️' },
}

function inlinksBadge(n: number) {
  if (n === 0)  return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-900/50 text-red-300 border border-red-800">0 links</span>
  if (n < 3)    return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-yellow-900/50 text-yellow-300 border border-yellow-800">{n} link{n !== 1 ? 's' : ''}</span>
  return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-green-900/40 text-green-400 border border-green-800">{n} links</span>
}

// ── AnchorSuggest ─────────────────────────────────────────────────────────────
function AnchorSuggest({ fromKeyword, toKeyword, toSlug }: {
  fromKeyword: string; toKeyword: string; toSlug: string
}) {
  const [anchor, setAnchor] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied]   = useState(false)

  async function generate() {
    setLoading(true)
    try {
      const res  = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content:
            `Write 3 natural anchor text options for an internal link.\n` +
            `The link is FROM a page about: "${fromKeyword}"\n` +
            `TO a page about: "${toKeyword}" (URL: /${toSlug})\n\n` +
            `Context: G2G.com gaming marketplace. Keep anchors short (2-6 words), natural, keyword-relevant.\n` +
            `Reply with ONLY the 3 anchor texts as a numbered list, nothing else.`
          }],
          pageDescription: 'Internal Linking Manager',
        }),
      })
      const data = await res.json()
      setAnchor(data.reply ?? data.content ?? '')
    } catch { /* silent */ }
    finally { setLoading(false) }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }

  return (
    <div className="mt-2">
      {!anchor ? (
        <button
          onClick={generate}
          disabled={loading}
          className="text-[10px] text-blue-400 hover:text-blue-300 transition flex items-center gap-1 disabled:opacity-50"
        >
          {loading ? <span className="animate-spin">⟳</span> : '✨'} Generate anchor text
        </button>
      ) : (
        <div className="bg-gray-800 rounded-lg p-2 mt-1">
          <pre className="text-[10px] text-gray-300 whitespace-pre-wrap">{anchor}</pre>
          <button
            onClick={() => copy(anchor)}
            className="text-[10px] text-blue-400 hover:text-blue-300 transition mt-1"
          >{copied ? '✓ Copied' : 'Copy'}</button>
        </div>
      )}
    </div>
  )
}

// ── OrphanCard ────────────────────────────────────────────────────────────────
function OrphanCard({ orphan }: { orphan: Orphan }) {
  const [expanded, setExpanded] = useState(false)
  const [showAnchorFor, setShowAnchorFor] = useState<string | null>(null)

  return (
    <div className={`bg-gray-900 border rounded-xl overflow-hidden transition ${
      orphan.inlinks_count === 0 ? 'border-red-800/40' : 'border-yellow-800/30'
    }`}>
      <div
        className="px-4 py-3 flex items-start gap-3 cursor-pointer hover:bg-gray-800/30 transition"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Severity dot */}
        <div className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${
          orphan.inlinks_count === 0 ? 'bg-red-500' : 'bg-yellow-500'
        }`} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {orphan.is_pillar && <span className="text-[10px] text-red-400">🏛️</span>}
            <span className="text-white text-xs font-medium">{orphan.keyword}</span>
            {inlinksBadge(orphan.inlinks_count)}
            <span className="text-gray-600 text-[10px]">· {orphan.map_topic}</span>
            {orphan.cluster_group && (
              <span className="text-gray-600 text-[10px]">· {orphan.cluster_group}</span>
            )}
          </div>
          <p className="text-gray-700 text-[10px] font-mono mt-0.5">/{orphan.url_slug}</p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="text-right">
            <p className="text-gray-500 text-[10px]">{orphan.outlinks_count} out</p>
          </div>
          <span className="text-gray-600 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-800 pt-3">
          <div className="grid grid-cols-2 gap-4">
            {/* Current inbound links */}
            <div>
              <p className="text-gray-500 text-[10px] font-semibold uppercase tracking-wider mb-2">
                Current inbound links ({orphan.inlinks.length})
              </p>
              {orphan.inlinks.length === 0 ? (
                <p className="text-red-400 text-xs">No pages link here</p>
              ) : (
                <div className="space-y-1">
                  {orphan.inlinks.slice(0, 5).map((link, i) => (
                    <div key={i} className="text-[10px] text-gray-400 flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${link.dofollow ? 'bg-green-500' : 'bg-gray-600'}`} />
                      <span className="font-mono truncate max-w-[180px]">{link.from}</span>
                      {link.anchor && <span className="text-gray-600">"{link.anchor}"</span>}
                    </div>
                  ))}
                  {orphan.inlinks.length > 5 && (
                    <p className="text-gray-700 text-[10px]">+{orphan.inlinks.length - 5} more</p>
                  )}
                </div>
              )}
            </div>

            {/* Suggested sources */}
            <div>
              <p className="text-gray-500 text-[10px] font-semibold uppercase tracking-wider mb-2">
                Suggested link sources
              </p>
              {orphan.suggestions.length === 0 ? (
                <p className="text-gray-600 text-xs">No suggestions available</p>
              ) : (
                <div className="space-y-2">
                  {orphan.suggestions.map(s => (
                    <div key={s.id} className="bg-gray-800 rounded-lg p-2">
                      <div className="flex items-center gap-1.5">
                        {s.is_pillar && <span className="text-[10px]">🏛️</span>}
                        <span className="text-xs text-gray-200 font-medium">{s.keyword}</span>
                      </div>
                      <p className="text-gray-600 text-[10px] font-mono">/{s.url_slug}</p>
                      {showAnchorFor === s.id ? (
                        <AnchorSuggest
                          fromKeyword={s.keyword}
                          toKeyword={orphan.keyword}
                          toSlug={orphan.url_slug}
                        />
                      ) : (
                        <button
                          onClick={() => setShowAnchorFor(s.id)}
                          className="text-[10px] text-blue-400 hover:text-blue-300 transition mt-1"
                        >✨ Suggest anchor</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── OpportunityRow ────────────────────────────────────────────────────────────
function OpportunityRow({ opp, showAnchor, onToggleAnchor }: {
  opp: Opportunity
  showAnchor: boolean
  onToggleAnchor: () => void
}) {
  const badge = REASON_LABELS[opp.reason]

  return (
    <div className="px-4 py-3 hover:bg-gray-800/20 transition border-t border-gray-800/60">
      <div className="flex items-start gap-3">
        {/* Reason badge */}
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border flex-shrink-0 mt-0.5 ${badge.color}`}>
          {badge.icon} {badge.label}
        </span>

        {/* From → To */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 min-w-0">
              {opp.from_is_pillar && <span className="text-[10px]">🏛️</span>}
              <span className="text-gray-200 text-xs font-medium truncate max-w-[180px]">{opp.from_keyword}</span>
              <span className="text-gray-600 font-mono text-[10px] hidden lg:inline">/{opp.from_slug}</span>
            </div>
            <span className="text-gray-600 text-xs flex-shrink-0">→</span>
            <div className="flex items-center gap-1.5 min-w-0">
              {opp.to_is_pillar && <span className="text-[10px]">🏛️</span>}
              <span className="text-gray-200 text-xs font-medium truncate max-w-[180px]">{opp.to_keyword}</span>
              <span className="text-gray-600 font-mono text-[10px] hidden lg:inline">/{opp.to_slug}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-gray-600 text-[10px]">{opp.map_topic}</span>
            {opp.cluster_group && <span className="text-gray-700 text-[10px]">· {opp.cluster_group}</span>}
          </div>

          {showAnchor && (
            <AnchorSuggest
              fromKeyword={opp.from_keyword}
              toKeyword={opp.to_keyword}
              toSlug={opp.to_slug}
            />
          )}
        </div>

        {/* Action */}
        <button
          onClick={onToggleAnchor}
          className="text-[10px] text-blue-400 hover:text-blue-300 transition flex-shrink-0"
          title="Generate anchor text suggestion"
        >✨ Anchor</button>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
type Tab = 'orphans' | 'opportunities' | 'linkmap'

export default function InternalLinksPage() {
  const [data, setData]         = useState<{
    summary: Summary
    orphans: Orphan[]
    opportunities: Opportunity[]
    pages: PageRow[]
    taskId: string
  } | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error,   setError]     = useState('')
  const [needsAudit, setNeedsAudit] = useState(false)
  const [tab, setTab]           = useState<Tab>('orphans')
  const [searchOrphan, setSearchOrphan] = useState('')
  const [searchOpp,    setSearchOpp]    = useState('')
  const [searchPage,   setSearchPage]   = useState('')
  const [reasonFilter, setReasonFilter] = useState<string>('all')
  const [anchorOpen,   setAnchorOpen]   = useState<Set<string>>(new Set())
  const [triggerAudit, setTriggerAudit] = useState(false)
  const [auditProgress, setAuditProgress] = useState<string | null>(null)

  // ── SKILL.INTLINK.1 — Strategic Recommendations state ─────────────────────
  const [intlinkRecs,          setIntlinkRecs]          = useState<null | {
    id:               string
    generated_at:     string
    orphan_count:     number
    opportunity_count: number
    total_pages:      number
    avg_inlinks:      number
    recommendations:  { title: string; action: string; target: string; priority: 'high'|'medium'|'low'; category: string }[]
  }>(null)
  const [intlinkRecsLoading,    setIntlinkRecsLoading]    = useState(true)
  const [intlinkRecsError,      setIntlinkRecsError]      = useState<string | null>(null)
  const [intlinkRecsGenerating, setIntlinkRecsGenerating] = useState(false)
  const [intlinkRecsDisabled,   setIntlinkRecsDisabled]   = useState(false)
  const [intlinkRecsCollapsed,  setIntlinkRecsCollapsed]  = useState(false)
  const [intlinkRecsRateMsg,    setIntlinkRecsRateMsg]    = useState<string | null>(null)

  const loadIntlinkRecs = useCallback(async () => {
    setIntlinkRecsLoading(true)
    try {
      const res  = await fetch('/api/content/internal-links/recommend')
      const json = await res.json() as { ok: boolean; record?: typeof intlinkRecs; disabled?: boolean; error?: string }
      if (json.disabled) { setIntlinkRecsDisabled(true); return }
      if (json.ok) setIntlinkRecs(json.record ?? null)
    } catch { /* silent */ } finally {
      setIntlinkRecsLoading(false)
    }
  }, []) // eslint-disable-line

  const generateIntlinkRecs = useCallback(async (force = false) => {
    if (!data) return
    setIntlinkRecsGenerating(true)
    setIntlinkRecsError(null)
    setIntlinkRecsRateMsg(null)
    try {
      const res  = await fetch('/api/content/internal-links/recommend', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          force,
          summary:     data.summary,
          top_orphans: data.orphans.slice(0, 5).map(o => ({
            keyword:  o.keyword,
            url_slug: o.url_slug,
            inlinks:  o.inlinks_count ?? 0,
          })),
          top_opps:    data.opportunities.slice(0, 5).map(op => ({
            from_keyword: op.from_keyword,
            to_keyword:   op.to_keyword,
            reason:       op.reason,
          })),
        }),
      })
      const json = await res.json() as {
        ok: boolean; cached?: boolean; rate_limited?: boolean;
        record?: typeof intlinkRecs; message?: string;
        disabled?: boolean; error?: string
      }
      if (json.disabled) { setIntlinkRecsDisabled(true); return }
      if (!json.ok) { setIntlinkRecsError(json.error ?? 'Generation failed'); return }
      if (json.rate_limited && json.message) setIntlinkRecsRateMsg(json.message)
      if (json.record) setIntlinkRecs(json.record)
    } catch (e) {
      setIntlinkRecsError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setIntlinkRecsGenerating(false)
    }
  }, [data]) // eslint-disable-line

  useEffect(() => { loadIntlinkRecs() }, [loadIntlinkRecs])

  useEffect(() => { load() }, []) // eslint-disable-line

  async function load() {
    setLoading(true)
    setError('')
    setNeedsAudit(false)
    try {
      const res  = await fetch('/api/internal-links')
      const json = await res.json()
      if (json.needsAudit) { setNeedsAudit(true); return }
      if (!res.ok) { setError(json.error ?? 'Failed to load'); return }
      setData(json)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  async function runAudit() {
    setTriggerAudit(true)
    setError('')
    setAuditProgress('Starting DataForSEO crawl…')
    try {
      const res = await fetch('/api/site-audit', { method: 'POST' })
      const json = await res.json()
      if (json.task?.status === 'finished') {
        setAuditProgress('Crawl finished. Loading link graph…')
        await load()
        setAuditProgress(null)
        setTriggerAudit(false)
        return
      }

      const taskRowId = json.task?.id
      if (!taskRowId) {
        setAuditProgress(null)
        setTriggerAudit(false)
        return
      }

      // Poll — DFS crawls of 100 pages can take 5-10 minutes. Old logic
      // gave up after 12 × 5s = 60s and silently abandoned. Now we poll
      // every 10s up to 60 attempts (10 min), with explicit progress text.
      const MAX_ATTEMPTS  = 60
      const POLL_EVERY_MS = 10_000
      const startedAt     = Date.now()
      let attempts        = 0

      const interval = setInterval(async () => {
        attempts++
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
        try {
          const poll = await fetch(`/api/site-audit?poll=${taskRowId}`)
          const pd   = await poll.json()

          if (pd.task?.status === 'finished') {
            clearInterval(interval)
            setAuditProgress('Crawl finished. Loading link graph…')
            await load()
            setAuditProgress(null)
            setTriggerAudit(false)
            return
          }

          const progress = pd.task?.summary?.crawlProgress ?? 'in_progress'
          setAuditProgress(`${elapsedSec}s elapsed · ${progress}`)

          if (attempts >= MAX_ATTEMPTS) {
            clearInterval(interval)
            setAuditProgress(null)
            setTriggerAudit(false)
            setError(
              `Audit still running after ${Math.round(MAX_ATTEMPTS * POLL_EVERY_MS / 60_000)} minutes. ` +
              `It will finish in the background — refresh this page in a few minutes to see results.`,
            )
          }
        } catch {
          // Network blip; keep retrying up to MAX_ATTEMPTS
        }
      }, POLL_EVERY_MS)
    } catch (e) {
      setError(String(e))
      setTriggerAudit(false)
      setAuditProgress(null)
    }
  }

  // Filtered data
  const filteredOrphans = useMemo(() => {
    if (!data) return []
    let list = data.orphans
    if (searchOrphan.trim()) {
      const q = searchOrphan.toLowerCase()
      list = list.filter(o => o.keyword.toLowerCase().includes(q) || o.url_slug.includes(q) || o.map_topic.toLowerCase().includes(q))
    }
    return list
  }, [data, searchOrphan])

  const filteredOpps = useMemo(() => {
    if (!data) return []
    let list = data.opportunities
    if (reasonFilter !== 'all') list = list.filter(o => o.reason === reasonFilter)
    if (searchOpp.trim()) {
      const q = searchOpp.toLowerCase()
      list = list.filter(o =>
        o.from_keyword.toLowerCase().includes(q) ||
        o.to_keyword.toLowerCase().includes(q) ||
        o.map_topic.toLowerCase().includes(q)
      )
    }
    return list
  }, [data, reasonFilter, searchOpp])

  const filteredPages = useMemo(() => {
    if (!data) return []
    let list = data.pages
    if (searchPage.trim()) {
      const q = searchPage.toLowerCase()
      list = list.filter(p => p.path.includes(q) || p.title.toLowerCase().includes(q))
    }
    return list.sort((a, b) => b.inlinks_count - a.inlinks_count)
  }, [data, searchPage])

  function toggleAnchor(key: string) {
    setAnchorOpen(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) return (
    <div className="flex items-center justify-center h-full py-32">
      <LottieLoader size={80} text="Analyzing internal links…" />
    </div>
  )

  if (needsAudit) return (
    <div className="p-8 flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="w-16 h-16 bg-gray-800 rounded-2xl flex items-center justify-center text-3xl mb-4">🔍</div>
      <h2 className="text-white font-bold text-lg mb-2">No site audit found</h2>
      <p className="text-gray-500 text-sm max-w-md mb-6">
        Internal linking analysis requires a site crawl. Run a full site audit first — it crawls up to 100 pages and builds the link graph.
      </p>
      <button
        onClick={runAudit}
        disabled={triggerAudit}
        className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white font-semibold px-6 py-2.5 rounded-xl transition flex items-center gap-2"
      >
        {triggerAudit
          ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Running audit…</>
          : '🔍 Run Site Audit'}
      </button>
      {auditProgress && triggerAudit && (
        <p className="text-blue-400 text-xs mt-3 max-w-md">{auditProgress}</p>
      )}
      <p className="text-gray-700 text-xs mt-3">
        DataForSEO crawl of 100 pages typically takes 3–8 minutes. We&apos;ll keep polling for up to 10 minutes.
        After that the crawl continues in the background — just refresh this page later to see results.
      </p>
    </div>
  )

  if (error) return (
    <div className="p-8">
      <div className="bg-red-900/30 border border-red-700 rounded-xl px-5 py-4 text-red-300 text-sm">{error}</div>
    </div>
  )

  if (!data) return null

  const { summary } = data

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-white font-bold text-xl">Internal Linking</h1>
          <p className="text-gray-500 text-sm mt-1">
            Orphan pages, link opportunities, and coverage across topic clusters
          </p>
        </div>
        <button
          onClick={load}
          className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white px-3 py-1.5 rounded-lg transition"
        >↺ Refresh</button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 mb-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-gray-500 text-xs mb-1">Crawled pages</p>
          <p className="text-white font-bold text-xl">{summary.totalCrawledPages.toLocaleString()}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-gray-500 text-xs mb-1">Keyword map pages</p>
          <p className="text-white font-bold text-xl">{summary.totalClusters}</p>
          <p className="text-green-400 text-[10px]">{summary.wellLinked} well-linked</p>
        </div>
        <div className={`border rounded-xl p-4 ${summary.orphanCount > 0 ? 'bg-red-900/20 border-red-800/40' : 'bg-gray-900 border-gray-800'}`}>
          <p className="text-gray-500 text-xs mb-1">Orphan / weak pages</p>
          <p className={`font-bold text-xl ${summary.orphanCount > 0 ? 'text-red-400' : 'text-green-400'}`}>{summary.orphanCount}</p>
          <p className="text-gray-600 text-[10px]">&lt; 3 inbound links</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-gray-500 text-xs mb-1">Avg inlinks</p>
          <p className="text-white font-bold text-xl">{summary.avgInlinks}</p>
          <p className="text-gray-600 text-[10px]">per cluster page</p>
        </div>
        <div className="bg-orange-900/20 border border-orange-800/30 rounded-xl p-4 col-span-2">
          <p className="text-gray-500 text-xs mb-1">Link opportunities</p>
          <p className="text-orange-400 font-bold text-xl">{summary.opportunityCount}</p>
          <p className="text-gray-600 text-[10px]">missing pillar↔cluster + intra-group links</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 mb-5 w-fit">
        {([
          { key: 'orphans',       label: `🔴 Orphans (${summary.orphanCount})` },
          { key: 'opportunities', label: `🔗 Opportunities (${Math.min(summary.opportunityCount, 200)})` },
          { key: 'linkmap',       label: `📋 Link Map (${Math.min(summary.totalCrawledPages, 500)})` },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-xs font-medium rounded-lg transition ${tab === t.key ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >{t.label}</button>
        ))}
      </div>

      {/* ── Tab: Orphans ──────────────────────────────────────────────────────── */}
      {tab === 'orphans' && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <input
              type="text"
              value={searchOrphan}
              onChange={e => setSearchOrphan(e.target.value)}
              placeholder="Search keyword, slug, or topic…"
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 w-72"
            />
            <span className="text-gray-600 text-xs ml-auto">{filteredOrphans.length} pages</span>
          </div>

          {filteredOrphans.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl flex flex-col items-center justify-center py-16 text-center">
              <p className="text-2xl mb-2">✅</p>
              <p className="text-gray-400 text-sm font-medium">No orphan pages found</p>
              <p className="text-gray-600 text-xs mt-1">All keyword map pages have 3+ inbound internal links</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredOrphans.map(o => (
                <OrphanCard key={o.id} orphan={o} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Opportunities ────────────────────────────────────────────────── */}
      {tab === 'opportunities' && (
        <div>
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <input
              type="text"
              value={searchOpp}
              onChange={e => setSearchOpp(e.target.value)}
              placeholder="Search keyword or topic…"
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 w-60"
            />
            <div className="flex gap-1 bg-gray-800 rounded-lg p-0.5">
              {[
                { v: 'all', l: 'All' },
                { v: 'pillar_to_cluster', l: '🏛️ Pillar→Cluster' },
                { v: 'cluster_to_pillar', l: '⬆️ Cluster→Pillar' },
                { v: 'intra_group', l: '↔️ Same group' },
              ].map(f => (
                <button
                  key={f.v}
                  onClick={() => setReasonFilter(f.v)}
                  className={`px-3 py-1 text-xs rounded-md transition ${reasonFilter === f.v ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
                >{f.l}</button>
              ))}
            </div>
            <span className="text-gray-600 text-xs ml-auto">{filteredOpps.length} opportunities</span>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            {filteredOpps.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <p className="text-2xl mb-2">✅</p>
                <p className="text-gray-400 text-sm">All topic cluster links are in place</p>
              </div>
            ) : (
              <div>
                <div className="px-4 py-2.5 bg-gray-800/40 border-b border-gray-800 flex items-center gap-3">
                  <span className="text-gray-500 text-xs font-medium">Type</span>
                  <span className="text-gray-500 text-xs font-medium flex-1">From → To</span>
                  <span className="text-gray-500 text-xs font-medium">Anchor</span>
                </div>
                {filteredOpps.map((o, i) => {
                  const key = `${o.from_slug}→${o.to_slug}`
                  return (
                    <OpportunityRow
                      key={i}
                      opp={o}
                      showAnchor={anchorOpen.has(key)}
                      onToggleAnchor={() => toggleAnchor(key)}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Tab: Link Map ─────────────────────────────────────────────────────── */}
      {tab === 'linkmap' && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <input
              type="text"
              value={searchPage}
              onChange={e => setSearchPage(e.target.value)}
              placeholder="Search URL or title…"
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 w-72"
            />
            <span className="text-gray-600 text-xs ml-auto">{filteredPages.length} pages</span>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-800/40 border-b border-gray-800">
                <tr>
                  <th className="text-left py-3 px-4 text-gray-500 font-medium">Page</th>
                  <th className="text-right py-3 px-3 text-gray-500 font-medium">Inbound links</th>
                  <th className="text-right py-3 px-3 text-gray-500 font-medium">Outbound links</th>
                  <th className="text-right py-3 px-3 text-gray-500 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredPages.map((p, i) => (
                  <tr key={i} className="border-t border-gray-800/60 hover:bg-gray-800/20 transition">
                    <td className="py-2.5 px-4">
                      <p className="text-gray-200 truncate max-w-[340px]">{p.title || p.path}</p>
                      <p className="text-gray-700 text-[10px] font-mono">{p.path}</p>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <span className={`font-semibold ${p.inlinks_count === 0 ? 'text-red-400' : p.inlinks_count < 3 ? 'text-yellow-400' : 'text-green-400'}`}>
                        {p.inlinks_count}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right text-gray-400">{p.links_internal}</td>
                    <td className="py-2.5 px-3 text-right">
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                        p.status_code === 200 ? 'bg-green-900/40 text-green-400' :
                        p.status_code && p.status_code >= 400 ? 'bg-red-900/40 text-red-400' :
                        'bg-gray-800 text-gray-500'
                      }`}>
                        {p.status_code ?? '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── SKILL.INTLINK.1 — Strategic Recommendations ──────────────────────── */}
      {!intlinkRecsDisabled && data && (
        <div className="mt-8 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">

          {/* Section header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
            <button
              onClick={() => setIntlinkRecsCollapsed(v => !v)}
              className="flex items-center gap-2 text-left flex-1 min-w-0"
            >
              <span className="text-base">💡</span>
              <span className="font-semibold text-white text-sm">Strategic Recommendations</span>
              {intlinkRecs && (
                <span className="text-xs text-gray-500 ml-1">
                  · {new Date(intlinkRecs.generated_at).toLocaleDateString()}
                </span>
              )}
              <svg
                className={`w-4 h-4 text-gray-600 flex-shrink-0 transition-transform ${intlinkRecsCollapsed ? '-rotate-90' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            <div className="flex items-center gap-2 flex-shrink-0 ml-3">
              {intlinkRecs && (
                <button
                  onClick={() => generateIntlinkRecs(true)}
                  disabled={intlinkRecsGenerating || !data}
                  className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 border border-gray-700 text-gray-300 hover:text-white rounded-lg transition"
                  title="Force regenerate (ignores 7-day rate limit)"
                >
                  {intlinkRecsGenerating ? '…' : '🔄 Regenerate'}
                </button>
              )}
              {!intlinkRecs && !intlinkRecsLoading && (
                <button
                  onClick={() => generateIntlinkRecs(false)}
                  disabled={intlinkRecsGenerating || !data}
                  className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold rounded-lg transition"
                >
                  {intlinkRecsGenerating ? 'Generating…' : '✨ Generate'}
                </button>
              )}
            </div>
          </div>

          {!intlinkRecsCollapsed && (
            <div className="p-5">

              {/* Rate-limit notice */}
              {intlinkRecsRateMsg && (
                <div className="mb-4 bg-amber-900/20 border border-amber-800/40 rounded-lg px-4 py-2.5 text-xs text-amber-300">
                  {intlinkRecsRateMsg}
                </div>
              )}

              {/* Error */}
              {intlinkRecsError && (
                <div className="mb-4 bg-red-900/20 border border-red-800/40 rounded-lg px-4 py-2.5 text-xs text-red-300">
                  {intlinkRecsError}
                </div>
              )}

              {/* Loading / Generating */}
              {(intlinkRecsLoading || intlinkRecsGenerating) && (
                <div className="flex items-center gap-3 py-6 justify-center">
                  <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-gray-400 text-sm">
                    {intlinkRecsGenerating ? 'Generating strategic recommendations via Claude Haiku…' : 'Loading…'}
                  </span>
                </div>
              )}

              {/* Empty state — prompt user to generate */}
              {!intlinkRecsLoading && !intlinkRecsGenerating && !intlinkRecs && !intlinkRecsError && (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <span className="text-3xl">🔗</span>
                  <p className="text-gray-300 font-medium text-sm">No recommendations yet</p>
                  <p className="text-gray-500 text-xs max-w-sm">
                    Click <strong>Generate</strong> to get strategic internal-linking recommendations
                    tailored to your current orphan and opportunity data.
                    Rate-limited to once per 7 days.
                  </p>
                  <button
                    onClick={() => generateIntlinkRecs(false)}
                    disabled={intlinkRecsGenerating}
                    className="text-sm px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-semibold rounded-lg transition"
                  >
                    ✨ Generate Recommendations
                  </button>
                </div>
              )}

              {/* Recommendation cards */}
              {!intlinkRecsLoading && !intlinkRecsGenerating && intlinkRecs && (
                <div className="space-y-3">
                  {intlinkRecs.recommendations.map((rec, i) => {
                    const priorityStyle =
                      rec.priority === 'high'   ? 'border-l-red-500'    :
                      rec.priority === 'medium' ? 'border-l-amber-500'  :
                                                   'border-l-blue-600'

                    const priorityBadge =
                      rec.priority === 'high'   ? 'bg-red-900/40 text-red-300 border-red-800/50'        :
                      rec.priority === 'medium' ? 'bg-amber-900/40 text-amber-300 border-amber-800/50'  :
                                                   'bg-blue-900/40 text-blue-300 border-blue-800/50'

                    const catBadge =
                      rec.category === 'orphan_fix'   ? 'bg-red-900/30 text-red-400'        :
                      rec.category === 'hub_spoke'    ? 'bg-violet-900/30 text-violet-400'  :
                      rec.category === 'cluster_link' ? 'bg-sky-900/30 text-sky-400'        :
                      rec.category === 'anchor_text'  ? 'bg-emerald-900/30 text-emerald-400' :
                                                         'bg-indigo-900/30 text-indigo-400'

                    return (
                      <div key={i} className={`border-l-2 ${priorityStyle} bg-gray-950/60 rounded-r-lg p-4 space-y-2`}>
                        <div className="flex items-start gap-2 flex-wrap">
                          <span className="font-semibold text-white text-sm flex-1 min-w-0">{rec.title}</span>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border ${priorityBadge}`}>
                              {rec.priority}
                            </span>
                            <span className={`text-[10px] font-medium px-2 py-0.5 rounded ${catBadge}`}>
                              {rec.category.replace(/_/g, ' ')}
                            </span>
                          </div>
                        </div>
                        <p className="text-sm text-gray-300 leading-relaxed">{rec.action}</p>
                        {rec.target && (
                          <p className="text-xs text-indigo-400/80">
                            <span className="text-gray-600">Target: </span>{rec.target}
                          </p>
                        )}
                      </div>
                    )
                  })}

                  {/* Context + attribution */}
                  <div className="pt-2 border-t border-gray-800/50 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
                    <span>
                      Based on {intlinkRecs.total_pages.toLocaleString()} pages ·{' '}
                      {intlinkRecs.orphan_count} orphans ·{' '}
                      {intlinkRecs.opportunity_count} opportunities
                    </span>
                    <span>Generated via Anthropic skill: searchfit-seo:internal-linking · Model: claude-haiku-4-5</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
