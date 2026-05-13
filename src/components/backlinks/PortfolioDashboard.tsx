'use client'

/**
 * PortfolioDashboard — paid-backlink portfolio analytics.
 *
 * Shows derived metrics from paid_backlinks rows:
 *   1. Cost-per-position widget (USD spent ÷ Δposition improvement)
 *   2. Anchor text type breakdown (brand vs exact-match vs partial vs URL)
 *   3. Status distribution (active / pending / broken)
 *   4. Cost over time (monthly bars)
 *
 * Surfaces at the top of /backlinks (above the table). Pure derivation —
 * no extra fetches; uses the same backlinks list the parent already loaded.
 */

import { useMemo } from 'react'

interface Backlink {
  id:                   string
  anchor_text:          string
  target_keyword:       string | null
  link_status:          'active' | 'broken' | 'pending'
  position_current:     number | null
  position_at_creation: number | null
  cost_amount:          number | null
  cost_currency:        string
  live_date:            string | null
}

interface Props {
  backlinks: Backlink[]
}

// USD-only conversion approximations — for display only, not authoritative
const USD_RATES: Record<string, number> = {
  USD: 1, IDR: 1 / 15700, SGD: 1 / 1.34, MYR: 1 / 4.7, PHP: 1 / 56,
  THB: 1 / 35, VND: 1 / 25000, AUD: 1 / 1.5, GBP: 1.27, EUR: 1.08,
  BRL: 1 / 5.2, JPY: 1 / 150, KRW: 1 / 1370,
}

function toUsd(amount: number, currency: string): number {
  const rate = USD_RATES[currency.toUpperCase()] ?? 1
  return amount * rate
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

function classifyAnchor(anchor: string, brandName = 'g2g'): 'brand' | 'exact' | 'partial' | 'url' | 'generic' {
  const a = anchor.toLowerCase().trim()
  if (!a) return 'generic'
  if (a.includes(brandName)) return 'brand'
  if (/^https?:\/\//.test(a) || /\.com\b/.test(a)) return 'url'
  if (/^(click here|read more|here|this|website|learn more)$/i.test(a)) return 'generic'
  // exact-match: the anchor is just the keyword. Partial: contains the keyword + extras
  return a.split(/\s+/).length <= 3 ? 'exact' : 'partial'
}

const ANCHOR_COLORS: Record<ReturnType<typeof classifyAnchor>, string> = {
  brand:   'bg-blue-500',
  exact:   'bg-amber-500',
  partial: 'bg-purple-500',
  url:     'bg-green-500',
  generic: 'bg-gray-500',
}

export default function PortfolioDashboard({ backlinks }: Props) {
  const stats = useMemo(() => {
    const active = backlinks.filter(b => b.link_status === 'active')

    // Cost (USD-equivalent)
    const totalCostUsd = backlinks.reduce((s, b) => {
      if (!b.cost_amount) return s
      return s + toUsd(Number(b.cost_amount), b.cost_currency)
    }, 0)

    // Position improvement: only count links with both positions
    const withImprovement = active.filter(b => b.position_current != null && b.position_at_creation != null)
    const totalImprovement = withImprovement.reduce((s, b) => {
      const delta = (b.position_at_creation ?? 0) - (b.position_current ?? 0)
      return s + (delta > 0 ? delta : 0)   // only count improvement
    }, 0)

    const costPerPosition = totalImprovement > 0
      ? totalCostUsd / totalImprovement
      : null

    // Anchor type breakdown
    const anchorCounts: Record<ReturnType<typeof classifyAnchor>, number> = {
      brand: 0, exact: 0, partial: 0, url: 0, generic: 0,
    }
    for (const b of active) anchorCounts[classifyAnchor(b.anchor_text)]++
    const anchorTotal = Object.values(anchorCounts).reduce((a, b) => a + b, 0)

    // Status distribution
    const statusCounts = {
      active:  backlinks.filter(b => b.link_status === 'active').length,
      pending: backlinks.filter(b => b.link_status === 'pending').length,
      broken:  backlinks.filter(b => b.link_status === 'broken').length,
    }

    // Cost over time — group by month (live_date)
    const byMonth = new Map<string, number>()
    for (const b of backlinks) {
      if (!b.live_date || !b.cost_amount) continue
      const month = b.live_date.slice(0, 7)   // YYYY-MM
      byMonth.set(month, (byMonth.get(month) ?? 0) + toUsd(Number(b.cost_amount), b.cost_currency))
    }
    const monthlySeries = Array.from(byMonth.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)  // last 6 months

    return {
      totalCostUsd,
      totalImprovement,
      costPerPosition,
      withImprovement: withImprovement.length,
      anchorCounts,
      anchorTotal,
      statusCounts,
      monthlySeries,
    }
  }, [backlinks])

  if (backlinks.length === 0) return null

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
      <header className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          📊 Portfolio Dashboard
        </h2>
        <p className="text-[11px] text-gray-500">{backlinks.length} backlinks · {stats.statusCounts.active} active · {fmtUsd(stats.totalCostUsd)} all-time spend</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Cost-per-position widget */}
        <div className="bg-gray-800/40 rounded-lg p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Cost per position improved</p>
          <p className="text-2xl font-bold text-white">
            {stats.costPerPosition != null ? fmtUsd(stats.costPerPosition) : '—'}
          </p>
          <p className="text-[10px] text-gray-500 mt-1">
            {stats.totalImprovement > 0
              ? `${fmtUsd(stats.totalCostUsd)} ÷ ${stats.totalImprovement} pos improved`
              : `${stats.withImprovement} active links have position data`}
          </p>
        </div>

        {/* Total spend */}
        <div className="bg-gray-800/40 rounded-lg p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">All-time spend (USD eq.)</p>
          <p className="text-2xl font-bold text-amber-400">{fmtUsd(stats.totalCostUsd)}</p>
          <p className="text-[10px] text-gray-500 mt-1">
            {backlinks.filter(b => b.cost_amount).length} of {backlinks.length} links have cost data
          </p>
        </div>

        {/* Position improvement */}
        <div className="bg-gray-800/40 rounded-lg p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Total position lift</p>
          <p className="text-2xl font-bold text-green-400">+{stats.totalImprovement}</p>
          <p className="text-[10px] text-gray-500 mt-1">
            Sum of (start pos − current pos) across {stats.withImprovement} tracked links
          </p>
        </div>

        {/* Status breakdown */}
        <div className="bg-gray-800/40 rounded-lg p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Status</p>
          <div className="space-y-1.5">
            <StatusBar label="Active"  value={stats.statusCounts.active}  total={backlinks.length} color="bg-green-500" />
            <StatusBar label="Pending" value={stats.statusCounts.pending} total={backlinks.length} color="bg-amber-500" />
            <StatusBar label="Broken"  value={stats.statusCounts.broken}  total={backlinks.length} color="bg-red-500" />
          </div>
        </div>
      </div>

      {/* Anchor mix + monthly cost */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        {/* Anchor mix */}
        <div className="bg-gray-800/40 rounded-lg p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Anchor text mix (active links)</p>
          {stats.anchorTotal === 0 ? (
            <p className="text-xs text-gray-600 italic">No active links yet.</p>
          ) : (
            <div className="space-y-2">
              {(['brand', 'exact', 'partial', 'url', 'generic'] as const).map(kind => {
                const count = stats.anchorCounts[kind]
                if (count === 0) return null
                const pct = (count / stats.anchorTotal) * 100
                return (
                  <div key={kind} className="flex items-center gap-2 text-xs">
                    <span className="w-16 text-gray-400 capitalize">{kind}</span>
                    <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                      <div className={`h-full ${ANCHOR_COLORS[kind]}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-12 text-right text-gray-300 tabular-nums">{count} ({pct.toFixed(0)}%)</span>
                  </div>
                )
              })}
            </div>
          )}
          <p className="text-[10px] text-gray-600 mt-3 italic">
            Healthy mix: 40-60% brand, 10-20% exact-match, 20-30% partial, rest generic/URL. Heavy exact-match risks over-optimization penalty.
          </p>
        </div>

        {/* Monthly cost */}
        <div className="bg-gray-800/40 rounded-lg p-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Cost over time (last 6 months, USD eq.)</p>
          {stats.monthlySeries.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No live_date + cost data yet.</p>
          ) : (() => {
            const max = Math.max(...stats.monthlySeries.map(([, v]) => v))
            return (
              <div className="space-y-1.5">
                {stats.monthlySeries.map(([month, cost]) => {
                  const pct = max > 0 ? (cost / max) * 100 : 0
                  return (
                    <div key={month} className="flex items-center gap-2 text-xs">
                      <span className="w-16 text-gray-500">{month}</span>
                      <div className="flex-1 h-3 bg-gray-700 rounded overflow-hidden">
                        <div className="h-full bg-amber-500" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-16 text-right text-gray-300 tabular-nums">{fmtUsd(cost)}</span>
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </div>
      </div>
    </section>
  )
}

function StatusBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 text-gray-400">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right text-gray-300 tabular-nums">{value}</span>
    </div>
  )
}
