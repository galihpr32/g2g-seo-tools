import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest, getSiteConfig } from '@/lib/sites'

// ── GET /api/actions/export?from=YYYY-MM-DD&to=YYYY-MM-DD ────────────────────
// Returns a CSV of all action items (no pagination) with brief status joined.
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(request)
  const db = createServiceClient()

  // Resolve site_url for the active brand from site_configs first; fall back
  // to the user's gsc_connections if no per-site config is registered yet.
  const siteCfg = await getSiteConfig(supabase, siteSlug)
  let siteUrl = siteCfg?.gsc_property as string | undefined
  if (!siteUrl) {
    const { data: conn } = await db
      .from('gsc_connections')
      .select('site_url')
      .eq('user_id', ownerId)
      .maybeSingle()
    siteUrl = conn?.site_url
  }

  // Parse optional date filter from query params
  const { searchParams } = new URL(request.url)
  const from = searchParams.get('from')
  const to   = searchParams.get('to')

  // Fetch all action items (no limit). Filter by site_slug AND site_url —
  // site_slug is the brand isolation; site_url provides legacy compatibility
  // for rows written before the slug column was populated.
  let query = db
    .from('seo_action_items')
    .select('id, page, action_type, status, notes, snapshot_date, clicks_drop, position_change, assigned_to, created_at, completed_at')
    .eq('site_slug', siteSlug)
    .order('snapshot_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (siteUrl) query = query.eq('site_url', siteUrl)
  if (from)    query = query.gte('snapshot_date', from)
  if (to)      query = query.lte('snapshot_date', to)

  const { data: items, error } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!items || items.length === 0) {
    return new NextResponse('No data', { status: 204 })
  }

  // Fetch brief statuses for all action item ids
  const ids = items.map(i => i.id)
  const { data: briefs } = await db
    .from('seo_content_briefs')
    .select('action_item_id, status, brief_type')
    .in('action_item_id', ids)

  // Build brief map: action_item_id → { status, brief_types }
  const briefMap = new Map<string, { status: string; types: string[] }>()
  for (const b of briefs ?? []) {
    const existing = briefMap.get(b.action_item_id)
    if (existing) {
      existing.types.push(b.brief_type)
      // Prefer highest status: published > reviewed > draft
      const rank = (s: string) => s === 'published' ? 3 : s === 'reviewed' ? 2 : 1
      if (rank(b.status) > rank(existing.status)) existing.status = b.status
    } else {
      briefMap.set(b.action_item_id, { status: b.status, types: [b.brief_type] })
    }
  }

  // ── Build CSV ───────────────────────────────────────────────────────────────
  function esc(val: unknown): string {
    if (val === null || val === undefined) return ''
    const s = String(val)
    // Wrap in quotes if contains comma, newline, or quote
    if (s.includes(',') || s.includes('\n') || s.includes('"')) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }

  const headers = [
    'Page URL',
    'Action Type',
    'Status',
    'Assigned To',
    'Snapshot Date',
    'Clicks Drop',
    'Position Change',
    'Brief Status',
    'Brief Types',
    'Notes',
    'Created At',
    'Completed At',
  ]

  const rows = items.map(item => {
    const brief = briefMap.get(item.id)
    return [
      esc(item.page),
      esc(item.action_type),
      esc(item.status),
      esc(item.assigned_to),
      esc(item.snapshot_date),
      esc(item.clicks_drop !== null ? item.clicks_drop : ''),
      esc(item.position_change !== null ? item.position_change : ''),
      esc(brief?.status ?? ''),
      esc(brief?.types.join('; ') ?? ''),
      esc(item.notes),
      esc(item.created_at ? item.created_at.slice(0, 10) : ''),
      esc(item.completed_at ? item.completed_at.slice(0, 10) : ''),
    ].join(',')
  })

  const csv = [headers.join(','), ...rows].join('\n')

  // Filename with date range
  const today = new Date().toISOString().slice(0, 10)
  const range = from && to ? `_${from}_to_${to}` : from ? `_from_${from}` : to ? `_to_${to}` : `_${today}`
  const filename = `action-items${range}.csv`

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
