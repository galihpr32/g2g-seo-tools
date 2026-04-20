'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [hashError, setHashError] = useState<{ code: string; description: string } | null>(null)
  const router = useRouter()
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
      router.push('/dashboard')
      router.refresh()
    }
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
        <form onSubmit={handleLogin} className="bg-gray-900 rounded-2xl p-6 border border-gray-800 space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
              {error}
            </div>
          )}

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

        <p className="text-center text-gray-600 text-xs mt-6">
          G2G Marketing · SEO Team
        </p>
      </div>
    </div>
  )
}
