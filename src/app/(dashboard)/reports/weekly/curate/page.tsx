'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

// Sprint WEEKLY.PUBLIC — Curatorial UI for weekly report editing.
// Edit narrative, action plan, watch list, top priorities before auto-publish
// at Monday 15:00 WIB. Saves auto-debounced. Manual Publish Now / Hold buttons.

interface ReportRow {
  id:                string
  site_slug:         string
  week_start:        string
  week_end:          string
  publish_status:    'draft' | 'approved' | 'published' | 'held' | 'auto_published'
  public_token:      string
  ai_narrative:      string | null
  ai_action_plan:    string | null
  curatorial_edits:  Edits | null
  published_at?:     string | null
  report_data?:      Record<string, unknown>
}

interface Edits {
  narrative?:      string
  action_plan?:    string
  watch_list?:     string[]
  top_priorities?: string[]
}

function CuratePageInner() {
  const params      = useSearchParams()
  const id          = params.get('id')
  const [report, setReport] = useState<ReportRow | null>(null)
  const [edits,  setEdits]  = useState<Edits>({})
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState<number | null>(null)
  const [error,  setError]  = useState<string | null>(null)
  const [busy,   setBusy]   = useState(false)

  // Load report on mount
  useEffect(() => {
    if (!id) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/reports/weekly/curate?id=${id}`)
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) { setError(data.error ?? 'Failed to load'); return }
        const r = data.report as ReportRow
        setReport(r)
        setEdits(r.curatorial_edits ?? {})
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [id])

  // Debounced auto-save
  useEffect(() => {
    if (!report) return
    if (Object.keys(edits).length === 0) return
    const t = setTimeout(async () => {
      setSaving(true)
      try {
        const res = await fetch('/api/reports/weekly/curate', {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ id: report.id, edits }),
        })
        if (res.ok) setSaved(Date.now())
      } catch { /* swallow */ }
      finally { setSaving(false) }
    }, 800)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, report?.id])

  async function publishNow() {
    if (!report) return
    if (!confirm('Publish to Slack NOW with current edits?')) return
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/reports/weekly/curate/publish', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: report.id, action: 'publish' }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setError(data.error ?? data.notes?.join('; ') ?? 'Publish failed')
      } else {
        setReport(prev => prev ? { ...prev, publish_status: 'published', published_at: new Date().toISOString() } : prev)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  async function holdReport() {
    if (!report) return
    if (!confirm('Hold this report — skip the 15:00 WIB auto-publish?')) return
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/reports/weekly/curate/hold', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: report.id, action: 'hold' }),
      })
      const data = await res.json()
      if (!res.ok) setError(data.error ?? 'Hold failed')
      else setReport(prev => prev ? { ...prev, publish_status: 'held' } : prev)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  if (!id) return <DraftPicker />
  if (error) return <div className="p-8 text-red-300">⚠ {error}</div>
  if (!report) return <div className="p-8 text-gray-500">Loading…</div>

  const brand = report.site_slug === 'offgamers' ? 'OffGamers' : 'G2G'
  const accent = report.site_slug === 'offgamers' ? '#2563EB' : '#DC2626'
  const isDraft = report.publish_status === 'draft' || report.publish_status === 'approved'
  const watchList  = edits.watch_list  ?? []
  const priorities = edits.top_priorities ?? (report.ai_action_plan ?? '').split('\n').filter(Boolean).slice(0, 5)

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-6 rounded" style={{ backgroundColor: accent }} />
            <h1 className="text-2xl font-bold text-white">{brand} — Weekly Report Editor</h1>
          </div>
          <p className="text-xs text-gray-400 mt-1">{report.week_start} → {report.week_end}</p>
        </div>
        <Link href={`/${report.site_slug}/reports/weekly?id=${report.id}`} className="text-sm text-gray-400 hover:text-white">← Dashboard view</Link>
      </div>

      {/* Status bar */}
      <div className={`rounded-lg border p-4 flex items-center justify-between flex-wrap gap-3 ${
        isDraft ? 'border-amber-700/40 bg-amber-500/5'
        : report.publish_status === 'held' ? 'border-gray-700 bg-gray-800/30'
        : 'border-emerald-700/40 bg-emerald-500/5'
      }`}>
        <div>
          <p className="text-sm text-white font-medium">Status: <span className={
            isDraft ? 'text-amber-300'
            : report.publish_status === 'held' ? 'text-gray-300'
            : 'text-emerald-300'
          }>{report.publish_status}</span></p>
          <p className="text-xs text-gray-400 mt-0.5">
            {isDraft && 'Auto-publishes Monday 15:00 WIB. Edit below — auto-saved.'}
            {report.publish_status === 'held' && 'Held — will NOT auto-publish. Click "Publish now" to override.'}
            {(report.publish_status === 'published' || report.publish_status === 'auto_published') && `Posted to Slack${report.published_at ? ` at ${new Date(report.published_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saving && <span className="text-[10px] text-gray-500 animate-pulse">Saving…</span>}
          {!saving && saved && Date.now() - saved < 3000 && <span className="text-[10px] text-emerald-400">✓ Saved</span>}
          {isDraft && (
            <>
              <button onClick={holdReport} disabled={busy} className="text-xs px-3 py-1.5 border border-gray-700 hover:bg-gray-800 disabled:opacity-40 text-gray-200 rounded-md">
                Hold
              </button>
              <button onClick={publishNow} disabled={busy} className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-md font-medium">
                {busy ? 'Publishing…' : '🚀 Publish now'}
              </button>
            </>
          )}
          {report.publish_status === 'held' && (
            <button onClick={publishNow} disabled={busy} className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-md font-medium">
              {busy ? 'Publishing…' : '🚀 Publish anyway'}
            </button>
          )}
        </div>
      </div>

      {/* Public URL display */}
      {report.public_token && (
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-gray-400 mb-1">📄 Public URL (no login)</p>
            <code className="text-[11px] text-blue-300 break-all">/public/weekly/{report.public_token}</code>
          </div>
          <button
            onClick={() => navigator.clipboard.writeText(`${window.location.origin}/public/weekly/${report.public_token}`)}
            className="text-xs px-3 py-1.5 border border-gray-700 hover:bg-gray-800 text-gray-200 rounded-md flex-shrink-0"
          >
            Copy
          </button>
        </div>
      )}

      {/* Narrative edit */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-2">
        <label className="text-sm font-semibold text-white">📝 Executive narrative</label>
        <p className="text-xs text-gray-400">2-3 paragraphs. Replaces AI version on publish.</p>
        <textarea
          value={edits.narrative ?? report.ai_narrative ?? ''}
          onChange={e => setEdits(prev => ({ ...prev, narrative: e.target.value }))}
          rows={8}
          className="w-full text-sm bg-gray-950 border border-gray-700 rounded-md p-3 text-gray-200 font-mono leading-relaxed"
          placeholder="(AI narrative will appear here once cron runs)"
        />
      </section>

      {/* Watch list edit */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-2">
        <label className="text-sm font-semibold text-white">⚠️ Watch list ({watchList.length})</label>
        <p className="text-xs text-gray-400">One item per line. Empty lines ignored.</p>
        <textarea
          value={watchList.join('\n')}
          onChange={e => setEdits(prev => ({ ...prev, watch_list: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }))}
          rows={5}
          className="w-full text-sm bg-gray-950 border border-gray-700 rounded-md p-3 text-gray-200 leading-relaxed"
          placeholder="/categories/valorant-points dropped #3 → #8 (-45% clicks)"
        />
      </section>

      {/* Top priorities edit */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-2">
        <label className="text-sm font-semibold text-white">✅ Top priorities ({priorities.length})</label>
        <p className="text-xs text-gray-400">One priority per line. First 3 shown in Slack.</p>
        <textarea
          value={priorities.join('\n')}
          onChange={e => setEdits(prev => ({ ...prev, top_priorities: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }))}
          rows={5}
          className="w-full text-sm bg-gray-950 border border-gray-700 rounded-md p-3 text-gray-200 leading-relaxed"
          placeholder="Refresh /categories/valorant-points content (T1)"
        />
      </section>

      {/* Action plan edit */}
      <section className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-2">
        <label className="text-sm font-semibold text-white">📋 Full action plan (detail)</label>
        <p className="text-xs text-gray-400">Long-form action plan. Visible on public page + dashboard.</p>
        <textarea
          value={edits.action_plan ?? report.ai_action_plan ?? ''}
          onChange={e => setEdits(prev => ({ ...prev, action_plan: e.target.value }))}
          rows={8}
          className="w-full text-sm bg-gray-950 border border-gray-700 rounded-md p-3 text-gray-200 font-mono leading-relaxed"
          placeholder="(AI action plan will appear here once cron runs)"
        />
      </section>
    </div>
  )
}

export default function WeeklyReportCuratePage() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-500">Loading…</div>}>
      <CuratePageInner />
    </Suspense>
  )
}

// ─── Draft picker (shown when no ?id is provided) ──────────────────────────
// Sprint WEEKLY.CURATE.LIST — lists the 20 most recent weekly_reports rows
// for this owner so user can pick one to curate without knowing the UUID.
// Status badges show at-a-glance whether each row is draft / published /
// held, and whether the public_token exists (means shareable link works).
interface DraftRow {
  id:                string
  site_slug:         string
  week_start:        string
  week_end:          string
  publish_status:    'draft' | 'approved' | 'published' | 'held' | 'auto_published'
  public_token:      string | null
  published_at:      string | null
}

function DraftPicker() {
  const [rows,    setRows]    = useState<DraftRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res  = await fetch('/api/reports/weekly/curate')
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) { setError(data.error ?? 'Failed to load'); return }
        setRows(data.reports ?? [])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const statusColor = (s: DraftRow['publish_status']): string => {
    switch (s) {
      case 'published':
      case 'auto_published': return 'bg-emerald-500/15 text-emerald-300 border-emerald-700/40'
      case 'held':           return 'bg-amber-500/15  text-amber-300  border-amber-700/40'
      case 'approved':       return 'bg-blue-500/15   text-blue-300   border-blue-700/40'
      default:               return 'bg-gray-500/15   text-gray-300   border-gray-700/40'
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">📝 Weekly Report — Curate</h1>
        <p className="text-sm text-gray-400 mt-1">
          Pick a report to edit narrative, action plan, and watch list. Publishing assigns a public token used by the shareable link.
        </p>
      </div>

      {loading && <div className="text-gray-500 text-sm">Loading drafts…</div>}
      {error   && <div className="p-3 rounded-md border border-red-700/40 bg-red-500/5 text-red-300 text-sm">⚠ {error}</div>}

      {!loading && rows.length === 0 && (
        <div className="rounded-lg border border-amber-700/40 bg-amber-500/5 p-4 text-sm text-amber-200 space-y-2">
          <div className="font-semibold">⚠ No weekly reports generated yet</div>
          <p>
            The Monday 08:00 WIB cron creates a fresh draft each week. If nothing's here, the cron hasn't run yet for your workspace. To bootstrap manually:
          </p>
          <ol className="list-decimal pl-5 space-y-1 text-amber-100/90 text-xs">
            <li>Open the API endpoint <code className="text-pink-300">/api/reports/weekly</code> with brand context, OR</li>
            <li>Wait for next Monday's auto-generation, OR</li>
            <li>Ping ops to trigger the <code className="text-pink-300">weekly-report-generator</code> cron manually.</li>
          </ol>
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map(r => {
            const brand = r.site_slug === 'offgamers' ? 'OffGamers' : 'G2G'
            const accent = r.site_slug === 'offgamers' ? '#34d399' : '#a78bfa'
            return (
              <Link
                key={r.id}
                href={`/reports/weekly/curate?id=${r.id}`}
                className="flex items-center gap-4 p-4 rounded-lg border border-gray-800 bg-gray-900 hover:border-gray-700 hover:bg-gray-900/70 transition"
              >
                <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: accent }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-semibold">{brand}</span>
                    <span className="text-gray-400 text-sm">·</span>
                    <span className="text-gray-300 text-sm">{r.week_start} → {r.week_end}</span>
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    {r.published_at ? `Published ${new Date(r.published_at).toLocaleString()}` : 'Not published'}
                  </div>
                </div>
                <span className={`text-[11px] px-2 py-1 rounded-md border ${statusColor(r.publish_status)}`}>
                  {r.publish_status}
                </span>
                {r.public_token && (
                  <span className="text-[11px] px-2 py-1 rounded-md border border-emerald-700/40 bg-emerald-500/10 text-emerald-300">
                    🔗 token
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
