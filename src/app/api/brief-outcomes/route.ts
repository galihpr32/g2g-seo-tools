import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSearchAnalytics } from '@/lib/gsc/client'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 60

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizePath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase().replace(/\/$/, '') || '/'
  } catch {
    return url.toLowerCase().replace(/\/$/, '') || '/'
  }
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0]
}

// Which checkpoint does this date correspond to?
// Returns null if too early for any snapshot, or the checkpoint number
function checkpointFor(publishedAt: string): null | 0 | 30 | 60 | 90 {
  const days = (Date.now() - new Date(publishedAt).getTime()) / 86400000
  if (days < 1)  return null   // too fresh, wait at least 1 day for GSC data
  if (days < 25) return 0
  if (days < 55) return 30
  if (days < 85) return 60
  if (days < 100) return 90
  return null   // past 100d, all snapshots complete
}

// GET /api/brief-outcomes — list all outcomes for this user
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const briefId = searchParams.get('brief_id')

  // brief_outcomes itself doesn't have site_slug — we filter via the
  // !inner join to seo_content_briefs which carries the brand isolation.
  let query = db
    .from('brief_outcomes')
    .select(`
      *,
      seo_content_briefs!inner(
        primary_keyword, page, status, tyr_score, content_outline, target_publish_date, site_slug
      )
    `)
    .eq('owner_user_id', ownerId)
    .eq('seo_content_briefs.site_slug', siteSlug)
    .order('published_at', { ascending: false })
    .limit(200)

  if (briefId) query = query.eq('brief_id', briefId) as typeof query

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ outcomes: data ?? [] })
}

// POST /api/brief-outcomes — seed an outcome row when a brief is published
// Body: { brief_id }
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => null) as { brief_id?: string } | null
  if (!body?.brief_id) return NextResponse.json({ error: 'brief_id required' }, { status: 400 })

  // Fetch brief
  const { data: brief } = await db
    .from('seo_content_briefs')
    .select('id, page, primary_keyword, status, updated_at')
    .eq('id', body.brief_id)
    .eq('owner_user_id', ownerId)
    .single()

  if (!brief?.page) return NextResponse.json({ error: 'Brief not found or has no page URL' }, { status: 404 })

  // Upsert the outcome row (idempotent — safe to call multiple times)
  const { data: outcome, error: upsertErr } = await db
    .from('brief_outcomes')
    .upsert({
      brief_id:        brief.id,
      owner_user_id:   ownerId,
      page_url:        brief.page,
      primary_keyword: brief.primary_keyword,
      published_at:    new Date().toISOString().split('T')[0],
    }, { onConflict: 'brief_id', ignoreDuplicates: false })
    .select()
    .single()

  if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 })

  return NextResponse.json({ ok: true, outcome })
}

// PATCH /api/brief-outcomes — take a GSC snapshot for one outcome row
// Body: { outcome_id } — fetches GSC data and writes to the right checkpoint column
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => null) as { outcome_id?: string } | null
  if (!body?.outcome_id) return NextResponse.json({ error: 'outcome_id required' }, { status: 400 })

  const { data: outcome } = await db
    .from('brief_outcomes')
    .select('*')
    .eq('id', body.outcome_id)
    .eq('owner_user_id', ownerId)
    .single()

  if (!outcome) return NextResponse.json({ error: 'Outcome not found' }, { status: 404 })

  const checkpoint = checkpointFor(outcome.published_at)
  if (checkpoint === null) return NextResponse.json({ ok: true, message: 'No snapshot due yet or all complete' })

  // Check if this checkpoint already taken
  const colPos = `pos_${checkpoint}` as keyof typeof outcome
  if (outcome[colPos] !== null) {
    return NextResponse.json({ ok: true, message: `Checkpoint ${checkpoint}d already snapshotted` })
  }

  // GSC OAuth (tokens cover all properties under this Google account)
  const { data: conn } = await supabase
    .from('gsc_connections')
    .select('*')
    .eq('user_id', ownerId)
    .single()

  if (!conn?.access_token) return NextResponse.json({ error: 'GSC not connected' }, { status: 422 })

  // Sprint 12: site_url comes from the active brand's site_configs row,
  // NOT from gsc_connections.site_url which is single-site per user.
  const siteSlug = resolveSiteSlugFromRequest(req)
  const dbAdmin = createServiceClient()
  const { data: siteConfig } = await dbAdmin
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', siteSlug)
    .eq('is_active', true)
    .maybeSingle()
  if (!siteConfig?.gsc_property) {
    return NextResponse.json({ error: `No site config for slug=${siteSlug}` }, { status: 422 })
  }
  const siteUrl = siteConfig.gsc_property

  const auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)

  // Fetch last 7 days of GSC data for this page, filtered by keyword
  const rows = await getSearchAnalytics(
    auth, siteUrl,
    daysAgo(7), daysAgo(1),
    ['page', 'query'],
    5000
  ).catch(() => [])

  const targetPath = normalizePath(outcome.page_url)
  const targetKw   = (outcome.primary_keyword ?? '').toLowerCase()

  // Find the row matching this page+keyword
  let clicks = 0, impressions = 0, position: number | null = null

  for (const row of rows) {
    const rowPage  = row.keys?.[0] ?? ''
    const rowQuery = (row.keys?.[1] ?? '').toLowerCase()

    if (normalizePath(rowPage) !== targetPath) continue
    if (targetKw && !rowQuery.includes(targetKw) && !targetKw.includes(rowQuery)) continue

    clicks      += row.clicks      ?? 0
    impressions += row.impressions ?? 0
    if (position === null) position = row.position ?? null
    else if (row.position) position = Math.min(position, row.position)
  }

  // If no keyword match, try page-only aggregate
  if (position === null) {
    const pageRows = await getSearchAnalytics(
      auth, siteUrl,
      daysAgo(7), daysAgo(1),
      ['page'], 5000
    ).catch(() => [])

    const pageRow = pageRows.find(r => normalizePath(r.keys?.[0] ?? '') === targetPath)
    if (pageRow) {
      clicks      = pageRow.clicks      ?? 0
      impressions = pageRow.impressions ?? 0
      position    = pageRow.position    ?? null
    }
  }

  const update: Record<string, unknown> = {
    [`pos_${checkpoint}`]:         position,
    [`clicks_${checkpoint}`]:      clicks,
    [`impressions_${checkpoint}`]: impressions,
    [`snapshot_${checkpoint}_at`]: new Date().toISOString(),
  }

  const { error: updateErr } = await db
    .from('brief_outcomes')
    .update(update)
    .eq('id', outcome.id)

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

  return NextResponse.json({ ok: true, checkpoint, position, clicks, impressions })
}
