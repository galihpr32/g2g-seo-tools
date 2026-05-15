'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * /reports/friday-kpi — Sprint FRIDAY.KPI
 *
 * Three things this page does:
 *   1. Live preview of what the digest contains RIGHT NOW (auto-fetches on load)
 *   2. Big "Send to Slack now" button — manual trigger for this week's run
 *   3. Schedule + routing reminder so Galih knows when the auto-cron fires
 */

interface ActionItemView {
  id:                 string
  page:               string | null
  title:              string
  action_type:        string | null
  priority:           string | null
  notification_type:  string | null
  search_volume:      number | null
  intent:             string | null
}

interface BucketView {
  notification_type: string
  count:             number
  top_items:         ActionItemView[]
}

interface BrandView {
  site_slug:       string
  total_items:     number
  buckets:         BucketView[]
  top_movers_up:   Array<{ keyword: string; market: string; from: number | null; to: number | null; product: string | null }>
  top_movers_down: Array<{ keyword: string; market: string; from: number | null; to: number | null; product: string | null }>
}

interface PreviewResponse {
  ok:      boolean
  sites:   string[]
  payload: {
    week_label:   string
    generated_at: string
    brands:       BrandView[]
    cost:         { yearMonth: string; anthropicUsd: number; totalUsd: number }
    experiments: {
      id_native_ab: { enrolled_total: number; en_translate: number; id_native: number; note: string }
    }
  }
  error?: string
}

interface SendResult {
  ok:           boolean
  posted:       boolean
  slack_status?: number
  reason?:      string
  hint?:        string
  summary?:     { total_items: number; anthropic_usd: number; enrolled_briefs: number }
}

const BUCKET_LABELS: Record<string, string> = {
  tier_rank:  '📊 Tier rank movement',
  gsc_signal: '🔎 GSC signal',
  cms_alert:  '📦 CMS alert',
  cost_alert: '💰 Cost alert',
  backlink:   '🔗 Backlink',
  mimir:      '🧠 Mimir learning',
  manual:     '✍️ Manual',
}

export default function FridayKpiPage() {
  const [preview, setPreview]   = useState<PreviewResponse | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error,   setError]     = useState<string | null>(null)
  const [sending, setSending]   = useState(false)
  const [sendResult, setSendResult] = useState<SendResult | null>(null)

  async function loadPreview() {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/reports/friday-kpi')
      const text = await res.text()
      let body: PreviewResponse | { error?: string } = {}
      try { body = text ? JSON.parse(text) : {} } catch {
        setError(`HTTP ${res.status} · non-JSON response (first 200 chars): ${text.slice(0, 200)}`)
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
    if (!confirm('Send the Friday KPI digest to Slack now?\n\nThis posts to the channel mapped to notification_type=friday_kpi.')) return
    setSending(true); setSendResult(null)
    try {
      const res  = await fetch('/api/reports/friday-kpi', { method: 'POST' })
      const body = await res.json() as SendResult
      setSendResult(body)
    } catch (e) {
      setSendResult({ ok: false, posted: false, reason: e instanceof Error ? e.message : String(e) })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto">
      <Link href="/reports/weekly" className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 mb-2">
        ← Reports
      </Link>
      <h1 className="text-2xl font-bold text-white mb-1">🗓 Friday KPI Digest</h1>
      <p className="text-sm text-gray-400 mb-6">
        Combined G2G + OffGamers weekly digest. Auto-fires every <strong className="text-white">Friday at 15:00 WIB</strong> (08:00 UTC).
        Routes to whichever Slack channel is mapped to <code className="text-amber-300">notification_type=friday_kpi</code> in{' '}
        <Link href="/settings/slack-routing" className="text-blue-400 hover:underline">slack routing settings</Link>.
      </p>

      {/* Trigger card */}
      <section className="bg-gradient-to-br from-purple-900/30 to-indigo-900/20 border border-purple-700/40 rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-white font-semibold mb-1">Manual trigger</h2>
            <p className="text-xs text-purple-200/80">
              Use this for the first run this week, or to push a fresh digest after a big update.
              Slack notification fires immediately — no email, no delay.
            </p>
          </div>
          <button
            onClick={send}
            disabled={sending || loading || !preview}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition"
          >
            {sending ? '📤 Sending…' : '📤 Send Friday KPI to Slack now'}
          </button>
        </div>

        {sendResult && (
          <div className={`mt-3 text-xs rounded-lg p-3 ${
            sendResult.posted
              ? 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-200'
              : 'bg-red-500/15 border border-red-500/40 text-red-200'
          }`}>
            {sendResult.posted ? (
              <>
                ✅ Sent · Slack status {sendResult.slack_status} ·
                {sendResult.summary && (
                  <> {sendResult.summary.total_items} items · ${sendResult.summary.anthropic_usd.toFixed(2)} MTD ·
                  {' '}{sendResult.summary.enrolled_briefs} A/B briefs</>
                )}
              </>
            ) : (
              <>
                ❌ Not sent — {sendResult.reason ?? 'unknown error'}
                {sendResult.hint && <p className="mt-1 italic text-red-300/80">{sendResult.hint}</p>}
              </>
            )}
          </div>
        )}
      </section>

      {/* Preview */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-semibold">Live preview</h2>
          <button onClick={loadPreview} className="text-xs text-gray-400 hover:text-white">↻ Refresh</button>
        </div>

        {loading && <p className="text-sm text-gray-500">Building preview…</p>}
        {error && <p className="text-sm text-red-400">Failed: {error}</p>}

        {preview && preview.payload && (
          <div className="space-y-4">
            <div className="text-xs text-gray-400">
              <strong className="text-white">{preview.payload.week_label}</strong> ·
              {' '}Sites: <code className="text-amber-300">{preview.sites.join(', ')}</code> ·
              {' '}Generated {new Date(preview.payload.generated_at).toLocaleString()}
            </div>

            {/* Header stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat label="Action items" value={preview.payload.brands.reduce((s, b) => s + b.total_items, 0).toString()} />
              <Stat label="Brands" value={preview.payload.brands.length.toString()} />
              <Stat label="Anthropic MTD" value={`$${preview.payload.cost.anthropicUsd.toFixed(2)}`} />
              <Stat label="A/B cohort" value={preview.payload.experiments.id_native_ab.enrolled_total.toString()} />
            </div>

            {preview.payload.brands.map(brand => (
              <BrandSection key={brand.site_slug} brand={brand} />
            ))}
          </div>
        )}
      </section>

      {/* Schedule info */}
      <section className="bg-gray-900/40 border border-gray-800 rounded-xl p-4 text-xs text-gray-400 space-y-1">
        <p>
          <strong className="text-white">Schedule:</strong> Friday 08:00 UTC (= 15:00 WIB) via{' '}
          <code className="text-amber-300">.github/workflows/friday-kpi.yml</code>
        </p>
        <p>
          <strong className="text-white">Manual GitHub Actions trigger:</strong> Actions tab → &quot;Friday KPI Digest&quot; → Run workflow
        </p>
        <p>
          <strong className="text-white">Slack channel:</strong> resolved via{' '}
          <Link href="/settings/slack-routing" className="text-blue-400 hover:underline">slack-routing</Link>{' '}
          (notification_type=<code className="text-amber-300">friday_kpi</code>). Falls back to{' '}
          <code className="text-amber-300">SLACK_WEBHOOK_URL</code> env if no row set.
        </p>
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-950/50 border border-gray-800 rounded-lg p-3">
      <p className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-1">{label}</p>
      <p className="text-xl font-bold text-white">{value}</p>
    </div>
  )
}

function BrandSection({ brand }: { brand: BrandView }) {
  return (
    <div className="bg-gray-950/40 border border-gray-800 rounded-lg p-4">
      <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
          brand.site_slug.toLowerCase() === 'g2g'
            ? 'bg-red-500/15 text-red-300 border-red-500/30'
            : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
        }`}>{brand.site_slug.toUpperCase()}</span>
        <span>{brand.total_items} action item{brand.total_items !== 1 ? 's' : ''}</span>
      </h3>

      {brand.buckets.length === 0 && brand.top_movers_up.length === 0 && brand.top_movers_down.length === 0 ? (
        <p className="text-xs text-gray-500 italic">No items or significant movement this week.</p>
      ) : (
        <>
          {brand.buckets.map(b => (
            <div key={b.notification_type} className="mb-3 last:mb-0">
              <p className="text-xs font-semibold text-gray-300 mb-1.5">
                {BUCKET_LABELS[b.notification_type] ?? b.notification_type} <span className="text-gray-500">({b.count})</span>
              </p>
              <ul className="space-y-1 text-xs text-gray-200">
                {b.top_items.map(it => (
                  <li key={it.id} className="flex gap-2">
                    <span className="text-gray-600">▸</span>
                    <span className="flex-1">
                      {it.title}
                      <span className="text-gray-500">
                        {' '}— SV {it.search_volume ? it.search_volume.toLocaleString() : '—'}
                        {it.intent && ` · ${it.intent}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {(brand.top_movers_up.length > 0 || brand.top_movers_down.length > 0) && (
            <div className="mt-3 pt-3 border-t border-gray-800">
              <p className="text-xs font-semibold text-gray-300 mb-1.5">📈 Top movers (last 2 weeks)</p>
              <ul className="space-y-0.5 text-xs">
                {brand.top_movers_up.map((m, i) => (
                  <li key={`up-${i}`} className="text-emerald-300">
                    📈 {m.keyword} ({m.market.toUpperCase()}) — #{m.from ?? '—'} → #{m.to ?? '—'}
                  </li>
                ))}
                {brand.top_movers_down.map((m, i) => (
                  <li key={`down-${i}`} className="text-red-300">
                    📉 {m.keyword} ({m.market.toUpperCase()}) — #{m.from ?? '—'} → #{m.to ?? '—'}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}
