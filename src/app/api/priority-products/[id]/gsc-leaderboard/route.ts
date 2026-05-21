import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { stripLocale } from '@/lib/priority-products/data-source'

export const maxDuration = 30

/**
 * GET /api/priority-products/[id]/gsc-leaderboard
 *
 * Sprint PP.GSC.MATCH.HINT — when Rankings Dashboard is in GSC mode, the
 * inline expanded leaderboard should show GSC numbers (impressions, clicks,
 * impression-weighted avg position) per tier_keyword instead of DFS positions.
 *
 * Algorithm mirrors fetchRankingsGSC (snapshot-based):
 *   1. Load tier_keywords for this product
 *   2. Resolve site_url from site_configs
 *   3. Pull gsc_query_snapshots for the last 120d where page matches product.url
 *      and query matches one of the tier_keywords
 *   4. For each kw: latest snapshot = current, snapshot ~28d before latest = prior
 *
 * Returns:
 *   leaderboard: [{ keyword, is_main, has_signal, impressions, clicks, ctr,
 *                  avgPosition, priorPosition, deltaPosition, latestDate }]
 *   matched / total
 */
const GSC_WOW_DAYS  = 28

function addDays(d: Date, n: number): Date {
  const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x
}
function isoDate(d: Date): string { return d.toISOString().slice(0, 10) }

export async function GET(
  req:  Request,
  ctx:  { params: Promise<{ id: string }> },
) {
  const { id: productId } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  // 1. Product info
  const { data: product, error: prodErr } = await db
    .from('product_tiers')
    .select('id, url, product_name')
    .eq('id', productId)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (prodErr || !product) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }

  // 2. Tier keywords for this product
  const { data: kwRows } = await db
    .from('tier_keywords')
    .select('id, keyword, language, is_main')
    .eq('owner_user_id', ownerId)
    .eq('product_tier_id', productId)
    .order('is_main', { ascending: false })
    .order('position', { ascending: true })
  const kws = (kwRows ?? []) as Array<{ id: string; keyword: string; language: string | null; is_main: boolean }>
  const kwLower = new Set(kws.map(k => k.keyword.toLowerCase().trim()))

  // 3. GSC property URL
  const { data: siteCfg } = await db
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', siteSlug)
    .maybeSingle()
  const gscPropertyUrl = (siteCfg?.gsc_property as string | undefined) ?? null
  if (!gscPropertyUrl) {
    return NextResponse.json({
      leaderboard: kws.map(k => ({
        keyword: k.keyword, language: k.language, is_main: k.is_main,
        has_signal: false, impressions: 0, clicks: 0, ctr: 0,
        avgPosition: null, priorPosition: null, deltaPosition: null, latestDate: null,
      })),
      matched: 0,
      total: kws.length,
      error: 'No GSC property configured for this site',
    })
  }

  // 4. Pull snapshots for the past 120d
  const now = new Date()
  const fetchSince = isoDate(addDays(now, -120))

  if (!product.url) {
    return NextResponse.json({
      leaderboard: kws.map(k => ({
        keyword: k.keyword, language: k.language, is_main: k.is_main,
        has_signal: false, impressions: 0, clicks: 0, ctr: 0,
        avgPosition: null, priorPosition: null, deltaPosition: null, latestDate: null,
      })),
      matched: 0,
      total: kws.length,
      error: 'Product has no URL configured',
    })
  }

  const { data: snapsRaw, error } = await db
    .from('gsc_query_snapshots')
    .select('snapshot_date, page, query, clicks, impressions, position')
    .eq('site_url', gscPropertyUrl)
    .gte('snapshot_date', fetchSince)
    .order('snapshot_date', { ascending: false })
    .limit(20_000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const snaps = (snapsRaw ?? []) as Array<{
    snapshot_date: string; page: string; query: string
    clicks: number; impressions: number; position: number
  }>

  // 5. Match `page` to product.url via path prefix.
  // Sprint PP.GSC.URL.LOCALE — strip locale prefix (/id/, /cn/, /en/, etc)
  // before comparing so localized URLs match the canonical product URL.
  function pathOf(rawUrl: string): string {
    let p: string
    try { p = new URL(rawUrl).pathname } catch { p = rawUrl }
    p = stripLocale(p).replace(/\/+$/, '')
    return p
  }
  const productPath = pathOf(product.url)
  function pageMatches(page: string): boolean {
    const p = pathOf(page)
    return p === productPath || p.startsWith(productPath + '/') || p.startsWith(productPath + '?')
  }

  // 6. Aggregate observations per (kw × snapshot_date)
  type Cell = { impressions: number; clicks: number; posWeighted: number }
  const observations = new Map<string, Array<{ date: string; cell: Cell }>>()  // key: kw
  for (const r of snaps) {
    const q = String(r.query ?? '').toLowerCase().trim()
    if (!q || !kwLower.has(q)) continue
    if (!pageMatches(r.page)) continue

    let list = observations.get(q)
    if (!list) { list = []; observations.set(q, list) }
    let entry = list.find(e => e.date === r.snapshot_date)
    if (!entry) {
      entry = { date: r.snapshot_date, cell: { impressions: 0, clicks: 0, posWeighted: 0 } }
      list.push(entry)
    }
    entry.cell.impressions += r.impressions
    entry.cell.clicks      += r.clicks
    entry.cell.posWeighted += r.position * r.impressions
  }
  for (const list of observations.values()) {
    list.sort((a, b) => b.date.localeCompare(a.date))
  }

  // 7. For each tier keyword, build a leaderboard row
  let matched = 0
  const leaderboard = kws.map(k => {
    const q = k.keyword.toLowerCase().trim()
    const list = observations.get(q) ?? []
    const latest = list[0]
    if (latest && latest.cell.impressions > 0) matched++

    // Find prior snapshot ~28d before latest (closest within ±5d)
    type Observation = { date: string; cell: Cell }
    let prior: Observation | null = null
    if (latest) {
      const targetMs = new Date(latest.date).getTime() - GSC_WOW_DAYS * 86_400_000
      let best: Observation | null = null
      let bestDiff = Infinity
      for (const entry of list) {
        if (entry.date >= latest.date) continue
        const diff = Math.abs(new Date(entry.date).getTime() - targetMs)
        if (diff < bestDiff) { bestDiff = diff; best = entry }
      }
      prior = best
    }

    const curPos   = latest && latest.cell.impressions > 0
      ? +(latest.cell.posWeighted / latest.cell.impressions).toFixed(2)
      : null
    const priorPos = prior  && prior.cell.impressions  > 0
      ? +(prior.cell.posWeighted  / prior.cell.impressions).toFixed(2)
      : null
    const deltaPos = (curPos != null && priorPos != null)
      ? +(priorPos - curPos).toFixed(2)   // positive = improved
      : null

    const impressions = latest?.cell.impressions ?? 0
    const clicks      = latest?.cell.clicks      ?? 0
    const ctr         = impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : 0

    return {
      keyword:       k.keyword,
      language:      k.language,
      is_main:       k.is_main,
      has_signal:    impressions > 0,
      impressions,
      clicks,
      ctr,
      avgPosition:   curPos,
      priorPosition: priorPos,
      deltaPosition: deltaPos,
      latestDate:    latest?.date ?? null,
    }
  })

  return NextResponse.json({
    leaderboard,
    matched,
    total: kws.length,
    productName: product.product_name,
    productUrl:  product.url,
  })
}
