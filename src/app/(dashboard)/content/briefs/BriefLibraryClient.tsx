'use client'

import { useMemo, useState } from 'react'

/**
 * BriefLibraryClient — client-side filterable, sortable brief list.
 *
 * Filter dimensions:
 *   • status         — generating / draft / agent_generated / reviewed / published
 *   • tyr verdict    — reviewed / borderline / failed (or no review yet)
 *   • Tyr score band — auto-promoted (≥80), borderline (70-79), failed (<70)
 *   • keyword search — substring match on primary_keyword OR page URL
 *   • date range     — created_at within last N days (7 / 30 / 90 / all)
 *
 * Each row supports:
 *   • Open editor — `/gsc/action-items/[id]` when action_item_id present,
 *                    otherwise `/content/briefs/[id]` (read-only viewer)
 *   • Copy brief  — copy outline + meta + FAQ as markdown to clipboard
 *   • Mark published — flip status to 'published' (requires API call)
 */

interface OutlineSection { heading?: string; points?: string[] }
interface FaqItem      { question?: string; suggested_answer?: string }
interface KeywordItem  { keyword?: string; volume?: number | null }

interface Brief {
  id:               string
  page:             string | null
  primary_keyword:  string | null
  brief_type:       string | null
  status:           string | null
  tyr_score:        number | null
  tyr_status:       string | null
  tyr_reviewed_at:  string | null
  action_item_id:   string | null
  content_outline:  unknown
  content_draft:    string | null
  faq_suggestions:  unknown
  new_keywords:     unknown
  notes:            string | null
  created_at:       string | null
  updated_at:       string | null
}

const STATUS_STYLES: Record<string, string> = {
  draft:           'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  generating:      'bg-orange-500/10 text-orange-400 border-orange-500/20 animate-pulse',
  agent_generated: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  reviewed:        'bg-blue-500/10 text-blue-400 border-blue-500/20',
  published:       'bg-green-500/10 text-green-400 border-green-500/20',
}

const STATUS_LABEL: Record<string, string> = {
  draft:           '📝 Draft',
  generating:      '⏳ Generating',
  agent_generated: '🤖 AI Draft',
  reviewed:        '✅ Reviewed',
  published:       '🚀 Published',
}

const TYR_LABEL: Record<string, string> = {
  reviewed:    '✅ Passed',
  borderline:  '⚠ Borderline',
  failed:      '❌ Failed',
  error:       '⚠ Error',
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString('id-ID')
}

function pathOnly(url: string | null): string {
  if (!url) return ''
  try { return new URL(url).pathname } catch { return url }
}

/**
 * Build a markdown-formatted dump of the brief for clipboard copy.
 * Useful when handing off to writers via Slack/Notion/email.
 */
function briefAsMarkdown(b: Brief): string {
  const outline:  OutlineSection[] = Array.isArray(b.content_outline) ? b.content_outline as OutlineSection[] : []
  const faqs:     FaqItem[]        = Array.isArray(b.faq_suggestions) ? b.faq_suggestions as FaqItem[]      : []
  const keywords: KeywordItem[]    = Array.isArray(b.new_keywords)    ? b.new_keywords    as KeywordItem[]   : []

  const parts: string[] = []
  parts.push(`# ${b.primary_keyword ?? pathOnly(b.page) ?? 'Untitled brief'}`)
  parts.push('')
  if (b.page) parts.push(`**Target page:** ${b.page}`)
  if (b.brief_type) parts.push(`**Brief type:** ${b.brief_type}`)
  if (b.status) parts.push(`**Status:** ${b.status}`)
  if (b.tyr_score != null) parts.push(`**Tyr score:** ${b.tyr_score}/100 (${b.tyr_status ?? '—'})`)

  if (outline.length > 0) {
    parts.push('', '## Content outline')
    for (const s of outline) {
      parts.push(`### ${s.heading ?? '(unnamed)'}`)
      for (const p of s.points ?? []) parts.push(`- ${p}`)
    }
  }

  if (faqs.length > 0) {
    parts.push('', '## FAQ suggestions')
    for (const f of faqs) {
      parts.push(`**Q:** ${f.question ?? ''}`)
      if (f.suggested_answer) parts.push(`**A:** ${f.suggested_answer}`)
      parts.push('')
    }
  }

  if (keywords.length > 0) {
    parts.push('', '## Target keywords')
    parts.push(keywords.map(k => `- ${k.keyword}${k.volume != null ? ` (${k.volume})` : ''}`).join('\n'))
  }

  if (b.content_draft) {
    parts.push('', '## Content draft', b.content_draft)
  }

  if (b.notes) {
    parts.push('', '---', `*Notes: ${b.notes}*`)
  }

  return parts.join('\n')
}

export default function BriefLibraryClient({ initialBriefs }: { initialBriefs: Brief[] }) {
  const [briefs, setBriefs]         = useState<Brief[]>(initialBriefs)
  const [statusF, setStatusF]       = useState<'all' | 'reviewed' | 'agent_generated' | 'draft' | 'published' | 'generating'>('all')
  const [tyrF, setTyrF]             = useState<'all' | 'pass' | 'borderline' | 'failed' | 'unreviewed'>('all')
  const [search, setSearch]         = useState('')
  const [dateRange, setDateRange]   = useState<'all' | '7d' | '30d' | '90d'>('all')
  const [busy, setBusy]             = useState<string | null>(null)
  const [copied, setCopied]         = useState<string | null>(null)

  const filtered = useMemo(() => {
    const sinceMs = dateRange === 'all' ? 0
      : dateRange === '7d'  ? Date.now() - 7  * 86400 * 1000
      : dateRange === '30d' ? Date.now() - 30 * 86400 * 1000
      : Date.now() - 90 * 86400 * 1000

    const lcSearch = search.trim().toLowerCase()

    return briefs.filter(b => {
      if (statusF !== 'all' && b.status !== statusF) return false

      if (tyrF !== 'all') {
        const score = b.tyr_score
        if (tyrF === 'pass'       && (score == null || score < 80))                        return false
        if (tyrF === 'borderline' && (score == null || score < 70 || score >= 80))         return false
        if (tyrF === 'failed'     && (score == null || score >= 70))                       return false
        if (tyrF === 'unreviewed' && score != null)                                        return false
      }

      if (lcSearch) {
        const hay = [
          b.primary_keyword ?? '',
          b.page ?? '',
          b.notes ?? '',
        ].join(' ').toLowerCase()
        if (!hay.includes(lcSearch)) return false
      }

      if (sinceMs > 0) {
        const ts = b.created_at ? new Date(b.created_at).getTime() : 0
        if (ts < sinceMs) return false
      }

      return true
    })
  }, [briefs, statusF, tyrF, search, dateRange])

  const counts = useMemo(() => ({
    total:    briefs.length,
    reviewed: briefs.filter(b => b.status === 'reviewed').length,
    agent:    briefs.filter(b => b.status === 'agent_generated').length,
    draft:    briefs.filter(b => b.status === 'draft').length,
    published:briefs.filter(b => b.status === 'published').length,
    failed:   briefs.filter(b => b.tyr_status === 'failed').length,
  }), [briefs])

  async function handleCopy(b: Brief) {
    try {
      await navigator.clipboard.writeText(briefAsMarkdown(b))
      setCopied(b.id)
      setTimeout(() => setCopied(prev => prev === b.id ? null : prev), 2000)
    } catch {
      alert('Copy failed — your browser may have blocked clipboard access.')
    }
  }

  async function handleMarkPublished(b: Brief) {
    if (!confirm(`Mark "${b.primary_keyword ?? pathOnly(b.page)}" as published?`)) return
    setBusy(b.id)
    try {
      const res = await fetch(`/api/content/briefs/${b.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: 'published' }),
      })
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}))
        alert(`Failed: ${error ?? res.statusText}`)
      } else {
        setBriefs(prev => prev.map(x => x.id === b.id ? { ...x, status: 'published', updated_at: new Date().toISOString() } : x))
      }
    } catch (e) {
      alert(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="p-8 max-w-7xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">📚 Brief Library</h1>
          <p className="text-gray-400 text-sm mt-1">
            All SEO content briefs — agent-drafted, manually edited, Tyr-reviewed, published.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span><span className="text-white font-semibold">{counts.total}</span> total</span>
          <span className="text-gray-700">·</span>
          <span><span className="text-blue-400 font-semibold">{counts.reviewed}</span> reviewed</span>
          <span className="text-gray-700">·</span>
          <span><span className="text-green-400 font-semibold">{counts.published}</span> published</span>
          {counts.failed > 0 && <>
            <span className="text-gray-700">·</span>
            <span><span className="text-red-400 font-semibold">{counts.failed}</span> failed</span>
          </>}
        </div>
      </div>

      {/* Filters */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 mb-5 grid grid-cols-1 md:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Status</label>
          <select
            value={statusF}
            onChange={e => setStatusF(e.target.value as 'all')}
            className="w-full bg-gray-950 border border-gray-800 rounded px-2.5 py-1.5 text-sm text-white"
          >
            <option value="all">All ({counts.total})</option>
            <option value="reviewed">✅ Reviewed ({counts.reviewed})</option>
            <option value="agent_generated">🤖 AI Draft ({counts.agent})</option>
            <option value="draft">📝 Draft ({counts.draft})</option>
            <option value="published">🚀 Published ({counts.published})</option>
            <option value="generating">⏳ Generating</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Tyr verdict</label>
          <select
            value={tyrF}
            onChange={e => setTyrF(e.target.value as 'all')}
            className="w-full bg-gray-950 border border-gray-800 rounded px-2.5 py-1.5 text-sm text-white"
          >
            <option value="all">All</option>
            <option value="pass">✅ Passed (≥80)</option>
            <option value="borderline">⚠ Borderline (70-79)</option>
            <option value="failed">❌ Failed (&lt;70)</option>
            <option value="unreviewed">— Not yet reviewed</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Created within</label>
          <select
            value={dateRange}
            onChange={e => setDateRange(e.target.value as 'all')}
            className="w-full bg-gray-950 border border-gray-800 rounded px-2.5 py-1.5 text-sm text-white"
          >
            <option value="all">All time</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Search</label>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="keyword or page path…"
            className="w-full bg-gray-950 border border-gray-800 rounded px-2.5 py-1.5 text-sm text-white placeholder-gray-600"
          />
        </div>
      </div>

      {/* Result count */}
      <p className="text-xs text-gray-500 mb-2">
        Showing {filtered.length} of {briefs.length} brief{briefs.length !== 1 ? 's' : ''}
      </p>

      {/* List */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 border-dashed rounded-2xl p-12 text-center">
            <p className="text-3xl mb-3">📭</p>
            <p className="text-white font-semibold mb-1">No briefs match your filters</p>
            <p className="text-gray-400 text-sm">Loosen the filters above, or run an agent to generate new briefs.</p>
          </div>
        ) : (
          filtered.map(b => {
            const editorUrl = b.action_item_id
              ? `/gsc/action-items/${b.action_item_id}`
              : `/content/briefs/${b.id}`
            const path = pathOnly(b.page)
            return (
              <div key={b.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      {b.status && (
                        <span className={`text-[10px] px-2 py-0.5 rounded border font-medium ${STATUS_STYLES[b.status] ?? 'bg-gray-800 text-gray-400 border-gray-700'}`}>
                          {STATUS_LABEL[b.status] ?? b.status}
                        </span>
                      )}
                      {b.tyr_score != null && (
                        <span className={`text-[10px] px-2 py-0.5 rounded border font-mono ${
                          b.tyr_score >= 80 ? 'bg-green-900/30 text-green-300 border-green-700/40' :
                          b.tyr_score >= 70 ? 'bg-amber-900/30 text-amber-300 border-amber-700/40' :
                                              'bg-red-900/30 text-red-300 border-red-700/40'
                        }`}>
                          ⚖️ {b.tyr_score}/100
                        </span>
                      )}
                      {b.tyr_status && (
                        <span className="text-[10px] text-gray-500">
                          {TYR_LABEL[b.tyr_status] ?? b.tyr_status}
                        </span>
                      )}
                      {b.brief_type && (
                        <span className="text-[10px] text-gray-600">· {b.brief_type}</span>
                      )}
                    </div>
                    <a
                      href={editorUrl}
                      className="text-white text-sm font-medium hover:text-blue-400 transition block truncate"
                    >
                      {b.primary_keyword ?? path ?? 'Untitled brief'}
                    </a>
                    {path && (
                      <p className="text-[11px] text-gray-500 truncate">{path}</p>
                    )}
                    <p className="text-[10px] text-gray-600 mt-1">
                      Created {formatDate(b.created_at)}
                      {b.updated_at && ` · Updated ${timeAgo(b.updated_at)}`}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
                    <a
                      href={editorUrl}
                      className="text-xs px-2.5 py-1.5 rounded bg-gray-800 text-gray-300 hover:bg-blue-700 hover:text-white transition"
                      title={b.action_item_id ? 'Open in editor' : 'Open read-only view'}
                    >
                      {b.action_item_id ? '✏️ Edit' : '👁 View'}
                    </a>
                    <button
                      onClick={() => handleCopy(b)}
                      className="text-xs px-2.5 py-1.5 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white transition"
                      title="Copy brief as markdown to clipboard"
                    >
                      {copied === b.id ? '✓ Copied' : '📋 Copy'}
                    </button>
                    {b.status !== 'published' && (
                      <button
                        onClick={() => handleMarkPublished(b)}
                        disabled={busy === b.id}
                        className="text-xs px-2.5 py-1.5 rounded bg-gray-800 text-gray-300 hover:bg-green-700 hover:text-white transition disabled:opacity-40"
                        title="Mark as published"
                      >
                        {busy === b.id ? '…' : '🚀 Mark published'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
