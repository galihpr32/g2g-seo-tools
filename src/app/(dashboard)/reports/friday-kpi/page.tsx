'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * /reports/friday-kpi — Sprint FRIDAY.KPI v2
 *
 * Trigger button + live KPI preview (Most Competitive Keyword Rankings +
 * Clicks/Impressions WoW per brand × market).
 */

interface MarketKpi {
  market:        'us' | 'id'
  market_label:  string
  kw_count:      number
  avg_position:  number | null
  avg_pos_delta: number | null
  top3:          number
  top3_delta:    number
  top10:         number
  top10_delta:   number
}

interface ClickKpi {
  market:       'us' | 'id'
  market_label: string
  clicks:       number
  clicks_pct:   number | null
  impressions:  number
  imp_pct:      number | null
}

interface BrandKpi {
  site_slug: string
  serp:      MarketKpi[]
  traffic:   ClickKpi[]
}

interface PreviewResponse {
  ok:      boolean
  sites:   string[]
  payload: {
    week_label:      string
    iso_week:        number
    generated_at:    string
    brands:          BrandKpi[]
    methodology_url: string
    priority_url:    string
    public_url:      string | null
  }
  error?: string
}

interface SendResult {
  ok:           boolean
  posted:       boolean
  slack_status?: number
  reason?:      string
  hint?:        string
  summary?:     { total_kws: number; brands: number; iso_week: number }
}

export default function FridayKpiPage() {
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState<SendResult | null>(null)

  async function loadPreview() {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/reports/friday-kpi')
      const text = await res.text()
      let body: PreviewResponse | { error?: string } = {}
      try { body = text ? JSON.parse(text) : {} } catch {
        setError(`HTTP ${res.status} · non-JSON response (first 200): ${text.slice(0, 200)}`)
        return
      }
      if (!res.ok) { setError(('error' in body && body.error) || `HTTP ${res.status}`); return }
      setPreview(body as PreviewResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void loadPreview() }, [])

  async function send() {
    if (!confirm('Send the Friday KPI digest to Slack now?')) return
    setSending(true); setSendResult(null)
    try {
      const res  = await fetch('/api/reports/friday-kpi', { method: 'POST' })
      const body = await res.json() as SendResult
      setSendResult(body)
    } catch (e) {
      setSendResult({ ok: false, posted: false, reason: e instanceof Error ? e.message : String(e) })
    } finally { setSending(false) }
  }

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto">
      <Link href="/reports/weekly" className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 mb-2">← Reports</Link>
      <h1 className="text-2xl font-bold text-white mb-1">📊 Friday KPI Digest</h1>
      <p className="text-sm text-gray-400 mb-6">
        Combined G2G + OffGamers weekly KPI wrap. Auto-fires every <strong className="text-white">Friday 15:00 WIB</strong>.
        Layout matches the boss-meeting template:{' '}
        Most Competitive Keyword Rankings + GSC Clicks/Impressions WoW per (brand × market).
      </p>

      <section className="bg-gradient-to-br from-purple-900/30 to-indigo-900/20 border border-purple-700/40 rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-white font-semibold mb-1">Manual trigger</h2>
            <p className="text-xs text-purple-200/80">Posts to <code>notification_type=friday_kpi</code> Slack route. Live preview below.</p>
          </div>
          <button onClick={send} disabled={sending || loading}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition">
            {sending ? '📤 Sending…' : '📤 Send Friday KPI to Slack now'}
          </button>
        </div>
        {sendResult && (
          <div className={`mt-3 text-xs rounded-lg p-3 ${sendResult.posted ? 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-200' : 'bg-red-500/15 border border-red-500/40 text-red-200'}`}>
            {sendResult.posted
              ? <>✅ Sent · Slack {sendResult.slack_status} · {sendResult.summary?.total_kws ?? 0} kws · {sendResult.summary?.brands ?? 0} brands · Week {sendResult.summary?.iso_week ?? '—'}</>
              : <>❌ Not sent — {sendResult.reason ?? 'unknown'}{sendResult.hint && <p className="mt-1 italic text-red-300/80">{sendResult.hint}</p>}</>}
          </div>
        )}
      </section>

      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-semibold">📊 Live preview</h2>
          <button onClick={loadPreview} className="text-xs text-gray-400 hover:text-white">↻ Refresh</button>
        </div>

        {loading && <p className="text-sm text-gray-500">Building preview…</p>}
        {error && <p className="text-sm text-red-400">Failed: {error}</p>}

        {preview && preview.payload && (
          <>
            <p className="text-xs text-gray-500 mb-4">
              <strong className="text-white">{preview.payload.week_label}</strong> ·
              Sites: <code className="text-amber-300">{preview.sites.join(', ')}</code>
            </p>

            {/* Most Competitive Keyword Rankings */}
            <h3 className="text-sm font-bold text-white mb-2">🥇 Most Competitive Keyword Rankings</h3>
            <div className="bg-gray-950/40 border border-gray-800 rounded-lg overflow-x-auto mb-3">
              <table className="w-full text-xs">
                <thead className="bg-gray-800/40 text-gray-400 text-[10px] uppercase">
                  <tr>
                    <th className="text-left  px-3 py-1.5">Brand</th>
                    <th className="text-left  px-3 py-1.5">Market</th>
                    <th className="text-right px-3 py-1.5">KWs</th>
                    <th className="text-right px-3 py-1.5">Avg Pos</th>
                    <th className="text-right px-3 py-1.5">Δ</th>
                    <th className="text-right px-3 py-1.5">Top 3</th>
                    <th className="text-right px-3 py-1.5">Top 10</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.payload.brands.flatMap(b => b.serp.map(m => (
                    <tr key={`${b.site_slug}-${m.market}`} className="border-t border-gray-800">
                      <td className="px-3 py-1.5 text-white">{b.site_slug.toUpperCase()}</td>
                      <td className="px-3 py-1.5 text-gray-300">{m.market_label}</td>
                      <td className="px-3 py-1.5 text-right text-gray-200">{m.kw_count}</td>
                      <td className="px-3 py-1.5 text-right text-gray-200">{m.avg_position ?? '—'}</td>
                      <td className={`px-3 py-1.5 text-right ${(m.avg_pos_delta ?? 0) > 0 ? 'text-emerald-400' : (m.avg_pos_delta ?? 0) < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                        {m.avg_pos_delta == null ? '—' : (m.avg_pos_delta > 0 ? `↑${m.avg_pos_delta}` : m.avg_pos_delta < 0 ? `↓${Math.abs(m.avg_pos_delta)}` : '·')}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-200">{m.top3} {sign(m.top3_delta)}</td>
                      <td className="px-3 py-1.5 text-right text-gray-200">{m.top10} {sign(m.top10_delta)}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>

            {/* Traffic */}
            <h3 className="text-sm font-bold text-white mb-2">📈 SEO Traffic — GSC clicks/impressions WoW</h3>
            <div className="bg-gray-950/40 border border-gray-800 rounded-lg overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-800/40 text-gray-400 text-[10px] uppercase">
                  <tr>
                    <th className="text-left  px-3 py-1.5">Brand</th>
                    <th className="text-left  px-3 py-1.5">Market</th>
                    <th className="text-right px-3 py-1.5">Clicks</th>
                    <th className="text-right px-3 py-1.5">Δ%</th>
                    <th className="text-right px-3 py-1.5">Impressions</th>
                    <th className="text-right px-3 py-1.5">Δ%</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.payload.brands.flatMap(b => b.traffic.map(t => (
                    <tr key={`${b.site_slug}-${t.market}-tr`} className="border-t border-gray-800">
                      <td className="px-3 py-1.5 text-white">{b.site_slug.toUpperCase()}</td>
                      <td className="px-3 py-1.5 text-gray-300">{t.market_label}</td>
                      <td className="px-3 py-1.5 text-right text-gray-200">{t.clicks.toLocaleString()}</td>
                      <td className={`px-3 py-1.5 text-right ${(t.clicks_pct ?? 0) > 0 ? 'text-emerald-400' : (t.clicks_pct ?? 0) < 0 ? 'text-red-400' : 'text-gray-500'}`}>{pct(t.clicks_pct)}</td>
                      <td className="px-3 py-1.5 text-right text-gray-200">{t.impressions.toLocaleString()}</td>
                      <td className={`px-3 py-1.5 text-right ${(t.imp_pct ?? 0) > 0 ? 'text-emerald-400' : (t.imp_pct ?? 0) < 0 ? 'text-red-400' : 'text-gray-500'}`}>{pct(t.imp_pct)}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
              <p className="text-[10px] text-gray-500 italic px-3 py-2">
                Last 7 days vs prior 7 days (3-day GSC freshness lag) · ID = country=idn; Global = all other countries.
              </p>
            </div>

            <div className="flex gap-3 mt-4 text-xs">
              <Link href="/methodology/competitive-keywords" className="text-blue-400 hover:text-blue-300">🎯 Methodology</Link>
              <Link href="/priority-products" className="text-blue-400 hover:text-blue-300">📊 Priority Products</Link>
              {preview.payload.public_url && (
                <a href={preview.payload.public_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">📄 Public weekly report</a>
              )}
            </div>
          </>
        )}
      </section>

      <section className="bg-gray-900/40 border border-gray-800 rounded-xl p-4 text-xs text-gray-400">
        <strong className="text-white">Schedule:</strong> Friday 08:00 UTC (15:00 WIB) · workflow_dispatch enabled ·
        Slack channel resolved via <Link href="/settings/slack-routing" className="text-blue-400 hover:underline">routing settings</Link> (notification_type=friday_kpi).
      </section>
    </div>
  )
}

function sign(d: number): string {
  if (d === 0) return ''
  return d > 0 ? `(+${d})` : `(${d})`
}

function pct(d: number | null): string {
  if (d == null) return '—'
  if (Math.abs(d) < 0.1) return 'flat'
  return d > 0 ? `↑${d.toFixed(0)}%` : `↓${Math.abs(d).toFixed(0)}%`
}
