import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 30

/**
 * Sprint KW.MASTER.1 — Keyword Master aggregator.
 *
 * GET /api/keyword-master
 *
 * Returns ALL tier_keywords for the active site joined with:
 *   • product_tiers (tier, market, category, restriction_type, product_name, url)
 *   • latest 2 snapshots per (kw × language→market) for position + WoW delta
 *
 * Page-side filters operate on the returned rows — we don't push filter to
 * the query because total dataset is small (≤500 kws typically) and clientside
 * filtering keeps the UX responsive.
 *
 * Sprint COMPETITIVE.SCORER fields surfaced: competitive_score, is_cluster_winner,
 * cluster_rank, sv_volume, serp_density, intent_score.
 *
 * Sprint DMCA.TAGGING surfacing: kw inherits product_tiers.restriction_type so
 * the page can render a ⚠ DMCA badge per row without needing per-kw flag.
 */

const LANG_TO_MARKET: Record<string, string> = { en: 'us', id: 'id' }

export interface KeywordMasterRow {
  id:               string
  product_tier_id:  string
  product_name:     string
  product_url:      string | null
  tier:             1 | 2
  market:           'us' | 'id'                         // product's target market
  category:         string | null
  restriction_type: string | null                       // null | 'dmca_global' | 'dmca_id' | ...
  keyword:          string
  language:         'en' | 'id'
  kw_market:        'us' | 'id'                         // derived from language
  is_main:          boolean
  notes:            string | null
  // Scoring (Sprint COMPETITIVE.SCORER)
  sv_volume:         number | null
  sv_volume_norm:    number | null
  serp_density:      number | null
  intent_score:      number | null
  competitive_score: number | null
  is_cluster_winner: boolean
  cluster_rank:      number | null
  last_scored_at:    string | null
  // Position (latest + prior week from tier_serp_snapshots)
  latest_position:   number | null
  prior_position:    number | null
  position_wow:      number | null      // prior - latest (positive = improvement)
  latest_snap_date:  string | null
}

export interface KeywordMasterSummary {
  total_kws:           number
  winners:             number
  dmca_flagged:        number
  needs_scoring:       number    // competitive_score is null
  products_with_kws:   number
  products_total:      number    // for "coverage" stat
  by_tier:             { t1: number; t2: number }
  by_market:           { us: number; id: number }
  by_language:         { en: number; id: number }
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  // ── 1. Pull all tier_keywords + product info via inner join ────────────
  const { data: kws, error: kwErr } = await db
    .from('tier_keywords')
    .select(`
      id, product_tier_id, keyword, language, is_main, notes,
      sv_volume, sv_volume_norm, serp_density, intent_score, competitive_score,
      is_cluster_winner, cluster_rank, last_scored_at,
      product_tiers!inner (
        id, tier, market, category, restriction_type, product_name, url, site_slug
      )
    `)
    .eq('owner_user_id', ownerId)
    .eq('product_tiers.site_slug', siteSlug)
    .order('competitive_score', { ascending: false, nullsFirst: false })

  if (kwErr) {
    return NextResponse.json({ error: kwErr.message }, { status: 500 })
  }

  type RawRow = {
    id:                string
    product_tier_id:   string
    keyword:           string
    language:          string | null
    is_main:           boolean
    notes:             string | null
    sv_volume:         number | null
    sv_volume_norm:    number | null
    serp_density:      number | null
    intent_score:      number | null
    competitive_score: number | null
    is_cluster_winner: boolean | null
    cluster_rank:      number | null
    last_scored_at:    string | null
    product_tiers:     {
      id:               string
      tier:             number
      market:           string | null
      category:         string | null
      restriction_type: string | null
      product_name:     string
      url:              string | null
      site_slug:        string
    } | Array<{
      id:               string
      tier:             number
      market:           string | null
      category:         string | null
      restriction_type: string | null
      product_name:     string
      url:              string | null
      site_slug:        string
    }>
  }

  const rawRows = (kws ?? []) as unknown as RawRow[]

  // ── 2. Pull total product count (for coverage stat) ──────────────────
  const { data: allProducts } = await db
    .from('product_tiers')
    .select('id')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
  const totalProductCount = (allProducts ?? []).length

  // ── 3. Pull latest 2 snapshots per (product × keyword × market) ──────
  // Window: last 21 days. Same logic as Friday KPI buildMarketSerp.
  const productIds = Array.from(new Set(rawRows.map(r => r.product_tier_id)))
  const sinceDate  = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10)

  const { data: snapsData } = productIds.length === 0
    ? { data: [] as unknown[] }
    : await db
      .from('tier_serp_snapshots')
      .select('product_tier_id, keyword, market, snapshot_date, our_position')
      .eq('owner_user_id', ownerId)
      .in('product_tier_id', productIds)
      .gte('snapshot_date', sinceDate)
      .order('snapshot_date', { ascending: false })

  type SnapRow = {
    product_tier_id: string
    keyword:         string
    market:          string
    snapshot_date:   string
    our_position:    number | null
  }
  const snaps = (snapsData ?? []) as SnapRow[]

  // Build (latest, prior) per (product × keyword × market). Same trick as
  // Friday KPI: latest = newest date for the key; prior = newest date that's
  // > 5 days older than latest.
  type SnapPair = { latest: { date: string; pos: number | null }; prior: { date: string; pos: number | null } | null }
  const byKey = new Map<string, SnapRow[]>()
  for (const s of snaps) {
    const key = `${s.product_tier_id}|${String(s.keyword).toLowerCase()}|${s.market}`
    const arr = byKey.get(key) ?? []
    arr.push(s)
    byKey.set(key, arr)
  }
  const pairs = new Map<string, SnapPair>()
  for (const [key, arr] of byKey.entries()) {
    arr.sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date))
    const latest = arr[0]
    if (!latest) continue
    const cutoffMs = new Date(latest.snapshot_date).getTime() - 5 * 86_400_000
    const prior = arr.find(s => new Date(s.snapshot_date).getTime() < cutoffMs) ?? null
    pairs.set(key, {
      latest: { date: latest.snapshot_date, pos: latest.our_position },
      prior:  prior ? { date: prior.snapshot_date, pos: prior.our_position } : null,
    })
  }

  // ── 4. Compose response rows ─────────────────────────────────────────
  const rows: KeywordMasterRow[] = rawRows.map(r => {
    const product = Array.isArray(r.product_tiers) ? r.product_tiers[0] : r.product_tiers
    const lang    = (r.language === 'id' ? 'id' : 'en') as 'en' | 'id'
    const kwMarket = (LANG_TO_MARKET[lang] ?? 'us') as 'us' | 'id'
    const key     = `${r.product_tier_id}|${r.keyword.toLowerCase()}|${kwMarket}`
    const pair    = pairs.get(key)
    const latest  = pair?.latest.pos ?? null
    const prior   = pair?.prior?.pos ?? null
    const wow     = (latest != null && prior != null) ? +(prior - latest).toFixed(1) : null

    return {
      id:               r.id,
      product_tier_id:  r.product_tier_id,
      product_name:     product?.product_name ?? '?',
      product_url:      product?.url ?? null,
      tier:             (product?.tier === 2 ? 2 : 1) as 1 | 2,
      market:           ((product?.market === 'id' ? 'id' : 'us') as 'us' | 'id'),
      category:         product?.category ?? null,
      restriction_type: product?.restriction_type ?? null,
      keyword:          r.keyword,
      language:         lang,
      kw_market:        kwMarket,
      is_main:          !!r.is_main,
      notes:            r.notes,
      sv_volume:         r.sv_volume,
      sv_volume_norm:    r.sv_volume_norm,
      serp_density:      r.serp_density,
      intent_score:      r.intent_score,
      competitive_score: r.competitive_score,
      is_cluster_winner: !!r.is_cluster_winner,
      cluster_rank:      r.cluster_rank,
      last_scored_at:    r.last_scored_at,
      latest_position:   latest,
      prior_position:    prior,
      position_wow:      wow,
      latest_snap_date:  pair?.latest.date ?? null,
    }
  })

  // ── 5. Summary KPIs ───────────────────────────────────────────────────
  const productsWithKws = new Set(rows.map(r => r.product_tier_id))
  const summary: KeywordMasterSummary = {
    total_kws:         rows.length,
    winners:           rows.filter(r => r.is_cluster_winner).length,
    dmca_flagged:      rows.filter(r => r.restriction_type && r.restriction_type.startsWith('dmca')).length,
    needs_scoring:     rows.filter(r => r.competitive_score == null).length,
    products_with_kws: productsWithKws.size,
    products_total:    totalProductCount,
    by_tier:           {
      t1: rows.filter(r => r.tier === 1).length,
      t2: rows.filter(r => r.tier === 2).length,
    },
    by_market: {
      us: rows.filter(r => r.kw_market === 'us').length,
      id: rows.filter(r => r.kw_market === 'id').length,
    },
    by_language: {
      en: rows.filter(r => r.language === 'en').length,
      id: rows.filter(r => r.language === 'id').length,
    },
  }

  return NextResponse.json({ rows, summary })
}
