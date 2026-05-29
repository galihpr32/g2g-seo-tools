'use client'

import { useState } from 'react'

// ─── Export to Sheet button ─────────────────────────────────────────────────
// Reusable trigger that pings /api/news/export. Shows result inline; redirects
// the user to /settings/news-export when the Sheet isn't configured yet.
//
// Used on /content/news-signals + /content/trends + /settings/news-export.
// The `kind` prop is just a label hint — the endpoint always writes all 3
// tabs (the divisions consuming the Sheet expect a consistent shape).

export default function ExportToSheetButton({ kind }: { kind: 'news' | 'trends' }) {
  const [busy, setBusy] = useState(false)
  const [msg,  setMsg]  = useState<string | null>(null)
  const [isError, setIsError] = useState(false)

  async function run() {
    if (busy) return
    setBusy(true); setMsg(null); setIsError(false)
    try {
      const res = await fetch('/api/news/export', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        if (typeof data.error === 'string' && data.error.includes('No Sheet configured')) {
          if (confirm('No Sheet configured for this brand yet. Open the config page to set one up?')) {
            window.location.href = '/settings/news-export'
          }
        } else {
          setIsError(true)
          setMsg(`❌ ${data.error ?? 'Export failed'}`)
        }
      } else {
        const tabs = (data.tabs ?? []) as { tab_name: string; rows: number }[]
        const tabList = tabs.map(t => `${t.tab_name} (${t.rows})`).join(' · ')
        setMsg(`✅ ${data.tabs?.length ?? 0} tabs · ${data.rows_total ?? 0} rows · ${tabList}`)
      }
    } catch (e) {
      setIsError(true)
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }
    setBusy(false)
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        onClick={run}
        disabled={busy}
        title={`Push fresh ${kind === 'news' ? 'News Signals' : 'Game Trends'} snapshot to the configured Google Sheet (creates date-stamped tabs).`}
        className="px-3 py-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition disabled:opacity-50 text-xs"
      >
        {busy ? '⏳ Exporting…' : '📤 Export to Sheet'}
      </button>
      {msg && (
        <span className={`text-[10px] max-w-[400px] truncate ${isError ? 'text-red-300' : 'text-emerald-300'}`} title={msg}>
          {msg}
        </span>
      )}
    </div>
  )
}
