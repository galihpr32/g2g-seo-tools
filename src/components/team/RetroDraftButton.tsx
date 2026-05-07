'use client'

/**
 * RetroDraftButton — calls /api/team-performance/retro-draft, opens a modal
 * with the generated retro draft. User can edit + copy to clipboard.
 *
 * Embedded at /team-performance header. Replaces the manual 30-min retro
 * write-up Specialist 1 / Asst Manager / Head used to do at end of week.
 */

import { useState } from 'react'

export default function RetroDraftButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-xs font-medium px-3 py-1.5 rounded-lg transition"
        title="Mimir generates a retro draft from this period's stats"
      >
        🪶 Generate retro draft
      </button>

      {open && <RetroDraftModal onClose={() => setOpen(false)} />}
    </>
  )
}

function RetroDraftModal({ onClose }: { onClose: () => void }) {
  const [period,  setPeriod]  = useState<'weekly' | 'monthly'>('weekly')
  const [loading, setLoading] = useState(false)
  const [draft,   setDraft]   = useState('')
  const [error,   setError]   = useState<string | null>(null)
  const [copied,  setCopied]  = useState(false)

  async function handleGenerate() {
    setLoading(true); setError(null); setCopied(false)
    try {
      const res = await fetch('/api/team-performance/retro-draft', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ period }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) throw new Error(d.error ?? `HTTP ${res.status}`)
      setDraft(String(d.draft ?? ''))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(draft)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-white font-semibold text-sm flex items-center gap-2">
              🪶 Mimir&apos;s Retro Draft
            </h2>
            <p className="text-amber-300/70 text-[11px] mt-0.5">Pulls last 7d / 30d stats and writes a candid retro</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Period picker */}
        <div className="px-5 py-3 border-b border-gray-800 flex items-center gap-3">
          <span className="text-xs text-gray-400">Period:</span>
          <div className="flex border border-gray-700 rounded-lg overflow-hidden text-xs">
            {(['weekly', 'monthly'] as const).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 transition ${period === p ? 'bg-amber-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                {p === 'weekly' ? '📅 Weekly (7d)' : '📊 Monthly (30d)'}
              </button>
            ))}
          </div>
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="ml-auto text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-semibold px-3 py-1.5 rounded transition"
          >
            {loading ? 'Mimir thinking…' : (draft ? '↻ Regenerate' : 'Generate')}
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex-1 overflow-y-auto max-h-[60vh]">
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-300 mb-3">
              ⚠️ {error}
            </div>
          )}
          {!draft && !loading && !error && (
            <div className="text-center py-12">
              <p className="text-3xl mb-3">🪶</p>
              <p className="text-gray-400 text-sm">Pick a period above and click Generate.</p>
              <p className="text-gray-600 text-xs mt-1">Draft is editable — tweak the wording, then copy to Slack/Notion.</p>
            </div>
          )}
          {loading && (
            <div className="text-center py-12">
              <p className="text-gray-400 text-sm">Mimir is reviewing the period&apos;s data…</p>
            </div>
          )}
          {draft && !loading && (
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              rows={18}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-amber-500 resize-none font-mono"
            />
          )}
        </div>

        {/* Footer */}
        {draft && (
          <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-between gap-3">
            <p className="text-[11px] text-gray-500">Edit freely — Mimir writes a starting point, not the final.</p>
            <div className="flex gap-2">
              <button
                onClick={handleCopy}
                className={`text-xs px-3 py-1.5 rounded transition ${copied ? 'bg-green-700/20 text-green-300 border border-green-700/40' : 'bg-amber-600 hover:bg-amber-500 text-white font-semibold'}`}
              >
                {copied ? '✓ Copied' : '📋 Copy to clipboard'}
              </button>
              <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1.5 transition">
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
