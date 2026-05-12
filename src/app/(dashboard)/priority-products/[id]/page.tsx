'use client'

import { useEffect, useMemo, useState, use } from 'react'
import Link from 'next/link'

/**
 * /priority-products/[id]
 *
 * Per-tier-product detail with two ranking lanes (GSC + DataForSEO),
 * keyword leaderboard, and SERP map per keyword.
 *
 * Sections:
 *   1. Header  — name, tier badge, category, URL
 *   2. Charts  — GSC clicks+position (left) | DataForSEO position trend (right)
 *   3. Keyword management — add / remove / mark-as-main
 *   4. Leaderboard — keyword × market matrix, click row to expand SERP top-10
 *   5. SERP detail (collapsible) — top-10 with competitor URLs
 */

const MARKET_LABELS: Record<string, string> = {
  us: 'US', de: 'DE', fr: 'FR', my: 'MY', id: 'ID',
}
const MARKET_ORDER = ['us', 'de', 'fr', 'my', 'id']

interface ProductInfo {
  id:           string
  tier:         1 | 2
  site_slug:    string
  product_name: string
  category:     string | null
  relation_id:  string | null
  url:          string | null
  notes:        string | null
}

interface KeywordRow {
  id:        string
  keyword:   string
  is_main:   boolean
  position:  number
  notes:     string | null
}

interface SerpTopRow { position: number; url: string; domain: string; title: string }

interface LeaderRow {
  keyword: string
  is_main: boolean
  positions: Record<string, { position: number | null; url: string | null; snapshot_date: string | null }>
}

interface HistoryPoint { date: string; position: number | null }
interface GscPoint     { date: string; clicks: number; impressions: number; position: number | null }

interface ApiBundle {
  product:       ProductInfo
  keywords:      KeywordRow[]
  leaderboard:   LeaderRow[]
  history:       Record<string, HistoryPoint[]>  // key = `${keyword}|${market}`
  gscTimeSeries: GscPoint[]
  markets:       string[]
}

export default function PriorityProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)

  const [data,    setData]    = useState<ApiBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  // Keyword form state
  const [newKeyword, setNewKeyword] = useState('')
  const [newIsMain,  setNewIsMain]  = useState(false)
  const [adding,     setAdding]     = useState(false)

  // Selected market for the DFS chart + SERP detail
  const [selectedMarket,  setSelectedMarket]  = useState<string>('us')
  const [expandedKeyword, setExpandedKeyword] = useState<string | null>(null)
  const [serpDetail,      setSerpDetail]      = useState<{ keyword: string; market: string; top: SerpTopRow[] } | null>(null)

  async function fetchData() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/priority-products/${id}`)
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? 'Failed to load')
        return
      }
      setData(body as ApiBundle)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [id])   // eslint-disable-line react-hooks/exhaustive-deps

  async function addKeyword() {
    const kw = newKeyword.trim()
    if (!kw) return
    setAdding(true)
    try {
      const res = await fetch(`/api/priority-products/${id}/keywords`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: kw, is_main: newIsMain }),
      })
      const body = await res.json()
      if (!res.ok) { alert(`Add failed: ${body.error ?? res.status}`); return }
      setNewKeyword('')
      setNewIsMain(false)
      await fetchData()
    } finally { setAdding(false) }
  }

  async function removeKeyword(kwId: string) {
    if (!confirm('Remove this keyword? Historical SERP data is kept for reference.')) return
    const res = await fetch(`/api/priority-products/${id}/keywords/${kwId}`, { method: 'DELETE' })
    if (!res.ok) { alert('Delete failed'); return }
    await fetchData()
  }

  async function toggleMain(kwId: string, isMain: boolean) {
    const res = await fetch(`/api/priority-products/${id}/keywords/${kwId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_main: !isMain }),
    })
    if (!res.ok) { alert('Update failed'); return }
    await fetchData()
  }

  function openSerpDetail(keyword: string, market: string) {
    // Currently we don't have an inline SERP fetch endpoint — show what was
    // captured in the latest snapshot's top_10 field instead. Future
    // enhancement: live re-fetch on demand.
    const point = data?.leaderboard.find(l => l.keyword === keyword)?.positions[market]
    if (!point) return
    // Fetch latest top_10 from snapshot via a tiny call (we already have it
    // grouped in the API but didn't expose top_10 in the leaderboard). Defer
    // to backfill: clicking shows the date + our position only for now.
    setExpandedKeyword(keyword)
    setSerpDetail({ keyword, market, top: [] })   // TODO: backfill with API call when we expose top_10
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return <div className="p-8 text-sm text-gray-400">Loading detail…</div>
  }
  if (error || !data) {
    return (
      <div className="p-8 text-sm text-red-300">
        Failed to load: {error ?? 'no data'}
        <div className="mt-2">
          <Link href="/priority-products" className="text-blue-400 hover:text-blue-300">← Back to Priority Products</Link>
        </div>
      </div>
    )
  }

  const { product, keywords, leaderboard, history, gscTimeSeries } = data

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="mb-6">
        <Link href="/priority-products" className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 mb-3">
          ← Priority Products
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                product.tier === 1
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
              }`}>T{product.tier}</span>
              {product.category && (
                <span className="text-[10px] uppercase tracking-wider text-gray-500">{product.category}</span>
              )}
              <span className="text-[10px] uppercase tracking-wider text-gray-500">· {product.site_slug.toUpperCase()}</span>
            </div>
            <h1 className="text-2xl font-bold text-white">{product.product_name}</h1>
            {product.url && (
              <a href={product.url} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:text-blue-300 inline-block mt-1">
                ↗ {product.url}
              </a>
            )}
            {product.notes && <p className="text-xs text-gray-500 italic mt-1">{product.notes}</p>}
          </div>
        </div>
      </div>

      {/* ── Charts row ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <ChartPanel title="GSC — Clicks & Position (90d)" subtitle="From Google Search Console daily snapshot">
          <GscChart points={gscTimeSeries} />
        </ChartPanel>
        <ChartPanel
          title="DataForSEO SERP — Position trend"
          subtitle={`Weekly snapshot (last 12 weeks) · ${MARKET_LABELS[selectedMarket]}`}
          right={
            <select
              value={selectedMarket}
              onChange={e => setSelectedMarket(e.target.value)}
              className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-white"
            >
              {MARKET_ORDER.map(m => <option key={m} value={m}>{MARKET_LABELS[m]}</option>)}
            </select>
          }
        >
          <DfsChart history={history} keywords={keywords} market={selectedMarket} />
        </ChartPanel>
      </div>

      {/* ── Keyword management ──────────────────────────────────────────── */}
      <section className="mb-6 bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-white font-semibold mb-0.5">Tracked Keywords</h2>
            <p className="text-xs text-gray-500">Manual list. Min recommended: 1 main + 5 secondary. SERP refreshed weekly across {MARKET_ORDER.map(m => MARKET_LABELS[m]).join(', ')}.</p>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-3">
          <input
            type="text"
            value={newKeyword}
            onChange={e => setNewKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addKeyword() }}
            placeholder="Add keyword (e.g. albion online accounts)"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-600"
          />
          <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
            <input type="checkbox" checked={newIsMain} onChange={e => setNewIsMain(e.target.checked)} />
            Set as main
          </label>
          <button
            onClick={addKeyword}
            disabled={adding || !newKeyword.trim()}
            className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm rounded-lg"
          >
            + Add
          </button>
        </div>

        {keywords.length === 0 ? (
          <p className="text-xs text-gray-500 italic">No keywords yet. Add the main keyword first, then 5-10 secondary.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {keywords.map(kw => (
              <div key={kw.id} className={`inline-flex items-center gap-2 px-2 py-1 rounded border text-xs ${
                kw.is_main ? 'bg-amber-500/10 border-amber-500/30 text-amber-200' : 'bg-gray-800 border-gray-700 text-gray-200'
              }`}>
                {kw.is_main && <span className="text-amber-400">★</span>}
                <span className="font-medium">{kw.keyword}</span>
                <button
                  onClick={() => toggleMain(kw.id, kw.is_main)}
                  className="text-gray-500 hover:text-amber-300 text-[10px]"
                  title={kw.is_main ? 'Demote from main' : 'Promote to main'}
                >
                  {kw.is_main ? 'demote' : 'main?'}
                </button>
                <button onClick={() => removeKeyword(kw.id)} className="text-gray-500 hover:text-red-400 text-[10px]">×</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Leaderboard ─────────────────────────────────────────────────── */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-white font-semibold">Keyword × Market Leaderboard</h2>
          <p className="text-xs text-gray-500 mt-0.5">Latest SERP positions. Click a row to see SERP detail. <code className="bg-gray-800 px-1 rounded">—</code> = not in top 50.</p>
        </div>
        {leaderboard.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No keyword data yet. Add keywords above, then wait for the next weekly SERP run (or trigger manually).</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-800/40 text-gray-400 text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left  px-3 py-2">Keyword</th>
                {MARKET_ORDER.map(m => (
                  <th key={m} className="text-center px-3 py-2 w-14">{MARKET_LABELS[m]}</th>
                ))}
                <th className="text-right px-3 py-2 w-24">Detail</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map(row => (
                <tr key={row.keyword} className="border-t border-gray-800 hover:bg-gray-800/30">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      {row.is_main && <span className="text-amber-400 text-[10px]">★</span>}
                      <span className="text-white font-medium">{row.keyword}</span>
                    </div>
                  </td>
                  {MARKET_ORDER.map(m => {
                    const p = row.positions[m]
                    return (
                      <td key={m} className="text-center px-3 py-2.5">
                        <PositionCell position={p?.position ?? null} />
                      </td>
                    )
                  })}
                  <td className="text-right px-3 py-2.5">
                    <button
                      onClick={() => openSerpDetail(row.keyword, selectedMarket)}
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      View SERP ↗
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* SERP detail panel (placeholder — wired when API surfaces top_10) */}
      {expandedKeyword && (
        <SerpDetailPanel
          keyword={expandedKeyword}
          market={selectedMarket}
          top={serpDetail?.top ?? []}
          productId={id}
          onClose={() => { setExpandedKeyword(null); setSerpDetail(null) }}
        />
      )}
    </div>
  )
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function ChartPanel({ title, subtitle, right, children }: { title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {subtitle && <p className="text-[10px] text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

function PositionCell({ position }: { position: number | null }) {
  if (position == null) return <span className="text-gray-600 text-xs">—</span>
  const cls =
    position <= 3  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' :
    position <= 10 ? 'bg-blue-500/15    text-blue-300    border-blue-500/30'    :
    position <= 20 ? 'bg-amber-500/15   text-amber-300   border-amber-500/30'   :
                      'bg-gray-700/40    text-gray-400    border-gray-600/30'
  return (
    <span className={`inline-flex items-center justify-center min-w-[28px] px-1.5 py-0.5 rounded border text-xs font-medium ${cls}`}>
      #{position}
    </span>
  )
}

function GscChart({ points }: { points: GscPoint[] }) {
  if (points.length === 0) return <p className="text-xs text-gray-500 py-8 text-center">No GSC data for this URL yet.</p>

  const w = 600, h = 180
  const padding = 32
  const maxClicks = Math.max(1, ...points.map(p => p.clicks))
  const positions = points.map(p => p.position ?? 100).filter(p => p > 0)
  const maxPos = positions.length ? Math.max(...positions) : 100

  // Clicks bars
  const barW = (w - padding * 2) / Math.max(points.length, 1)
  const clickBars = points.map((p, i) => {
    const bh = (p.clicks / maxClicks) * (h - padding * 2)
    return { x: padding + i * barW, y: h - padding - bh, w: Math.max(1, barW - 1), h: bh }
  })

  // Position line (inverted — pos 1 is at top)
  const posPoints = points.map((p, i) => {
    const x = padding + i * barW + barW / 2
    const yNorm = p.position == null ? null : 1 - (1 / Math.min(p.position, maxPos))   // pos 1 → top
    const y = yNorm == null ? null : padding + yNorm * (h - padding * 2)
    return { x, y, position: p.position }
  })
  const linePath = posPoints
    .filter(p => p.y != null)
    .map((p, idx, arr) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y!.toFixed(1)}`)
    .join(' ')

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {/* Clicks bars */}
      {clickBars.map((b, i) => <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill="rgba(59, 130, 246, 0.4)" />)}
      {/* Position line */}
      {linePath && <path d={linePath} fill="none" stroke="#f59e0b" strokeWidth="1.5" />}
      {/* Legend */}
      <g transform={`translate(${padding}, 12)`}>
        <rect x={0}  y={0} width={10} height={6} fill="rgba(59, 130, 246, 0.4)" />
        <text x={14} y={6} fontSize="9" fill="#9ca3af">clicks</text>
        <line x1={50} y1={3} x2={62} y2={3} stroke="#f59e0b" strokeWidth="1.5" />
        <text x={66} y={6} fontSize="9" fill="#9ca3af">avg position</text>
      </g>
    </svg>
  )
}

function DfsChart({ history, keywords, market }: { history: Record<string, HistoryPoint[]>; keywords: KeywordRow[]; market: string }) {
  // Filter to the chosen market. One line per keyword (main + secondary).
  const series = useMemo(() => {
    return keywords.map(kw => ({
      keyword:  kw.keyword,
      is_main:  kw.is_main,
      points:   history[`${kw.keyword}|${market}`] ?? [],
    })).filter(s => s.points.length > 0)
  }, [history, keywords, market])

  if (series.length === 0) {
    return <p className="text-xs text-gray-500 py-8 text-center">No SERP snapshots yet. Run the weekly cron to populate.</p>
  }

  const w = 600, h = 180, padding = 32
  // Y axis: position 1 at top, position 30 at bottom (anything beyond → off-chart)
  const yMax = 30
  const allDates = Array.from(new Set(series.flatMap(s => s.points.map(p => p.date)))).sort()
  const xStep = (w - padding * 2) / Math.max(allDates.length - 1, 1)
  const xOf = (date: string) => padding + allDates.indexOf(date) * xStep
  const yOf = (pos: number | null) => {
    if (pos == null || pos > yMax) return h - padding
    return padding + ((pos - 1) / (yMax - 1)) * (h - padding * 2)
  }

  // Color palette
  const palette = ['#f59e0b', '#3b82f6', '#ec4899', '#10b981', '#a855f7', '#06b6d4', '#eab308', '#f87171']

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {/* Gridlines */}
      {[1, 5, 10, 20, 30].map(p => {
        const y = yOf(p)
        return (
          <g key={p}>
            <line x1={padding} y1={y} x2={w - padding} y2={y} stroke="rgba(255,255,255,0.05)" strokeDasharray="2 3" />
            <text x={4} y={y + 3} fontSize="8" fill="#6b7280">#{p}</text>
          </g>
        )
      })}
      {/* Lines */}
      {series.map((s, idx) => {
        const color = s.is_main ? '#f59e0b' : palette[(idx + 1) % palette.length]
        const path = s.points
          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(p.date).toFixed(1)} ${yOf(p.position).toFixed(1)}`)
          .join(' ')
        return <path key={s.keyword} d={path} fill="none" stroke={color} strokeWidth={s.is_main ? 2 : 1.25} opacity={s.is_main ? 1 : 0.8} />
      })}
      {/* Legend */}
      <g transform={`translate(${padding}, 12)`}>
        {series.slice(0, 4).map((s, idx) => {
          const color = s.is_main ? '#f59e0b' : palette[(idx + 1) % palette.length]
          return (
            <g key={s.keyword} transform={`translate(${idx * 120}, 0)`}>
              <line x1={0} y1={3} x2={10} y2={3} stroke={color} strokeWidth={s.is_main ? 2 : 1.25} />
              <text x={14} y={6} fontSize="9" fill="#9ca3af">{s.keyword.length > 16 ? s.keyword.slice(0, 16) + '…' : s.keyword}</text>
            </g>
          )
        })}
        {series.length > 4 && <text x={480} y={6} fontSize="9" fill="#6b7280">+{series.length - 4} more</text>}
      </g>
    </svg>
  )
}

function SerpDetailPanel({ keyword, market, top, productId, onClose }: {
  keyword:   string
  market:    string
  top:       SerpTopRow[]
  productId: string
  onClose:   () => void
}) {
  // top_10 isn't surfaced through the main API yet — show a note instead of
  // a broken empty list. Future: add /api/priority-products/[id]/serp?kw=...&market=...
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h3 className="text-white font-semibold">SERP — {keyword}</h3>
            <p className="text-xs text-gray-500 mt-0.5">{MARKET_LABELS[market]} · Top 10 competitor list</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">✕</button>
        </div>
        <div className="p-5">
          {top.length === 0 ? (
            <p className="text-xs text-gray-500 italic">
              Top-10 SERP data is captured weekly into <code className="bg-gray-800 px-1 rounded">tier_serp_snapshots.top_10</code> but not yet exposed via the detail API.
              Next iteration: surface competitor URLs here so you can see who&apos;s outranking us.
            </p>
          ) : (
            <ol className="space-y-2">
              {top.map(r => (
                <li key={r.position} className="bg-gray-800 rounded-lg p-2 flex items-start gap-3 text-xs">
                  <span className="text-amber-300 font-bold w-6 text-right">#{r.position}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium truncate">{r.title}</p>
                    <p className="text-gray-500 truncate">{r.domain}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
  void productId   // silence unused — wired in future iteration
}
