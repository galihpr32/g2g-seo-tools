'use client'

/**
 * Sprint #361 / Sprint #363 — Weekly Snapshot preview page (admin).
 * Sprint #373 — Render content via shared <BossViewContent /> component
 * so the public /reports/[slug] page can reuse all the same visualization.
 * Sprint #378 — renamed "Weekly Boss View" → "Weekly Snapshot". Added a
 * Published Snapshots list (last 50) so the user can re-open past report
 * pages without hunting URLs.
 */

import { useCallback, useEffect, useState } from 'react'
import { BossViewContent, type Payload, type BossViewCommentary } from '@/components/reports/BossViewContent'

// Sprint #379 — unified row shape for both snapshots + kw breakdowns.
interface PublishedItem {
  type:        'snapshot' | 'kw_breakdown'
  url:         string
  label:       string
  sub:         string | null
  publishedAt: string
  generatedAt: string
}

export default function BossViewPreviewPage() {
  const [payload,     setPayload]     = useState<Payload | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [refreshing,  setRefreshing]  = useState(false)
  const [publishing,  setPublishing]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [cached,      setCached]      = useState(false)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  // Sprint #378 — toast holds the published URL so we can render a real
  // clickable anchor + Open button (was plain text before).
  const [publishToast, setPublishToast] = useState<{ url: string; copied: boolean } | null>(null)
  // Sprint #374 — commentary state (admin can regenerate via AI or edit)
  const [commentary,     setCommentary]     = useState<BossViewCommentary | null>(null)
  const [commentaryBusy, setCommentaryBusy] = useState(false)
  // Sprint #378/#379 — unified list of previously-published reports
  // (snapshots + KW breakdowns) for quick re-access.
  const [publishedList, setPublishedList] = useState<PublishedItem[]>([])
  const [publishedListOpen, setPublishedListOpen] = useState(false)

  async function load(refresh = false) {
    if (refresh) setRefreshing(true)
    else         setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/reports/friday-kpi/boss-view', {
        method: refresh ? 'POST' : 'GET',
        headers: refresh ? { 'Content-Type': 'application/json' } : undefined,
        body:    refresh ? JSON.stringify({ sites: ['g2g', 'offgamers'] }) : undefined,
      })
      const ct = res.headers.get('content-type') ?? ''
      if (!res.ok || !ct.includes('application/json')) {
        const txt = (await res.text().catch(() => '')).slice(0, 300)
        setError(`HTTP ${res.status}: ${txt || 'unknown error'}`)
        return
      }
      const data = await res.json() as { cached?: boolean; payload?: Payload; generatedAt?: string; error?: string }
      if (data.error)    { setError(data.error); return }
      if (!data.payload) { setError('No payload returned'); return }
      setPayload(data.payload)
      setCached(!!data.cached)
      setGeneratedAt(data.generatedAt ?? null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => { load(false) }, [])

  // Sprint #374 — fetch commentary on payload load + every refresh.
  const fetchCommentary = useCallback(async () => {
    try {
      const res = await fetch('/api/reports/friday-kpi/boss-view/commentary')
      if (!res.ok) return
      const data = await res.json() as { commentary?: BossViewCommentary | null }
      setCommentary(data.commentary ?? null)
    } catch { /* silent — commentary is optional */ }
  }, [])
  useEffect(() => { if (payload) fetchCommentary() }, [payload, fetchCommentary])

  const regenerateCommentary = useCallback(async () => {
    setCommentaryBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/reports/friday-kpi/boss-view/commentary', { method: 'POST' })
      const data = await res.json().catch(() => ({})) as { commentary?: BossViewCommentary; error?: string }
      if (!res.ok || data.error) { setError(data.error ?? `HTTP ${res.status}: Commentary regen failed`); return }
      if (data.commentary) setCommentary(data.commentary)
    } catch (e) {
      setError(String(e))
    } finally {
      setCommentaryBusy(false)
    }
  }, [])

  const saveCommentary = useCallback(async (next: { whyWorked: string; actionTaken: string }) => {
    setCommentaryBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/reports/friday-kpi/boss-view/commentary', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      const data = await res.json().catch(() => ({})) as { commentary?: BossViewCommentary; error?: string }
      if (!res.ok || data.error) { setError(data.error ?? `HTTP ${res.status}: Save failed`); return }
      if (data.commentary) setCommentary(data.commentary)
    } catch (e) {
      setError(String(e))
    } finally {
      setCommentaryBusy(false)
    }
  }, [])

  // Sprint #378 — load the published-list whenever a publish completes (or
  // on first mount) so the list stays in sync with the publish action.
  const fetchPublishedList = useCallback(async () => {
    try {
      const res = await fetch('/api/reports/friday-kpi/boss-view/published')
      if (!res.ok) return
      const data = await res.json() as { snapshots?: PublishedItem[] }
      setPublishedList(data.snapshots ?? [])
    } catch { /* silent — list is optional */ }
  }, [])
  useEffect(() => { fetchPublishedList() }, [fetchPublishedList])

  async function publish() {
    if (!payload || refreshing) return
    setPublishing(true)
    setError(null)
    try {
      const res = await fetch('/api/reports/friday-kpi/boss-view/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const ct = res.headers.get('content-type') ?? ''
      if (!res.ok || !ct.includes('application/json')) {
        const txt = (await res.text().catch(() => '')).slice(0, 300)
        setError(`HTTP ${res.status}: ${txt || 'publish failed'}`)
        return
      }
      const data = await res.json() as { ok?: boolean; slug?: string; url?: string; publishedAt?: string; error?: string }
      if (data.error) { setError(data.error); return }
      if (!data.ok || !data.url) { setError('Publish returned no URL'); return }
      // Resolve to absolute URL so what we copy actually opens publicly.
      const absoluteUrl = data.url.startsWith('http')
        ? data.url
        : (typeof window !== 'undefined' ? window.location.origin + data.url : data.url)
      // Sprint #378 — store URL + copy flag; toast renders real clickable anchor.
      let copied = false
      try {
        await navigator.clipboard.writeText(absoluteUrl)
        copied = true
      } catch { /* ignore clipboard rejection — still show link */ }
      setPublishToast({ url: absoluteUrl, copied })
      // Sprint #378 — refresh the published list so the new entry shows up
      fetchPublishedList()
      // Don't auto-dismiss — user might want to click the link
    } catch (e) {
      setError(String(e))
    } finally {
      setPublishing(false)
    }
  }

  const publishDisabled = !payload || refreshing || publishing

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto">
      <header className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            📸 Weekly Snapshot
            <span className="text-xs px-2 py-0.5 bg-purple-700/30 text-purple-300 rounded font-normal">Preview</span>
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            {payload?.weekLabel ?? 'Loading…'}
            {generatedAt && (
              <span className="text-gray-600 ml-2">
                · {cached ? 'cached' : 'fresh'} {new Date(generatedAt).toLocaleString()}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={publish}
            disabled={publishDisabled}
            className="text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-2 rounded-lg transition font-medium"
            title={!payload ? 'No cached payload yet' : 'Publish a public snapshot of the current cached payload'}
          >
            {publishing ? '⏳ Publishing…' : '📤 Create Report Page'}
          </button>
          <button
            onClick={() => load(true)}
            disabled={refreshing || loading}
            className="text-xs bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white px-3 py-2 rounded-lg transition font-medium"
          >
            {refreshing ? '⏳ Refreshing…' : '🔄 Refresh data'}
          </button>
        </div>
      </header>

      {/* Sprint #378 — publish toast with real clickable anchor + Open button.
          Doesn't auto-dismiss; user clicks ✕ to close. */}
      {publishToast && (
        <div className="mb-4 p-3 bg-emerald-900/30 border border-emerald-700/40 rounded-lg flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-emerald-300 text-sm font-semibold mb-1">
              ✅ Published {publishToast.copied && <span className="text-emerald-400/70 font-normal">· URL copied to clipboard</span>}
            </p>
            <a
              href={publishToast.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-200 hover:text-white text-sm font-mono break-all underline decoration-emerald-700 hover:decoration-white"
            >{publishToast.url}</a>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href={publishToast.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs bg-emerald-700 hover:bg-emerald-600 text-white px-3 py-1.5 rounded transition font-medium"
            >🔗 Open</a>
            <button
              onClick={() => setPublishToast(null)}
              className="text-emerald-400 hover:text-white text-lg leading-none px-2"
              title="Dismiss"
            >×</button>
          </div>
        </div>
      )}

      {/* Sprint #378/#379 — collapsible unified list of published reports
          (boss view snapshots + KW breakdown public tokens). Type badge per row. */}
      {publishedList.length > 0 && (
        <section className="mb-5 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <button
            onClick={() => setPublishedListOpen(o => !o)}
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-900/60 transition"
          >
            <p className="text-sm font-semibold text-white">
              📚 Published reports
              <span className="text-xs text-gray-500 font-normal ml-2">
                {publishedList.length} {publishedList.length === 1 ? 'item' : 'items'}
                {' · '}
                {publishedList.filter(i => i.type === 'snapshot').length} snapshot{publishedList.filter(i => i.type === 'snapshot').length === 1 ? '' : 's'}
                {' / '}
                {publishedList.filter(i => i.type === 'kw_breakdown').length} KW breakdown{publishedList.filter(i => i.type === 'kw_breakdown').length === 1 ? '' : 's'}
              </span>
            </p>
            <span className="text-gray-500 text-sm">{publishedListOpen ? '▾' : '▸'}</span>
          </button>
          {publishedListOpen && (
            <div className="border-t border-gray-800 max-h-72 overflow-y-auto">
              <ul className="divide-y divide-gray-800/60">
                {publishedList.map((item, i) => {
                  const isSnap = item.type === 'snapshot'
                  return (
                    <li key={`${item.type}-${item.url}-${i}`} className="px-4 py-2.5 hover:bg-gray-950/60 flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-white font-medium truncate flex items-center gap-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-normal ${isSnap ? 'bg-purple-700/30 text-purple-300' : 'bg-amber-700/30 text-amber-300'}`}>
                            {isSnap ? '📸 Snapshot' : '🔑 KW Breakdown'}
                          </span>
                          {item.label}
                        </p>
                        <p className="text-[11px] text-gray-500">
                          <span className="font-mono text-gray-400">{item.url}</span>
                          <span className="ml-2">published {new Date(item.publishedAt).toLocaleString()}</span>
                        </p>
                      </div>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-200 px-2.5 py-1 rounded transition flex-shrink-0"
                      >🔗 Open</a>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </section>
      )}

      <BossViewContent
        payload={payload}
        loading={loading}
        error={error}
        commentary={commentary}
        onSaveCommentary={saveCommentary}
        onRegenerateCommentary={regenerateCommentary}
        commentaryBusy={commentaryBusy}
      />
    </div>
  )
}
