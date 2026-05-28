'use client'

/**
 * /site-health/schema — list pages with their latest schema-health snapshot.
 *
 * Asst Manager's daily check (Workflow #3 step 3.6): "any page with
 * broken/missing JSON-LD?" Sorted broken-first for fast triage.
 */

import { useEffect, useState } from 'react'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'

interface Snapshot {
  page_url:           string
  snapshot_date:      string
  has_jsonld:         boolean
  jsonld_count:       number
  schema_types:       string[]
  validation_errors:  string[]
  validity_score:     number
  http_status:        number | null
}

interface Stats { total: number; healthy: number; needs_work: number; broken: number; no_jsonld: number }

export default function SchemaHealthPage() {
  const siteSlug = useSiteSlug()
  const [data, setData] = useState<{ stats: Stats; snapshots: Snapshot[] } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/site-health/schema?site=${siteSlug}&days=30`)
      .then(r => r.json())
      .then(d => setData({ stats: d.stats, snapshots: d.snapshots ?? [] }))
      .catch(() => { /* silent */ })
      .finally(() => setLoading(false))
  }, [siteSlug])

  return (
    <div className="p-8 max-w-6xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-white">🧬 Schema Health</h1>
        <p className="text-gray-400 text-sm mt-1">
          JSON-LD structured data validation per page. Weekly cron pulls top traffic pages and checks schema.org structure.
        </p>
      </header>

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          {[
            { label: 'Pages tracked', value: data.stats.total,      color: 'text-white'      },
            { label: 'Healthy ≥90',   value: data.stats.healthy,    color: 'text-green-400'  },
            { label: 'Needs work',    value: data.stats.needs_work, color: 'text-amber-400'  },
            { label: 'Broken <70',    value: data.stats.broken,     color: 'text-red-400'    },
            { label: 'No JSON-LD',    value: data.stats.no_jsonld,  color: 'text-gray-500'   },
          ].map(s => (
            <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-center text-gray-500 py-12">Loading…</p>
      ) : !data || data.snapshots.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">🧬</p>
          <p className="text-gray-400 text-sm">No schema snapshots yet.</p>
          <p className="text-gray-600 text-xs mt-1">First snapshot lands Sunday 04:00 UTC. Or trigger via GitHub Actions → Schema Health → Run workflow.</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/40 border-b border-gray-800">
              <tr>
                <th className="text-left py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Page</th>
                <th className="text-center py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-20">Score</th>
                <th className="text-left py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-44">Schema types</th>
                <th className="text-center py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-20">Errors</th>
                <th className="text-right py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-24">Last check</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {data.snapshots.map(s => {
                const path = s.page_url.replace(/^https?:\/\/[^/]+/, '')
                const scoreColor =
                  s.validity_score >= 90 ? 'text-green-400'  :
                  s.validity_score >= 70 ? 'text-amber-400'  :
                                           'text-red-400'
                return (
                  <tr key={s.page_url} className="hover:bg-gray-800/30">
                    <td className="py-2 px-3">
                      <a href={s.page_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 truncate max-w-md inline-block" title={s.page_url}>
                        {path}
                      </a>
                    </td>
                    <td className={`py-2 px-3 text-center font-bold ${scoreColor}`}>
                      {s.validity_score}
                    </td>
                    <td className="py-2 px-3">
                      {s.schema_types.length === 0 ? (
                        <span className="text-gray-600 text-xs italic">no schema</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {s.schema_types.slice(0, 3).map(t => (
                            <span key={t} className="text-[10px] bg-gray-800 text-gray-300 px-1.5 py-0.5 rounded">{t}</span>
                          ))}
                          {s.schema_types.length > 3 && (
                            <span className="text-[10px] text-gray-500">+{s.schema_types.length - 3}</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-3 text-center">
                      {s.validation_errors.length > 0 ? (
                        <span className="text-[11px] text-red-400 font-bold" title={s.validation_errors.slice(0, 3).join('\n')}>
                          {s.validation_errors.length}
                        </span>
                      ) : (
                        <span className="text-[11px] text-gray-600">—</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right text-[11px] text-gray-500">{s.snapshot_date}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
