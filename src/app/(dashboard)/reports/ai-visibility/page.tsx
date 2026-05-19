'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'

/**
 * /reports/ai-visibility — Sprint FREYJA
 *
 * The Freyja dashboard. Three sections:
 *   1. Totals strip — total mentions / citations / cited pages across all LLMs
 *   2. Per-LLM table — latest counts + WoW delta per source
 *   3. Trend chart — sum of all sources over time
 *   4. Import section — paste JSON or upload CSV
 *
 * Data sources: Bing Webmaster AI Performance + Semrush AI Visibility (both
 * manually uploaded for now; schema is API-ready for future automation).
 */

interface PerLlmSummary {
  llm_source:        string
  label:             string
  group:             'bing' | 'semrush' | 'other'
  latest_date:       string | null
  latest_mentions:   number
  latest_citations:  number
  latest_cited:      number
  mentions_wow_pct:  number | null
  citations_wow_pct: number | null
  cited_wow_pct:     number | null
}

interface TrendPoint {
  date:        string
  mentions:    number
  citations:   number
  cited_pages: number
}

interface OverviewBundle {
  site_slug:  string
  totals:     { mentions: number; citations: number; cited_pages: number }
  per_llm:    PerLlmSummary[]
  trend:      TrendPoint[]
  data_freshness: { latest: string | null; oldest_in_window: string | null }
}

interface ApiResponse {
  ok:          boolean
  site_slug?:  string
  window_days?: number
  overview?:   OverviewBundle
  error?:      string
}

// ── Skill: searchfit-seo:ai-visibility — recommendation types ────────────────
interface AiVisRec {
  title:     string
  action:    string
  metric:    string
  rationale: string
  priority:  'high' | 'medium' | 'low'
  dimension: 'content' | 'technical' | 'authority' | 'prompt_optimization'
}

interface RecsRecord {
  id:              string
  snapshot_date:   string
  recommendations: AiVisRec[]
  generated_at:    string
}

interface RecsApiResponse {
  ok:        boolean
  cached?:   boolean
  disabled?: boolean
  skill?:    string
  record?:   RecsRecord | null
  error?:    string
}

export default function AiVisibilityPage() {
  const siteSlug = useSiteSlug()

  const [data,    setData]    = useState<OverviewBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [days,    setDays]    = useState(84)

  const [importJson,   setImportJson]   = useState('')
  const [importing,    setImporting]    = useState(false)
  const [importResult, setImportResult] = useState<{ ok: boolean; inserted: number; skipped: number; errors?: unknown[] } | null>(null)

  // ── Skill: ai-visibility recommendations ────────────────────────────────
  const [recsRecord,      setRecsRecord]      = useState<RecsRecord | null>(null)
  const [recsLoading,     setRecsLoading]     = useState(false)
  const [recsError,       setRecsError]       = useState<string | null>(null)
  const [recsDisabled,    setRecsDisabled]    = useState(false)
  const [recsCollapsed,   setRecsCollapsed]   = useState(false)
  const [recsGenerating,  setRecsGenerating]  = useState(false)

  const loadRecs = useCallback(async () => {
    setRecsLoading(true); setRecsError(null)
    try {
      const res  = await fetch(`/api/reports/ai-visibility/recommend?site=${siteSlug}`)
      const body = await res.json() as RecsApiResponse
      if (body.disabled) { setRecsDisabled(true); return }
      if (!body.ok) { setRecsError(body.error ?? 'Failed to load recommendations'); return }
      setRecsRecord(body.record ?? null)
    } catch (e) {
      setRecsError(e instanceof Error ? e.message : String(e))
    } finally {
      setRecsLoading(false)
    }
  }, [siteSlug])

  const generateRecs = async (force = false) => {
    setRecsGenerating(true); setRecsError(null)
    try {
      const res  = await fetch('/api/reports/ai-visibility/recommend', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ site: siteSlug, force }),
      })
      const body = await res.json() as RecsApiResponse
      if (!body.ok) { setRecsError(body.error ?? 'Generation failed'); return }
      setRecsRecord(body.record ?? null)
    } catch (e) {
      setRecsError(e instanceof Error ? e.message : String(e))
    } finally {
      setRecsGenerating(false)
    }
  }

  async function load() {
    setLoading(true); setError(null)
    try {
      const res  = await fetch(`/api/reports/ai-visibility?days=${days}`)
      const body = await res.json() as ApiResponse
      if (!res.ok || !body.ok) {
        setError(body.error ?? `HTTP ${res.status}`)
        return
      }
      setData(body.overview ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [days, siteSlug])
  useEffect(() => { void loadRecs() }, [loadRecs])

  async function runImport() {
    setImporting(true); setImportResult(null)
    try {
      const parsed = JSON.parse(importJson)
      const res = await fetch('/api/reports/ai-visibility', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(parsed),
      })
      const body = await res.json()
      setImportResult(body)
      if (body.ok || body.inserted > 0) {
        setImportJson('')
        void load()
      }
    } catch (e) {
      setImportResult({ ok: false, inserted: 0, skipped: 0, errors: [{ error: e instanceof Error ? e.message : String(e) }] })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto">
      <Link href="/reports/weekly" className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 mb-2">
        ← Reports
      </Link>
      <h1 className="text-2xl font-bold text-white mb-1">🔮 AI Visibility</h1>
      <p className="text-sm text-gray-400 mb-6">
        How <strong className="text-white">{siteSlug.toUpperCase()}</strong> appears across LLMs and AI-driven search surfaces.
        Sources: Bing Webmaster AI Performance + Semrush AI Visibility (Overall, ChatGPT, Gemini, Google AI Mode, Google AI Overview).
        Data is manually imported until APIs stabilize.
      </p>

      {/* Window selector */}
      <div className="flex items-center gap-2 mb-4 text-xs">
        <span className="text-gray-500">Window:</span>
        {[7, 28, 84, 180].map(d => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`px-2 py-1 rounded border ${
              days === d
                ? 'bg-purple-500/20 border-purple-500/40 text-purple-200'
                : 'bg-gray-900 border-gray-800 text-gray-400 hover:bg-gray-800'
            }`}
          >
            {d === 7 ? '7d' : d === 28 ? '4w' : d === 84 ? '12w' : '6mo'}
          </button>
        ))}
        <button onClick={() => void load()} className="ml-auto text-gray-400 hover:text-white">↻ Refresh</button>
      </div>

      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-red-400">Failed: {error}</p>}

      {data && (
        <>
          {/* Totals strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <StatCard label="Total Mentions"   value={data.totals.mentions.toLocaleString()}    accent="#a78bfa" />
            <StatCard label="Total Citations"  value={data.totals.citations.toLocaleString()}   accent="#60a5fa" />
            <StatCard label="Cited Pages"      value={data.totals.cited_pages.toLocaleString()} accent="#34d399" />
            <StatCard label="Latest snapshot"  value={data.data_freshness.latest ?? '—'}        accent="#fbbf24" small />
          </div>

          {/* Trend chart */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-white">Trend</h2>
                <p className="text-[10px] text-gray-500 mt-0.5">Total across all sources, per snapshot date</p>
              </div>
            </div>
            <TrendChart data={data.trend} />
          </section>

          {/* Per-LLM table */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-white">Per-source breakdown</h2>
              <p className="text-[10px] text-gray-500 mt-0.5">Latest snapshot per LLM with WoW delta</p>
            </div>
            {data.per_llm.length === 0 ? (
              <p className="p-6 text-sm text-gray-500">No data yet. Import snapshots below to get started.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-800/40 text-gray-400 text-[10px] uppercase tracking-wider">
                  <tr>
                    <th className="text-left  px-3 py-2">Source</th>
                    <th className="text-right px-3 py-2">Mentions</th>
                    <th className="text-right px-3 py-2 w-20">Δ%</th>
                    <th className="text-right px-3 py-2">Citations</th>
                    <th className="text-right px-3 py-2 w-20">Δ%</th>
                    <th className="text-right px-3 py-2">Cited Pages</th>
                    <th className="text-right px-3 py-2 w-20">Δ%</th>
                    <th className="text-right px-3 py-2">Latest</th>
                  </tr>
                </thead>
                <tbody>
                  {data.per_llm.map(p => (
                    <tr key={p.llm_source} className="border-t border-gray-800">
                      <td className="px-3 py-2 text-white">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold border mr-2 ${
                          p.group === 'bing'    ? 'bg-blue-500/15 text-blue-300 border-blue-500/30' :
                          p.group === 'semrush' ? 'bg-orange-500/15 text-orange-300 border-orange-500/30' :
                                                  'bg-gray-700 text-gray-300 border-gray-600'
                        }`}>{p.group}</span>
                        {p.label}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-200">{p.latest_mentions.toLocaleString()}</td>
                      <td className={`px-3 py-2 text-right text-xs ${pctClass(p.mentions_wow_pct)}`}>{fmtPct(p.mentions_wow_pct)}</td>
                      <td className="px-3 py-2 text-right text-gray-200">{p.latest_citations.toLocaleString()}</td>
                      <td className={`px-3 py-2 text-right text-xs ${pctClass(p.citations_wow_pct)}`}>{fmtPct(p.citations_wow_pct)}</td>
                      <td className="px-3 py-2 text-right text-gray-200">{p.latest_cited.toLocaleString()}</td>
                      <td className={`px-3 py-2 text-right text-xs ${pctClass(p.cited_wow_pct)}`}>{fmtPct(p.cited_wow_pct)}</td>
                      <td className="px-3 py-2 text-right text-gray-500 text-xs">{p.latest_date ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {/* ── Skill: AI Visibility Recommendations ───────────────────────────── */}
      {!recsDisabled && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-6">
          {/* Header row */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <button
              onClick={() => setRecsCollapsed(c => !c)}
              className="flex items-center gap-2 text-left flex-1"
            >
              <span className="text-sm font-semibold text-white">💡 Recommendations</span>
              {recsRecord && (
                <span className="text-[10px] text-gray-500 ml-1">
                  from snapshot {recsRecord.snapshot_date} · {timeAgo(recsRecord.generated_at)}
                </span>
              )}
              <span className="text-gray-600 text-xs ml-1">{recsCollapsed ? '▼' : '▲'}</span>
            </button>
            <button
              onClick={() => void generateRecs(true)}
              disabled={recsGenerating}
              className="text-[11px] px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 flex-shrink-0"
              title="Regenerate recommendations using latest snapshot data"
            >
              <span>{recsGenerating ? '⏳' : '🤖'}</span>
              <span>{recsGenerating ? 'Generating…' : 'Regenerate'}</span>
            </button>
          </div>

          {!recsCollapsed && (
            <div className="p-4">
              {/* Attribution */}
              <p className="text-[10px] text-gray-600 mb-3">
                Generated via Anthropic skill: <code className="text-gray-500">searchfit-seo:ai-visibility</code> · Model: claude-haiku-4-5
              </p>

              {recsLoading && (
                <p className="text-xs text-gray-500 py-4 text-center">Loading recommendations…</p>
              )}

              {recsError && (
                <p className="text-xs text-red-400 py-2">⚠ {recsError}</p>
              )}

              {!recsLoading && !recsError && !recsRecord && (
                <div className="py-6 text-center">
                  <p className="text-sm text-gray-400 mb-3">No recommendations yet for this site.</p>
                  <button
                    onClick={() => void generateRecs(false)}
                    disabled={recsGenerating}
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm rounded-lg"
                  >
                    {recsGenerating ? 'Generating…' : '🤖 Generate recommendations'}
                  </button>
                </div>
              )}

              {recsRecord && recsRecord.recommendations.length > 0 && (
                <div className="space-y-3">
                  {recsRecord.recommendations.map((rec, i) => (
                    <RecCard key={i} rec={rec} index={i + 1} />
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Import section */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <h2 className="text-sm font-semibold text-white mb-2">📥 Import snapshots</h2>
        <p className="text-xs text-gray-500 mb-3">
          Paste a JSON row or array of rows. Re-imports of same (date × llm × country) override.
        </p>
        <details className="text-xs text-gray-400 mb-2">
          <summary className="cursor-pointer hover:text-white">Show example payload</summary>
          <pre className="mt-2 p-3 bg-gray-950 border border-gray-800 rounded text-[10px] overflow-x-auto">{`{
  "rows": [
    { "snapshot_date": "2026-05-15", "llm_source": "bing_ai",         "country": "global", "mentions": 12500, "citations": 8400, "cited_pages": 691,  "source": "manual" },
    { "snapshot_date": "2026-05-15", "llm_source": "semrush_overall", "country": "global", "mentions": 3600,  "citations": 2600, "cited_pages": 1600, "source": "manual" },
    { "snapshot_date": "2026-05-15", "llm_source": "chatgpt",         "country": "global", "mentions": 392,   "citations": 283,  "cited_pages": 174,  "source": "manual" },
    { "snapshot_date": "2026-05-15", "llm_source": "gemini",          "country": "global", "mentions": 1019,  "citations": 736,  "cited_pages": 452,  "source": "manual" },
    { "snapshot_date": "2026-05-15", "llm_source": "ai_mode",         "country": "global", "mentions": 1202,  "citations": 870,  "cited_pages": 534,  "source": "manual" },
    { "snapshot_date": "2026-05-15", "llm_source": "ai_overview",     "country": "global", "mentions": 983,   "citations": 711,  "cited_pages": 440,  "source": "manual" }
  ]
}`}</pre>
        </details>
        <textarea
          value={importJson}
          onChange={e => setImportJson(e.target.value)}
          placeholder="Paste JSON here…"
          rows={6}
          className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-xs text-white font-mono placeholder-gray-600 focus:outline-none focus:border-gray-600"
        />
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={runImport}
            disabled={importing || !importJson.trim()}
            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs rounded-lg"
          >
            {importing ? 'Importing…' : '📥 Import'}
          </button>
          {importResult && (
            <span className={`text-xs ${importResult.ok ? 'text-emerald-400' : 'text-amber-400'}`}>
              {importResult.ok ? '✓' : '⚠'} Inserted {importResult.inserted}{importResult.skipped > 0 ? ` · ${importResult.skipped} skipped` : ''}
            </span>
          )}
        </div>
      </section>

      <section className="bg-gray-900/40 border border-gray-800 rounded-xl p-4 text-xs text-gray-400 space-y-1">
        <p><strong className="text-white">Sources:</strong> Bing Webmaster AI Performance (Copilot + partners), Semrush AI Visibility (overall + per-LLM breakdown across ChatGPT, Gemini, AI Mode, AI Overview).</p>
        <p><strong className="text-white">Cadence recommendation:</strong> Weekly manual import on Mondays — paste latest week's numbers from both dashboards.</p>
        <p><strong className="text-white">API automation:</strong> Schema is forward-compatible; when Bing or Semrush expose APIs, swap manual import for cron pull. <code className="text-amber-300">source</code> field will switch from <code>manual</code> to <code>bing_api</code> / <code>semrush_api</code>.</p>
      </section>
    </div>
  )
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function StatCard({ label, value, accent, small }: { label: string; value: string; accent: string; small?: boolean }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: accent }} />
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5 font-semibold">{label}</p>
      <p className={`${small ? 'text-base' : 'text-2xl'} font-bold text-white leading-tight`}>{value}</p>
    </div>
  )
}

function TrendChart({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) {
    return <p className="text-xs text-gray-500 py-12 text-center">No data yet — import snapshots below.</p>
  }
  const w = 800, h = 220, pad = 32
  const max = Math.max(1, ...data.map(d => Math.max(d.mentions, d.citations, d.cited_pages)))
  const xStep = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0
  const xScale = (i: number) => pad + i * xStep
  const yScale = (n: number) => h - pad - (n / max) * (h - pad * 2)

  const series: Array<{ key: keyof TrendPoint; label: string; color: string }> = [
    { key: 'mentions',    label: 'Mentions',    color: '#a78bfa' },
    { key: 'citations',   label: 'Citations',   color: '#60a5fa' },
    { key: 'cited_pages', label: 'Cited Pages', color: '#34d399' },
  ]

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* axis baseline */}
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#374151" strokeWidth={0.5} />

        {series.map(s => {
          const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d[s.key] as number)}`).join(' ')
          return (
            <g key={s.key}>
              <path d={path} fill="none" stroke={s.color} strokeWidth={1.5} opacity={0.9} />
              {data.map((d, i) => (
                <circle key={i} cx={xScale(i)} cy={yScale(d[s.key] as number)} r={2} fill={s.color} />
              ))}
            </g>
          )
        })}

        {/* X labels (sparse) */}
        {data.map((d, i) => {
          if (data.length > 12 && i % Math.ceil(data.length / 12) !== 0) return null
          return (
            <text key={i} x={xScale(i)} y={h - pad + 12} fontSize="8" fill="#6b7280" textAnchor="middle">
              {d.date.slice(5)}
            </text>
          )
        })}
      </svg>
      <div className="flex items-center gap-4 mt-2 text-[10px]">
        {series.map(s => (
          <span key={s.key} className="inline-flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="text-gray-400">{s.label}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Recommendation card ───────────────────────────────────────────────────────

const PRIORITY_BG: Record<AiVisRec['priority'], string> = {
  high:   'border-red-800/50   bg-red-900/20',
  medium: 'border-amber-800/50 bg-amber-900/20',
  low:    'border-blue-800/50  bg-blue-900/20',
}

const PRIORITY_LABEL: Record<AiVisRec['priority'], string> = {
  high:   'text-red-300   bg-red-900/40   border-red-700/40',
  medium: 'text-amber-300 bg-amber-900/40 border-amber-700/40',
  low:    'text-blue-300  bg-blue-900/40  border-blue-700/40',
}

const DIMENSION_LABEL: Record<AiVisRec['dimension'], string> = {
  content:              'Content',
  technical:            'Technical',
  authority:            'Authority',
  prompt_optimization:  'Prompt Opt.',
}

function RecCard({ rec, index }: { rec: AiVisRec; index: number }) {
  return (
    <div className={`rounded-lg border p-3.5 ${PRIORITY_BG[rec.priority]}`}>
      <div className="flex items-start gap-2 mb-1.5">
        <span className="text-gray-500 text-xs font-mono mt-0.5 flex-shrink-0">{index}.</span>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <span className="text-white text-sm font-semibold">{rec.title}</span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded border uppercase font-bold ${PRIORITY_LABEL[rec.priority]}`}>
              {rec.priority}
            </span>
            <span className="text-[9px] px-1.5 py-0.5 rounded border bg-gray-800 border-gray-700 text-gray-400 uppercase">
              {DIMENSION_LABEL[rec.dimension] ?? rec.dimension}
            </span>
          </div>
          <p className="text-sm text-gray-200 mb-1">{rec.action}</p>
          <p className="text-xs text-emerald-400 mb-1">🎯 {rec.metric}</p>
          <p className="text-xs text-gray-500 leading-relaxed">{rec.rationale}</p>
        </div>
      </div>
    </div>
  )
}

// ── Time helper ───────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m  = Math.floor(ms / 60_000)
  if (m < 60)  return `${m}m ago`
  const h  = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d  = Math.floor(h / 24)
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString()
}

function pctClass(d: number | null): string {
  if (d == null) return 'text-gray-600'
  if (Math.abs(d) < 0.1) return 'text-gray-500'
  return d > 0 ? 'text-emerald-400' : 'text-red-400'
}

function fmtPct(d: number | null): string {
  if (d == null) return '—'
  if (Math.abs(d) < 0.1) return 'flat'
  return d > 0 ? `↑${d.toFixed(0)}%` : `↓${Math.abs(d).toFixed(0)}%`
}
