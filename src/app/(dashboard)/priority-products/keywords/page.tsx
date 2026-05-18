'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'
import type { KeywordMasterRow, KeywordMasterSummary } from '@/app/api/keyword-master/route'

/**
 * /priority-products/keywords — Sprint KW.MASTER.2
 *
 * Bird's-eye view of every tier_keyword across all priority products.
 * Dense table with all signals surfaced inline: scoring, winner rank,
 * DMCA flag (inherited from parent product), language/market badge,
 * latest position with WoW delta.
 *
 * Filters operate client-side over the full payload (typically ≤500 rows)
 * for instant feedback. CSV export of current filtered view.
 */

const EMPTY_SUMMARY: KeywordMasterSummary = {
  total_kws: 0, winners: 0, dmca_flagged: 0, needs_scoring: 0,
  products_with_kws: 0, products_total: 0,
  by_tier: { t1: 0, t2: 0 },
  by_market: { us: 0, id: 0 },
  by_language: { en: 0, id: 0 },
}

type SortKey = 'score_desc' | 'score_asc' | 'pos_drop' | 'pos_gain' | 'product' | 'keyword' | 'sv_desc'

export default function KeywordMasterPage() {
  const siteSlug = useSiteSlug()

  const [rows,    setRows]    = useState<KeywordMasterRow[]>([])
  const [summary, setSummary] = useState<KeywordMasterSummary>(EMPTY_SUMMARY)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const [search,      setSearch]      = useState('')
  const [tierFilter,  setTierFilter]  = useState<'all' | '1' | '2'>('all')
  const [marketFilter, setMarketFilter] = useState<'all' | 'us' | 'id'>('all')
  const [langFilter,  setLangFilter]   = useState<'all' | 'en' | 'id'>('all')
  const [dmcaFilter,  setDmcaFilter]   = useState<'all' | 'flagged' | 'safe'>('all')
  const [winnersOnly, setWinnersOnly]  = useState(false)
  const [hasSvOnly,   setHasSvOnly]    = useState(false)
  const [sortBy,      setSortBy]       = useState<SortKey>('score_desc')

  const [rescoreMsg, setRescoreMsg] = useState<string | null>(null)
  const [rescoring,  setRescoring]  = useState(false)

  // Sprint KW.MASTER.3 — pre-apply product filter via ?product_id=
  const [productIdFilter, setProductIdFilter] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const p = new URLSearchParams(window.location.search).get('product_id')
    if (p) setProductIdFilter(p)
  }, [])

  async function fetchData() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/keyword-master')
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? 'Failed to load')
        return
      }
      setRows(body.rows ?? [])
      setSummary(body.summary ?? EMPTY_SUMMARY)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [siteSlug])  // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    let out = rows
      .filter(r => productIdFilter ? r.product_tier_id === productIdFilter : true)
      .filter(r => tierFilter   === 'all' || String(r.tier)      === tierFilter)
      .filter(r => marketFilter === 'all' || r.kw_market         === marketFilter)
      .filter(r => langFilter   === 'all' || r.language          === langFilter)
      .filter(r => dmcaFilter   === 'all' ||
        (dmcaFilter === 'flagged' ? !!r.restriction_type?.startsWith('dmca') : !r.restriction_type?.startsWith('dmca')))
      .filter(r => !winnersOnly || r.is_cluster_winner)
      .filter(r => !hasSvOnly   || (r.sv_volume != null && r.sv_volume > 0))
    if (s) {
      out = out.filter(r =>
        r.keyword.toLowerCase().includes(s)
        || r.product_name.toLowerCase().includes(s)
        || (r.category ?? '').toLowerCase().includes(s),
      )
    }

    // Sort
    const cmp = (a: KeywordMasterRow, b: KeywordMasterRow): number => {
      switch (sortBy) {
        case 'score_desc': return (b.competitive_score ?? -1) - (a.competitive_score ?? -1)
        case 'score_asc':  return (a.competitive_score ?? 999) - (b.competitive_score ?? 999)
        case 'pos_drop':   return (a.position_wow ?? 0) - (b.position_wow ?? 0)   // most negative = biggest drop first
        case 'pos_gain':   return (b.position_wow ?? 0) - (a.position_wow ?? 0)
        case 'product':    return a.product_name.localeCompare(b.product_name) || a.keyword.localeCompare(b.keyword)
        case 'keyword':    return a.keyword.localeCompare(b.keyword)
        case 'sv_desc':    return (b.sv_volume ?? -1) - (a.sv_volume ?? -1)
      }
    }
    return out.slice().sort(cmp)
  }, [rows, search, tierFilter, marketFilter, langFilter, dmcaFilter, winnersOnly, hasSvOnly, sortBy, productIdFilter])

  async function bulkRescore() {
    if (rescoring) return
    if (!confirm('Re-score all competitive keywords for this brand?\nThis recomputes SV, density, intent and final score. Cost ~$0.005. Takes 5-20 seconds.')) return
    setRescoring(true)
    setRescoreMsg(null)
    try {
      const res = await fetch('/api/competitive/rescore', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      })
      const body = await res.json()
      if (!res.ok) {
        setRescoreMsg(`Failed: ${body.error ?? 'unknown'}`)
      } else {
        const svParts = ((body.sv_diagnostics ?? []) as Array<{ market: string; requested: number; with_sv: number; error?: string }>)
          .map(d => `${d.market.toUpperCase()} ${d.with_sv}/${d.requested}`)
          .join(', ')
        const svLine = svParts ? ` · DataForSEO SV: ${svParts}` : ''
        setRescoreMsg(`✓ Scored ${body.scored} kws across ${body.clusters} clusters${svLine}`)
        await fetchData()
      }
    } catch (e) {
      setRescoreMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRescoring(false)
    }
  }

  function exportCsv() {
    if (filtered.length === 0) return
    const headers = [
      'Tier', 'Product', 'Keyword', 'Main', 'Language', 'KW Market', 'Product Market',
      'Category', 'DMCA', 'Winner Rank', 'Score',
      'SV', 'SV norm', 'Density', 'Intent',
      'Latest Position', 'Prior Position', 'WoW Delta', 'Latest Snapshot',
      'Last Scored At',
    ]
    const lines = [headers.join(',')]
    for (const r of filtered) {
      lines.push([
        `T${r.tier}`,
        csvEscape(r.product_name),
        csvEscape(r.keyword),
        r.is_main ? 'yes' : '',
        r.language.toUpperCase(),
        r.kw_market.toUpperCase(),
        r.market.toUpperCase(),
        csvEscape(r.category ?? ''),
        r.restriction_type?.startsWith('dmca') ? csvEscape(r.restriction_type) : '',
        r.is_cluster_winner ? `#${r.cluster_rank ?? '?'}` : '',
        r.competitive_score ?? '',
        r.sv_volume ?? '',
        r.sv_volume_norm ?? '',
        r.serp_density ?? '',
        r.intent_score ?? '',
        r.latest_position ?? '',
        r.prior_position ?? '',
        r.position_wow ?? '',
        r.latest_snap_date ?? '',
        r.last_scored_at ?? '',
      ].join(','))
    }
    const csv = lines.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `keyword-master_${siteSlug}_${stamp}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const dmcaBanner = summary.dmca_flagged > 0
    ? `⚠ ${summary.dmca_flagged} keyword${summary.dmca_flagged !== 1 ? 's' : ''} inherit DMCA flag from parent product`
    : null
  const emptyProductBanner = summary.products_total > summary.products_with_kws
    ? `📋 ${summary.products_total - summary.products_with_kws} product${summary.products_total - summary.products_with_kws !== 1 ? 's' : ''} have no keywords tracked yet`
    : null

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto">
      <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div>
          <Link href="/priority-products" className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 mb-2">
            ← Priority Products
          </Link>
          <h1 className="text-2xl font-bold text-white mb-1">🔑 Keyword Master</h1>
          <p className="text-sm text-gray-400">
            All tier-tracked keywords across every priority product on <strong className="text-white">{siteSlug.toUpperCase()}</strong>.
            Winner badges from <Link href="/methodology/competitive-keywords" className="text-blue-400 hover:text-blue-300">competitive methodology</Link>.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={bulkRescore}
            disabled={rescoring}
            className="px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg"
            title="Re-compute competitive_score for all tier_keywords + mark top 3 winners per cluster"
          >
            {rescoring ? '⏳ Scoring…' : '🎯 Re-score winners (bulk)'}
          </button>
          <button
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-200 text-sm rounded-lg border border-gray-700"
            title="Download filtered keyword list as CSV"
          >
            ⬇ Export CSV ({filtered.length})
          </button>
        </div>
      </div>
      {rescoreMsg && (
        <p className="text-xs text-gray-400 mb-4">{rescoreMsg}</p>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Kpi label="Total kws"       value={summary.total_kws}        sub={`${summary.by_tier.t1} T1 · ${summary.by_tier.t2} T2`} accent="#6366f1" />
        <Kpi label="Cluster winners" value={summary.winners}          sub="top 3 per cluster"                                     accent="#a855f7" />
        <Kpi label="Coverage"        value={summary.products_with_kws} sub={`of ${summary.products_total} products`}              accent="#10b981" />
        <Kpi label="DMCA-flagged"    value={summary.dmca_flagged}     sub="inherited from product"                                accent="#ef4444" />
        <Kpi label="Need scoring"    value={summary.needs_scoring}    sub="run re-score above"                                    accent="#f59e0b" />
      </div>

      {/* Conditional banners */}
      {(dmcaBanner || emptyProductBanner || productIdFilter) && (
        <div className="space-y-1.5 mb-4">
          {productIdFilter && (
            <div className="flex items-center justify-between bg-blue-900/20 border border-blue-700/30 rounded-lg px-3 py-2 text-xs text-blue-200">
              <span>Filtered to a single product. {filtered.length} kw{filtered.length !== 1 ? 's' : ''} shown.</span>
              <button
                onClick={() => {
                  setProductIdFilter(null)
                  if (typeof window !== 'undefined') {
                    const u = new URL(window.location.href)
                    u.searchParams.delete('product_id')
                    window.history.replaceState({}, '', u.toString())
                  }
                }}
                className="text-blue-300 hover:text-white underline"
              >
                Clear product filter
              </button>
            </div>
          )}
          {dmcaBanner && (
            <div className="bg-red-900/15 border border-red-700/30 rounded-lg px-3 py-2 text-xs text-red-200">{dmcaBanner}</div>
          )}
          {emptyProductBanner && (
            <div className="flex items-center justify-between bg-amber-900/15 border border-amber-700/30 rounded-lg px-3 py-2 text-xs text-amber-200">
              <span>{emptyProductBanner}</span>
              <Link href="/priority-products" className="text-amber-300 hover:text-white underline">Open Priority Products →</Link>
            </div>
          )}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Search keyword / product / category…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[240px] bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-600"
        />
        <Select label="Tier"   value={tierFilter}   onChange={v => setTierFilter(v as typeof tierFilter)}     options={[['all', 'All tiers'], ['1', 'T1 only'], ['2', 'T2 only']]} />
        <Select label="Market" value={marketFilter} onChange={v => setMarketFilter(v as typeof marketFilter)} options={[['all', 'All markets'], ['us', '🌐 Global'], ['id', '🇮🇩 ID']]} />
        <Select label="Lang"   value={langFilter}   onChange={v => setLangFilter(v as typeof langFilter)}     options={[['all', 'All langs'], ['en', 'EN'], ['id', 'ID']]} />
        <Select label="DMCA"   value={dmcaFilter}   onChange={v => setDmcaFilter(v as typeof dmcaFilter)}     options={[['all', 'All DMCA'], ['flagged', '⚠ Flagged'], ['safe', '✓ Safe']]} />
        <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
          <input type="checkbox" checked={winnersOnly} onChange={e => setWinnersOnly(e.target.checked)} />
          Winners only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
          <input type="checkbox" checked={hasSvOnly} onChange={e => setHasSvOnly(e.target.checked)} />
          Has SV
        </label>
        <Select
          label="Sort"
          value={sortBy}
          onChange={v => setSortBy(v as SortKey)}
          options={[
            ['score_desc', 'Score ↓'],
            ['score_asc',  'Score ↑'],
            ['pos_drop',   'Biggest drops first'],
            ['pos_gain',   'Biggest gains first'],
            ['sv_desc',    'Volume ↓'],
            ['product',    'Product (A–Z)'],
            ['keyword',    'Keyword (A–Z)'],
          ]}
        />
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-sm text-gray-500 py-12 text-center">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-400 py-12 text-center">{error}</p>
      ) : filtered.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">🔍</p>
          <p className="text-white font-semibold mb-1">
            {rows.length === 0 ? 'No keywords tracked yet' : 'No keywords match these filters'}
          </p>
          <p className="text-gray-500 text-sm">
            {rows.length === 0
              ? 'Add tier keywords from Priority Products → product detail page.'
              : 'Try clearing filters or expanding search.'}
          </p>
        </div>
      ) : (
        <KeywordTable rows={filtered} />
      )}
    </div>
  )
}

// ─── Sub-components ────────────────────────────────────────────────────

function KeywordTable({ rows }: { rows: KeywordMasterRow[] }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-950/80 sticky top-0 z-10">
            <tr className="text-gray-500 text-[10px] uppercase tracking-wider">
              <th className="px-3 py-2 text-left font-semibold">Tier</th>
              <th className="px-3 py-2 text-left font-semibold">Product</th>
              <th className="px-3 py-2 text-left font-semibold">Keyword</th>
              <th className="px-3 py-2 text-center font-semibold">Lang</th>
              <th className="px-3 py-2 text-center font-semibold">Market</th>
              <th className="px-3 py-2 text-center font-semibold">DMCA</th>
              <th className="px-3 py-2 text-right font-semibold">Score</th>
              <th className="px-3 py-2 text-right font-semibold">SV</th>
              <th className="px-3 py-2 text-right font-semibold">Pos</th>
              <th className="px-3 py-2 text-right font-semibold">WoW</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => <KeywordRow key={r.id} r={r} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function KeywordRow({ r }: { r: KeywordMasterRow }) {
  const dmca = r.restriction_type?.startsWith('dmca') ?? false
  const wowCls = r.position_wow == null
    ? 'text-gray-500'
    : r.position_wow > 0 ? 'text-emerald-400'
    : r.position_wow < 0 ? 'text-red-400'
    : 'text-gray-500'

  return (
    <tr className={`border-t border-gray-800 hover:bg-gray-800/30 transition ${dmca ? 'bg-red-950/10' : ''}`}>
      <td className="px-3 py-2 align-middle">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
          r.tier === 1
            ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
            : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
        }`}>T{r.tier}</span>
      </td>
      <td className="px-3 py-2 align-middle max-w-[180px]">
        <Link href={`/priority-products/${r.product_tier_id}`} className="text-gray-200 hover:text-white truncate block" title={r.product_name}>
          {r.product_name}
        </Link>
        {r.category && <p className="text-[9px] text-gray-600 uppercase tracking-wider truncate">{r.category}</p>}
      </td>
      <td className="px-3 py-2 align-middle max-w-[260px]">
        <div className="flex items-center gap-1.5 flex-wrap">
          {r.is_main && <span className="text-amber-400" title="Main keyword">★</span>}
          {r.is_cluster_winner && (
            <span
              className="text-[9px] font-bold px-1 py-0.5 rounded border bg-purple-500/20 text-purple-200 border-purple-500/40"
              title={
                `Cluster winner #${r.cluster_rank ?? '?'}\n`
                + `Score: ${r.competitive_score ?? '—'}/100\n`
                + `SV norm: ${r.sv_volume_norm ?? '—'} · Density: ${r.serp_density ?? '—'} · Intent: ${r.intent_score ?? '—'}`
              }
            >
              🥇{r.cluster_rank ? `#${r.cluster_rank}` : ''}
            </span>
          )}
          <span className="text-white truncate" title={r.keyword}>{r.keyword}</span>
        </div>
      </td>
      <td className="px-3 py-2 align-middle text-center">
        <span className={`text-[10px] font-bold px-1 py-0.5 rounded border ${
          r.language === 'id'
            ? 'bg-red-500/15 text-red-300 border-red-500/30'
            : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
        }`}>{r.language.toUpperCase()}</span>
      </td>
      <td className="px-3 py-2 align-middle text-center">
        <span className="text-[11px] text-gray-300">{r.kw_market === 'id' ? '🇮🇩' : '🌐'}</span>
      </td>
      <td className="px-3 py-2 align-middle text-center">
        {dmca ? (
          <span
            className="text-[9px] font-bold px-1 py-0.5 rounded border bg-red-500/20 text-red-200 border-red-500/40"
            title={`Parent product flagged: ${r.restriction_type}`}
          >⚠ DMCA</span>
        ) : <span className="text-gray-700">—</span>}
      </td>
      <td className="px-3 py-2 align-middle text-right font-mono">
        {r.competitive_score == null ? <span className="text-gray-600">—</span> : (
          <span className={r.competitive_score >= 70 ? 'text-emerald-300' : r.competitive_score >= 40 ? 'text-gray-200' : 'text-gray-500'}>{r.competitive_score}</span>
        )}
      </td>
      <td className="px-3 py-2 align-middle text-right font-mono text-gray-400">
        {r.sv_volume == null ? '—' : r.sv_volume.toLocaleString()}
      </td>
      <td className="px-3 py-2 align-middle text-right font-mono">
        {r.latest_position == null ? <span className="text-gray-600">—</span> : (
          <span className={r.latest_position <= 3 ? 'text-emerald-300' : r.latest_position <= 10 ? 'text-gray-200' : 'text-gray-400'}>
            #{r.latest_position.toFixed(1)}
          </span>
        )}
      </td>
      <td className={`px-3 py-2 align-middle text-right font-mono ${wowCls}`}>
        {r.position_wow == null ? '—' : `${r.position_wow > 0 ? '↑+' : r.position_wow < 0 ? '↓' : ''}${Math.abs(r.position_wow).toFixed(1)}`}
      </td>
      <td className="px-3 py-2 align-middle text-right">
        <Link
          href={`/priority-products/${r.product_tier_id}`}
          className="text-[10px] text-blue-400 hover:text-blue-300 whitespace-nowrap"
        >
          Open →
        </Link>
      </td>
    </tr>
  )
}

function Kpi({ label, value, sub, accent }: { label: string; value: number; sub?: string; accent: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: accent }} />
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 font-semibold">{label}</p>
      <p className="text-2xl font-bold text-white leading-tight">{value.toLocaleString()}</p>
      {sub && <p className="text-[10px] text-gray-500 mt-0.5 truncate">{sub}</p>}
    </div>
  )
}

function Select({ label, value, onChange, options }: {
  label:    string
  value:    string
  onChange: (v: string) => void
  options:  Array<[string, string]>
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-gray-900 border border-gray-800 rounded-lg px-2 py-2 text-xs text-white focus:outline-none focus:border-gray-600"
      aria-label={label}
    >
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )
}

function csvEscape(s: string): string {
  const str = String(s ?? '')
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}
