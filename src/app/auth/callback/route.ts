// Sprint #392 BOSS.VIEW.GOOGLE-OAUTH ─────────────────────────────────────
// Supabase OAuth code-exchange callback. After a user completes the Google
// sign-in flow, Google redirects them here with a ?code= param. We exchange
// that code for a session cookie, then send them to `next` (or /dashboard
// by default).
//
// Used by:
//   - /login page "Sign in with Google" button
//   - /reports/[slug] Access Denied page Google CTA
//
// Both pass `?next=<app-relative-path>` so the user lands on the page they
// were originally trying to reach.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url  = new URL(req.url)
  const code = url.searchParams.get('code')

  // Defensive `next` validation — same open-redirect guard as /login
  const rawNext = url.searchParams.get('next')
  const next    = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//')
    ? rawNext
    : '/dashboard'

  if (!code) {
    return NextResponse.redirect(`${url.origin}/login?error=missing_code`)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    return NextResponse.redirect(
      `${url.origin}/login?error=${encodeURIComponent(error.message)}`,
    )
  }

  return NextResponse.redirect(`${url.origin}${next}`)
}
