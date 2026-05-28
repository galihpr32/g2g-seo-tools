import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * GET /api/site-health/schema?days=30
 *
 * Returns latest schema_health_snapshots per page (most recent within window),
 * sorted by validity_score asc so broken pages surface first.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const url      = new URL(req.url)
  const days     = Math.max(1, Math.min(180, Number(url.searchParams.get('days') ?? '30')))
  const since    = new Date(Date.now() - days * 86400_000).toISOString().split('T')[0]
  const db       = createServiceClient()

  // Pull all snapshots in window then dedupe by (page_url) keeping the most
  // recent. We do dedup client-side since SQL window-functions over JSONB
  // are awkward across PostgREST.
  const { data: snaps } = await db
    .from('schema_health_snapshots')
    .select('page_url, snapshot_date, has_jsonld, jsonld_count, schema_types, validation_errors, validity_score, http_status')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .gte('snapshot_date', since)
    .order('snapshot_date', { ascending: false })

  const latestByPage = new Map<string, NonNullable<typeof snaps>[number]>()
  for (const s of snaps ?? []) {
    if (!latestByPage.has(String(s.page_url))) latestByPage.set(String(s.page_url), s)
  }
  const latest = Array.from(latestByPage.values())
    .sort((a, b) => (a.validity_score ?? 0) - (b.validity_score ?? 0))

  // Aggregate stats
  const stats = {
    total:        latest.length,
    healthy:      latest.filter(s => (s.validity_score ?? 0) >= 90).length,
    needs_work:   latest.filter(s => (s.validity_score ?? 0) >= 70 && (s.validity_score ?? 0) < 90).length,
    broken:       latest.filter(s => (s.validity_score ?? 0) < 70).length,
    no_jsonld:    latest.filter(s => !s.has_jsonld).length,
  }

  return NextResponse.json({ ok: true, days, stats, snapshots: latest })
}
