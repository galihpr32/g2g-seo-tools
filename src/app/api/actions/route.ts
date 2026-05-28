import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

// POST /api/actions
//   Bulk (from ranking drop):  { pages: [...], action_type, notes, snapshot_date }
//   Manual (single URL):       { page: string, action_type, notes? }
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Resolve active site (cookie/query/body) — single helper, used everywhere
  const cookieSite = resolveSiteSlugFromRequest(request)

  // Sprint 12: site_url ONLY comes from site_configs based on active slug.
  // No fallback to gsc_connections.site_url — that path always returned
  // G2G's URL regardless of which brand the user is on.
  const { data: siteConfig } = await db
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', cookieSite)
    .eq('is_active', true)
    .maybeSingle()

  // Verify user has GSC OAuth connected; without it, we can't act on rankings.
  const { data: conn } = await db
    .from('gsc_connections')
    .select('user_id')
    .eq('user_id', effectiveOwnerId)
    .maybeSingle()

  const resolvedSiteUrl = (conn && siteConfig?.gsc_property) ? siteConfig.gsc_property : null
  if (!resolvedSiteUrl) return NextResponse.json({ error: `No data for site=${cookieSite}` }, { status: 400 })

  const body = await request.json()

  // ── Manual single-URL add ───────────────────────────────────────────────
  if (body.page && !body.pages) {
    const { page, action_type, notes } = body as {
      page: string
      action_type: 'on_page' | 'off_page'
      notes?: string
    }
    if (!page || !action_type) {
      return NextResponse.json({ error: 'Missing page or action_type' }, { status: 400 })
    }

    // Normalise URL — ensure it's a full URL under the site
    let normalised = page.trim()
    if (!normalised.startsWith('http')) {
      // Accept path like /categories/xyz and prepend site_url
      const base = resolvedSiteUrl.replace(/\/$/, '')
      normalised = `${base}${normalised.startsWith('/') ? '' : '/'}${normalised}`
    }

    const today = new Date().toISOString().slice(0, 10)
    const { data, error } = await db
      .from('seo_action_items')
      .insert({
        site_url:      resolvedSiteUrl,
        site_slug:     cookieSite,
        page:          normalised,
        action_type,
        notes:         notes ?? null,
        snapshot_date: today,
        clicks_drop:   null,
        position_change: null,
        status:        'pending',
      })
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ created: 1, item: data })
  }

  // ── Bulk add from ranking drop ──────────────────────────────────────────
  const { pages, action_type, notes, snapshot_date } = body as {
    pages: { page: string; clicks_drop: number; position_change: number }[]
    action_type: 'on_page' | 'off_page'
    notes?: string
    snapshot_date: string
  }

  if (!pages?.length || !action_type || !snapshot_date) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const inserts = pages.map(p => ({
    site_url:        resolvedSiteUrl,
    site_slug:       cookieSite,
    page:            p.page,
    action_type,
    notes:           notes ?? null,
    snapshot_date,
    clicks_drop:     p.clicks_drop,
    position_change: p.position_change,
    status:          'pending',
  }))

  const { data, error } = await db
    .from('seo_action_items')
    .insert(inserts)
    .select()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ created: data?.length ?? 0 })
}

// PATCH /api/actions — update status, notes, and/or assigned_to
export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const body = await request.json()
  const { id, status, notes, assigned_to } = body as {
    id: string
    status?: string
    notes?: string
    assigned_to?: string | null
  }
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const updates: Record<string, unknown> = {}

  if (status) {
    updates.status = status
    updates.completed_at = status === 'done' ? new Date().toISOString() : null
    // Auto-assign to current user when moving to in_progress (only if not already assigned)
    if (status === 'in_progress') {
      // Check if already assigned
      const { data: existing } = await db
        .from('seo_action_items')
        .select('assigned_to')
        .eq('id', id)
        .single()
      if (!existing?.assigned_to) {
        updates.assigned_to = user.email
      }
    }
  }

  if (notes !== undefined) updates.notes = notes

  // Allow explicit assignee override
  if (assigned_to !== undefined) updates.assigned_to = assigned_to

  // RLS ensures user can only update their own items
  const { error } = await db
    .from('seo_action_items')
    .update(updates)
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
