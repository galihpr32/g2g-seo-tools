'use client'

/**
 * Sprint #373 — Public Boss View report page.
 * Sprint #384 — Domain-gated. Caller must be signed in with @g2g.com or
 *   @offgamers.com email. Random visitors get an Access Denied screen
 *   (no auto-redirect to login — user instructed: just show the message).
 *
 * Renders a published snapshot fetched from
 * GET /api/public/reports/friday-kpi/boss-view/[slug].
 *
 * This page lives at /reports/[slug] (root-level, NOT inside the (dashboard)
 * group) so it does not inherit the admin layout/sidebar/auth-guard. The
 * Boss View visualization itself is rendered by the shared
 * <BossViewContent /> component.
 */

import { useEffect, useState } from 'react'
import { BossViewContent, type Payload, type BossViewCommentary } from '@/components/reports/BossViewContent'

// Sprint #374 — the publish endpoint injects commentary into the payload,
// so we just read it back here.
type PublicPayload = Payload & { commentary?: BossViewCommentary | null }

// Sprint #384 — discriminator for the access-denied screen vs generic
// "report not found" / network error.
type GateState =
  | { kind: 'ok' }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden_domain'; yourEmail: string | null }
  | { kind: 'other'; message: string }

export default function PublicReportPage({ params }: { params: Promise<{ slug: string }> }) {
  const [payload, setPayload] = useState<PublicPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [meta, setMeta] = useState<{ generatedAt?: string; publishedAt?: string } | null>(null)
  // Sprint #380 — keep the slug in component state so we can forward it to
  // <BossViewContent publicSlug=…/> for the server-side PDF download.
  const [slug, setSlug] = useState<string | null>(null)
  // Sprint #384 — gate state replaces the generic `error` string so we can
  // render distinct screens for not-signed-in vs wrong-domain vs other.
  const [gate, setGate] = useState<GateState>({ kind: 'ok' })

  useEffect(() => {
    (async () => {
      const { slug } = await params
      setSlug(slug)
      try {
        const res = await fetch(`/api/public/reports/friday-kpi/boss-view/${slug}`)
        const ct = res.headers.get('content-type') ?? ''
        if (!ct.includes('application/json')) {
          setGate({ kind: 'other', message: `HTTP ${res.status}: unexpected response` })
          return
        }
        const data = await res.json() as {
          slug?:        string
          payload?:     PublicPayload
          generatedAt?: string
          publishedAt?: string
          error?:       string
          message?:     string
          yourEmail?:   string | null
        }
        // Sprint #384 — translate 401/403 to gate states for distinct UI
        if (res.status === 401 || data.error === 'unauthenticated') {
          setGate({ kind: 'unauthenticated' })
          return
        }
        if (res.status === 403 || data.error === 'forbidden_domain') {
          setGate({ kind: 'forbidden_domain', yourEmail: data.yourEmail ?? null })
          return
        }
        if (!res.ok) {
          setGate({ kind: 'other', message: data.message || data.error || `HTTP ${res.status}` })
          return
        }
        if (!data.payload) {
          setGate({ kind: 'other', message: 'No payload returned' })
          return
        }
        setPayload(data.payload)
        setMeta({ generatedAt: data.generatedAt, publishedAt: data.publishedAt })
      } catch (e) {
        setGate({ kind: 'other', message: String(e) })
      } finally {
        setLoading(false)
      }
    })()
  }, [params])

  // ── Sprint #384: Access Denied screen ──────────────────────────────────
  if (gate.kind === 'unauthenticated' || gate.kind === 'forbidden_domain') {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center px-6">
        <div className="max-w-md w-full bg-gray-900/70 border border-gray-700 rounded-2xl p-8 text-center">
          <div className="text-5xl mb-4">🔒</div>
          <h1 className="text-xl font-bold text-white mb-3">Access Restricted</h1>
          <p className="text-sm text-gray-300 leading-relaxed">
            Only <span className="text-emerald-300 font-mono">@g2g.com</span> &amp;{' '}
            <span className="text-emerald-300 font-mono">@offgamers.com</span> domains can open this file.
          </p>
          <p className="text-sm text-gray-400 mt-3 leading-relaxed">
            Please use your account profile to open this file.
          </p>
          {gate.kind === 'forbidden_domain' && gate.yourEmail && (
            <p className="text-xs text-gray-500 mt-4 font-mono">
              Signed in as: {gate.yourEmail}
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-black">
      <div className="px-6 py-6 max-w-7xl mx-auto">
        <header className="flex items-start justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              📸 Weekly Snapshot
              <span className="text-xs px-2 py-0.5 bg-emerald-700/30 text-emerald-300 rounded font-normal">
                Internal
              </span>
            </h1>
            <p className="text-sm text-gray-400 mt-1">
              {payload?.weekLabel ?? (loading ? 'Loading…' : '')}
              {meta?.publishedAt && (
                <span className="text-gray-600 ml-2">
                  · published {new Date(meta.publishedAt).toLocaleString()}
                </span>
              )}
            </p>
          </div>
        </header>
        <BossViewContent
          payload={payload}
          loading={loading}
          error={gate.kind === 'other' ? gate.message : null}
          commentary={payload?.commentary ?? null}
          publicSlug={slug ?? undefined}
        />
      </div>
    </div>
  )
}
