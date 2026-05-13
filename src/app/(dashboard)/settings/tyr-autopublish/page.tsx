'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// ─── Tyr Auto-Publish Settings ──────────────────────────────────────────────
// Per-tier threshold config that decides if a brief skips human review.
// Direct answer to: "remove human review dependency for content auto-pub"

interface AutopublishCfg {
  tier_level:               number
  auto_publish_enabled:     boolean
  min_tyr_score:            number
  min_dimension_threshold:  number
  forbidden_violations_max: number
  notes?:                   string | null
}

const TIER_INFO = {
  0: { label: 'Non-tier products',  desc: 'All products not in tier 1 or 2 (most products).', tone: 'gray' },
  1: { label: 'Tier 1 — Top 10',    desc: 'Highest priority. Default: manual review required.', tone: 'amber' },
  2: { label: 'Tier 2 — Next 25',   desc: 'Mid priority. Default: auto-publish with stricter threshold.', tone: 'blue' },
} as const

export default function TyrAutopublishPage() {
  const [configs, setConfigs] = useState<AutopublishCfg[]>([])
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState<number | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [success, setSuccess] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const res = await fetch('/api/settings/tyr-autopublish')
        const data = await res.json() as { configs: AutopublishCfg[] }
        if (!cancelled) setConfigs(data.configs ?? [])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function save(tier: number) {
    const cfg = configs.find(c => Number(c.tier_level) === tier)
    if (!cfg) return
    setSaving(tier)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch('/api/settings/tyr-autopublish', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      })
      const data = await res.json()
      if (!res.ok) setError(data.error ?? 'Save failed')
      else setSuccess(tier)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setSaving(null)
    setTimeout(() => setSuccess(null), 2000)
  }

  function update(tier: number, patch: Partial<AutopublishCfg>) {
    setConfigs(prev => prev.map(c => Number(c.tier_level) === tier ? { ...c, ...patch } : c))
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">⚖ Tyr Auto-Publish Rules</h1>
          <p className="text-sm text-gray-400 mt-1">
            Per-tier thresholds that decide if a brief can skip human review and go straight to <code className="text-blue-300">auto_approved</code> after Tyr review.
            Designed to remove the manual review bottleneck for non-top products without sacrificing quality on Tier 1.
          </p>
        </div>
        <Link href="/settings" className="text-sm text-gray-400 hover:text-white">← Settings</Link>
      </div>

      <details className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 text-sm text-gray-300">
        <summary className="cursor-pointer font-medium text-white">How auto-publish works</summary>
        <ol className="list-decimal pl-5 mt-3 space-y-1.5">
          <li>Bragi generates a brief → Tyr scores it (0-100 overall, per-dimension 0-10).</li>
          <li>System resolves the brief&apos;s product tier (1 = top 10, 2 = next 25, 0 = non-tier).</li>
          <li>Tyr checks: <code>auto_publish_enabled</code>? Score ≥ threshold? All dims ≥ floor? Forbidden violations ≤ max?</li>
          <li>All pass → status = <code className="text-emerald-300">auto_approved</code> (no human action needed).<br/>
              Any fail → status = <code className="text-amber-300">needs_review</code> (writer/editor opens it).</li>
        </ol>
      </details>

      {loading && <div className="text-center py-12 text-gray-500">Loading…</div>}

      {!loading && configs.map(cfg => {
        const tier = Number(cfg.tier_level) as 0 | 1 | 2
        const info = TIER_INFO[tier]
        const toneClass = info.tone === 'gray'  ? 'border-gray-800'
                       : info.tone === 'amber' ? 'border-amber-700/40 bg-amber-500/5'
                       :                          'border-blue-700/40 bg-blue-500/5'
        return (
          <div key={tier} className={`rounded-lg border ${toneClass} bg-gray-900 p-5 space-y-3`}>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  {info.label}
                  {cfg.auto_publish_enabled ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">🟢 Auto-publish ON</span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-700 text-gray-300 border border-gray-600">⚪ Manual review</span>
                  )}
                </h2>
                <p className="text-xs text-gray-400 mt-1">{info.desc}</p>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-white">
              <input
                type="checkbox"
                checked={cfg.auto_publish_enabled}
                onChange={e => update(tier, { auto_publish_enabled: e.target.checked })}
              />
              Enable auto-publish for this tier
            </label>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Min Tyr score (0-100)</label>
                <input
                  type="number"
                  min={0} max={100}
                  value={cfg.min_tyr_score}
                  onChange={e => update(tier, { min_tyr_score: parseInt(e.target.value, 10) || 0 })}
                  disabled={!cfg.auto_publish_enabled}
                  className="w-full bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-gray-200 disabled:opacity-50"
                />
                <p className="text-[10px] text-gray-500 mt-1">Overall score floor. Stricter = fewer auto-approves.</p>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Min dimension floor (0-10)</label>
                <input
                  type="number"
                  min={0} max={10}
                  value={cfg.min_dimension_threshold}
                  onChange={e => update(tier, { min_dimension_threshold: parseInt(e.target.value, 10) || 0 })}
                  disabled={!cfg.auto_publish_enabled}
                  className="w-full bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-gray-200 disabled:opacity-50"
                />
                <p className="text-[10px] text-gray-500 mt-1">Every per-dimension score must be ≥ this.</p>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Max forbidden violations</label>
                <input
                  type="number"
                  min={0}
                  value={cfg.forbidden_violations_max}
                  onChange={e => update(tier, { forbidden_violations_max: parseInt(e.target.value, 10) || 0 })}
                  disabled={!cfg.auto_publish_enabled}
                  className="w-full bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-gray-200 disabled:opacity-50"
                />
                <p className="text-[10px] text-gray-500 mt-1">Forbidden-claim hits allowed. 0 = strict.</p>
              </div>
            </div>

            <textarea
              value={cfg.notes ?? ''}
              onChange={e => update(tier, { notes: e.target.value })}
              placeholder="Notes (optional, e.g. 'After 2-week A/B test, lower to 75')"
              className="w-full text-xs bg-gray-950 border border-gray-700 rounded-md p-2 text-gray-300"
              rows={2}
            />

            <div className="flex items-center gap-2">
              <button
                onClick={() => save(tier)}
                disabled={saving === tier}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-md"
              >
                {saving === tier ? 'Saving…' : 'Save'}
              </button>
              {success === tier && <span className="text-xs text-emerald-300">✓ Saved</span>}
            </div>
          </div>
        )
      })}

      {error && <div className="rounded-md border border-red-700/40 bg-red-500/5 p-3 text-sm text-red-300">⚠ {error}</div>}
    </div>
  )
}
