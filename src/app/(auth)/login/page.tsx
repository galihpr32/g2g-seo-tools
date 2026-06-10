'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useSearchParams } from 'next/navigation'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [hashError, setHashError] = useState<{ code: string; description: string } | null>(null)
  const router = useRouter()
  const searchParams = useSearchParams()
  // Sprint #391 — honor ?returnTo=<path> so users coming from a gated public
  // report land back on that report after sign-in. Defensive: only accept
  // app-relative paths (must start with /), never absolute URLs (prevents
  // open-redirect to attacker-controlled domains).
  const rawReturnTo = searchParams.get('returnTo')
  const returnTo    = rawReturnTo && rawReturnTo.startsWith('/') && !rawReturnTo.startsWith('//')
    ? rawReturnTo
    : '/dashboard'
  const supabase = createClient()

  // Read Supabase error params from URL hash BEFORE Supabase clears them
  useEffect(() => {
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (!hash) return

    const params = new URLSearchParams(hash.replace(/^#/, ''))
    const errorCode   = params.get('error_code') ?? ''
    const description = params.get('error_description') ?? ''

    if (errorCode) {
      setHashError({ code: errorCode, description: decodeURIComponent(description.replace(/\+/g, ' ')) })
      // Clear hash from URL without triggering a navigation/reload
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      // Sprint #391 — return to original page if ?returnTo= was provided
      router.push(returnTo)
      router.refresh()
    }
  }

  // Sprint #392 — Google OAuth sign-in. Supabase auto-creates auth.users
  // record on first sign-in; no manual invite/profile setup needed. The
  // domain gate on /reports/[slug] still enforces @g2g.com / @offgamers.com.
  async function handleGoogleSignIn() {
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(returnTo)}`,
        queryParams: {
          // Force account chooser so users on multi-Google-account machines
          // (common for boss/manager) can pick @g2g.com instead of personal.
          prompt: 'select_account',
        },
      },
    })
    if (error) {
      setError(error.message)
      setLoading(false)
    }
    // On success, Supabase navigates away — no further state to manage.
  }

  function goToForgotPassword(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    // Use window.location to bypass any Supabase hash-processing interference
    window.location.href = '/forgot-password' + (email ? `?email=${encodeURIComponent(email)}` : '')
  }

  const isExpiredInvite = hashError?.code === 'otp_expired'

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo / Brand */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-red-700 mb-4">
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">G2G SEO Tools</h1>
          <p className="text-gray-400 text-sm mt-1">Sign in to your account</p>
        </div>

        {/* Expired invite banner */}
        {isExpiredInvite && (
          <div className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
            <p className="text-amber-300 text-sm font-semibold mb-1">⏰ Invite link expired</p>
            <p className="text-amber-200/70 text-xs leading-relaxed">
              Your invite link is no longer valid. Enter your email below and click <strong>"Set up password"</strong> to get a fresh link in your inbox.
            </p>
          </div>
        )}

        {/* Form */}
        <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800 space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Sprint #392 — Google OAuth button (primary for stakeholders) */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed text-gray-800 font-semibold rounded-lg py-2.5 text-sm transition"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            {loading ? 'Redirecting…' : 'Sign in with Google'}
          </button>

          <div className="relative py-2">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-800"></div>
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-gray-900 px-3 text-gray-500">or sign in with email</span>
            </div>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder="you@g2g.com"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent transition"
            />
          </div>

          {isExpiredInvite ? (
            /* For expired invites — skip password, show set-up button */
            <button
              type="button"
              onClick={goToForgotPassword}
              className="w-full bg-amber-600 hover:bg-amber-500 text-white font-semibold rounded-lg py-2.5 text-sm transition"
            >
              Set up password →
            </button>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-medium text-gray-300">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={goToForgotPassword}
                    className="text-xs text-red-400 hover:text-red-300 transition"
                  >
                    Forgot password?
                  </button>
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent transition"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-red-700 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 text-sm transition"
              >
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
            </>
          )}
          </form>
        </div>

        <p className="text-center text-gray-600 text-xs mt-6">
          G2G Marketing · SEO Team
        </p>
      </div>
    </div>
  )
}
