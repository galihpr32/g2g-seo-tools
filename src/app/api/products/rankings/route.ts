import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * GET /api/products/rankings?days=30&country=us
 *
 * Returns daily ranking history for every active tracked_product on the
 * resolved site. Shape:
 *   { products: [{ id, name, page_url, market, history: [{ keyword, snapshots: [{date, position, url}] }] }] }
 *
 * Used by /gsc/product-rankings to render sparklines + "current position"
 * pills on each product card.
 *
 * Country handling:
 *   - If `country` is omitted, returns history for whatever each product's
 *     own market column says (the default UX — what the user added them as).
 *   - If `country` is provided, only returns history snapshots for that
 *     country across all products (used by the country toggle on the
 *     rankings page).
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const url      = new URL(req.url)
  const days     = Math.max(1, Math.min(180, Number(url.searchParams.get('days') ?? '30')))
  const country  = url.searchParams.get('country')?.toLowerCase() ?? null

  const db = createServiceClient()

  // Fetch active products for this site
  const { data: products, error: prodErr } = await db
    .from('tracked_products')
    .select('id, name, page_url, keywords, market, active')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('active', true)
    .order('created_at', { ascending: false })

  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 500 })
  if (!products || products.length === 0) return NextResponse.json({ products: [] })

  const productIds = products.map(p => p.id)

  // Fetch history rows in one query — narrowed to time window + country
  const sinceDate = new Date(Date.now() - days * 86400_000).toISOString().split('T')[0]
  let historyQ = db
    .from('keyword_ranking_history')
    .select('tracked_product_id, keyword, country_code, snapshot_date, position, url, search_volume')
    .in('tracked_product_id', productIds)
    .gte('snapshot_date', sinceDate)
    .order('snapshot_date', { ascending: true })

  if (country) historyQ = historyQ.eq('country_code', country)

  const { data: history, error: histErr } = await historyQ
  if (histErr) return NextResponse.json({ error: histErr.message }, { status: 500 })

  // Group history by product → keyword → snapshots[]
  const byProduct = new Map<string, Map<string, { date: string; position: number | null; url: string | null }[]>>()
  for (const row of history ?? []) {
    const pid = String(row.tracked_product_id)
    const kw  = String(row.keyword)
    if (!byProduct.has(pid)) byProduct.set(pid, new Map())
    const kwMap = byProduct.get(pid)!
    if (!kwMap.has(kw)) kwMap.set(kw, [])
    kwMap.get(kw)!.push({
      date:     String(row.snapshot_date),
      position: row.position as number | null,
      url:      row.url      as string | null,
    })
  }

  // Shape for the UI
  const out = products.map(p => {
    const kwMap = byProduct.get(String(p.id)) ?? new Map()
    const history = (p.keywords as string[] ?? []).map(kw => ({
      keyword:   kw,
      snapshots: kwMap.get(kw) ?? [],
    }))
    return {
      id:       p.id,
      name:     p.name,
      page_url: p.page_url,
      market:   p.market,
      keywords: p.keywords,
      history,
    }
  })

  return NextResponse.json({ products: out, country, days })
}
