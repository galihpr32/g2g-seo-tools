import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * Sprint FORSETI.SETTINGS — Subreddit config CRUD.
 *
 *   GET    /api/forseti/configs       → list all configs for active owner
 *   POST   /api/forseti/configs       → create new config
 *   PATCH  /api/forseti/configs?id=   → update config
 *   DELETE /api/forseti/configs?id=   → hard delete (cascade clears threads via FK SET NULL)
 */

const VALID_PRESETS = ['small_sub', 'big_sub', 'custom'] as const

// ─── GET ──────────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const { data, error } = await db
    .from('forseti_subreddit_configs')
    .select('*')
    .eq('owner_user_id', ownerId)
    .order('subreddit', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Filter by active site for the UI default view (caller can re-fetch with ?all=1 if needed)
  const { searchParams } = new URL(req.url)
  const filtered = searchParams.get('all') === '1'
    ? (data ?? [])
    : (data ?? []).filter(c => c.site_slug === siteSlug)

  return NextResponse.json({ configs: filtered })
}

// ─── POST ─────────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    subreddit?:          string
    site_slug?:          string
    enabled?:            boolean
    keyword_filter?:     string
    severity_preset?:    string
    sev5_min_upvotes?:   number | null
    sev4_min_upvotes?:   number | null
    sev5_min_comments?:  number | null
    sev4_min_comments?:  number | null
  }

  // Strip "r/" prefix if user typed it
  const subreddit = String(body.subreddit ?? '').replace(/^\/?r\//i, '').trim()
  if (!subreddit) return NextResponse.json({ error: 'subreddit required' }, { status: 400 })
  if (!/^[A-Za-z0-9_]{2,40}$/.test(subreddit)) {
    return NextResponse.json({ error: 'Invalid subreddit name — letters, digits, underscore only (2-40 chars)' }, { status: 400 })
  }

  const preset = VALID_PRESETS.includes(body.severity_preset as typeof VALID_PRESETS[number])
    ? body.severity_preset
    : 'small_sub'

  const { data, error } = await db.from('forseti_subreddit_configs').insert({
    owner_user_id:      ownerId,
    site_slug:          body.site_slug ?? siteSlug,
    subreddit,
    enabled:            body.enabled ?? true,
    keyword_filter:     String(body.keyword_filter ?? '').slice(0, 500),
    severity_preset:    preset,
    sev5_min_upvotes:   preset === 'custom' ? body.sev5_min_upvotes  ?? null : null,
    sev4_min_upvotes:   preset === 'custom' ? body.sev4_min_upvotes  ?? null : null,
    sev5_min_comments:  preset === 'custom' ? body.sev5_min_comments ?? null : null,
    sev4_min_comments:  preset === 'custom' ? body.sev4_min_comments ?? null : null,
  }).select('*').single()

  if (error) {
    if (error.message.includes('forseti_configs_unique_per_owner')) {
      return NextResponse.json({ error: `Subreddit r/${subreddit} already configured` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ config: data })
}

// ─── PATCH ────────────────────────────────────────────────────────────────
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = { updated_at: new Date().toISOString() }
  if (typeof body.enabled        === 'boolean') patch.enabled        = body.enabled
  if (typeof body.keyword_filter === 'string')  patch.keyword_filter = body.keyword_filter.slice(0, 500)
  if (typeof body.site_slug      === 'string')  patch.site_slug      = body.site_slug
  if (typeof body.severity_preset === 'string' && VALID_PRESETS.includes(body.severity_preset as typeof VALID_PRESETS[number])) {
    patch.severity_preset = body.severity_preset
  }
  if ('sev5_min_upvotes'  in body) patch.sev5_min_upvotes  = body.sev5_min_upvotes  as number | null
  if ('sev4_min_upvotes'  in body) patch.sev4_min_upvotes  = body.sev4_min_upvotes  as number | null
  if ('sev5_min_comments' in body) patch.sev5_min_comments = body.sev5_min_comments as number | null
  if ('sev4_min_comments' in body) patch.sev4_min_comments = body.sev4_min_comments as number | null

  const { data, error } = await db
    .from('forseti_subreddit_configs')
    .update(patch)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ config: data })
}

// ─── DELETE ───────────────────────────────────────────────────────────────
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await db
    .from('forseti_subreddit_configs')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
