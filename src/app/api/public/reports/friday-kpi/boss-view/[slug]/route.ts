// Sprint #373 BOSS.VIEW.PUBLISH —
// GET /api/public/reports/friday-kpi/boss-view/[slug]
//
// Sprint #384 BOSS.VIEW.GATE —
// "Public" in the URL = no per-owner ACL (any team member can hit it with
// the slug). BUT the caller MUST be signed in with a @g2g.com or
// @offgamers.com email — random internet visitors get 403.
//
// Returns dedicated error codes so the client page can render the right
// Access Denied screen:
//   401  not signed in
//   403  signed in but email domain not allowed
//   404  slug not found
//   500  db error
//
// Reads from `friday_kpi_boss_view_published` via the service-role client
// to bypass RLS (no owner scoping by design — every g2g/og staff sees the
// same published snapshot for a slug, last-write-wins).

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import type { BossViewPayload } from '@/lib/reports/boss-view'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Sprint #384 — allowed corporate domains. Add more here (or move to env
// var) if the allowlist grows beyond two brands.
const ALLOWED_EMAIL_DOMAINS = ['g2g.com', 'offgamers.com'] as const

function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const lower = email.toLowerCase().trim()
  return ALLOWED_EMAIL_DOMAINS.some(d => lower.endsWith(`@${d}`))
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 })

  // ── Sprint #384 — auth gate ───────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({
      error: 'unauthenticated',
      message: 'Please sign in with your G2G or OffGamers account to view this report.',
    }, { status: 401 })
  }
  if (!isAllowedEmail(user.email)) {
    return NextResponse.json({
      error: 'forbidden_domain',
      message: 'This report is restricted to @g2g.com and @offgamers.com accounts. ' +
               'Please switch to a valid company account to open this file.',
      yourEmail: user.email ?? null,
    }, { status: 403 })
  }

  // ── Payload fetch ─────────────────────────────────────────────────────
  const db = createServiceClient()
  const { data, error } = await db
    .from('friday_kpi_boss_view_published')
    .select('payload, generated_at, published_at')
    .eq('slug', slug)
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'Not found' },  { status: 404 })

  return NextResponse.json({
    slug,
    payload:      data.payload as BossViewPayload,
    generatedAt:  data.generated_at,
    publishedAt:  data.published_at,
  })
}
