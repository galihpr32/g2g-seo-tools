'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// ─── G2G CMS JWT manager ────────────────────────────────────────────────────
// JWT expires roughly once a week. The BDT (or admin) refreshes by:
//   1. Logging into the G2G admin (with Authy 2FA)
//   2. Opening DevTools → Network → any admin request
//   3. Copying the full `Authorization: Bearer …` value
//   4. Pasting it here, picking a brand, saving
//
// Once saved, the cron auto-upload (in processProductRow) immediately picks
// up the fresh token and unsticks any rows parked as `awaiting_token`.

type SiteSlug = 'g2g' | 'offgamers'

interface TokenStatus {
  site_slug:     SiteSlug
  has_token:     boolean
  expires_at:    string | null
  token_subject: string | null
  updated_at:    string | null
}

const SITES: { slug: SiteSlug; label: string }[] = [
  { slug: 'g2g',       label: 'G2G' },
  { slug: 'offgamers', label: 'OffGamers' },
]

export default function CmsTokenPage() {
  const [tokens,  setTokens]  = useState<Record<SiteSlug, TokenStatus | null>>({ g2g: null, offgamers: null })
  const [loading, setLoading] = useState(true)
  const [drafts,  setDrafts]  = useState<Record<SiteSlug, string>>({ g2g: '', offgamers: '' })
  const [saving,  setSaving]  = useState<SiteSlug | null>(null)
  const [errors,  setErrors]  = useState<Record<SiteSlug, string | null>>({ g2g: null, offgamers: null })
  const [success, setSuccess] = useState<Record<SiteSlug, string | null>>({ g2g: null, offgamers: null })
  // Mount-time "now" — used for the StatusPill/daysUntil math. Keeping the
  // value stable for the page lifetime is fine; the badge accuracy is
  // measured in days, not seconds. (Avoids the react-hooks/purity rule that
  // flags Date.now() during render.)
  const [now] = useState<number>(() => Date.now())

  useEffect(() => { void refresh() }, [])

  async function refresh() {
    setLoading(true)
    try {
      const res = await fetch('/api/settings/cms-token')
      const data = await res.json() as { tokens?: TokenStatus[] }
      const map: Record<SiteSlug, TokenStatus | null> = { g2g: null, offgamers: null }
      for (const t of data.tokens ?? []) map[t.site_slug] = t
      setTokens(map)
    } catch (e) {
      console.error('Failed to load cms-token status', e)
    }
    setLoading(false)
  }

  async function save(slug: SiteSlug) {
    const token = drafts[slug].trim()
    if (!token) {
      setErrors(prev => ({ ...prev, [slug]: 'Paste a JWT first.' }))
      return
    }
    setSaving(slug)
    setErrors(prev => ({ ...prev, [slug]: null }))
    setSuccess(prev => ({ ...prev, [slug]: null }))
    try {
      const res = await fetch('/api/settings/cms-token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_slug: slug, token }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErrors(prev => ({ ...prev, [slug]: data.error ?? 'Save failed' }))
      } else {
        setDrafts(prev => ({ ...prev, [slug]: '' }))
        const exp = data.expires_at ? new Date(data.expires_at) : null
        setSuccess(prev => ({
          ...prev,
          [slug]: exp ? `Saved. Expires ${exp.toLocaleString()}.` : 'Saved.',
        }))
        await refresh()
      }
    } catch (e) {
      setErrors(prev => ({ ...prev, [slug]: e instanceof Error ? e.message : String(e) }))
    }
    setSaving(null)
  }

  async function remove(slug: SiteSlug) {
    if (!confirm(`Remove the saved JWT for ${slug}? The cron will stop uploading for this brand until you paste a new one.`)) return
    setSaving(slug)
    try {
      await fetch(`/api/settings/cms-token?site_slug=${slug}`, { method: 'DELETE' })
      await refresh()
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">G2G CMS Token</h1>
          <p className="text-sm text-gray-400 mt-1">
            Paste a fresh admin JWT here once per week (or whenever uploads start failing).
          </p>
        </div>
        <Link href="/settings" className="text-sm text-gray-400 hover:text-white">← Back to Settings</Link>
      </div>

      <details className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 text-sm text-gray-300">
        <summary className="cursor-pointer font-medium text-white">How to grab a fresh token</summary>
        <ol className="list-decimal pl-5 mt-3 space-y-1.5">
          <li>Open the G2G admin in a browser; complete the Authy 2FA challenge.</li>
          <li>Open DevTools → Network tab → click any admin request (e.g. a product config page).</li>
          <li>In Headers, find <code className="text-blue-300">Authorization: Bearer …</code> and copy everything after <code>Bearer </code>.</li>
          <li>Paste below and click Save. We&apos;ll decode its expiry automatically.</li>
        </ol>
      </details>

      {SITES.map(({ slug, label }) => {
        const t = tokens[slug]
        return (
          <div key={slug} className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">{label}</h2>
              <StatusPill status={t} now={now} />
            </div>

            {t?.has_token && (
              <div className="text-xs text-gray-400 space-y-0.5">
                {t.token_subject && <div>Subject: <span className="text-gray-200">{t.token_subject}</span></div>}
                {t.expires_at  && <div>Expires:  <span className="text-gray-200">{new Date(t.expires_at).toLocaleString()}</span> ({daysUntil(t.expires_at, now)})</div>}
                {t.updated_at  && <div>Updated:  <span className="text-gray-200">{new Date(t.updated_at).toLocaleString()}</span></div>}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">
                Paste full JWT (Bearer prefix is OK; we strip it)
              </label>
              <textarea
                rows={3}
                spellCheck={false}
                value={drafts[slug]}
                onChange={e => setDrafts(prev => ({ ...prev, [slug]: e.target.value }))}
                placeholder="eyJhbGciOi…"
                className="w-full text-xs font-mono bg-gray-950 border border-gray-700 rounded-md p-2.5 text-gray-200 focus:outline-none focus:border-blue-500 break-all"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => save(slug)}
                disabled={saving === slug || loading || !drafts[slug].trim()}
                className="px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
              >
                {saving === slug ? 'Saving…' : (t?.has_token ? 'Replace token' : 'Save token')}
              </button>
              {t?.has_token && (
                <button
                  onClick={() => remove(slug)}
                  disabled={saving === slug}
                  className="px-3 py-1.5 text-sm font-medium rounded-md text-red-300 hover:bg-red-500/10 transition-colors"
                >
                  Remove
                </button>
              )}
              {errors[slug]  && <span className="text-xs text-red-400">{errors[slug]}</span>}
              {success[slug] && <span className="text-xs text-green-400">{success[slug]}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Bits ─────────────────────────────────────────────────────────────────

function StatusPill({ status, now }: { status: TokenStatus | null; now: number }) {
  if (!status?.has_token) {
    return <Pill tone="gray">Not configured</Pill>
  }
  const expMs = status.expires_at ? new Date(status.expires_at).getTime() : null
  if (!expMs) return <Pill tone="green">Active</Pill>
  const msLeft = expMs - now
  if (msLeft <= 0)               return <Pill tone="red">Expired</Pill>
  if (msLeft < 24 * 3600 * 1000) return <Pill tone="amber">Expires in &lt; 24h</Pill>
  return <Pill tone="green">Active</Pill>
}

function Pill({ tone, children }: { tone: 'gray' | 'green' | 'amber' | 'red'; children: React.ReactNode }) {
  const colors = {
    gray:  'bg-gray-700/40 text-gray-300 border-gray-600',
    green: 'bg-green-500/15 text-green-300 border-green-700',
    amber: 'bg-amber-500/15 text-amber-300 border-amber-700',
    red:   'bg-red-500/15   text-red-300   border-red-700',
  }[tone]
  return (
    <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${colors}`}>
      {children}
    </span>
  )
}

function daysUntil(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now
  if (ms <= 0) return 'expired'
  const days  = Math.floor(ms / (24 * 3600 * 1000))
  const hours = Math.floor((ms % (24 * 3600 * 1000)) / (3600 * 1000))
  if (days === 0) return `${hours}h left`
  return `${days}d ${hours}h left`
}
