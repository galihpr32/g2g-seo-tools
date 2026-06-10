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
import { createClient } from '@/lib/supabase/client'

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

  // ── Sprint #392 — direct Google OAuth from Access Denied ────────────────
  async function handleGoogleSignIn() {
    const currentPath = slug ? `/reports/${slug}` : '/reports'
    const supabase    = createClient()
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(currentPath)}`,
        queryParams: { prompt: 'select_account' },
      },
    })
  }

  // ── Sprint #384 / #391 / #392: Access Denied screen ────────────────────
  //   401 unauthenticated → Google sign-in CTA (primary) + email/password link
  //   403 forbidden_domain → message + signed-in email + switch-account option
  if (gate.kind === 'unauthenticated' || gate.kind === 'forbidden_domain') {
    const currentPath = slug ? `/reports/${slug}` : '/reports'
    const signInHref  = `/login?returnTo=${encodeURIComponent(currentPath)}`
    return (
      <div className="min-h-screen bg-black flex items-center justify-center px-6">
        <div className="max-w-md w-full bg-gray-900/70 border border-gray-700 rounded-2xl p-8 text-center">
          <div className="text-5xl mb-4">🔒</div>
          <h1 className="text-xl font-bold text-white mb-3">Access Restricted</h1>

          {gate.kind === 'unauthenticated' ? (
            <>
              <p className="text-sm text-gray-300 leading-relaxed mb-5">
                This report is for <span className="text-emerald-300 font-mono">@g2g.com</span> &amp;{' '}
                <span className="text-emerald-300 font-mono">@offgamers.com</span> staff only.
                Sign in with your company Google account to continue.
              </p>
              <button
                onClick={handleGoogleSignIn}
                className="w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-100 text-gray-800 text-sm font-semibold px-5 py-2.5 rounded-lg transition">
                <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Sign in with Google
              </button>
              <a href={signInHref}
                className="inline-block mt-4 text-xs text-gray-500 hover:text-gray-300 underline underline-offset-4">
                Use email + password instead
              </a>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-300 leading-relaxed mb-2">
                Only <span className="text-emerald-300 font-mono">@g2g.com</span> &amp;{' '}
                <span className="text-emerald-300 font-mono">@offgamers.com</span> domains can open this file.
              </p>
              {gate.yourEmail && (
                <p className="text-xs text-gray-500 mt-3 font-mono">
                  Currently signed in as: {gate.yourEmail}
                </p>
              )}
              <button
                onClick={handleGoogleSignIn}
                className="mt-5 w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-100 text-gray-800 text-sm font-semibold px-5 py-2.5 rounded-lg transition">
                <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Switch Google account
              </button>
            </>
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
