'use client'

import { useState, useEffect, useCallback } from 'react'
import { LottieLoader } from '@/components/ui/LottieLoader'

// ── Types ──────────────────────────────────────────────────────────────────────
interface BalanceData {
  dataforseo: {
    money_balance: number | null
    api_calls_today: number | null
    api_calls_total: number | null
    error?: string
  }
  semrush: {
    units_remaining: number | null
    plan_supports_balance?: boolean
    error?: string
  }
  anthropic: {
    month_to_date_usd:  number
    total_calls_mtd:    number
    total_input_tokens:  number
    total_output_tokens: number
    by_model:    { model: string; calls: number; cost_usd: number; input_tokens: number; output_tokens: number }[]
    by_endpoint: { endpoint: string; calls: number; cost_usd: number }[]
    budget?: {
      monthly_usd:    number | null
      projected_usd:  number
      pct_used:       number | null
      pct_projected:  number | null
      days_elapsed:   number
      days_in_month:  number
    }
    error?: string
  }
  checked_at: string
}

interface UsageData {
  period_months: number
  total_calls: number
  totals_by_api: { api: string; calls: number }[]
  monthly: { month: string; api: string; calls: number }[]
  by_trigger: { trigger: string; calls: number }[]
  recent: {
    api: string
    endpoint: string | null
    call_count: number
    triggered_by: string | null
    created_at: string
  }[]
}

const API_COLORS: Record<string, string> = {
  dataforseo: 'text-blue-400',
  semrush:    'text-orange-400',
  firecrawl:  'text-green-400',
  claude:     'text-purple-400',
}

const API_BG: Record<string, string> = {
  dataforseo: 'bg-blue-900/30 border-blue-700/50',
  semrush:    'bg-orange-900/30 border-orange-700/50',
  firecrawl:  'bg-green-900/30 border-green-700/50',
  claude:     'bg-purple-900/30 border-purple-700/50',
}

const TRIGGER_LABELS: Record<string, string> = {
  brief_generate:   '✍️ Brief Generate',
  brief_draft:      '📝 Brief Draft',
  url_analysis:     '🔍 URL Analysis',
  backlink_refresh: '🔗 Backlink Refresh',
  backlink_check:   '🔗 Backlink Check',
  keyword_load:     '🔑 Keyword Load',
  other:            '⚙️ Other',
}

// ── Cost Reference ─────────────────────────────────────────────────────────────
const COST_REFERENCE = [
  { api: 'DataForSEO', endpoint: 'SERP organic (top 20)', unit: 'per task', est: '$0.0006 – $0.003' },
  { api: 'DataForSEO', endpoint: 'Keyword suggestions', unit: 'per keyword', est: '~$0.01' },
  { api: 'SEMrush', endpoint: 'Domain overview', unit: 'per call', est: '10 API units' },
  { api: 'SEMrush', endpoint: 'Domain organic keywords', unit: 'per row', est: '10 API units/row' },
  { api: 'Firecrawl', endpoint: 'Scrape page', unit: 'per page', est: '1 credit' },
  { api: 'Claude', endpoint: 'claude-opus-4-6 (brief)', unit: 'per call', est: '~$0.03 – $0.15' },
]

// ── Stat Card ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, colorClass }: { label: string; value: string; sub?: string; colorClass?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <p className="text-gray-400 text-xs font-semibold uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-bold ${colorClass ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-gray-500 text-xs mt-1">{sub}</p>}
    </div>
  )
}

// ── Monthly bar chart (simple CSS bars) ────────────────────────────────────────
function MonthlyChart({ monthly }: { monthly: UsageData['monthly'] }) {
  const apis = ['dataforseo', 'semrush', 'firecrawl', 'claude']

  // Build per-month totals (all APIs combined) for last 6 months
  const monthTotals = new Map<string, number>()
  for (const row of monthly) {
    monthTotals.set(row.month, (monthTotals.get(row.month) ?? 0) + row.calls)
  }
  const sortedMonths = Array.from(monthTotals.keys()).sort().slice(-6)
  const maxVal = Math.max(...Array.from(monthTotals.values()), 1)

  // Per-month, per-API breakdown
  const monthApiMap = new Map<string, Map<string, number>>()
  for (const row of monthly) {
    if (!monthApiMap.has(row.month)) monthApiMap.set(row.month, new Map())
    monthApiMap.get(row.month)!.set(row.api, row.calls)
  }

  if (sortedMonths.length === 0) {
    return <p className="text-gray-500 text-sm text-center py-8">No data yet — usage will appear here after your first API calls.</p>
  }

  return (
    <div className="space-y-3">
      {sortedMonths.reverse().map(month => {
        const total = monthTotals.get(month) ?? 0
        const pct   = Math.round((total / maxVal) * 100)
        const apiData = monthApiMap.get(month)

        return (
          <div key={month} className="space-y-1">
            <div className="flex justify-between text-xs text-gray-400">
              <span>{month}</span>
              <span>{total.toLocaleString()} calls</span>
            </div>
            {/* Stacked bar */}
            <div className="h-6 bg-gray-800 rounded-lg overflow-hidden flex" style={{ width: `${Math.max(pct, 2)}%` }}>
              {apis.map(api => {
                const calls   = apiData?.get(api) ?? 0
                const apiPct  = total > 0 ? (calls / total) * 100 : 0
                const bgColor = api === 'dataforseo' ? 'bg-blue-600' : api === 'semrush' ? 'bg-orange-500' : api === 'firecrawl' ? 'bg-green-600' : 'bg-purple-600'
                return calls > 0 ? (
                  <div
                    key={api}
                    className={`${bgColor} h-full`}
                    style={{ width: `${apiPct}%` }}
                    title={`${api}: ${calls}`}
                  />
                ) : null
              })}
            </div>
          </div>
        )
      })}

      {/* Legend */}
      <div className="flex gap-4 pt-2">
        {apis.map(api => (
          <div key={api} className="flex items-center gap-1.5 text-xs text-gray-400">
            <span className={`w-2.5 h-2.5 rounded-sm ${api === 'dataforseo' ? 'bg-blue-600' : api === 'semrush' ? 'bg-orange-500' : api === 'firecrawl' ? 'bg-green-600' : 'bg-purple-600'}`} />
            {api}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function ApiCostsPage() {
  const [balance, setBalance]       = useState<BalanceData | null>(null)
  const [usage, setUsage]           = useState<UsageData | null>(null)
  const [loadingBalance, setLB]     = useState(false)
  const [loadingUsage, setLU]       = useState(true)
  const [months, setMonths]         = useState(3)
  const [activeTab, setActiveTab]   = useState<'overview' | 'recent' | 'reference'>('overview')
  const [balanceErr, setBalanceErr] = useState<string | null>(null)

  const fetchUsage = useCallback(async (m: number) => {
    setLU(true)
    try {
      const res = await fetch(`/api/costs/usage?months=${m}`)
      if (res.ok) setUsage(await res.json())
    } catch { /* silent */ }
    setLU(false)
  }, [])

  useEffect(() => { fetchUsage(months) }, [fetchUsage, months])

  async function checkBalance() {
    setLB(true)
    setBalanceErr(null)
    try {
      const res = await fetch('/api/costs/balance')
      if (res.ok) setBalance(await res.json())
      else setBalanceErr('Failed to fetch balance')
    } catch { setBalanceErr('Network error') }
    setLB(false)
  }

  return (
    <div className="min-h-screen bg-gray-950 p-8">
      <div className="max-w-5xl mx-auto space-y-8">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white mb-1">💰 API Cost Tracker</h1>
            <p className="text-gray-400">Live balances + call volume by API and feature</p>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={months}
              onChange={e => setMonths(parseInt(e.target.value))}
              className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-red-700"
            >
              {[1, 2, 3, 6, 12].map(m => (
                <option key={m} value={m}>Last {m} month{m > 1 ? 's' : ''}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Live Balance Section */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-white font-semibold text-lg">Live API Balances</h2>
            <button
              onClick={checkBalance}
              disabled={loadingBalance}
              className="px-4 py-2 bg-red-700 text-white text-sm font-medium rounded-lg hover:bg-red-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loadingBalance ? '⟳ Checking…' : '🔄 Check Balances'}
            </button>
          </div>

          {balanceErr && <p className="text-red-400 text-sm">{balanceErr}</p>}

          {!balance && !loadingBalance && (
            <p className="text-gray-500 text-sm">Click "Check Balances" to fetch live credit info from DataForSEO and SEMrush.</p>
          )}

          {balance && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* DataForSEO */}
              <div className={`border rounded-xl p-5 ${API_BG.dataforseo}`}>
                <p className="text-blue-400 font-semibold mb-3">📊 DataForSEO</p>
                {balance.dataforseo.error ? (
                  <p className="text-red-400 text-sm break-words">{balance.dataforseo.error}</p>
                ) : (
                  <div className="space-y-2">
                    <div>
                      <p className="text-gray-400 text-xs">Money Balance</p>
                      <p className="text-2xl font-bold text-white">
                        ${balance.dataforseo.money_balance?.toFixed(2) ?? '—'}
                      </p>
                      <p className="text-gray-500 text-[11px] mt-1">Live from DataForSEO API</p>
                    </div>
                  </div>
                )}
              </div>

              {/* SEMrush — graceful for plans without api_units */}
              <div className={`border rounded-xl p-5 ${API_BG.semrush}`}>
                <p className="text-orange-400 font-semibold mb-3">🎯 SEMrush</p>
                {balance.semrush.error && balance.semrush.plan_supports_balance === false ? (
                  <div>
                    <p className="text-amber-300 text-sm">⚠️ Plan limit</p>
                    <p className="text-gray-400 text-xs mt-1.5 leading-relaxed">{balance.semrush.error}</p>
                    <a
                      href="https://www.semrush.com/api-analytics/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-orange-400 text-xs underline mt-2 inline-block"
                    >
                      Check usage in SEMrush dashboard →
                    </a>
                  </div>
                ) : balance.semrush.error ? (
                  <p className="text-red-400 text-sm break-words">{balance.semrush.error}</p>
                ) : (
                  <div>
                    <p className="text-gray-400 text-xs">API Units Remaining</p>
                    <p className="text-2xl font-bold text-white">
                      {balance.semrush.units_remaining?.toLocaleString() ?? '—'}
                    </p>
                    <p className="text-gray-500 text-[11px] mt-2">Resets monthly with subscription</p>
                  </div>
                )}
              </div>

              {/* Anthropic — month-to-date spend computed from logs */}
              <div className={`border rounded-xl p-5 ${API_BG.claude}`}>
                <p className="text-purple-400 font-semibold mb-3">🧠 Anthropic (Claude)</p>
                {balance.anthropic.error ? (
                  <p className="text-red-400 text-sm break-words">{balance.anthropic.error}</p>
                ) : (
                  <div className="space-y-2">
                    <div>
                      <p className="text-gray-400 text-xs">Spent this month</p>
                      <p className="text-2xl font-bold text-white">
                        ${balance.anthropic.month_to_date_usd.toFixed(2)}
                      </p>
                    </div>
                    <div className="flex gap-4 text-xs flex-wrap">
                      <div>
                        <p className="text-gray-500">Calls</p>
                        <p className="text-gray-300">{balance.anthropic.total_calls_mtd.toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">Tokens (in / out)</p>
                        <p className="text-gray-300">
                          {(balance.anthropic.total_input_tokens / 1000).toFixed(0)}K / {(balance.anthropic.total_output_tokens / 1000).toFixed(0)}K
                        </p>
                      </div>
                    </div>
                    <p className="text-gray-500 text-[11px]">Computed from token logs × pricing table</p>

                    {/* Budget tracker — only shown if ANTHROPIC_MONTHLY_BUDGET_USD env set */}
                    {balance.anthropic.budget?.monthly_usd && balance.anthropic.budget.pct_used !== null && (
                      <div className="pt-2 border-t border-purple-700/30">
                        <div className="flex items-center justify-between text-[11px] mb-1">
                          <span className="text-gray-400">Budget · ${balance.anthropic.budget.monthly_usd.toFixed(0)}/mo</span>
                          <span className={
                            balance.anthropic.budget.pct_projected != null && balance.anthropic.budget.pct_projected > 100 ? 'text-red-300' :
                            balance.anthropic.budget.pct_projected != null && balance.anthropic.budget.pct_projected > 80  ? 'text-amber-300' : 'text-gray-400'
                          }>
                            {balance.anthropic.budget.pct_used}% used · projected {balance.anthropic.budget.pct_projected}%
                          </span>
                        </div>
                        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className={
                              balance.anthropic.budget.pct_used > 100 ? 'h-full bg-red-500' :
                              balance.anthropic.budget.pct_used > 80  ? 'h-full bg-amber-500' : 'h-full bg-purple-500'
                            }
                            style={{ width: `${Math.min(balance.anthropic.budget.pct_used, 100)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Anthropic per-model breakdown (only if there's spend) */}
          {balance?.anthropic && balance.anthropic.by_model.length > 0 && (
            <div className="mt-4 bg-gray-950 border border-gray-800 rounded-xl p-4">
              <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">Claude spend breakdown (this month)</p>
              <table className="w-full text-xs">
                <thead className="text-gray-500">
                  <tr>
                    <th className="text-left  py-1.5">Model / endpoint</th>
                    <th className="text-right py-1.5">Calls</th>
                    <th className="text-right py-1.5">Cost (USD)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {balance.anthropic.by_model.map(m => (
                    <tr key={m.model} className="text-purple-300">
                      <td className="py-1 font-mono">{m.model}</td>
                      <td className="py-1 text-right text-gray-300">{m.calls}</td>
                      <td className="py-1 text-right">${m.cost_usd.toFixed(4)}</td>
                    </tr>
                  ))}
                  {balance.anthropic.by_endpoint.map(e => (
                    <tr key={e.endpoint} className="text-gray-400">
                      <td className="py-1 pl-3 italic">└ {e.endpoint}</td>
                      <td className="py-1 text-right">{e.calls}</td>
                      <td className="py-1 text-right">${e.cost_usd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {balance && (
            <p className="text-gray-600 text-xs">Last checked: {new Date(balance.checked_at).toLocaleString()}</p>
          )}
        </div>

        {/* Usage Stats */}
        {loadingUsage ? (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <LottieLoader size={70} text="Loading usage data…" />
          </div>
        ) : usage ? (
          <div className="space-y-6">
            {/* Summary Cards */}
            <div className="grid grid-cols-4 gap-4">
              <StatCard
                label="Total API Calls"
                value={usage.total_calls.toLocaleString()}
                sub={`last ${usage.period_months} month${usage.period_months > 1 ? 's' : ''}`}
              />
              {usage.totals_by_api.slice(0, 3).map(({ api, calls }) => (
                <StatCard
                  key={api}
                  label={api.charAt(0).toUpperCase() + api.slice(1)}
                  value={calls.toLocaleString()}
                  sub="calls"
                  colorClass={API_COLORS[api] ?? 'text-white'}
                />
              ))}
            </div>

            {/* Tabs */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
              <div className="flex border-b border-gray-800">
                {[
                  { id: 'overview' as const,   label: '📊 Monthly Usage' },
                  { id: 'recent'   as const,   label: '🕐 Recent Calls' },
                  { id: 'reference' as const,  label: '💡 Cost Reference' },
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex-1 px-6 py-4 font-medium text-sm transition border-b-2 ${
                      activeTab === tab.id
                        ? 'text-white border-b-red-700'
                        : 'text-gray-400 border-b-transparent hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="p-6">
                {/* Monthly Chart */}
                {activeTab === 'overview' && (
                  <div className="space-y-8">
                    <MonthlyChart monthly={usage.monthly} />

                    {/* By Trigger */}
                    {usage.by_trigger.length > 0 && (
                      <div>
                        <p className="text-gray-400 text-xs font-semibold uppercase mb-4">Calls by Feature</p>
                        <div className="space-y-2">
                          {usage.by_trigger.map(({ trigger, calls }) => {
                            const maxCalls = usage.by_trigger[0].calls
                            const pct = Math.round((calls / maxCalls) * 100)
                            return (
                              <div key={trigger} className="flex items-center gap-3">
                                <span className="text-gray-300 text-sm w-44 flex-shrink-0">
                                  {TRIGGER_LABELS[trigger] ?? trigger}
                                </span>
                                <div className="flex-1 bg-gray-800 rounded-full h-2">
                                  <div className="bg-red-700 h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
                                </div>
                                <span className="text-gray-400 text-sm w-16 text-right">{calls.toLocaleString()}</span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Recent Calls */}
                {activeTab === 'recent' && (
                  <div className="overflow-x-auto">
                    {usage.recent.length === 0 ? (
                      <p className="text-gray-500 text-sm text-center py-8">No recent calls recorded yet.</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-700">
                            <th className="text-left py-3 px-3 text-gray-400 font-semibold">API</th>
                            <th className="text-left py-3 px-3 text-gray-400 font-semibold">Endpoint</th>
                            <th className="text-left py-3 px-3 text-gray-400 font-semibold">Feature</th>
                            <th className="text-right py-3 px-3 text-gray-400 font-semibold">Calls</th>
                            <th className="text-right py-3 px-3 text-gray-400 font-semibold">Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {usage.recent.map((row, i) => (
                            <tr key={i} className="border-b border-gray-800 hover:bg-gray-800/50 transition">
                              <td className="py-2.5 px-3">
                                <span className={`font-medium ${API_COLORS[row.api] ?? 'text-gray-300'}`}>{row.api}</span>
                              </td>
                              <td className="py-2.5 px-3 text-gray-300 text-xs font-mono">{row.endpoint ?? '—'}</td>
                              <td className="py-2.5 px-3 text-gray-400 text-xs">
                                {TRIGGER_LABELS[row.triggered_by ?? ''] ?? row.triggered_by ?? '—'}
                              </td>
                              <td className="text-right py-2.5 px-3 text-gray-300">{row.call_count}</td>
                              <td className="text-right py-2.5 px-3 text-gray-500 text-xs">
                                {new Date(row.created_at).toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {/* Cost Reference */}
                {activeTab === 'reference' && (
                  <div className="space-y-4">
                    <p className="text-gray-400 text-sm">Estimated costs per API call — use this as a reference for monthly budget planning.</p>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-700">
                          <th className="text-left py-3 px-3 text-gray-400 font-semibold">API</th>
                          <th className="text-left py-3 px-3 text-gray-400 font-semibold">Endpoint</th>
                          <th className="text-left py-3 px-3 text-gray-400 font-semibold">Unit</th>
                          <th className="text-right py-3 px-3 text-gray-400 font-semibold">Est. Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {COST_REFERENCE.map((row, i) => (
                          <tr key={i} className="border-b border-gray-800">
                            <td className="py-3 px-3 text-gray-300 font-medium">{row.api}</td>
                            <td className="py-3 px-3 text-gray-300 text-xs">{row.endpoint}</td>
                            <td className="py-3 px-3 text-gray-500 text-xs">{row.unit}</td>
                            <td className="text-right py-3 px-3 text-green-400 font-mono text-xs">{row.est}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="text-gray-600 text-xs pt-2">
                      * DataForSEO costs depend on task depth. SERP top-10 ≈ $0.0006, top-100 ≈ $0.003.
                      Claude costs vary by model — Opus is ~5× more expensive than Haiku.
                      Check your provider dashboards for exact figures.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <p className="text-gray-500">No usage data available</p>
          </div>
        )}
      </div>
    </div>
  )
}
