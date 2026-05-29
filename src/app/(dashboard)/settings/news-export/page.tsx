'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// ─── News & Trends Export Settings ──────────────────────────────────────────
// Per-brand Google Sheet target. The export endpoint + weekly cron read this
// to know where to push News Articles × Game, Game Rollup, and Game Trends
// snapshots — each as a fresh date-stamped tab.

interface ExportConfig {
  spreadsheet_url:     string
  spreadsheet_id:      string
  last_exported_at:    string | null
  last_run_status:     string | null
  last_run_summary:    string | null
  weekly_cron_enabled: boolean
  updated_at:          string
}

export default function NewsExportSettingsPage() {
  const [config,  setConfig]  = useState<ExportConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft,   setDraft]   = useState('')
  const [cronOn,  setCronOn]  = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const res = await fetch('/api/settings/news-export')
        const data = await res.json() as { config: ExportConfig | null }
        if (!cancelled) {
          setConfig(data.config)
          if (data.config) {
            setDraft(data.config.spreadsheet_url)
            setCronOn(data.config.weekly_cron_enabled)
          }
        }
      } catch { /* silent */ }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [])

  async function save() {
    if (!draft.trim()) { setError('Paste a Google Sheet URL or ID.'); return }
    setSaving(true); setError(null); setSuccess(null)
    try {
      const res = await fetch('/api/settings/news-export', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheet_url: draft.trim(), weekly_cron_enabled: cronOn }),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        setError(data.error ?? 'Save failed')
      } else {
        setConfig(data.config)
        setSuccess(`Saved. Sheet ID: ${data.config.spreadsheet_id}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setSaving(false)
  }

  async function runExportNow() {
    if (!confirm('Run a news + trends export NOW? Will add fresh date-stamped tabs to your Sheet.')) return
    setExporting(true); setError(null); setSuccess(null)
    try {
      const res = await fetch('/api/news/export', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Export failed')
      } else {
        setSuccess(`✅ Done — ${data.tabs?.length ?? 0} tabs added, ${data.rows_total ?? 0} rows total`)
        // Refresh config to get fresh last_exported_at
        const refresh = await fetch('/api/settings/news-export')
        const r = await refresh.json() as { config: ExportConfig | null }
        setConfig(r.config)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setExporting(false)
  }

  async function clearConfig() {
    if (!confirm('Remove the configured Sheet for this brand? The weekly cron will stop pushing until you set a new one.')) return
    await fetch('/api/settings/news-export', { method: 'DELETE' })
    setConfig(null); setDraft(''); setCronOn(true)
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📤 News & Trends Export</h1>
          <p className="text-sm text-gray-400 mt-1">
            Configure a Google Sheet to receive News Signals + Game Trends snapshots.
            Each run adds new date-stamped tabs (history-preserving) so other divisions
            can scroll back through past snapshots.
          </p>
        </div>
        <Link href="/settings" className="text-sm text-gray-400 hover:text-white">← Settings</Link>
      </div>

      {/* Status pill */}
      {!loading && (
        <div className={`rounded-lg border p-4 ${config ? 'border-green-700/40 bg-green-500/5' : 'border-gray-800 bg-gray-900'}`}>
          {config ? (
            <div className="space-y-1 text-sm">
              <p className="text-green-300 font-medium">✓ Configured</p>
              <p className="text-gray-300">
                Sheet: <a href={config.spreadsheet_url} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:text-blue-200 underline">Open in Drive ↗</a>
              </p>
              <p className="text-xs text-gray-500 font-mono">ID: {config.spreadsheet_id}</p>
              {config.last_exported_at && (
                <p className="text-xs text-gray-500">
                  Last exported: {new Date(config.last_exported_at).toLocaleString()}
                  {config.last_run_status && <> · status: {config.last_run_status}</>}
                </p>
              )}
              {config.last_run_summary && (
                <p className="text-xs text-gray-400 mt-1">{config.last_run_summary}</p>
              )}
              <p className="text-xs text-gray-500">
                Weekly cron: {config.weekly_cron_enabled ? '🟢 enabled (Mon 08:00 WIB)' : '🔴 disabled'}
              </p>
            </div>
          ) : (
            <p className="text-sm text-gray-400">⚪ Not configured. Paste a Sheet URL below to start.</p>
          )}
        </div>
      )}

      {/* Form */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-3">
        <label className="block">
          <span className="block text-sm text-gray-300 mb-1.5">Google Sheet URL or ID</span>
          <input
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/1AbCd.../edit"
            className="w-full bg-gray-950 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-gray-500 mt-1">
            Make sure the service account email (in Vercel env) has <b>Editor</b> access to this Sheet — share the URL with that email first.
          </p>
        </label>

        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" checked={cronOn} onChange={e => setCronOn(e.target.checked)} />
          Enable weekly auto-push (Monday 08:00 WIB)
        </label>

        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={save}
            disabled={saving || !draft.trim()}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-md"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {config && (
            <>
              <button
                onClick={runExportNow}
                disabled={exporting}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm font-medium rounded-md"
              >
                {exporting ? '⏳ Exporting…' : '📤 Run export now'}
              </button>
              <button
                onClick={clearConfig}
                className="text-xs text-red-300 hover:text-red-200 px-2 py-1.5"
              >
                Remove
              </button>
            </>
          )}
          {error   && <span className="text-xs text-red-400">{error}</span>}
          {success && <span className="text-xs text-green-300">{success}</span>}
        </div>
      </div>

      <details className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 text-sm text-gray-300">
        <summary className="cursor-pointer font-medium text-white">What gets exported</summary>
        <div className="mt-3 space-y-3">
          <div>
            <p className="font-medium text-blue-300">Tab: News-Articles-YYYY-MM-DD</p>
            <p className="text-xs text-gray-400">One row per (article × game mention). Includes source authority, importance score, news type, KB match.</p>
          </div>
          <div>
            <p className="font-medium text-blue-300">Tab: News-Games-YYYY-MM-DD</p>
            <p className="text-xs text-gray-400">One row per game. Article count, trend arrow vs prev week, sources cited, top headlines, buzz score, action suggestion (Pitch/Monitor/Ignore), G2G coverage link.</p>
          </div>
          <div>
            <p className="font-medium text-blue-300">Tab: Trends-YYYY-MM-DD</p>
            <p className="text-xs text-gray-400">Steam concurrency + DataForSEO search volume per game, trend direction, price, G2G coverage check, action suggestion.</p>
          </div>
        </div>
      </details>
    </div>
  )
}
