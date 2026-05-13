'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { SERP_COUNTRIES } from '@/lib/country-config'
import { LottieLoader } from '@/components/ui/LottieLoader'
import { IntentBadge, type Intent } from '@/components/ui/IntentBadge'
import LokiFindingsPanel from '@/components/agents/LokiFindingsPanel'
import ClusterChip from '@/components/clusters/ClusterChip'

// ── Constants ─────────────────────────────────────────────────────────────────
const COMP_COLORS = ['#ef4444', '#a855f7', '#06b6d4', '#ec4899']

// ── Types ─────────────────────────────────────────────────────────────────────
interface Competitor     { id: string; domain: string; name: string; active: boolean }
interface TrackedProduct { id: string; name: string; page_url: string; keywords: string[] }

interface CompetitorPos { domain: string; position: number | null; url: string | null }

interface GapRow {
  keyword: string
  searchVolume: number
  cpc: number
  g2g_position: number | null
  g2g_url: string | null
  competitors: CompetitorPos[]
  best_competitor_position: number | null
  position_diff: number | null
}

interface VennData {
  domain: string
  g2g_only: number
  comp_only: number
  shared: number
  overlap_pct?: number
}

interface PosDist { top3: number; pos4_10: number; pos11_20: number; pos21_30: number }

interface GapResult {
  competitor_domains: string[]
  competitor_domain: string
  g2g_domain: string
  excluded_count: number
  summary: {
    g2g_total: number
    competitor_totals?: Record<string, number>
    competitor_total?: number
    gaps: number
    behind: number
    winning: number
  }
  venn: VennData[]
  position_distribution: { g2g: PosDist; competitors: Record<string, PosDist> } | null
  gaps: GapRow[]
  behind: GapRow[]
  winning: GapRow[]
  pipeline_push?: {
    enabled:           boolean
    threshold_sv:      number
    pushed_count:      number
    skipped_existing:  number
  }
}

interface Exclusion { id: string; pattern: string; match_type: string; source: string; source_domain: string | null }

interface Snapshot {
  id: string
  competitor_domain: string
  location_code: number | null
  language_code: string | null
  summary: Record<string, unknown>
  excluded_count: number
  created_at: string
}

type Tab     = 'gaps' | 'behind' | 'winning'
type SortKey = 'keyword' | 'searchVolume' | 'g2g_position' | 'best_competitor_position' | 'position_diff'

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizeRows(rows: any[], fallbackDomain: string): GapRow[] {
  return (rows ?? []).map(r => {
    if (Array.isArray(r.competitors)) return r as GapRow
    return {
      ...r,
      competitors: [{ domain: fallbackDomain, position: r.competitor_position ?? null, url: r.competitor_url ?? null }],
      best_competitor_position: r.competitor_position ?? null,
    }
  })
}

function positionBadge(pos: number | null) {
  if (pos === null) return <span className="text-gray-600 text-xs">—</span>
  const color = pos <= 3 ? 'text-green-400' : pos <= 10 ? 'text-yellow-400' : pos <= 20 ? 'text-orange-400' : 'text-gray-400'
  return <span className={`text-xs font-semibold ${color}`}>#{pos}</span>
}

function suggestClusterName(keywords: string[]): string {
  if (keywords.length === 0) return ''
  const stop = new Set(['the','a','an','and','or','for','of','in','on','to','buy','sell','cheap','free','best','top','how','get'])
  const freq = new Map<string, number>()
  for (const kw of keywords) {
    for (const w of kw.split(' ')) {
      const lw = w.toLowerCase()
      if (lw.length > 2 && !stop.has(lw)) freq.set(lw, (freq.get(lw) ?? 0) + 1)
    }
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w)
  return top.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// ── Venn Diagram ──────────────────────────────────────────────────────────────
function VennDiagram({ venn }: { venn: VennData[] }) {
  if (!venn || venn.length === 0) return null

  if (venn.length === 1) {
    const { domain, g2g_only, comp_only, shared } = venn[0]
    const total = g2g_only + comp_only + shared
    const overlapPct = total > 0 ? Math.round(shared / total * 100) : 0
    const compColor = COMP_COLORS[0]

    const W = 280, H = 130
    const r = 55, cy = 62
    const spread = r * 1.05
    const cx1 = W / 2 - spread / 2
    const cx2 = W / 2 + spread / 2

    return (
      <div className="flex flex-col items-center">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 130 }}>
          <circle cx={cx1} cy={cy} r={r} fill="#3b82f6" fillOpacity={0.2} stroke="#3b82f6" strokeWidth={1.5} />
          <circle cx={cx2} cy={cy} r={r} fill={compColor} fillOpacity={0.2} stroke={compColor} strokeWidth={1.5} />
          {/* Counts */}
          <text x={cx1 - spread * 0.28} y={cy + 2} textAnchor="middle"
            style={{ fontSize: 17, fill: 'white', fontWeight: 'bold' }}>{g2g_only}</text>
          <text x={W / 2} y={cy + 2} textAnchor="middle"
            style={{ fontSize: 14, fill: 'white', fontWeight: 'bold' }}>{shared}</text>
          <text x={cx2 + spread * 0.28} y={cy + 2} textAnchor="middle"
            style={{ fontSize: 17, fill: 'white', fontWeight: 'bold' }}>{comp_only}</text>
          {/* Sub-labels */}
          <text x={cx1 - spread * 0.28} y={cy + 15} textAnchor="middle"
            style={{ fontSize: 8, fill: '#93c5fd' }}>G2G only</text>
          <text x={W / 2} y={cy + 15} textAnchor="middle"
            style={{ fontSize: 8, fill: '#c4b5fd' }}>shared</text>
          <text x={cx2 + spread * 0.28} y={cy + 15} textAnchor="middle"
            style={{ fontSize: 8, fill: compColor }}>{domain.split('.')[0]} only</text>
          {/* Domain labels */}
          <text x={cx1} y={14} textAnchor="middle" style={{ fontSize: 10, fill: '#60a5fa', fontWeight: 600 }}>G2G</text>
          <text x={cx2} y={14} textAnchor="middle" style={{ fontSize: 10, fill: compColor, fontWeight: 600 }}>{domain}</text>
        </svg>
        <p className="text-xs text-gray-500 mt-1">
          <span className="text-purple-400 font-semibold">{overlapPct}% overlap</span>
          {' · '}{total.toLocaleString()} total top-30 keywords across both domains
        </p>
      </div>
    )
  }

  // Multi-competitor: stacked-bar layout
  return (
    <div className="space-y-3">
      {venn.map(({ domain, g2g_only, comp_only, shared }, i) => {
        const total = g2g_only + comp_only + shared
        const sharedPct = total > 0 ? Math.round(shared / total * 100) : 0
        const color = COMP_COLORS[i % COMP_COLORS.length]
        return (
          <div key={domain}>
            <div className="flex justify-between items-baseline mb-1">
              <span className="text-xs text-gray-300 font-medium">G2G vs {domain}</span>
              <span className="text-xs text-purple-400 font-semibold">{sharedPct}% overlap · {shared.toLocaleString()} shared</span>
            </div>
            <div className="flex h-5 rounded overflow-hidden text-[9px]">
              <div style={{ width: `${total > 0 ? g2g_only / total * 100 : 0}%`, background: '#3b82f6', opacity: 0.85 }}
                className="flex items-center justify-center text-white overflow-hidden whitespace-nowrap px-1 min-w-0">
                {g2g_only > 0 && `G2G ${g2g_only.toLocaleString()}`}
              </div>
              <div style={{ width: `${total > 0 ? shared / total * 100 : 0}%`, background: '#a855f7', opacity: 0.85 }}
                className="flex items-center justify-center text-white overflow-hidden whitespace-nowrap px-1 min-w-0">
                {shared > 0 && shared.toLocaleString()}
              </div>
              <div style={{ width: `${total > 0 ? comp_only / total * 100 : 0}%`, background: color, opacity: 0.85 }}
                className="flex items-center justify-center text-white overflow-hidden whitespace-nowrap px-1 min-w-0">
                {comp_only > 0 && comp_only.toLocaleString()}
              </div>
            </div>
          </div>
        )
      })}
      <div className="flex gap-4 text-[10px] text-gray-500 mt-1 flex-wrap">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-500 inline-block" />G2G only</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-purple-500 inline-block" />Shared</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500 inline-block" />Competitor only</span>
      </div>
    </div>
  )
}

// ── Position Distribution Chart ───────────────────────────────────────────────
function PositionDistChart({ posDist, competitorDomains }: {
  posDist: { g2g: PosDist; competitors: Record<string, PosDist> }
  competitorDomains: string[]
}) {
  const buckets: { key: keyof PosDist; label: string }[] = [
    { key: 'top3',     label: 'Top 3'  },
    { key: 'pos4_10',  label: '4–10'   },
    { key: 'pos11_20', label: '11–20'  },
    { key: 'pos21_30', label: '21–30'  },
  ]
  const domains = ['g2g.com', ...competitorDomains]
  const allVals = domains.flatMap(d =>
    buckets.map(b => d === 'g2g.com' ? posDist.g2g[b.key] : (posDist.competitors[d]?.[b.key] ?? 0))
  )
  const maxVal = Math.max(...allVals, 1)

  const CHART_H = 80
  const BAR_W   = 14
  const BAR_GAP = 1
  const GROUP_PAD = 10
  const GROUP_W = domains.length * (BAR_W + BAR_GAP) + GROUP_PAD
  const W = buckets.length * GROUP_W + 16
  const H = CHART_H + 30

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 120 }}>
        {buckets.map((bucket, bi) => {
          const gx = 8 + bi * GROUP_W
          return (
            <g key={bucket.key}>
              <text
                x={gx + (domains.length * (BAR_W + BAR_GAP)) / 2 - BAR_GAP / 2}
                y={H - 5} textAnchor="middle"
                style={{ fontSize: 7, fill: '#6b7280' }}
              >{bucket.label}</text>
              {domains.map((domain, di) => {
                const val = domain === 'g2g.com'
                  ? posDist.g2g[bucket.key]
                  : (posDist.competitors[domain]?.[bucket.key] ?? 0)
                const barH = (val / maxVal) * CHART_H
                const x   = gx + di * (BAR_W + BAR_GAP)
                const y   = CHART_H - barH + 5
                const fill = domain === 'g2g.com' ? '#3b82f6' : COMP_COLORS[(di - 1) % COMP_COLORS.length]
                return (
                  <g key={domain}>
                    <rect x={x} y={y} width={BAR_W} height={Math.max(barH, 0)} fill={fill} fillOpacity={0.85} rx={2} />
                    {val > 0 && barH > 12 && (
                      <text x={x + BAR_W / 2} y={y - 2} textAnchor="middle"
                        style={{ fontSize: 7, fill: '#e5e7eb' }}>{val}</text>
                    )}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
      <div className="flex gap-3 flex-wrap mt-1">
        {domains.map((d, i) => (
          <span key={d} className="flex items-center gap-1 text-[10px] text-gray-400">
            <span className="w-2 h-2 rounded-sm inline-block"
              style={{ background: d === 'g2g.com' ? '#3b82f6' : COMP_COLORS[i - 1] }} />
            {d === 'g2g.com' ? 'G2G' : d}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Optimize Page Modal ───────────────────────────────────────────────────────
function OptimizeModal({ selected, trackedProducts, competitorDomain, onClose, onSuccess }: {
  selected: GapRow[]
  trackedProducts: TrackedProduct[]
  competitorDomain: string
  onClose: () => void
  onSuccess: (msg: string) => void
}) {
  const [urlMode, setUrlMode]   = useState<'product' | 'custom'>(trackedProducts.length > 0 ? 'product' : 'custom')
  const [productId, setProduct] = useState(trackedProducts[0]?.id ?? '')
  const [customUrl, setCustom]  = useState('')
  const [notes, setNotes]       = useState(() => {
    const kws = selected.map(r => r.keyword).join(', ')
    return `Keyword gap opportunity vs ${competitorDomain}.\n\nTarget keywords to improve: ${kws}`
  })
  const [saving, setSaving]     = useState(false)
  const [err, setErr]           = useState<string | null>(null)

  const targetUrl = urlMode === 'product'
    ? trackedProducts.find(p => p.id === productId)?.page_url ?? ''
    : customUrl.trim()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!targetUrl) { setErr('Please select or enter a target URL.'); return }
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: targetUrl, action_type: 'on_page', notes }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onSuccess(`✅ Action item created for ${selected.length} keyword${selected.length !== 1 ? 's' : ''}`)
      onClose()
    } catch (e) { setErr(String(e)) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
        <h2 className="text-white font-bold text-lg mb-1">📝 Optimize Existing Page</h2>
        <p className="text-gray-400 text-sm mb-5">
          Create an action item to optimize a G2G page for{' '}
          <span className="text-white font-medium">{selected.length} selected keyword{selected.length !== 1 ? 's' : ''}</span>.
        </p>
        <div className="flex flex-wrap gap-1.5 mb-4 max-h-20 overflow-y-auto">
          {selected.slice(0, 20).map(r => (
            <span key={r.keyword} className="text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded-full">
              {r.keyword}
              {r.searchVolume > 0 && <span className="ml-1 text-gray-500">{(r.searchVolume / 1000).toFixed(0)}K</span>}
            </span>
          ))}
          {selected.length > 20 && <span className="text-xs text-gray-500">+{selected.length - 20} more</span>}
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-2">Target G2G page</label>
            <div className="flex rounded-lg overflow-hidden border border-gray-700 mb-3">
              {trackedProducts.length > 0 && (
                <button type="button" onClick={() => setUrlMode('product')}
                  className={`text-xs px-3 py-2 flex-1 transition ${urlMode === 'product' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
                  From tracked products
                </button>
              )}
              <button type="button" onClick={() => setUrlMode('custom')}
                className={`text-xs px-3 py-2 flex-1 transition ${urlMode === 'custom' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
                Custom URL
              </button>
            </div>
            {urlMode === 'product' ? (
              <select value={productId} onChange={e => setProduct(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
                {trackedProducts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : (
              <input value={customUrl} onChange={e => setCustom(e.target.value)}
                placeholder="https://www.g2g.com/categories/…"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500" />
            )}
            {targetUrl && <p className="text-xs text-blue-400 mt-1 truncate">{targetUrl}</p>}
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Action notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-red-500" />
          </div>
          {err && <p className="text-red-400 text-xs">{err}</p>}
          <div className="flex gap-3 pt-1">
            <button type="submit" disabled={saving || !targetUrl}
              className="flex-1 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-lg transition">
              {saving ? 'Creating…' : 'Create action item →'}
            </button>
            <button type="button" onClick={onClose}
              className="px-4 py-2.5 rounded-lg border border-gray-700 text-gray-400 text-sm hover:border-gray-500 transition">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── New Page Opportunity Modal ────────────────────────────────────────────────
function NewPageModal({ selected, competitorDomain, onClose, onSuccess }: {
  selected: GapRow[]
  competitorDomain: string
  onClose: () => void
  onSuccess: (msg: string) => void
}) {
  const [clusterName, setCluster] = useState(() => suggestClusterName(selected.map(r => r.keyword)))
  const [gameCategory, setGame]   = useState('')
  const [notes, setNotes]         = useState('')
  const [saving, setSaving]       = useState(false)
  const [err, setErr]             = useState<string | null>(null)

  const totalVolume = selected.reduce((s, r) => s + (r.searchVolume ?? 0), 0)
  const avgVolume   = selected.length > 0 ? Math.round(totalVolume / selected.length) : 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!clusterName.trim()) { setErr('Cluster name is required.'); return }
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/competitive/opportunities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster_name:      clusterName.trim(),
          game_category:     gameCategory.trim() || null,
          keywords:          selected.map(r => r.keyword),
          avg_volume:        avgVolume,
          total_volume:      totalVolume,
          competitor_domain: competitorDomain,
          notes:             notes.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onSuccess(`✅ "${clusterName}" saved as a new page opportunity`)
      onClose()
    } catch (e) { setErr(String(e)) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
        <h2 className="text-white font-bold text-lg mb-1">🆕 New Page Opportunity</h2>
        <p className="text-gray-400 text-sm mb-5">
          G2G doesn't rank for these keywords — flag as a potential new product/category page.
        </p>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-gray-800 rounded-lg p-3 text-center">
            <p className="text-white font-bold text-lg">{selected.length}</p>
            <p className="text-gray-500 text-xs">Keywords</p>
          </div>
          <div className="bg-gray-800 rounded-lg p-3 text-center">
            <p className="text-white font-bold text-lg">{totalVolume > 0 ? `${(totalVolume / 1000).toFixed(0)}K` : '—'}</p>
            <p className="text-gray-500 text-xs">Total vol/mo</p>
          </div>
          <div className="bg-gray-800 rounded-lg p-3 text-center">
            <p className="text-white font-bold text-lg">{avgVolume > 0 ? `${(avgVolume / 1000).toFixed(0)}K` : '—'}</p>
            <p className="text-gray-500 text-xs">Avg vol/mo</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 mb-4 max-h-20 overflow-y-auto">
          {selected.slice(0, 20).map(r => (
            <span key={r.keyword} className="text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded-full">{r.keyword}</span>
          ))}
          {selected.length > 20 && <span className="text-xs text-gray-500">+{selected.length - 20} more</span>}
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Cluster name <span className="text-red-500">*</span></label>
              <input value={clusterName} onChange={e => setCluster(e.target.value)}
                placeholder="e.g. Monopoly Go Dice Links"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Game / category</label>
              <input value={gameCategory} onChange={e => setGame(e.target.value)}
                placeholder="e.g. Monopoly Go"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Notes <span className="text-gray-600">(optional)</span></label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
              placeholder={`e.g. ${competitorDomain} ranks for these, suggests strong demand.`}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-red-500" />
          </div>
          {err && <p className="text-red-400 text-xs">{err}</p>}
          <div className="flex gap-3 pt-1">
            <button type="submit" disabled={saving || !clusterName.trim()}
              className="flex-1 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-lg transition">
              {saving ? 'Saving…' : 'Save opportunity →'}
            </button>
            <button type="button" onClick={onClose}
              className="px-4 py-2.5 rounded-lg border border-gray-700 text-gray-400 text-sm hover:border-gray-500 transition">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Gap Table ─────────────────────────────────────────────────────────────────
function GapTable({ rows, tab, competitorDomains, selected, onToggle, onToggleAll, intents, intentsLoading }: {
  rows: GapRow[]
  tab: Tab
  competitorDomains: string[]
  selected: Set<string>
  onToggle: (kw: string) => void
  onToggleAll: (kwList: string[], checked: boolean) => void
  intents: Record<string, Intent>
  intentsLoading: boolean
}) {
  const [search, setSearch]       = useState('')
  const [sortKey, setSortKey]     = useState<SortKey>('searchVolume')
  const [sortDir, setSortDir]     = useState<'asc' | 'desc'>('desc')
  const [minVol, setMinVol]       = useState('')
  const [missingOnly, setMissing] = useState(false)
  const [page, setPage]           = useState(1)
  const PAGE_SIZE = 50

  const filtered = useMemo(() => {
    let list = rows
    if (search.trim()) list = list.filter(r => r.keyword.includes(search.trim().toLowerCase()))
    if (minVol && parseInt(minVol) > 0) list = list.filter(r => r.searchVolume >= parseInt(minVol))
    if (missingOnly) list = list.filter(r => r.g2g_url === null)
    return [...list].sort((a, b) => {
      let va: number | string, vb: number | string
      switch (sortKey) {
        case 'keyword':                  va = a.keyword;                               vb = b.keyword;                               break
        case 'searchVolume':             va = a.searchVolume;                          vb = b.searchVolume;                          break
        case 'g2g_position':             va = a.g2g_position ?? 999;                  vb = b.g2g_position ?? 999;                   break
        case 'best_competitor_position': va = a.best_competitor_position ?? 999;       vb = b.best_competitor_position ?? 999;       break
        case 'position_diff':            va = a.position_diff ?? 999;                  vb = b.position_diff ?? 999;                  break
        default:                         va = 0; vb = 0
      }
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb as string) : (vb as string).localeCompare(va)
      return sortDir === 'asc' ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
  }, [rows, search, minVol, missingOnly, sortKey, sortDir])

  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const paginated   = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const pageKws     = paginated.map(r => r.keyword)
  const allPageSel  = pageKws.length > 0 && pageKws.every(kw => selected.has(kw))
  const missingCount = rows.filter(r => r.g2g_url === null).length

  function th(key: SortKey, label: string, align: 'left' | 'right' = 'right') {
    const active = sortKey === key
    return (
      <th
        onClick={() => {
          if (active) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
          else { setSortKey(key); setSortDir(key === 'keyword' ? 'asc' : 'desc') }
          setPage(1)
        }}
        className={`py-3 px-3 text-xs font-medium cursor-pointer select-none hover:text-white transition ${align === 'left' ? 'text-left' : 'text-right'} ${active ? 'text-white' : 'text-gray-500'}`}
      >
        {label} {active ? (sortDir === 'asc' ? '↑' : '↓') : <span className="text-gray-700">↕</span>}
      </th>
    )
  }

  const showMulti = competitorDomains.length > 1

  return (
    <div>
      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <input
          value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
          placeholder="Search keyword…"
          className="flex-1 min-w-[180px] max-w-xs bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">Min volume:</label>
          <input value={minVol} onChange={e => { setMinVol(e.target.value); setPage(1) }}
            placeholder="500"
            className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500" />
        </div>
        {tab === 'gaps' && missingCount > 0 && (
          <button
            onClick={() => { setMissing(m => !m); setPage(1) }}
            className={`text-xs px-3 py-2 rounded-lg border transition flex items-center gap-1.5 ${
              missingOnly
                ? 'bg-orange-500/20 border-orange-500/40 text-orange-300'
                : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
            }`}
          >
            🆕 Missing pages only <span className="font-semibold">{missingCount}</span>
          </button>
        )}
        <span className="text-xs text-gray-500 ml-auto">{filtered.length} keywords</span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">No keywords match your filters.</p>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-800">
              <tr>
                <th className="py-3 px-3 w-10">
                  <input type="checkbox" checked={allPageSel}
                    onChange={() => onToggleAll(pageKws, !allPageSel)}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-red-500 cursor-pointer" />
                </th>
                {th('keyword', 'Keyword', 'left')}
                {th('searchVolume', 'Volume')}
                <th className="py-3 px-3 text-right text-xs font-medium text-gray-500">CPC</th>
                {th('g2g_position', 'G2G')}
                {/* Competitor columns */}
                {showMulti
                  ? competitorDomains.map((d, i) => (
                      <th key={d} className="py-3 px-3 text-right text-xs font-medium"
                        style={{ color: COMP_COLORS[i % COMP_COLORS.length] }}>
                        {d.replace(/\.[^.]+$/, '')}
                      </th>
                    ))
                  : th('best_competitor_position', competitorDomains[0] ?? 'Competitor')
                }
                {tab !== 'winning' && (
                  showMulti
                    ? <th className="py-3 px-3 text-right text-xs font-medium text-gray-500">Best gap</th>
                    : th('position_diff', 'Gap')
                )}
                <th className="py-3 px-3 text-right text-xs font-medium text-gray-500">G2G URL</th>
                <th className="py-3 px-3 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {paginated.map((r, i) => {
                const isSel     = selected.has(r.keyword)
                const isMissing = r.g2g_url === null
                return (
                  <tr key={i}
                    onClick={() => onToggle(r.keyword)}
                    className={`border-t border-gray-800 cursor-pointer transition ${isSel ? 'bg-red-500/10' : 'hover:bg-gray-800/40'}`}
                  >
                    <td className="py-2.5 px-3" onClick={e => { e.stopPropagation(); onToggle(r.keyword) }}>
                      <input type="checkbox" checked={isSel} onChange={() => {}}
                        className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-red-500 cursor-pointer" />
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <IntentBadge intent={intents[r.keyword]} loading={intentsLoading && !intents[r.keyword]} />
                        <span className="text-white text-xs font-medium">{r.keyword}</span>
                        {isMissing && tab === 'gaps' && (
                          <span className="text-[10px] bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded-full">no page</span>
                        )}
                        <ClusterChip keyword={r.keyword} compact />
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right text-gray-300 text-xs">
                      {r.searchVolume > 0 ? r.searchVolume.toLocaleString() : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right text-gray-500 text-xs">
                      {r.cpc > 0 ? `$${r.cpc.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right">{positionBadge(r.g2g_position)}</td>
                    {/* Competitor position column(s) */}
                    {showMulti
                      ? competitorDomains.map(d => (
                          <td key={d} className="py-2.5 px-3 text-right">
                            {positionBadge(r.competitors.find(c => c.domain === d)?.position ?? null)}
                          </td>
                        ))
                      : <td className="py-2.5 px-3 text-right">{positionBadge(r.best_competitor_position)}</td>
                    }
                    {tab !== 'winning' && (
                      <td className="py-2.5 px-3 text-right">
                        {r.position_diff !== null
                          ? <span className="text-red-400 text-xs font-semibold">+{r.position_diff}</span>
                          : <span className="text-orange-400 text-xs">not ranking</span>}
                      </td>
                    )}
                    <td className="py-2.5 px-3 text-right">
                      {r.g2g_url ? (
                        <a href={r.g2g_url} target="_blank" rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-blue-400 hover:text-blue-300 text-xs truncate max-w-[140px] inline-block" title={r.g2g_url}>
                          {(() => { try { return new URL(r.g2g_url).pathname } catch { return r.g2g_url } })()}
                        </a>
                      ) : <span className="text-gray-700 text-xs">—</span>}
                    </td>
                    <td className="py-2.5 px-3">
                      <a
                        href={`/content/keyword-map?add=${encodeURIComponent(r.keyword)}${r.searchVolume > 0 ? `&volume=${r.searchVolume}` : ''}`}
                        onClick={e => e.stopPropagation()}
                        className="text-gray-600 hover:text-blue-400 transition text-sm"
                        title="Add to Keyword Map"
                      >🗺️</a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-between">
              <span className="text-xs text-gray-500">Page {page} of {totalPages} · {filtered.length} results</span>
              <div className="flex gap-1">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="text-xs px-3 py-1 rounded text-gray-400 hover:text-white disabled:opacity-30 transition">‹ Prev</button>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="text-xs px-3 py-1 rounded text-gray-400 hover:text-white disabled:opacity-30 transition">Next ›</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function KeywordGapPage() {
  const searchParams = useSearchParams()
  const [competitors, setCompetitors]             = useState<Competitor[]>([])
  const [trackedProducts, setTrackedProducts]     = useState<TrackedProduct[]>([])
  const [selectedDomains, setSelectedDomains]     = useState<string[]>([])   // multi-select for competitors

  // Manual "Send to Pipeline" — uses existing `selected` set; pushes gap rows
  // into pipeline manually, overriding the SV threshold gate (so user can opt
  // in low-SV but strategically interesting gaps).
  const [sendingToPipeline, setSendingToPipeline] = useState(false)
  const [sendResult, setSendResult]               = useState<{ pushed: number; skipped: number } | null>(null)
  const [database, setDatabase]                   = useState('us')
  const [limit, setLimit]                         = useState('10')
  // Exclusions
  const [exclusions, setExclusions]               = useState<Exclusion[]>([])
  const [showExclusions, setShowExclusions]       = useState(false)
  const [newPattern, setNewPattern]               = useState('')
  const [savingExcl, setSavingExcl]               = useState(false)
  const [exclMsg, setExclMsg]                     = useState<string | null>(null)
  // Core state
  const [loading, setLoading]                     = useState(false)
  const [loadingMeta, setLoadingMeta]             = useState(true)
  const [result, setResult]                       = useState<GapResult | null>(null)
  const [error, setError]                         = useState<string | null>(null)
  const [activeTab, setActiveTab]                 = useState<Tab>('gaps')
  const [successMsg, setSuccessMsg]               = useState<string | null>(null)
  const [intents, setIntents]                     = useState<Record<string, Intent>>({})
  const [intentsLoading, setIntentsLoading]       = useState(false)
  // Snapshot library
  const [snapshots, setSnapshots]                 = useState<Snapshot[]>([])
  const [showLibrary, setShowLibrary]             = useState(false)
  const [loadingSnapshot, setLoadingSnapshot]     = useState(false)
  const [currentSnapshotId, setCurrentSnapshotId] = useState<string | null>(null)
  const snapshotCache = useRef<Map<string, GapResult>>(new Map())
  // Selection state
  const [selected, setSelected]                   = useState<Set<string>>(new Set())
  // Modal state
  const [showOptimize, setShowOptimize]           = useState(false)
  const [showNewPage, setShowNewPage]             = useState(false)

  useEffect(() => {
    async function fetchMeta() {
      try {
        const [compRes, prodRes, exclRes, snapRes] = await Promise.all([
          fetch('/api/competitors'),
          fetch('/api/products'),
          fetch('/api/keyword-exclusions'),
          fetch('/api/competitive/keyword-gap/snapshots'),
        ])
        if (compRes.ok) {
          const { competitors } = await compRes.json()
          const active: Competitor[] = competitors.filter((c: Competitor) => c.active)
          setCompetitors(active)
          // Prefill from ?competitors=domain1,domain2 query (used by SERP page's
          // "Run keyword gap →" CTA after bulk-add). Falls back to first active.
          const prefill = (searchParams.get('competitors') ?? '')
            .split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
          const matchPrefill = prefill.filter(d => active.some(c => c.domain.toLowerCase() === d)).slice(0, 3)
          if (matchPrefill.length > 0) {
            setSelectedDomains(matchPrefill)
          } else if (active.length > 0) {
            setSelectedDomains([active[0].domain])
          }
        }
        if (prodRes.ok) {
          const { products } = await prodRes.json()
          setTrackedProducts(products.filter((p: TrackedProduct & { active: boolean }) => p.active))
        }
        if (exclRes.ok) {
          const { exclusions } = await exclRes.json()
          setExclusions(exclusions ?? [])
        }
        if (snapRes.ok) {
          const { snapshots } = await snapRes.json()
          setSnapshots(snapshots ?? [])
        }
      } catch { /* silent */ }
      finally { setLoadingMeta(false) }
    }
    fetchMeta()
  }, [])

  // ── Exclusion management ──────────────────────────────────────────────────
  async function addExclusion() {
    if (!newPattern.trim()) return
    setSavingExcl(true)
    try {
      const res = await fetch('/api/keyword-exclusions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: newPattern.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setExclusions(prev => [...prev, data.exclusion])
      setNewPattern('')
      setExclMsg(`✓ "${newPattern.trim()}" added`)
      setTimeout(() => setExclMsg(null), 2500)
    } catch (e) { setExclMsg(`⚠ ${String(e)}`) }
    finally { setSavingExcl(false) }
  }

  async function autoGenerateFromCompetitors() {
    setSavingExcl(true)
    try {
      const res = await fetch('/api/keyword-exclusions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_from_competitors: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      const fresh = await fetch('/api/keyword-exclusions')
      if (fresh.ok) { const d = await fresh.json(); setExclusions(d.exclusions ?? []) }
      setExclMsg(`✓ Added ${data.added} brand patterns from ${competitors.length} competitors`)
      setTimeout(() => setExclMsg(null), 4000)
    } catch (e) { setExclMsg(`⚠ ${String(e)}`) }
    finally { setSavingExcl(false) }
  }

  async function removeExclusion(id: string) {
    await fetch('/api/keyword-exclusions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    setExclusions(prev => prev.filter(e => e.id !== id))
  }

  // ── Snapshot management ────────────────────────────────────────────────────
  async function loadSnapshot(id: string) {
    if (loadingSnapshot) return
    if (snapshotCache.current.has(id)) {
      setResult(snapshotCache.current.get(id)!)
      setCurrentSnapshotId(id)
      setActiveTab('gaps')
      setSelected(new Set())
      setShowLibrary(false)
      return
    }
    setLoadingSnapshot(true)
    try {
      const res = await fetch(`/api/competitive/keyword-gap/snapshots/${id}`)
      if (!res.ok) throw new Error('Failed to load snapshot')
      const data = await res.json()

      const snapshotSummary = data.summary as Record<string, any>
      const compDomains: string[] = snapshotSummary.competitor_domains ?? [data.competitor_domain]

      const built: GapResult = {
        competitor_domains:   compDomains,
        competitor_domain:    data.competitor_domain,
        g2g_domain:           'g2g.com',
        excluded_count:       data.excluded_count ?? 0,
        summary:              data.summary,
        venn:                 (snapshotSummary.venn as VennData[]) ?? [],
        position_distribution: (snapshotSummary.position_distribution as GapResult['position_distribution']) ?? null,
        gaps:    normalizeRows(data.gaps,    data.competitor_domain),
        behind:  normalizeRows(data.behind,  data.competitor_domain),
        winning: normalizeRows(data.winning, data.competitor_domain),
      }
      snapshotCache.current.set(id, built)
      setResult(built)
      setCurrentSnapshotId(id)
      setActiveTab('gaps')
      setSelected(new Set())
      setShowLibrary(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoadingSnapshot(false)
    }
  }

  async function deleteSnapshot(id: string) {
    await fetch(`/api/competitive/keyword-gap/snapshots/${id}`, { method: 'DELETE' })
    snapshotCache.current.delete(id)
    setSnapshots(prev => prev.filter(s => s.id !== id))
    if (currentSnapshotId === id) { setResult(null); setCurrentSnapshotId(null) }
  }

  // ── Run analysis ───────────────────────────────────────────────────────────
  async function runAnalysis() {
    if (selectedDomains.length === 0) return
    setLoading(true); setError(null); setResult(null); setSelected(new Set())
    const country = SERP_COUNTRIES.find(c => c.semrushDb === database) ?? SERP_COUNTRIES.find(c => c.code === 'us')!
    try {
      const res = await fetch('/api/competitive/keyword-gap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          competitor_domains: selectedDomains,
          location_code:      country.dfsLocationCode,
          language_code:      country.dfsLanguageCode,
          limit:              parseInt(limit),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResult(data)
      setCurrentSnapshotId(null)
      setActiveTab('gaps')

      // Auto-save to library (fire-and-forget)
      fetch('/api/competitive/keyword-gap/snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          competitor_domain: data.competitor_domains[0],
          location_code:     country.dfsLocationCode,
          language_code:     country.dfsLanguageCode,
          summary: {
            ...data.summary,
            competitor_domains:   data.competitor_domains,
            venn:                 data.venn,
            position_distribution: data.position_distribution,
          },
          gaps:           data.gaps,
          behind:         data.behind,
          winning:        data.winning,
          excluded_count: data.excluded_count ?? 0,
        }),
      })
        .then(r => r.json())
        .then(saved => {
          if (saved.id) {
            const compLabel = data.competitor_domains.length > 1
              ? `${data.competitor_domains[0]} +${data.competitor_domains.length - 1}`
              : data.competitor_domains[0]
            const newSnap: Snapshot = {
              id:                saved.id,
              competitor_domain: compLabel,
              location_code:     country.dfsLocationCode,
              language_code:     country.dfsLanguageCode,
              summary:           data.summary,
              excluded_count:    data.excluded_count ?? 0,
              created_at:        new Date().toISOString(),
            }
            setSnapshots(prev => [newSnap, ...prev].slice(0, 30))
            setCurrentSnapshotId(saved.id)
          }
        })
        .catch(() => {})

      // Non-blocking intent fetch
      const allKeywords = [
        ...data.gaps.map((r: GapRow) => r.keyword),
        ...data.behind.map((r: GapRow) => r.keyword),
        ...data.winning.map((r: GapRow) => r.keyword),
      ]
      if (allKeywords.length > 0) {
        setIntentsLoading(true)
        fetch('/api/keywords/intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keywords: allKeywords }),
        })
          .then(r => r.json())
          .then(d => { if (d.intents) setIntents(d.intents) })
          .catch(() => {})
          .finally(() => setIntentsLoading(false))
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  function toggleKw(kw: string) {
    setSelected(prev => { const n = new Set(prev); n.has(kw) ? n.delete(kw) : n.add(kw); return n })
  }
  function toggleAll(kwList: string[], checked: boolean) {
    setSelected(prev => {
      const n = new Set(prev)
      kwList.forEach(kw => checked ? n.add(kw) : n.delete(kw))
      return n
    })
  }

  function toggleDomain(domain: string) {
    setSelectedDomains(prev =>
      prev.includes(domain)
        ? prev.filter(d => d !== domain)
        : prev.length < 3 ? [...prev, domain] : prev
    )
  }

  const selectedRows = useMemo(() => {
    if (!result) return []
    const allRows = [...result.gaps, ...result.behind, ...result.winning]
    const seen = new Set<string>()
    const unique: GapRow[] = []
    for (const r of allRows) { if (!seen.has(r.keyword)) { seen.add(r.keyword); unique.push(r) } }
    return unique.filter(r => selected.has(r.keyword))
  }, [result, selected])

  const hasMissingSelected = selectedRows.some(r => r.g2g_url === null)

  const TAB_LABELS: { key: Tab; label: string; color: string; desc: string }[] = [
    { key: 'gaps',    label: 'Keyword Gaps',   color: 'text-red-400',    desc: 'Competitor ranks top 30, G2G not ranking' },
    { key: 'behind',  label: 'Falling Behind', color: 'text-orange-400', desc: 'Both rank, but G2G is 10+ positions behind' },
    { key: 'winning', label: 'Winning',         color: 'text-green-400',  desc: 'G2G ranks better or competitor not ranking' },
  ]

  const activeRows = result
    ? activeTab === 'gaps' ? result.gaps : activeTab === 'behind' ? result.behind : result.winning
    : []

  const resultCompDomains = result?.competitor_domains ?? []

  return (
    <div className="p-8">
      {/* Modals */}
      {showOptimize && result && (
        <OptimizeModal
          selected={selectedRows}
          trackedProducts={trackedProducts}
          competitorDomain={result.competitor_domain}
          onClose={() => setShowOptimize(false)}
          onSuccess={msg => { setSuccessMsg(msg); setSelected(new Set()) }}
        />
      )}
      {showNewPage && result && (
        <NewPageModal
          selected={selectedRows.filter(r => r.g2g_url === null)}
          competitorDomain={result.competitor_domain}
          onClose={() => setShowNewPage(false)}
          onSuccess={msg => { setSuccessMsg(msg); setSelected(new Set()) }}
        />
      )}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">🔍 Keyword Gap Finder</h1>
        <p className="text-gray-400 text-sm mt-1">
          Compare G2G's organic rankings against up to 3 competitors — find gaps, overlaps, and winning opportunities.
        </p>
      </div>

      {/* Loki agent's recent gap findings — surfaces keyword gaps Loki
          discovered automatically (without requiring user to run a fresh
          gap analysis). Complements the manual tool below. */}
      <LokiFindingsPanel
        mode="keyword-gap"
        limit={200}
        title="🦊 Loki — Recent gaps discovered automatically"
      />

      {/* Success banner */}
      {successMsg && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3 mb-5 flex items-center justify-between">
          <p className="text-green-400 text-sm font-medium">{successMsg}</p>
          <div className="flex items-center gap-3">
            {successMsg.includes('action item') && (
              <a href="/gsc/action-items" className="text-xs text-green-300 underline hover:text-green-200">View Action Items →</a>
            )}
            {successMsg.includes('opportunity') && (
              <a href="/competitive/opportunities" className="text-xs text-green-300 underline hover:text-green-200">View Opportunities →</a>
            )}
            <button onClick={() => setSuccessMsg(null)} className="text-gray-500 hover:text-white text-xs">✕</button>
          </div>
        </div>
      )}

      {/* Config */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <div className="flex items-end gap-4 flex-wrap">
          {/* Multi-select competitors */}
          <div className="flex-1 min-w-[240px]">
            <label className="block text-xs text-gray-400 mb-1.5">
              Competitors to compare{' '}
              <span className="text-gray-600">(select up to 3)</span>
            </label>
            {loadingMeta ? (
              <div className="h-9 bg-gray-800 rounded-lg animate-pulse" />
            ) : competitors.length === 0 ? (
              <div className="flex items-center gap-3">
                <p className="text-gray-500 text-sm">No competitors yet.</p>
                <a href="/competitive/competitors" className="text-xs text-red-400 hover:text-red-300 underline">+ Add competitors →</a>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {competitors.map(c => {
                  const isSel = selectedDomains.includes(c.domain)
                  const isDisabled = !isSel && selectedDomains.length >= 3
                  const colorIdx = selectedDomains.indexOf(c.domain)
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggleDomain(c.domain)}
                      disabled={isDisabled}
                      className={`text-xs px-3 py-1.5 rounded-lg border transition flex items-center gap-1.5 ${
                        isSel
                          ? 'text-white'
                          : isDisabled
                            ? 'border-gray-800 text-gray-600 cursor-not-allowed'
                            : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
                      }`}
                      style={isSel ? {
                        backgroundColor: `${COMP_COLORS[colorIdx]}22`,
                        borderColor: COMP_COLORS[colorIdx],
                        color: COMP_COLORS[colorIdx],
                      } : {}}
                    >
                      {isSel && <span>✓</span>}
                      {c.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* Market selector */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Market</label>
            <select value={database} onChange={e => setDatabase(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
              {SERP_COUNTRIES.map(c => (
                <option key={c.code} value={c.semrushDb}>{c.flag} {c.label}</option>
              ))}
            </select>
          </div>

          {/* Keywords to fetch — default 10, expandable up to 250.
              Cost estimate per option: 1 unit per keyword per competitor in DataForSEO. */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">
              Keywords to fetch
              <span className="ml-1 text-gray-600">
                · ~{parseInt(limit) * Math.max(selectedDomains.length, 1)} API units
              </span>
            </label>
            <select value={limit} onChange={e => setLimit(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
              <option value="10">Top 10 (cheap, recommended)</option>
              <option value="25">Top 25</option>
              <option value="50">Top 50</option>
              <option value="100">Top 100</option>
              <option value="250">Top 250 (heavy quota)</option>
            </select>
            {parseInt(limit) >= 100 && (
              <p className="text-[11px] text-amber-400 mt-1">⚠ Heavy SEMrush usage — pakai untuk deep scan saja</p>
            )}
          </div>

          <button onClick={runAnalysis} disabled={loading || selectedDomains.length === 0}
            className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition">
            {loading ? '⏳ Analyzing…' : '🔍 Run analysis'}
          </button>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-gray-600">
            Fetches top organic keywords via DataForSEO for G2G
            {selectedDomains.length > 0 && ` and ${selectedDomains.join(', ')}`} in parallel, then computes the gap.
          </p>
          <button
            onClick={() => setShowExclusions(e => !e)}
            className="text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 px-3 py-1 rounded-lg transition flex items-center gap-1.5 flex-shrink-0"
          >
            🚫 Exclusions
            {exclusions.length > 0 && (
              <span className="bg-orange-600/70 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{exclusions.length}</span>
            )}
            <span>{showExclusions ? '▲' : '▼'}</span>
          </button>
        </div>
      </div>

      {/* ── Keyword Exclusion Panel ──────────────────────────────────────────── */}
      {showExclusions && (
        <div className="bg-gray-900 border border-orange-500/20 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-white font-semibold text-sm">🚫 Keyword Exclusion Rules</h3>
              <p className="text-gray-500 text-xs mt-0.5">Keywords matching these patterns are hidden from all gap analysis results.</p>
            </div>
            {competitors.length > 0 && (
              <button onClick={autoGenerateFromCompetitors} disabled={savingExcl}
                className="text-xs bg-orange-600/20 hover:bg-orange-600/30 border border-orange-500/30 text-orange-300 px-3 py-1.5 rounded-lg transition disabled:opacity-50">
                ⚡ Auto-generate from {competitors.length} competitor{competitors.length > 1 ? 's' : ''}
              </button>
            )}
          </div>
          {exclMsg && (
            <p className={`text-xs mb-3 ${exclMsg.startsWith('⚠') ? 'text-red-400' : 'text-green-400'}`}>{exclMsg}</p>
          )}
          <div className="flex gap-2 mb-4">
            <input value={newPattern} onChange={e => setNewPattern(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addExclusion()}
              placeholder="e.g. playerauctions, eldorado, g2a…"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
            />
            <button onClick={addExclusion} disabled={savingExcl || !newPattern.trim()}
              className="bg-orange-600/80 hover:bg-orange-600 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded-lg transition">
              + Add
            </button>
          </div>
          {exclusions.length === 0 ? (
            <p className="text-gray-600 text-xs text-center py-3">No exclusion rules yet. Add manually or auto-generate from competitors.</p>
          ) : (
            <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
              {exclusions.map(ex => (
                <div key={ex.id} className="flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded-full px-2.5 py-1 text-xs">
                  <span className="text-gray-300">{ex.pattern}</span>
                  {ex.source === 'auto' && ex.source_domain && (
                    <span className="text-gray-600">· {ex.source_domain}</span>
                  )}
                  <button onClick={() => removeExclusion(ex.id)}
                    className="text-gray-600 hover:text-red-400 transition ml-0.5">✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Analysis Library ─────────────────────────────────────────────────── */}
      {snapshots.length > 0 && (
        <div className="mb-6">
          <button
            onClick={() => setShowLibrary(l => !l)}
            className="w-full flex items-center justify-between bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl px-5 py-3.5 transition"
          >
            <div className="flex items-center gap-2.5">
              <span className="text-base">📚</span>
              <span className="text-white font-semibold text-sm">Analysis Library</span>
              <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">{snapshots.length} saved</span>
              {currentSnapshotId && (
                <span className="text-xs bg-blue-900/50 text-blue-300 border border-blue-700/40 px-2 py-0.5 rounded-full">viewing saved</span>
              )}
            </div>
            <svg className={`w-4 h-4 text-gray-500 transition-transform ${showLibrary ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showLibrary && (
            <div className="bg-gray-900 border border-gray-800 border-t-0 rounded-b-xl overflow-hidden">
              {loadingSnapshot && (
                <div className="text-center py-4 text-gray-500 text-sm">Loading…</div>
              )}
              <div className="divide-y divide-gray-800">
                {snapshots.map(snap => {
                  const isCurrent = snap.id === currentSnapshotId
                  const date = new Date(snap.created_at)
                  const dateStr = date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
                  const timeStr = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
                  const summaryAny = snap.summary as Record<string, any>
                  const compDomains: string[] = summaryAny?.competitor_domains ?? [snap.competitor_domain]
                  return (
                    <div
                      key={snap.id}
                      className={`flex items-center gap-4 px-5 py-3.5 hover:bg-gray-800/50 transition cursor-pointer ${isCurrent ? 'bg-blue-900/10' : ''}`}
                      onClick={() => !isCurrent && loadSnapshot(snap.id)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-white text-sm font-medium">
                            {compDomains.join(' + ')}
                          </span>
                          {isCurrent && <span className="text-[10px] bg-blue-700/50 text-blue-300 px-1.5 py-0.5 rounded">active</span>}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-500 flex-wrap">
                          <span>{dateStr} {timeStr}</span>
                          <span className="text-red-400">{summaryAny?.gaps ?? snap.summary.gaps as number} gaps</span>
                          <span className="text-orange-400">{summaryAny?.behind ?? snap.summary.behind as number} behind</span>
                          <span className="text-green-400">{summaryAny?.winning ?? snap.summary.winning as number} winning</span>
                          {snap.excluded_count > 0 && <span className="text-gray-600">🚫 {snap.excluded_count} excluded</span>}
                        </div>
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); deleteSnapshot(snap.id) }}
                        className="text-gray-700 hover:text-red-400 transition p-1 flex-shrink-0"
                        title="Delete"
                      >🗑</button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-red-400 text-sm">⚠️ {error}</div>
      )}

      {loading && (
        <div className="flex justify-center py-16"><LottieLoader size={90} text="Fetching keyword rankings…" /></div>
      )}

      {result && !loading && (
        <>
          {/* ── Summary cards ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-white">{result.summary.g2g_total.toLocaleString()}</p>
              <p className="text-xs text-gray-500 mt-1">G2G keywords</p>
            </div>
            {/* Per-competitor total (or single) */}
            {resultCompDomains.length === 1 ? (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-white">
                  {(result.summary.competitor_totals?.[resultCompDomains[0]] ?? result.summary.competitor_total ?? 0).toLocaleString()}
                </p>
                <p className="text-xs text-gray-500 mt-1 truncate">{resultCompDomains[0]}</p>
              </div>
            ) : (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center col-span-1">
                <p className="text-sm font-bold text-white mb-0.5">{resultCompDomains.length} competitors</p>
                <div className="space-y-0.5">
                  {resultCompDomains.map((d, i) => (
                    <p key={d} className="text-[10px] truncate" style={{ color: COMP_COLORS[i % COMP_COLORS.length] }}>
                      {d}: {(result.summary.competitor_totals?.[d] ?? 0).toLocaleString()}
                    </p>
                  ))}
                </div>
              </div>
            )}
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-red-400">{result.summary.gaps}</p>
              <p className="text-xs text-gray-500 mt-1">Keyword gaps</p>
            </div>
            <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-orange-400">{result.summary.behind}</p>
              <p className="text-xs text-gray-500 mt-1">Falling behind</p>
            </div>
            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-green-400">{result.summary.winning}</p>
              <p className="text-xs text-gray-500 mt-1">G2G winning</p>
            </div>
            {(result.excluded_count ?? 0) > 0 && (
              <div className="bg-orange-500/5 border border-orange-500/20 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-orange-300">{result.excluded_count}</p>
                <p className="text-xs text-gray-500 mt-1">🚫 Excluded</p>
              </div>
            )}
          </div>

          {/* Auto-push to Pipeline status — surfaces hybrid threshold result */}
          {result.pipeline_push && result.pipeline_push.enabled && (result.pipeline_push.pushed_count > 0 || result.summary.gaps > 0) && (
            <div className="bg-purple-500/10 border border-purple-500/30 rounded-xl p-3 mb-4 flex items-center justify-between">
              <div className="text-xs text-purple-200">
                {result.pipeline_push.pushed_count > 0 ? (
                  <>
                    🚦 <span className="font-semibold">{result.pipeline_push.pushed_count} gaps auto-pushed to Pipeline</span>
                    <span className="text-gray-400"> (SV ≥ {result.pipeline_push.threshold_sv.toLocaleString()})</span>
                    {result.pipeline_push.skipped_existing > 0 && (
                      <span className="text-gray-500"> · {result.pipeline_push.skipped_existing} already in pipeline</span>
                    )}
                    <span className="text-gray-500 ml-2">— Saga aggregator picks up in next 30min cycle</span>
                  </>
                ) : (
                  <>
                    🚦 <span className="text-gray-400">No gaps met auto-push threshold (SV ≥ {result.pipeline_push.threshold_sv.toLocaleString()})</span>
                    <span className="text-gray-500 ml-1">— select gaps below + "Send to Pipeline" to push manually</span>
                  </>
                )}
              </div>
              <a href="/command-center/pipeline" className="text-[11px] text-blue-400 hover:text-blue-300 transition border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 rounded-lg">
                View Pipeline →
              </a>
            </div>
          )}

          {/* ── Visual analysis: Venn + Position Distribution ─────────────────── */}
          {(result.venn?.length > 0 || result.position_distribution) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
              {/* Venn Diagram */}
              {result.venn?.length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h3 className="text-white font-semibold text-sm mb-4 flex items-center gap-2">
                    <span>⭕</span> Keyword Overlap
                  </h3>
                  <VennDiagram venn={result.venn} />

                  {/* Overlap stats strip */}
                  {result.venn.length === 1 && (() => {
                    const v = result.venn[0]
                    const total = v.g2g_only + v.comp_only + v.shared
                    const g2gOnlyPct = total > 0 ? Math.round(v.g2g_only / total * 100) : 0
                    const compOnlyPct = total > 0 ? Math.round(v.comp_only / total * 100) : 0
                    return (
                      <div className="grid grid-cols-3 gap-2 mt-4">
                        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-center">
                          <p className="text-blue-400 font-bold">{g2gOnlyPct}%</p>
                          <p className="text-gray-500 text-xs mt-0.5">G2G unique</p>
                        </div>
                        <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-3 text-center">
                          <p className="text-purple-400 font-bold">{v.overlap_pct ?? Math.round(v.shared / total * 100)}%</p>
                          <p className="text-gray-500 text-xs mt-0.5">Overlap</p>
                        </div>
                        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-center">
                          <p className="text-red-400 font-bold">{compOnlyPct}%</p>
                          <p className="text-gray-500 text-xs mt-0.5">Comp unique</p>
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )}

              {/* Position Distribution */}
              {result.position_distribution && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h3 className="text-white font-semibold text-sm mb-4 flex items-center gap-2">
                    <span>📊</span> Position Distribution
                    <span className="text-gray-600 text-xs font-normal ml-1">Top-30 keywords by ranking bucket</span>
                  </h3>
                  <PositionDistChart
                    posDist={result.position_distribution}
                    competitorDomains={resultCompDomains}
                  />
                  {/* Summary stats per bucket */}
                  <div className="mt-3 grid grid-cols-4 gap-2">
                    {(['top3', 'pos4_10', 'pos11_20', 'pos21_30'] as const).map(k => {
                      const g2gVal = result.position_distribution!.g2g[k]
                      const compBest = Math.max(...resultCompDomains.map(d => result.position_distribution!.competitors[d]?.[k] ?? 0))
                      const label = k === 'top3' ? 'Top 3' : k === 'pos4_10' ? '4–10' : k === 'pos11_20' ? '11–20' : '21–30'
                      const diff = g2gVal - compBest
                      return (
                        <div key={k} className="bg-gray-800/50 rounded-lg p-2 text-center">
                          <p className="text-gray-400 text-[10px] mb-1">{label}</p>
                          <p className="text-white text-sm font-bold">{g2gVal}</p>
                          {compBest > 0 && (
                            <p className={`text-[10px] ${diff >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {diff >= 0 ? '+' : ''}{diff} vs comp
                            </p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Tabs ──────────────────────────────────────────────────────────── */}
          <div className="flex items-center gap-1 mb-5 border-b border-gray-800">
            {TAB_LABELS.map(t => (
              <button key={t.key} onClick={() => { setActiveTab(t.key); setSelected(new Set()) }}
                className={`px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
                  activeTab === t.key ? `${t.color} border-current` : 'text-gray-500 border-transparent hover:text-gray-300'
                }`}>
                {t.label}
                <span className="ml-2 text-xs opacity-70">
                  {t.key === 'gaps' ? result.gaps.length : t.key === 'behind' ? result.behind.length : result.winning.length}
                </span>
              </button>
            ))}
            <span className="ml-auto text-xs text-gray-600 pb-2">{TAB_LABELS.find(t => t.key === activeTab)?.desc}</span>
          </div>

          <GapTable
            rows={activeRows}
            tab={activeTab}
            competitorDomains={resultCompDomains}
            selected={selected}
            onToggle={toggleKw}
            onToggleAll={toggleAll}
            intents={intents}
            intentsLoading={intentsLoading}
          />
        </>
      )}

      {/* ── Floating action bar ─────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-gray-900 border border-gray-600 rounded-2xl px-5 py-3 shadow-2xl shadow-black/40">
          <span className="text-white text-sm font-medium">
            {selected.size} keyword{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div className="w-px h-5 bg-gray-700" />
          <button onClick={() => setShowOptimize(true)}
            className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition flex items-center gap-1.5">
            📝 Optimize page
          </button>
          {hasMissingSelected && (
            <button onClick={() => setShowNewPage(true)}
              className="bg-orange-700 hover:bg-orange-600 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition flex items-center gap-1.5">
              🆕 New page opportunity
              <span className="text-orange-300 text-xs">({selectedRows.filter(r => r.g2g_url === null).length})</span>
            </button>
          )}
          <button
            disabled={sendingToPipeline}
            onClick={async () => {
              if (!result || selectedRows.length === 0) return
              setSendingToPipeline(true)
              setSendResult(null)
              try {
                const gaps = selectedRows.slice(0, 30).map(r => ({
                  keyword:              r.keyword,
                  competitor_domain:    r.competitors[0]?.domain ?? result.competitor_domain,
                  competitor_url:       r.competitors[0]?.url ?? null,
                  competitor_position:  r.competitors[0]?.position ?? undefined,
                  our_position:         r.g2g_position,
                  search_volume:        r.searchVolume,
                  cpc:                  r.cpc,
                }))
                const res = await fetch('/api/competitive/keyword-gap/send-to-pipeline', {
                  method:  'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body:    JSON.stringify({ gaps }),
                })
                const data = await res.json()
                if (res.ok) {
                  setSendResult({ pushed: data.pushed ?? 0, skipped: data.skipped_existing ?? 0 })
                  setSelected(new Set())
                } else {
                  alert(`Failed: ${data.error ?? 'Unknown error'}`)
                }
              } finally {
                setSendingToPipeline(false)
              }
            }}
            className="bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition flex items-center gap-1.5">
            {sendingToPipeline ? '⏳ Sending…' : '🚦 Send to Pipeline'}
          </button>
          <button onClick={() => setSelected(new Set())} className="text-gray-400 hover:text-white text-sm transition">✕</button>
        </div>
      )}

      {/* Send-to-pipeline result toast */}
      {sendResult && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-40 bg-emerald-500/15 border border-emerald-500/40 rounded-xl px-4 py-2.5 flex items-center gap-3 shadow-xl">
          <span className="text-xs text-emerald-300">
            ✓ <span className="font-semibold">{sendResult.pushed} pushed to Pipeline</span>
            {sendResult.skipped > 0 && <span className="text-gray-400"> · {sendResult.skipped} already exist</span>}
            <span className="text-gray-500 ml-2">— Saga aggregator will pick up next 30min</span>
          </span>
          <button onClick={() => setSendResult(null)} className="text-gray-500 hover:text-gray-300 text-xs">✕</button>
        </div>
      )}
    </div>
  )
}
