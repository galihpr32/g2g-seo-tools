'use client'

/**
 * /competitive/backlink-gap — domains linking to a competitor that we should
 * pitch but currently don't have.
 *
 * Specialist 2's monthly competitor backlink-gap analysis (Workflow #2 step
 * 2.11) lived in a spreadsheet. Now in-app: pick competitor → DFS pulls
 * their refs → diff against our refs → ranked outreach gold list.
 */

import { useState, useEffect } from 'react'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'

interface CompetitorResult {
  competitor: string
  gaps:       Array<{ domain: string; rank: number; backlinks: number }>
  total:      number
  gapsCount:  number
}

interface ApiResult {
  ok:          boolean
  ourDomain:   string
  competitors: CompetitorResult[]
  when:        string
  error?:      string
}

export default function BacklinkGapPage() {
  const siteSlug = useSiteSlug()
  const [data, setData] = useState<ApiResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manualDomain, setManualDomain] = useState('')

  async function load(competitor?: string) {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams({ site: siteSlug })
      if (competitor) params.set('competitor', competitor)
      const res = await fetch(`/api/competitive/backlink-gap?${params.toString()}`)
      const d = await res.json()
      if (!res.ok || !d.ok) throw new Error(d.error ?? `HTTP ${res.status}`)
      setData(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // Don't auto-load — backlinks API costs $$, let the user click
  useEffect(() => { setData(null) }, [siteSlug])

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">🕵️ Competitor Backlink Gap</h1>
          <p className="text-gray-400 text-sm mt-1">
            Domains linking to your competitors but not to you — outreach gold.
          </p>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
          <div>
            <p className="text-sm text-white font-medium">Run analysis</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Either analyze all tracked competitors or enter a specific domain. Each competitor costs ~$0.05 in DataForSEO credits.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => load()}
            disabled={loading}
            className="text-sm bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white font-semibold px-4 py-2 rounded-lg transition"
          >
            {loading ? 'Pulling DataForSEO…' : '🚀 Run on tracked competitors'}
          </button>
          <span className="text-xs text-gray-500 self-center">or</span>
          <div className="flex gap-2 flex-1">
            <input
              type="text"
              value={manualDomain}
              onChange={e => setManualDomain(e.target.value)}
              placeholder="e.g. overgear.com"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
            <button
              onClick={() => manualDomain.trim() && load(manualDomain.trim())}
              disabled={loading || !manualDomain.trim()}
              className="text-sm bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-white px-4 py-2 rounded-lg transition border border-gray-700"
            >
              Analyze single
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300">
          ⚠️ {error}
        </div>
      )}

      {data && data.competitors.length === 0 && !loading && (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-gray-400 text-sm">No tracked competitors. Add some at /competitive/competitors first.</p>
        </div>
      )}

      {data && data.competitors.map(c => (
        <section key={c.competitor} className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-4">
          <header className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-white font-semibold text-sm">
              vs {c.competitor}
            </h2>
            <p className="text-xs text-gray-500">
              {c.gapsCount} gap domains found from {c.total} total referring (we already have the rest)
            </p>
          </header>

          {c.gaps.length === 0 ? (
            <p className="text-xs text-gray-600 italic py-4 text-center">
              No clean gaps — either we share most of {c.competitor}&apos;s backlinks already, or DFS returned no data.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-xs text-gray-500">
                  <th className="text-left py-2 font-semibold">Domain</th>
                  <th className="text-right py-2 font-semibold w-24">Rank</th>
                  <th className="text-right py-2 font-semibold w-24">Backlinks</th>
                  <th className="text-right py-2 font-semibold w-24">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/60">
                {c.gaps.slice(0, 25).map(g => (
                  <tr key={g.domain} className="hover:bg-gray-800/40 transition">
                    <td className="py-2">
                      <a
                        href={`https://${g.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 font-medium"
                      >
                        {g.domain}
                      </a>
                    </td>
                    <td className="py-2 text-right text-amber-300 font-medium tabular-nums">{g.rank}</td>
                    <td className="py-2 text-right text-gray-400 tabular-nums">{g.backlinks.toLocaleString()}</td>
                    <td className="py-2 text-right">
                      <a
                        href={`/outreach?prospect_domain=${encodeURIComponent(g.domain)}`}
                        className="text-[11px] bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 px-2 py-1 rounded transition"
                      >
                        + Add to Outreach
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}

      {!data && !loading && !error && (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">🕵️</p>
          <p className="text-gray-400 text-sm">Run analysis to see backlink gaps.</p>
        </div>
      )}
    </div>
  )
}
