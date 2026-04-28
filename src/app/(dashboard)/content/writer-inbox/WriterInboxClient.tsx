'use client'

import { useState, useMemo, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface OutlineSection { heading?: string; points?: string[] }
interface FaqItem        { question?: string; suggested_answer?: string }
interface KeywordItem    { keyword?: string; volume?: number | null }

interface Brief {
  id:                  string
  page:                string | null
  primary_keyword:     string | null
  brief_type:          string | null
  status:              string | null
  tyr_score:           number | null
  content_outline:     unknown
  content_draft:       string | null
  faq_suggestions:     unknown
  new_keywords:        unknown
  notes:               string | null
  target_publish_date: string | null
  created_at:          string | null
  updated_at:          string | null
}

// Writer-visible lifecycle (no agent jargon)
type WriterStatus = 'ready' | 'in_progress' | 'published'

function writerStatus(b: Brief): WriterStatus {
  if (b.status === 'published') return 'published'
  if (b.status === 'draft')     return 'in_progress'
  return 'ready'  // 'reviewed' — SEO approved, ready to write
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pathOnly(url: string | null): string {
  if (!url) return ''
  try { return new URL(url).pathname } catch { return url }
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })
}

function estimateWordCount(outline: unknown): number {
  const sections = Array.isArray(outline) ? outline as OutlineSection[] : []
  // ~200 words per section heading + ~80 per bullet point
  return sections.reduce((acc, s) => acc + 200 + (s.points?.length ?? 0) * 80, 0)
}

function outlineHeadings(outline: unknown): string[] {
  const sections = Array.isArray(outline) ? outline as OutlineSection[] : []
  return sections.map(s => s.heading ?? '').filter(Boolean)
}

function faqCount(faqs: unknown): number {
  return Array.isArray(faqs) ? faqs.length : 0
}

function keywordList(kws: unknown): string[] {
  if (!Array.isArray(kws)) return []
  return (kws as KeywordItem[]).map(k => k.keyword ?? '').filter(Boolean).slice(0, 6)
}

// Urgency: overdue > due-soon > high-score > default
function urgencyScore(b: Brief): number {
  let score = 0
  if (b.target_publish_date) {
    const daysUntil = (new Date(b.target_publish_date).getTime() - Date.now()) / 86400000
    if (daysUntil < 0)  score += 1000  // overdue
    else if (daysUntil < 3)  score += 500
    else if (daysUntil < 7)  score += 200
  }
  if (b.tyr_score != null) score += b.tyr_score  // higher quality = higher priority
  return score
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: WriterStatus }) {
  const styles = {
    ready:       'bg-blue-500/15 text-blue-300 border border-blue-500/30',
    in_progress: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
    published:   'bg-green-500/15 text-green-300 border border-green-500/30',
  }
  const labels = {
    ready:       '✦ Ready to write',
    in_progress: '✎ In progress',
    published:   '✓ Published',
  }
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${styles[status]}`}>
      {labels[status]}
    </span>
  )
}

function DueDateBadge({ date }: { date: string | null }) {
  if (!date) return null
  const d = new Date(date)
  const daysUntil = (d.getTime() - Date.now()) / 86400000
  const label = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })
  if (daysUntil < 0)  return <span className="text-[10px] bg-red-900/40 text-red-300 border border-red-700/40 rounded px-1.5 py-0.5">⚠ Overdue · {label}</span>
  if (daysUntil < 3)  return <span className="text-[10px] bg-orange-900/40 text-orange-300 border border-orange-700/40 rounded px-1.5 py-0.5">🔥 Due soon · {label}</span>
  if (daysUntil < 7)  return <span className="text-[10px] bg-amber-900/40 text-amber-300 border border-amber-700/40 rounded px-1.5 py-0.5">📅 {label}</span>
  return <span className="text-[10px] text-gray-500">📅 {label}</span>
}

function OutlinePreview({ outline, expanded }: { outline: unknown; expanded: boolean }) {
  const headings = outlineHeadings(outline)
  const sections = Array.isArray(outline) ? outline as OutlineSection[] : []
  if (headings.length === 0) return <p className="text-gray-600 text-xs italic">No outline yet</p>

  if (!expanded) {
    return (
      <div className="flex flex-wrap gap-1.5 mt-2">
        {headings.slice(0, 4).map((h, i) => (
          <span key={i} className="text-[10px] bg-gray-800 text-gray-400 rounded px-2 py-0.5 border border-gray-700">
            {h}
          </span>
        ))}
        {headings.length > 4 && (
          <span className="text-[10px] text-gray-600">+{headings.length - 4} more sections</span>
        )}
      </div>
    )
  }

  return (
    <div className="mt-3 space-y-2">
      {sections.map((s, i) => (
        <div key={i}>
          <p className="text-xs text-gray-300 font-medium">{s.heading}</p>
          {(s.points ?? []).length > 0 && (
            <ul className="mt-1 space-y-0.5 pl-3">
              {s.points!.map((p, j) => (
                <li key={j} className="text-[11px] text-gray-500 list-disc list-outside">{p}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Brief Card ────────────────────────────────────────────────────────────────

function BriefCard({
  brief,
  onMarkPublished,
  onMarkInProgress,
  busy,
}: {
  brief: Brief
  onMarkPublished: (id: string) => Promise<void>
  onMarkInProgress: (id: string) => Promise<void>
  busy: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied]     = useState(false)
  const ws = writerStatus(brief)
  const headings = outlineHeadings(brief.content_outline)
  const faqs     = faqCount(brief.faq_suggestions)
  const keywords = keywordList(brief.new_keywords)
  const wordEst  = estimateWordCount(brief.content_outline)
  const path     = pathOnly(brief.page)
  const editorUrl = `/content/briefs/${brief.id}`

  async function handleCopy() {
    const kws = keywordList(brief.new_keywords)
    const sections = Array.isArray(brief.content_outline) ? brief.content_outline as OutlineSection[] : []
    const parts: string[] = [
      `# ${brief.primary_keyword ?? path ?? 'Untitled'}`,
      brief.page ? `\n**Target page:** ${brief.page}` : '',
      kws.length > 0 ? `\n**Keywords to include:** ${kws.join(', ')}` : '',
      '\n## Content Outline',
      ...sections.map(s => [
        `\n### ${s.heading ?? ''}`,
        ...(s.points ?? []).map(p => `- ${p}`),
      ].join('\n')),
    ]
    if (Array.isArray(brief.faq_suggestions) && brief.faq_suggestions.length > 0) {
      parts.push('\n## FAQ')
      for (const f of brief.faq_suggestions as FaqItem[]) {
        parts.push(`\n**Q: ${f.question ?? ''}**`)
        if (f.suggested_answer) parts.push(f.suggested_answer)
      }
    }
    if (brief.notes) parts.push(`\n---\n*Note: ${brief.notes}*`)

    try {
      await navigator.clipboard.writeText(parts.filter(Boolean).join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* silent */ }
  }

  return (
    <div className={`rounded-2xl border transition-all ${
      ws === 'ready'       ? 'bg-gray-900 border-blue-800/40 hover:border-blue-600/60' :
      ws === 'in_progress' ? 'bg-gray-900 border-amber-800/40 hover:border-amber-600/60' :
                             'bg-gray-900/50 border-gray-800'
    }`}>
      <div className="p-5">
        {/* Top row */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusPill status={ws} />
            <DueDateBadge date={brief.target_publish_date} />
            {brief.brief_type && (
              <span className="text-[10px] text-gray-600 capitalize">{brief.brief_type.replace(/_/g, ' ')}</span>
            )}
          </div>
          <span className="text-[10px] text-gray-600">Updated {timeAgo(brief.updated_at)}</span>
        </div>

        {/* Title */}
        <div className="mt-3">
          <a
            href={editorUrl}
            className="text-white font-semibold text-base hover:text-blue-400 transition leading-snug block"
          >
            {brief.primary_keyword ?? path ?? 'Untitled brief'}
          </a>
          {path && (
            <p className="text-[11px] text-gray-500 font-mono mt-0.5 truncate">{path}</p>
          )}
        </div>

        {/* Meta chips */}
        <div className="flex items-center gap-3 mt-3 flex-wrap text-xs text-gray-500">
          {headings.length > 0 && (
            <span>📄 {headings.length} section{headings.length !== 1 ? 's' : ''}</span>
          )}
          {faqs > 0 && (
            <span>❓ {faqs} FAQ{faqs !== 1 ? 's' : ''}</span>
          )}
          {wordEst > 0 && (
            <span>~{wordEst.toLocaleString()} words est.</span>
          )}
          {keywords.length > 0 && (
            <span className="text-gray-600">Keywords: {keywords.slice(0, 3).join(', ')}{keywords.length > 3 ? ` +${keywords.length - 3}` : ''}</span>
          )}
        </div>

        {/* Outline preview */}
        {headings.length > 0 && (
          <div className="mt-3">
            <OutlinePreview outline={brief.content_outline} expanded={expanded} />
            <button
              onClick={() => setExpanded(e => !e)}
              className="mt-2 text-[10px] text-gray-600 hover:text-gray-400 transition"
            >
              {expanded ? '▲ Collapse outline' : '▼ Expand outline'}
            </button>
          </div>
        )}

        {/* Notes */}
        {brief.notes && !expanded && (
          <p className="mt-2 text-[11px] text-gray-600 italic line-clamp-1">💬 {brief.notes}</p>
        )}
        {brief.notes && expanded && (
          <p className="mt-2 text-[11px] text-gray-500 italic">💬 {brief.notes}</p>
        )}
      </div>

      {/* Action bar */}
      <div className="border-t border-gray-800 px-5 py-3 flex items-center gap-2 flex-wrap">
        <a
          href={editorUrl}
          className="text-sm px-4 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white font-medium transition"
        >
          {ws === 'ready' ? '✎ Start writing' : ws === 'in_progress' ? '✎ Continue writing' : '👁 View brief'}
        </a>
        <button
          onClick={handleCopy}
          className="text-sm px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition"
        >
          {copied ? '✓ Copied' : '📋 Copy brief'}
        </button>
        {ws === 'ready' && (
          <button
            onClick={() => onMarkInProgress(brief.id)}
            disabled={busy === brief.id}
            className="text-sm px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-amber-700 text-gray-400 hover:text-white transition disabled:opacity-40"
          >
            {busy === brief.id ? '…' : '▶ Mark in progress'}
          </button>
        )}
        {ws !== 'published' && (
          <button
            onClick={() => onMarkPublished(brief.id)}
            disabled={busy === brief.id}
            className="text-sm px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-green-700 text-gray-400 hover:text-white transition disabled:opacity-40"
          >
            {busy === brief.id ? '…' : '✓ Mark published'}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WriterInboxClient({ initialBriefs }: { initialBriefs: Brief[] }) {
  const [briefs, setBriefs] = useState<Brief[]>(initialBriefs)
  const [filter, setFilter] = useState<'all' | 'ready' | 'in_progress' | 'published'>('all')
  const [search, setSearch] = useState('')
  const [busy,   setBusy]   = useState<string | null>(null)

  // Sorted: urgency desc, then ready→in_progress→published
  const sorted = useMemo(() => {
    const statusOrder = { ready: 0, in_progress: 1, published: 2 }
    return [...briefs].sort((a, b) => {
      const so = statusOrder[writerStatus(a)] - statusOrder[writerStatus(b)]
      if (so !== 0) return so
      return urgencyScore(b) - urgencyScore(a)
    })
  }, [briefs])

  const filtered = useMemo(() => {
    const lc = search.toLowerCase()
    return sorted.filter(b => {
      if (filter !== 'all' && writerStatus(b) !== filter) return false
      if (lc) {
        const hay = [b.primary_keyword, b.page, b.notes].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(lc)) return false
      }
      return true
    })
  }, [sorted, filter, search])

  const counts = useMemo(() => ({
    ready:       briefs.filter(b => writerStatus(b) === 'ready').length,
    in_progress: briefs.filter(b => writerStatus(b) === 'in_progress').length,
    published:   briefs.filter(b => writerStatus(b) === 'published').length,
  }), [briefs])

  const patchBrief = useCallback(async (id: string, patch: Record<string, string>) => {
    setBusy(id)
    try {
      const res = await fetch(`/api/content/briefs/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      })
      if (res.ok) {
        setBriefs(prev => prev.map(b => b.id === id ? { ...b, ...patch, updated_at: new Date().toISOString() } : b))
      }
    } finally {
      setBusy(null)
    }
  }, [])

  const handleMarkPublished   = useCallback((id: string) => patchBrief(id, { status: 'published' }), [patchBrief])
  const handleMarkInProgress  = useCallback((id: string) => patchBrief(id, { status: 'draft' }), [patchBrief])

  return (
    <div className="p-6 max-w-4xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">✍️ Writer Inbox</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          Your content briefs, ready to write. Focus on the blue ones first.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-blue-900/20 border border-blue-800/40 rounded-xl p-4 text-center">
          <p className="text-2xl font-bold text-blue-300">{counts.ready}</p>
          <p className="text-xs text-blue-400 mt-0.5">Ready to write</p>
        </div>
        <div className="bg-amber-900/20 border border-amber-800/40 rounded-xl p-4 text-center">
          <p className="text-2xl font-bold text-amber-300">{counts.in_progress}</p>
          <p className="text-xs text-amber-400 mt-0.5">In progress</p>
        </div>
        <div className="bg-green-900/20 border border-green-800/40 rounded-xl p-4 text-center">
          <p className="text-2xl font-bold text-green-300">{counts.published}</p>
          <p className="text-xs text-green-400 mt-0.5">Published</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex border border-gray-700 rounded-lg overflow-hidden text-sm">
          {([
            ['all',         `All (${counts.ready + counts.in_progress + counts.published})`],
            ['ready',       `Ready (${counts.ready})`],
            ['in_progress', `In progress (${counts.in_progress})`],
            ['published',   `Published (${counts.published})`],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-3 py-1.5 transition ${filter === k ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search keyword or page…"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none w-52"
        />
      </div>

      {/* Brief cards */}
      {filtered.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-2xl p-16 text-center">
          <p className="text-4xl mb-3">
            {counts.ready + counts.in_progress === 0 ? '🎉' : '🔍'}
          </p>
          <p className="text-white font-semibold text-lg mb-1">
            {counts.ready + counts.in_progress === 0
              ? 'All caught up!'
              : 'No briefs match your search'}
          </p>
          <p className="text-gray-400 text-sm">
            {counts.ready + counts.in_progress === 0
              ? 'No briefs ready to write right now. Check back after the next content review.'
              : 'Try a different keyword or clear the search.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map(b => (
            <BriefCard
              key={b.id}
              brief={b}
              onMarkPublished={handleMarkPublished}
              onMarkInProgress={handleMarkInProgress}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  )
}
