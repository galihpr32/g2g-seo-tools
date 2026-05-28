import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * GET /api/g2g-catalog/stats
 * Snapshot used by /settings/g2g-products header + coverage tile.
 *
 * Returns:
 *   total_products, active_products, inactive_products
 *   by_service_name: [{ service_name, count }, …]
 *   last_import:     { imported_at, rows_total, rows_inserted, … } | null
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Sprint OG.CATALOG — scope stats to active site (default 'g2g')
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  // ── 1. Totals ──────────────────────────────────────────────────────────
  const { count: totalCount } = await db
    .from('g2g_products')
    .select('*', { count: 'exact', head: true })
    .eq('site_slug', siteSlug)

  const { count: activeCount } = await db
    .from('g2g_products')
    .select('*', { count: 'exact', head: true })
    .eq('site_slug', siteSlug)
    .eq('is_active', true)

  // ── 2. By service_name — single query, aggregate in JS (small cardinality) ─
  const { data: catRows } = await db
    .from('g2g_products')
    .select('service_name')
    .eq('site_slug', siteSlug)
    .eq('is_active', true)

  const catMap = new Map<string, number>()
  for (const r of catRows ?? []) {
    catMap.set(r.service_name, (catMap.get(r.service_name) ?? 0) + 1)
  }
  const by_service_name = Array.from(catMap.entries())
    .map(([service_name, count]) => ({ service_name, count }))
    .sort((a, b) => b.count - a.count)

  // ── 3. Last import row ─────────────────────────────────────────────────
  const { data: lastImport } = await db
    .from('g2g_catalog_imports')
    .select('*')
    .order('imported_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({
    total_products:    totalCount ?? 0,
    active_products:   activeCount ?? 0,
    inactive_products: Math.max(0, (totalCount ?? 0) - (activeCount ?? 0)),
    by_service_name,
    last_import:       lastImport ?? null,
  })
}
