'use client'

/**
 * Sprint #361 / Sprint #363 — Weekly Boss View preview page (admin).
 * Sprint #373 — Render content via shared <BossViewContent /> component
 * so the public /reports/[slug] page can reuse all the same visualization.
 * Adds a "📤 Create Report Page" button that snapshots the current cached
 * payload to the published table and copies the public URL to clipboard.
 *
 * This page keeps:
 *   - Data fetching (GET cached / POST refresh)
 *   - Header with title + Refresh + Publish buttons
 *   - State for cached/generatedAt/refreshing
 *
 * Everything else (KPI strip, 4 historical charts, scatter charts, focus
 * tables, AI source panel, Slack preview) lives in BossViewContent.
 */

import { useCallback, useEffect, useState } from 'react'
import { BossViewContent, type Payload, type BossViewCommentary } from '@/components/reports/BossViewContent'

export default function BossViewPreviewPage() {
  const [payload,     setPayload]     = useState<Payload | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [refreshing,  setRefreshing]  = useState(false)
  const [publishing,  setPublishing]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [cached,      setCached]      = useState(false)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [publishToast, setPublishToast] = useState<string | null>(null)
  // Sprint #374 — commentary state (admin can regenerate via AI or edit)
  const [commentary,     setCommentary]     = useState<BossViewCommentary | null>(null)
  const [commentaryBusy, setCommentaryBusy] = useState(false)

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
      try {
        await navigator.clipboard.writeText(absoluteUrl)
        setPublishToast(`Published — URL copied: ${absoluteUrl}`)
      } catch {
        setPublishToast(`Published — ${absoluteUrl}`)
      }
      setTimeout(() => setPublishToast(null), 3000)
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
            🔍 Weekly Boss View
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

      {publishToast && (
        <div className="mb-4 p-3 bg-emerald-900/30 border border-emerald-700/40 text-emerald-300 text-sm rounded-lg break-all">
          {publishToast}
        </div>
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
