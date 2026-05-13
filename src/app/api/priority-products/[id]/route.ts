import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { TIER_MARKET_CODES, type TierMarket } from '@/lib/ranking-tracker'

export const maxDuration = 30

/**
 * GET /api/priority-products/[id]
 *
 * Returns the full detail bundle for one tiered product:
 *   • product info (from product_tiers)
 *   • keyword list (from tier_keywords)
 *   • latest SERP snapshot per (keyword × market)
 *   • SERP history per keyword (last 12 weeks) for the trend chart
 *   • GSC time series for the product URL (last 90 days)
 *
 * Heavy aggregation but bounded — typical product has 6 keywords × 5 markets
 * = 30 latest + 30×12 = 360 history rows + 90 GSC rows = ~500 rows total.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: productId } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  // ── 1. Product info ──────────────────────────────────────────────────────
  const { data: product, error: prodErr } = await db
    .from('product_tiers')
    .select('id, tier, site_slug, product_name, category, relation_id, url, notes, created_at, updated_at')
    .eq('id', productId)
    .eq('owner_user_id', ownerId)
    .single()

  if (prodErr || !product) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }

  // ── 2. Keyword list ──────────────────────────────────────────────────────
  const { data: keywords } = await db
    .from('tier_keywords')
    .select('id, keyword, is_main, position, notes, created_at')
    .eq('owner_user_id', ownerId)
    .eq('product_tier_id', productId)
    .order('is_main', { ascending: false })
    .order('position', { ascending: true })

  // ── 3. SERP snapshots — pull last 12 weeks; latest + history both ───────
  const sinceIso = new Date(Date.now() - 84 * 86_400_000).toISOString().slice(0, 10)
  const { data: snapshots } = await db
    .from('tier_serp_snapshots')
    .select('keyword, tier_keyword_id, market, snapshot_date, our_position, our_url, top_10, total_results')
    .eq('owner_user_id', ownerId)
    .eq('product_tier_id', productId)
    .gte('snapshot_date', sinceIso)
    .order('snapshot_date', { ascending: false })

  // Group snapshots: latest per (keyword × market) + history per (keyword × market)
  type Snap = {
    keyword:       string
    tier_keyword_id: string | null
    market:        string
    snapshot_date: string
    our_position:  number | null
    our_url:       string | null
    top_10:        Array<{ position: number; url: string; domain: string; title: string }>
    total_results: number | null
  }
  const allSnaps = (snapshots ?? []) as Snap[]

  const latest: Record<string, Snap> = {}                    // key = `${keyword}|${market}`
  const history: Record<string, Array<{ date: string; position: number | null }>> = {}

  for (const s of allSnaps) {
    const key = `${s.keyword}|${s.market}`
    if (!latest[key] || s.snapshot_date > latest[key].snapshot_date) latest[key] = s
    history[key] ??= []
    history[key].push({ date: s.snapshot_date, position: s.our_position })
  }

  // Sort history ascending for chart consumption
  for (const k of Object.keys(history)) {
    history[k].sort((a, b) => a.date.localeCompare(b.date))
  }

  // Build leaderboard: one row per keyword with positions across all markets
  const leaderboard = (keywords ?? []).map(kw => {
    const row: {
      keyword:    string
      is_main:    boolean
      positions:  Record<TierMarket, { position: number | null; url: string | null; snapshot_date: string | null }>
    } = {
      keyword:   kw.keyword,
      is_main:   kw.is_main,
      positions: {} as Record<TierMarket, { position: number | null; url: string | null; snapshot_date: string | null }>,
    }
    for (const m of TIER_MARKET_CODES) {
      const snap = latest[`${kw.keyword}|${m}`]
      row.positions[m] = {
        position:      snap?.our_position      ?? null,
        url:           snap?.our_url           ?? null,
        snapshot_date: snap?.snapshot_date     ?? null,
      }
    }
    return row
  })

  // ── 4. GSC time series for the product URL (last 90 days) ───────────────
  // The product_tiers.url field is what we use to filter gsc_ranking_drops.
  // Multi-brand-safe: site_url resolved per slug from site_configs.
  let gscTimeSeries: Array<{ date: string; clicks: number; impressions: number; position: number | null }> = []
  if (product.url) {
    const { data: siteConfig } = await db
      .from('site_configs')
      .select('gsc_property')
      .eq('slug', product.site_slug)
      .eq('is_active', true)
      .maybeSingle()
    const siteUrl = siteConfig?.gsc_property ?? null

    if (siteUrl) {
      const gscSince = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
      const { data: gscRows } = await db
        .from('gsc_ranking_drops')
        .select('snapshot_date, clicks_now, impressions_now, position_now')
        .eq('site_url', siteUrl)
        .eq('page', product.url)
        .gte('snapshot_date', gscSince)
        .order('snapshot_date', { ascending: true })

      gscTimeSeries = (gscRows ?? []).map(r => ({
        date:        r.snapshot_date,
        clicks:      r.clicks_now ?? 0,
        impressions: r.impressions_now ?? 0,
        position:    r.position_now ?? null,
      }))
    }
  }

  return NextResponse.json({
    product,
    keywords: keywords ?? [],
    leaderboard,
    history,
    gscTimeSeries,
    markets: TIER_MARKET_CODES,
  })
}
