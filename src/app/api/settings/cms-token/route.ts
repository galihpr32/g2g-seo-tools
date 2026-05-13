import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { decodeJwtPayload } from '@/lib/g2g/cms-api'

export const maxDuration = 10

const VALID_SITES = ['g2g', 'offgamers'] as const

// ─── GET /api/settings/cms-token ───────────────────────────────────────────
// Returns metadata only — never the raw token value. UI uses this to render
// the per-site status badges and "expires in N days" hint.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { data, error } = await db
    .from('cms_tokens')
    .select('site_slug, expires_at, token_subject, updated_at')
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Normalize into a per-site map so the UI always has both slugs (even
  // when one has never been saved).
  const map: Record<string, {
    site_slug:     string
    has_token:     boolean
    expires_at:    string | null
    token_subject: string | null
    updated_at:    string | null
  }> = {}

  for (const slug of VALID_SITES) {
    map[slug] = {
      site_slug:     slug,
      has_token:     false,
      expires_at:    null,
      token_subject: null,
      updated_at:    null,
    }
  }
  for (const row of data ?? []) {
    map[row.site_slug] = {
      site_slug:     row.site_slug,
      has_token:     true,
      expires_at:    row.expires_at,
      token_subject: row.token_subject,
      updated_at:    row.updated_at,
    }
  }

  return NextResponse.json({ tokens: Object.values(map) })
}

// ─── PUT /api/settings/cms-token ───────────────────────────────────────────
// Body: { site_slug: 'g2g'|'offgamers', token: <full JWT> }
// Decodes the JWT to surface `exp` + `sub` for the UI. We DO NOT verify the
// signature (we're not the issuer — G2G admin is).
export async function PUT(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { site_slug?: string; token?: string }
  const siteSlug = String(body.site_slug ?? '').trim()
  const token    = String(body.token     ?? '').trim().replace(/^Bearer\s+/i, '')

  if (!VALID_SITES.includes(siteSlug as typeof VALID_SITES[number])) {
    return NextResponse.json({ error: `site_slug must be one of: ${VALID_SITES.join(', ')}` }, { status: 400 })
  }
  if (!token || token.split('.').length !== 3) {
    return NextResponse.json({ error: 'token must be a full JWT (3 dot-separated parts)' }, { status: 400 })
  }

  const payload = decodeJwtPayload(token)
  if (!payload) {
    return NextResponse.json({ error: 'Could not decode JWT payload — token malformed?' }, { status: 400 })
  }

  const expiresAt = payload.exp ? new Date(payload.exp * 1000).toISOString() : null
  const subject   = payload.email ?? payload.sub ?? null

  // Reject already-expired tokens up front to save a confusing failure later.
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
    return NextResponse.json({
      error: `Token is already expired (exp=${expiresAt}). Grab a fresh JWT from the G2G admin and try again.`,
    }, { status: 400 })
  }

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { error } = await db
    .from('cms_tokens')
    .upsert({
      owner_user_id:  ownerId,
      site_slug:      siteSlug,
      token,
      expires_at:     expiresAt,
      token_subject:  subject,
      updated_at:     new Date().toISOString(),
    }, { onConflict: 'owner_user_id,site_slug' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // When a fresh token lands, unstick any rows we'd parked as awaiting_token.
  // They'll get re-tried on the next cron tick.
  await db
    .from('product_content_queue')
    .update({ cms_upload_status: 'pending', cms_upload_error: null })
    .eq('owner_user_id', ownerId)
    .eq('cms_upload_status', 'awaiting_token')

  return NextResponse.json({
    ok: true,
    site_slug:     siteSlug,
    expires_at:    expiresAt,
    token_subject: subject,
  })
}

// ─── DELETE /api/settings/cms-token?site_slug=g2g ──────────────────────────
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const siteSlug = String(searchParams.get('site_slug') ?? '').trim()
  if (!VALID_SITES.includes(siteSlug as typeof VALID_SITES[number])) {
    return NextResponse.json({ error: 'invalid site_slug' }, { status: 400 })
  }

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { error } = await db
    .from('cms_tokens')
    .delete()
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
