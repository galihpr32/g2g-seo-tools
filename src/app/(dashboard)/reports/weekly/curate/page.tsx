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

  if (!id) return <div className="p-8 text-gray-400">Missing ?id=… query parameter.</div>
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
