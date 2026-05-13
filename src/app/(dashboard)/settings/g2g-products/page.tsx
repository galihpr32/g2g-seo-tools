'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// ─── G2G canonical catalog admin ─────────────────────────────────────────────
// Upload the latest CSV export from the G2G CMS admin, eyeball the delta,
// browse the catalog. Powers CMS auto-upload (cached brand_id), tier admin
// typeahead, sheet validation, opportunity mapping, etc.

interface Stats {
  total_products:    number
  active_products:   number
  inactive_products: number
  by_service_name:   { service_name: string; count: number }[]
  last_import: {
    imported_at:      string
    rows_total:       number
    rows_inserted:    number
    rows_updated:     number
    rows_unchanged:   number
    rows_deactivated: number
    source_label:     string | null
  } | null
}

interface CatalogRow {
  relation_id:    string
  service_id:     string
  brand_id:       string
  service_name:   string
  brand_name:     string
  cms_created_at: string | null
  is_active:      boolean
}

interface ImportResult {
  ok:               boolean
  rows_total:       number
  rows_inserted:    number
  rows_updated:     number
  rows_unchanged:   number
  rows_deactivated: number
  errors:           string[]
}

interface CoverageBucket {
  service_name: string
  total:        number
  has_content:  number
  has_uploaded: number
  has_tier:     number
  has_keywords: number
}

interface Coverage {
  total_active: number
  coverage:     { has_content: number; has_uploaded: number; has_tier: number; has_keywords: number }
  by_service:   CoverageBucket[]
}

export default function G2gProductsPage() {
  const [stats,   setStats]   = useState<Stats | null>(null)
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [rows,    setRows]    = useState<CatalogRow[]>([])
  const [q,       setQ]       = useState('')
  const [service, setService] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [loadingTable, setLoadingTable] = useState(false)
  const [uploading,    setUploading]    = useState(false)
  const [lastResult,   setLastResult]   = useState<ImportResult | null>(null)
  const [uploadErr,    setUploadErr]    = useState<string | null>(null)

  // Bumped after a successful import to force stats + coverage + rows refresh.
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [s, c] = await Promise.all([
          fetch('/api/g2g-catalog/stats').then(r => r.ok ? r.json() : null),
          fetch('/api/g2g-catalog/coverage').then(r => r.ok ? r.json() : null),
        ])
        if (cancelled) return
        if (s) setStats(s)
        if (c) setCoverage(c)
      } catch { /* silent */ }
    })()
    return () => { cancelled = true }
  }, [refreshTick])

  useEffect(() => {
    let cancelled = false
    setLoadingTable(true)
    ;(async () => {
      try {
        const params = new URLSearchParams()
        if (q)       params.set('q', q)
        if (service) params.set('service', service)
        if (includeInactive) params.set('include_inactive', '1')
        params.set('limit', '50')
        const res = await fetch(`/api/g2g-catalog/search?${params}`)
        const data = await res.json() as { results?: CatalogRow[] }
        if (!cancelled) setRows(data.results ?? [])
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoadingTable(false)
      }
    })()
    return () => { cancelled = true }
  }, [q, service, includeInactive, refreshTick])

  async function handleFile(file: File) {
    setUploading(true)
    setUploadErr(null)
    setLastResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('label', file.name)
      const res = await fetch('/api/admin/g2g-catalog/import', { method: 'POST', body: fd })
      const data = await res.json() as ImportResult & { error?: string }
      if (!res.ok || data.error) {
        setUploadErr(data.error ?? 'Import failed')
      } else {
        setLastResult(data)
        setRefreshTick(t => t + 1)   // triggers the two effects above
      }
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : String(e))
    }
    setUploading(false)
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📚 G2G Product Catalog</h1>
          <p className="text-sm text-gray-400 mt-1">
            Canonical mirror of every G2G CMS product — feeds CMS upload caching, tier autocomplete, sheet validation, and opportunity mapping.
          </p>
        </div>
        <Link href="/settings" className="text-sm text-gray-400 hover:text-white">← Back to Settings</Link>
      </div>

      {/* ── KPI strip ───────────────────────────────────────────────────── */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi label="Total products" value={stats.total_products.toLocaleString()} />
          <Kpi label="Active"         value={stats.active_products.toLocaleString()} tone="green" />
          <Kpi label="Inactive"       value={stats.inactive_products.toLocaleString()} tone="gray" />
          <Kpi label="Categories"     value={String(stats.by_service_name.length)} />
        </div>
      )}

      {/* ── Upload + last import ────────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
        <h2 className="text-lg font-semibold text-white mb-3">Import CSV</h2>
        <p className="text-sm text-gray-400 mb-4">
          Expected columns: <code className="text-blue-300">service_id, brand_id, relation_id, service_name, brand_name, created_at</code>.
          New rows are inserted; existing rows are updated; rows missing from the latest CSV are marked inactive (preserves history).
        </p>

        <label className="block">
          <input
            type="file"
            accept=".csv"
            disabled={uploading}
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) void handleFile(f)
            }}
            className="block text-sm text-gray-300 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-600 file:text-white hover:file:bg-blue-500 file:cursor-pointer"
          />
        </label>

        {uploading   && <p className="mt-3 text-sm text-amber-300">Uploading… (parsing + bulk upsert + deactivation pass)</p>}
        {uploadErr   && <p className="mt-3 text-sm text-red-400">❌ {uploadErr}</p>}
        {lastResult  && (
          <div className="mt-3 rounded-md border border-green-700/50 bg-green-500/5 p-3 text-sm text-green-200 space-y-0.5">
            <p className="font-medium">✅ Import complete — {lastResult.rows_total.toLocaleString()} rows scanned</p>
            <p>Inserted: <b>{lastResult.rows_inserted}</b> · Updated: <b>{lastResult.rows_updated}</b> · Unchanged: <b>{lastResult.rows_unchanged}</b> · Deactivated: <b>{lastResult.rows_deactivated}</b></p>
            {lastResult.errors.length > 0 && (
              <details className="mt-2">
                <summary className="text-amber-300 cursor-pointer">⚠ {lastResult.errors.length} non-blocking warning(s)</summary>
                <pre className="mt-2 text-xs text-amber-200 whitespace-pre-wrap">{lastResult.errors.slice(0, 30).join('\n')}</pre>
              </details>
            )}
          </div>
        )}

        {stats?.last_import && !lastResult && (
          <p className="mt-3 text-xs text-gray-500">
            Last import: <span className="text-gray-300">{new Date(stats.last_import.imported_at).toLocaleString()}</span>
            {stats.last_import.source_label && <> · {stats.last_import.source_label}</>}
            <> · {stats.last_import.rows_total.toLocaleString()} rows · +{stats.last_import.rows_inserted} new · ~{stats.last_import.rows_updated} updated · -{stats.last_import.rows_deactivated} deactivated</>
          </p>
        )}
      </div>

      {/* ── Pipeline reset (clean slate before re-running agents) ─────────── */}
      <ClearPipelineCard />

      {/* ── Coverage matrix ─────────────────────────────────────────────── */}
      {coverage && coverage.total_active > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-white">Coverage Matrix</h2>
            <span className="text-xs text-gray-500">{coverage.total_active.toLocaleString()} active products</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <CoveragePill label="AI content generated" value={coverage.coverage.has_content}  total={coverage.total_active} tone="blue"   />
            <CoveragePill label="Uploaded to CMS"      value={coverage.coverage.has_uploaded} total={coverage.total_active} tone="green"  />
            <CoveragePill label="In a tier"            value={coverage.coverage.has_tier}     total={coverage.total_active} tone="amber"  />
            <CoveragePill label="Keyword-tracked"      value={coverage.coverage.has_keywords} total={coverage.total_active} tone="purple" />
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-gray-300 hover:text-white">Drill down by category</summary>
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-xs">
                <thead className="text-gray-500 border-b border-gray-800">
                  <tr>
                    <th className="text-left px-2 py-1.5">Category</th>
                    <th className="text-right px-2 py-1.5">Total</th>
                    <th className="text-right px-2 py-1.5">Content</th>
                    <th className="text-right px-2 py-1.5">Uploaded</th>
                    <th className="text-right px-2 py-1.5">Tiered</th>
                    <th className="text-right px-2 py-1.5">Keywords</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.by_service.map(b => (
                    <tr key={b.service_name} className="border-b border-gray-800/40">
                      <td className="px-2 py-1.5 text-white">{b.service_name}</td>
                      <td className="px-2 py-1.5 text-right text-gray-300">{b.total.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right text-blue-300">{pct(b.has_content,  b.total)}</td>
                      <td className="px-2 py-1.5 text-right text-green-300">{pct(b.has_uploaded, b.total)}</td>
                      <td className="px-2 py-1.5 text-right text-amber-300">{pct(b.has_tier,     b.total)}</td>
                      <td className="px-2 py-1.5 text-right text-purple-300">{pct(b.has_keywords, b.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}

      {/* ── Category distribution ──────────────────────────────────────── */}
      {stats && stats.by_service_name.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
          <h2 className="text-lg font-semibold text-white mb-3">Distribution by Category</h2>
          <div className="space-y-2">
            {stats.by_service_name.map(r => {
              const pct = stats.active_products > 0 ? Math.round((r.count / stats.active_products) * 100) : 0
              return (
                <button
                  key={r.service_name}
                  onClick={() => setService(prev => prev === r.service_name ? '' : r.service_name)}
                  className={`w-full text-left rounded-md border px-3 py-2 transition ${
                    service === r.service_name
                      ? 'border-blue-500 bg-blue-500/10'
                      : 'border-gray-800 hover:border-gray-600 bg-gray-950'
                  }`}
                >
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white font-medium">{r.service_name}</span>
                    <span className="text-gray-400">{r.count.toLocaleString()} <span className="text-gray-600">({pct}%)</span></span>
                  </div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-gray-800 overflow-hidden">
                    <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
                  </div>
                </button>
              )
            })}
          </div>
          {service && (
            <p className="mt-2 text-xs text-blue-300">Filter active: <b>{service}</b> · <button onClick={() => setService('')} className="underline hover:text-blue-200">clear</button></p>
          )}
        </div>
      )}

      {/* ── Browse table ────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="text-lg font-semibold text-white">Browse Catalog</h2>
          <div className="flex items-center gap-2 text-sm">
            <input
              type="text"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search brand or brand_id…"
              className="bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 text-sm w-64"
            />
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} />
              Include inactive
            </label>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-gray-500 border-b border-gray-800">
              <tr>
                <th className="text-left px-2 py-2">Brand</th>
                <th className="text-left px-2 py-2">Category</th>
                <th className="text-left px-2 py-2">brand_id</th>
                <th className="text-left px-2 py-2">relation_id</th>
                <th className="text-left px-2 py-2">CMS created</th>
                <th className="text-left px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {loadingTable && (
                <tr><td colSpan={6} className="px-2 py-6 text-center text-gray-500">Loading…</td></tr>
              )}
              {!loadingTable && rows.length === 0 && (
                <tr><td colSpan={6} className="px-2 py-6 text-center text-gray-500">No products match.</td></tr>
              )}
              {!loadingTable && rows.map(r => (
                <tr key={r.relation_id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-2 py-2 text-white">{r.brand_name}</td>
                  <td className="px-2 py-2 text-gray-300">{r.service_name}</td>
                  <td className="px-2 py-2 text-gray-400 font-mono text-xs">{r.brand_id}</td>
                  <td className="px-2 py-2 text-gray-500 font-mono text-xs">{r.relation_id.slice(0, 8)}…</td>
                  <td className="px-2 py-2 text-gray-500 text-xs">{r.cms_created_at ? new Date(r.cms_created_at).toLocaleDateString() : '—'}</td>
                  <td className="px-2 py-2">
                    {r.is_active
                      ? <span className="text-xs text-green-400">● active</span>
                      : <span className="text-xs text-gray-500">● inactive</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 50 && (
          <p className="mt-2 text-xs text-gray-500">Showing first 50 — narrow search to see more.</p>
        )}
      </div>
    </div>
  )
}

// ─── Clear-pipeline card ───────────────────────────────────────────────────
// One-time tool used right after the catalog import: wipe existing
// opportunities + briefs so a manual agent re-run can rebuild them, this
// time auto-tagged with the canonical matched_relation_id via Sprint
// CATALOG.14's hook in the Saga aggregator.

function ClearPipelineCard() {
  const [scope,    setScope]   = useState<'opps' | 'briefs' | 'all'>('all')
  const [busy,     setBusy]    = useState(false)
  const [result,   setResult]  = useState<{ briefs_deleted: number; opportunities_deleted: number; message?: string } | null>(null)
  const [err,      setErr]     = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')

  async function doClear() {
    setBusy(true); setErr(null); setResult(null)
    try {
      const res = await fetch('/api/admin/clear-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, scope }),
      })
      const data = await res.json()
      if (!res.ok || data.error) setErr(data.error ?? 'Clear failed')
      else { setResult(data); setConfirmText('') }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const armed = confirmText.trim().toUpperCase() === 'CLEAR'

  return (
    <div className="rounded-lg border border-red-900/40 bg-red-950/10 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">⚠ Clear Pipeline (clean-slate)</h2>
          <p className="text-sm text-gray-400 mt-1">
            Wipe existing opportunities + briefs for the active brand so you can re-run Heimdall/Loki/Odin from scratch.
            New rows will land with canonical <code className="text-blue-300">matched_relation_id</code> pre-populated via the catalog auto-match hook.
          </p>
          <p className="text-xs text-amber-300 mt-2">
            Doesn&apos;t touch <code>agent_actions</code> (raw signals stay) or product catalog / tier / content data.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <label className="text-gray-400">Scope:</label>
        <select
          value={scope}
          onChange={e => setScope(e.target.value as typeof scope)}
          className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200"
          disabled={busy}
        >
          <option value="all">All (opportunities + briefs)</option>
          <option value="opps">Opportunities only</option>
          <option value="briefs">Briefs only</option>
        </select>
        <input
          type="text"
          value={confirmText}
          onChange={e => setConfirmText(e.target.value)}
          placeholder='Type CLEAR to enable'
          className="bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-gray-200 placeholder:text-gray-600 text-sm w-40"
          disabled={busy}
        />
        <button
          onClick={doClear}
          disabled={busy || !armed}
          className="px-3 py-1.5 text-sm font-medium rounded-md bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
        >
          {busy ? 'Clearing…' : '🗑 Clear pipeline'}
        </button>
      </div>

      {err && <p className="mt-3 text-sm text-red-400">❌ {err}</p>}
      {result && (
        <div className="mt-3 rounded-md border border-green-700/50 bg-green-500/5 p-3 text-sm text-green-200">
          ✅ Done — deleted <b>{result.opportunities_deleted}</b> opportunities + <b>{result.briefs_deleted}</b> briefs.
          <p className="text-xs text-green-100/80 mt-1">{result.message}</p>
        </div>
      )}
    </div>
  )
}

function CoveragePill({ label, value, total, tone }: { label: string; value: number; total: number; tone: 'blue' | 'green' | 'amber' | 'purple' }) {
  const pctNum = total > 0 ? Math.round((value / total) * 100) : 0
  const colors = {
    blue:   { bar: 'bg-blue-500',   text: 'text-blue-300' },
    green:  { bar: 'bg-green-500',  text: 'text-green-300' },
    amber:  { bar: 'bg-amber-500',  text: 'text-amber-300' },
    purple: { bar: 'bg-purple-500', text: 'text-purple-300' },
  }[tone]
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 p-3">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-xl font-bold text-white mt-1">{value.toLocaleString()} <span className={`text-sm ${colors.text}`}>({pctNum}%)</span></p>
      <div className="mt-1.5 h-1.5 rounded-full bg-gray-800 overflow-hidden">
        <div className={`h-full ${colors.bar}`} style={{ width: `${pctNum}%` }} />
      </div>
    </div>
  )
}

function pct(value: number, total: number): string {
  if (total === 0) return '0%'
  return `${value.toLocaleString()} (${Math.round((value / total) * 100)}%)`
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'gray' }) {
  const border =
    tone === 'green' ? 'border-green-700/40 bg-green-500/5' :
    tone === 'gray'  ? 'border-gray-800 bg-gray-900/60' :
                       'border-gray-800 bg-gray-900'
  return (
    <div className={`rounded-lg border ${border} p-4`}>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-white mt-1">{value}</p>
    </div>
  )
}
