'use client'

/**
 * /site-health — overview page bringing together schema + PSI + open
 * action items, plus an on-demand Mimir-generated summary the Asst
 * Manager can paste into the monthly report.
 */

import { useState } from 'react'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'

export default function SiteHealthOverviewPage() {
  const siteSlug = useSiteSlug()
  const [summary, setSummary] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [stats,   setStats]   = useState<Record<string, unknown> | null>(null)
  const [copied,  setCopied]  = useState(false)

  async function generate() {
    setLoading(true); setError(null); setSummary(''); setStats(null); setCopied(false)
    try {
      const res = await fetch('/api/site-health/summary', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ site: siteSlug }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) throw new Error(d.error ?? `HTTP ${res.status}`)
      setSummary(d.summary)
      setStats(d.stats ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-8 max-w-5xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-white">🛡️ Site Health Overview</h1>
        <p className="text-gray-400 text-sm mt-1">
          Compiles latest schema validity, PageSpeed Insights, and open technical action items into a Mimir-generated tech health summary for the monthly report.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <a
          href="/site-health/schema"
          className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-5 transition group"
        >
          <p className="text-2xl mb-1">🧬</p>
          <p className="text-white font-semibold text-sm">Schema Health</p>
          <p className="text-gray-500 text-xs mt-1">JSON-LD validity per page · weekly</p>
          <p className="text-gray-600 text-[10px] mt-2 group-hover:text-amber-400 transition">View →</p>
        </a>
        <a
          href="/site-health/psi"
          className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-5 transition group"
        >
          <p className="text-2xl mb-1">⚡</p>
          <p className="text-white font-semibold text-sm">PageSpeed Insights</p>
          <p className="text-gray-500 text-xs mt-1">Lighthouse + Core Web Vitals · monthly</p>
          <p className="text-gray-600 text-[10px] mt-2 group-hover:text-amber-400 transition">View →</p>
        </a>
        <a
          href="/gsc/action-items"
          className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-5 transition group"
        >
          <p className="text-2xl mb-1">✅</p>
          <p className="text-white font-semibold text-sm">Action Items (technical)</p>
          <p className="text-gray-500 text-xs mt-1">Open + aged tech debt</p>
          <p className="text-gray-600 text-[10px] mt-2 group-hover:text-amber-400 transition">View →</p>
        </a>
      </div>

      <section className="bg-gradient-to-br from-amber-500/5 to-transparent border border-amber-500/30 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <h2 className="text-white font-semibold text-sm flex items-center gap-2">
              🪶 Mimir&apos;s Tech Health Summary
            </h2>
            <p className="text-amber-300/70 text-[11px] mt-0.5">
              Compiles schema + PSI + action items into a 2-paragraph tech-health narrative for the monthly report.
            </p>
          </div>
          <button
            onClick={generate}
            disabled={loading}
            className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm font-semibold px-4 py-2 rounded-lg transition"
          >
            {loading ? 'Mimir thinking…' : (summary ? '↻ Regenerate' : '✨ Generate summary')}
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-300 mb-3">
            ⚠️ {error}
          </div>
        )}

        {!summary && !loading && !error && (
          <p className="text-gray-500 text-xs italic py-6 text-center">
            Click Generate to compile the latest schema + PSI + tech debt data into a narrative summary.
          </p>
        )}

        {summary && (
          <div className="space-y-3">
            <pre className="text-sm text-gray-200 whitespace-pre-wrap font-sans bg-gray-800/40 rounded-lg p-4">{summary}</pre>
            <div className="flex justify-end">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(summary)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
                className={`text-xs px-3 py-1.5 rounded transition ${copied ? 'bg-green-700/20 text-green-300 border border-green-700/40' : 'bg-amber-600 hover:bg-amber-500 text-white font-semibold'}`}
              >
                {copied ? '✓ Copied' : '📋 Copy to clipboard'}
              </button>
            </div>
            {stats && (
              <details className="text-[11px] text-gray-600">
                <summary className="cursor-pointer hover:text-gray-400">View source stats used</summary>
                <pre className="mt-2 bg-gray-950 rounded p-2 overflow-x-auto">{JSON.stringify(stats, null, 2)}</pre>
              </details>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
