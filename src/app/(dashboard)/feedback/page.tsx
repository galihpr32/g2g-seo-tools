'use client'

/**
 * /feedback — bug report triage queue
 *
 * Two views:
 *  - Submitter view: their own reports (status + replies)
 *  - Admin view (Head): all reports, status flow controls, resolution notes
 *
 * The /api/feedback route auto-detects role via FEEDBACK_ADMINS env var
 * (comma-separated user IDs). Returns `isAdmin: true|false` on GET.
 */

import { useCallback, useEffect, useState } from 'react'

interface Reply { author_id: string; author_role: 'admin' | 'submitter'; ts: string; content: string }

interface BugReport {
  id:               string
  submitter_id:     string
  submitter_email?: string | null
  site_slug:        string | null
  title:            string
  description:      string
  page_url:         string | null
  severity:         'low' | 'medium' | 'high'
  status:           'new' | 'in_progress' | 'resolved' | 'wont_fix'
  attachments:      string[]
  replies:          Reply[]
  resolution_notes: string | null
  triaged_at:       string | null
  created_at:       string
  updated_at:       string
}

const SEVERITY_STYLES: Record<BugReport['severity'], string> = {
  low:    'bg-gray-700/30 text-gray-400 border-gray-700',
  medium: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  high:   'bg-red-500/15 text-red-300 border-red-500/30',
}

const STATUS_STYLES: Record<BugReport['status'], { label: string; class: string }> = {
  new:         { label: 'NEW',          class: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  in_progress: { label: 'IN PROGRESS',  class: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  resolved:    { label: 'RESOLVED',     class: 'bg-green-500/15 text-green-300 border-green-500/30' },
  wont_fix:    { label: "WON'T FIX",    class: 'bg-gray-700/40 text-gray-500 border-gray-700' },
}

export default function FeedbackPage() {
  const [reports, setReports] = useState<BugReport[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [filter,  setFilter]  = useState<'all' | BugReport['status']>('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/feedback')
      if (res.ok) {
        const d = await res.json()
        setReports(d.reports ?? [])
        setIsAdmin(!!d.isAdmin)
      }
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

   
  useEffect(() => { load() }, [load])

  const filtered = filter === 'all' ? reports : reports.filter(r => r.status === filter)
  const counts = reports.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <span>🐛</span> Feedback {isAdmin && <span className="text-xs bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded font-normal uppercase tracking-wider">admin</span>}
        </h1>
        <p className="text-gray-400 text-sm mt-1">
          {isAdmin
            ? 'All bug reports + feedback from team. Triage by changing status, reply to discuss.'
            : 'Your submitted reports. Galih will reply or update status here.'}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        {(['all', 'new', 'in_progress', 'resolved', 'wont_fix'] as const).map(f => {
          const count = f === 'all' ? reports.length : (counts[f] ?? 0)
          const label = f === 'all' ? `All (${count})` : `${STATUS_STYLES[f].label} (${count})`
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                filter === f
                  ? 'bg-red-700 border-red-600 text-white'
                  : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
              }`}
            >
              {label}
            </button>
          )
        })}
        <button onClick={load} className="ml-auto text-xs text-gray-500 hover:text-white border border-gray-700 px-3 py-1.5 rounded-lg transition">
          ↻ Refresh
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">📭</p>
          <p className="text-gray-400 text-sm">
            {filter === 'all' ? 'No reports yet.' : 'No reports in this status.'}
          </p>
          <p className="text-gray-600 text-xs mt-1">
            Use the floating 🐛 button (bottom-right) to submit feedback from any page.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(r => (
            <ReportCard key={r.id} report={r} isAdmin={isAdmin} onChange={load} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Card ────────────────────────────────────────────────────────────────────

function ReportCard({ report, isAdmin, onChange }: {
  report:  BugReport
  isAdmin: boolean
  onChange: () => void
}) {
  const [expanded,    setExpanded]    = useState(false)
  const [reply,       setReply]       = useState('')
  const [replying,    setReplying]    = useState(false)
  const [updating,    setUpdating]    = useState(false)
  const [resolution,  setResolution]  = useState(report.resolution_notes ?? '')
  const [editingRes,  setEditingRes]  = useState(false)

  async function patch(updates: Partial<{ status: BugReport['status']; resolution_notes: string; reply: string }>) {
    setUpdating(true)
    try {
      await fetch('/api/feedback', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: report.id, ...updates }),
      })
      onChange()
    } finally { setUpdating(false) }
  }

  async function handleReply() {
    if (!reply.trim()) return
    setReplying(true)
    try {
      await patch({ reply: reply.trim() })
      setReply('')
    } finally { setReplying(false) }
  }

  return (
    <article className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <header className="flex items-start gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${SEVERITY_STYLES[report.severity]}`}>
              {report.severity}
            </span>
            <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${STATUS_STYLES[report.status].class}`}>
              {STATUS_STYLES[report.status].label}
            </span>
            <span className="text-[10px] text-gray-500">{new Date(report.created_at).toLocaleString('id-ID')}</span>
            {report.submitter_email && <span className="text-[10px] text-gray-500">· {report.submitter_email}</span>}
          </div>
          <h3 className="text-white font-semibold text-sm">{report.title}</h3>
          {report.page_url && (
            <p className="text-[11px] text-gray-600 mt-0.5 break-all">📍 {report.page_url}</p>
          )}
        </div>
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-xs text-gray-500 hover:text-white px-2 py-1 transition"
        >
          {expanded ? '▴' : '▾'}
        </button>
      </header>

      {expanded && (
        <div className="space-y-3 mt-3 pt-3 border-t border-gray-800">
          <pre className="text-xs text-gray-300 whitespace-pre-wrap font-sans bg-gray-800/40 rounded p-3">
            {report.description}
          </pre>

          {/* Replies thread */}
          {report.replies.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Replies</p>
              {report.replies.map((rp, i) => (
                <div key={i} className={`text-xs p-2 rounded ${rp.author_role === 'admin' ? 'bg-amber-500/5 border border-amber-500/20' : 'bg-gray-800/40 border border-gray-700/50'}`}>
                  <p className="text-[10px] text-gray-500 mb-0.5">
                    <span className={rp.author_role === 'admin' ? 'text-amber-400 font-medium' : 'text-gray-400'}>{rp.author_role === 'admin' ? '🛠 Galih' : '🧑 Submitter'}</span>
                    <span className="ml-2">{new Date(rp.ts).toLocaleString('id-ID')}</span>
                  </p>
                  <p className="text-gray-200">{rp.content}</p>
                </div>
              ))}
            </div>
          )}

          {/* Resolution notes (admin only) */}
          {isAdmin && (report.status === 'resolved' || report.status === 'wont_fix' || editingRes) && (
            <div className="bg-gray-800/40 rounded p-2">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Resolution notes</p>
              {editingRes ? (
                <>
                  <textarea
                    value={resolution}
                    onChange={e => setResolution(e.target.value)}
                    rows={3}
                    placeholder="What was done / why won't fix"
                    className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-red-500"
                  />
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={async () => { await patch({ resolution_notes: resolution }); setEditingRes(false) }}
                      className="text-[11px] bg-amber-600 hover:bg-amber-500 text-white px-2 py-1 rounded transition"
                    >
                      Save
                    </button>
                    <button onClick={() => { setEditingRes(false); setResolution(report.resolution_notes ?? '') }} className="text-[11px] text-gray-500 hover:text-gray-300 px-2 py-1 transition">
                      Cancel
                    </button>
                  </div>
                </>
              ) : report.resolution_notes ? (
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs text-gray-300 flex-1">{report.resolution_notes}</p>
                  <button onClick={() => setEditingRes(true)} className="text-[10px] text-gray-500 hover:text-white">Edit</button>
                </div>
              ) : (
                <button onClick={() => setEditingRes(true)} className="text-[11px] text-gray-500 hover:text-white">+ Add resolution notes</button>
              )}
            </div>
          )}

          {/* Reply form (anyone) */}
          <div>
            <textarea
              value={reply}
              onChange={e => setReply(e.target.value)}
              rows={2}
              placeholder="Reply…"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-red-500 resize-none"
            />
            <div className="flex justify-between items-center mt-2">
              {/* Status flow (admin) */}
              {isAdmin && (
                <div className="flex gap-1.5">
                  {(['new','in_progress','resolved','wont_fix'] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => patch({ status: s })}
                      disabled={updating || report.status === s}
                      className={`text-[11px] px-2 py-1 rounded border transition ${
                        report.status === s
                          ? STATUS_STYLES[s].class
                          : 'border-gray-700 text-gray-500 hover:text-white hover:border-gray-600'
                      } ${updating ? 'opacity-50' : ''}`}
                    >
                      {STATUS_STYLES[s].label}
                    </button>
                  ))}
                </div>
              )}
              <button
                onClick={handleReply}
                disabled={replying || !reply.trim()}
                className="ml-auto text-[11px] bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white px-3 py-1 rounded transition"
              >
                {replying ? 'Sending…' : 'Reply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  )
}
