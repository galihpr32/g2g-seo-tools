import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import type { ProductTier } from '@/lib/product-tiers'

export const maxDuration = 30

/**
 * GET /api/priority-products
 *
 * Aggregates per-Tier-1/2-product metrics into a single response so the war
 * room page can render 35 rows without doing 175 separate queries.
 *
 * Strategy:
 *   1. Pull the tier list (≤35 rows for the active site)
 *   2. Pull GSC ranking drops, opps, briefs, outreach prospects, paid backlinks
 *      for the owner+site in 5 bulk queries
 *   3. Match each row to a tier product using the same identifier-priority
 *      logic as the resolver lib (relation_id → URL exact → URL slug → name)
 *   4. Compute per-product stats + a health label
 *
 * Returns:
 *   { products: ProductRow[], summary: { ... } }
 */

interface ProductRow {
  id:           string
  tier:         1 | 2
  market:       'us' | 'id'        // Sprint TIER.PER.MARKET
  productName:  string
  category:     string | null
  relationId:   string | null
  url:          string | null
  notes:        string | null
  // GSC metrics — last 7d aggregate from gsc_ranking_drops snapshots that
  // touched this product's URL/page.
  clicks7d:     number
  clicksPrev7d: number
  position:     number | null   // latest snapshot position
  // Pipeline state
  oppsOpen:     number
  briefsDraft:  number
  briefsLive:   number
  outreachInFlight: number
  outreachReplies:  number
  backlinksMtd: number
  // Health label — derived
  health:       'healthy' | 'monitor' | 'attention' | 'critical'
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  // Sprint PP.GSC.LAG — GSC has ~4 day publishing lag, so a raw `now-7d`
  // window only gives us ~3 days of usable data while the previous-7d window
  // has 7 full days, breaking the WoW comparison and producing fake -100%
  // drops. We offset both windows by GSC_LAG_DAYS so each window ends at the
  // most-recent GSC-available date. Mirror Sprint HEIMDALL.LAG.FIX +
  // PP.GSC.REFRESH which already use the same 4-day lag.
  //
  //   anchor       = today - 4d   (last day GSC has data for)
  //   current 7d   = [anchor-6d, anchor]   (7 days, e.g. May 16–22)
  //   previous 7d  = [anchor-13d, anchor-7d] (prior 7 days, e.g. May 9–15)
  //
  // MTD windows stay raw because they're cumulative-from-1st, not a moving
  // window where lag-misalignment matters.
  const GSC_LAG_DAYS = 4
  const now    = Date.now()
  const anchor = new Date(now - GSC_LAG_DAYS * 86_400_000)
  const last7  = new Date(anchor.getTime() - 6  * 86_400_000)              // start of current 7d, inclusive
  const prev7  = new Date(anchor.getTime() - 13 * 86_400_000)              // start of previous 7d, inclusive
  const last7Date  = last7.toISOString().slice(0, 10)
  const prev7Date  = prev7.toISOString().slice(0, 10)
  const anchorDate = anchor.toISOString().slice(0, 10)                     // upper bound for current 7d, inclusive
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
  const monthStartDate = monthStart.slice(0, 10)

  // ── 1. Tier list ────────────────────────────────────────────────────────────
  // Sprint TIER.PER.MARKET — include market column so the page can group/filter.
  const { data: tiersRaw } = await db
    .from('product_tiers')
    .select('id, tier, market, product_name, category, relation_id, url, notes')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tiers = (tiersRaw ?? []) as Array<Pick<ProductTier, 'id' | 'tier' | 'product_name' | 'category' | 'relation_id' | 'url' | 'notes'> & { market?: 'us' | 'id' }>
  if (tiers.length === 0) {
    return NextResponse.json({
      products: [],
      summary:  { total: 0, t1: 0, t2: 0, healthy: 0, monitor: 0, attention: 0, critical: 0 },
    })
  }

  // Resolve site_url for GSC queries (per Sprint 12 — no fallback to gsc_connections)
  const { data: siteConfig } = await db
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', siteSlug)
    .eq('is_active', true)
    .maybeSingle()
  const siteUrl = siteConfig?.gsc_property ?? null

  // ── 2. Bulk-fetch all per-table data in parallel ────────────────────────────
  const [
    drops7d,       dropsPrev7d,
    opps,
    briefs,
    prospects,
    backlinks,
  ] = await Promise.all([
    // GSC ranking drops — last 7d snapshots, lag-aligned ending at anchor.
    // Sprint PP.GSC.LAG — adds upper bound `lte anchorDate` so any stray
    // future-dated snapshot doesn't bleed into the current window.
    siteUrl
      ? db.from('gsc_ranking_drops')
          .select('page, clicks_now, position_now, snapshot_date')
          .eq('site_url', siteUrl)
          .gte('snapshot_date', last7Date)
          .lte('snapshot_date', anchorDate)
      : Promise.resolve({ data: [] as Array<{ page: string; clicks_now: number | null; position_now: number | null; snapshot_date: string }> }),

    // GSC ranking drops — previous 7d (for WoW delta), lag-aligned.
    // Upper bound is exclusive `lt last7Date` so the two windows don't
    // overlap on the boundary day.
    siteUrl
      ? db.from('gsc_ranking_drops')
          .select('page, clicks_now, snapshot_date')
          .eq('site_url', siteUrl)
          .gte('snapshot_date', prev7Date)
          .lt('snapshot_date',  last7Date)
      : Promise.resolve({ data: [] as Array<{ page: string; clicks_now: number | null; snapshot_date: string }> }),

    // Opportunities — open (not dismissed/published)
    db.from('seo_opportunities')
      .select('id, topic, target_url, status')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .not('status', 'in', '(dismissed,published)'),

    // Briefs — all states, we'll bucket per product
    db.from('seo_content_briefs')
      .select('id, status, primary_keyword, notes, created_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug),

    // Outreach prospects — match by source_keyword (≈ product name / opp topic)
    db.from('outreach_prospects')
      .select('id, source_keyword, status, last_sent_at, created_at')
      .eq('owner_user_id', ownerId),

    // Paid backlinks — MTD count, per target_page
    db.from('paid_backlinks')
      .select('id, target_page, link_status, live_date, created_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .gte('created_at', monthStart),
  ])

  // ── 3. Build per-product index keys for fast matching ───────────────────────
  // For each tier row, we precompute lowercase keys we'll match against the
  // various rows. Same priority as the resolver lib.
  type TierKeys = {
    relationId:  string | null
    urlExact:    string | null
    urlSlug:     string | null
    nameLower:   string | null
  }
  const tierKeys: Map<string, TierKeys> = new Map()
  for (const t of tiers) {
    tierKeys.set(t.id, {
      relationId: t.relation_id ?? null,
      urlExact:   t.url ? t.url.trim().toLowerCase() : null,
      urlSlug:    t.url ? extractSlug(t.url) : null,
      nameLower:  t.product_name ? t.product_name.trim().toLowerCase() : null,
    })
  }

  /** Match an arbitrary row's identifier (URL or keyword) against the tier
   *  list, returning the matching tier id or null. Used per-row inside the
   *  bulk aggregation loops below. */
  function matchByUrl(rawUrl: string | null): string | null {
    if (!rawUrl) return null
    const u = rawUrl.trim().toLowerCase()
    const slug = extractSlug(rawUrl)
    for (const [tid, k] of tierKeys) {
      if (k.urlExact && k.urlExact === u)        return tid
      if (k.urlSlug && slug && k.urlSlug === slug) return tid
    }
    return null
  }
  function matchByKeyword(raw: string | null): string | null {
    if (!raw) return null
    const k = raw.trim().toLowerCase()
    for (const [tid, keys] of tierKeys) {
      if (keys.nameLower === k) return tid
      if (keys.nameLower && (k.includes(keys.nameLower) || keys.nameLower.includes(k))) return tid
    }
    return null
  }
  function matchByRelationId(rid: string | null): string | null {
    if (!rid) return null
    for (const [tid, k] of tierKeys) {
      if (k.relationId === rid) return tid
    }
    return null
  }

  // ── 4. Aggregate per tier-product ───────────────────────────────────────────
  // Initialize the result map with zeros for every product.
  const agg = new Map<string, {
    clicks7d:     number
    clicksPrev7d: number
    position:     number | null
    posSnapshot:  string | null   // tracks latest snapshot date used for position
    oppsOpen:     number
    briefsDraft:  number
    briefsLive:   number
    outreachInFlight: number
    outreachReplies:  number
    backlinksMtd: number
  }>()
  for (const t of tiers) {
    agg.set(t.id, {
      clicks7d: 0, clicksPrev7d: 0, position: null, posSnapshot: null,
      oppsOpen: 0, briefsDraft: 0, briefsLive: 0,
      outreachInFlight: 0, outreachReplies: 0, backlinksMtd: 0,
    })
  }

  // GSC last 7d
  for (const d of drops7d.data ?? []) {
    const tid = matchByUrl(d.page)
    if (!tid) continue
    const a = agg.get(tid)!
    a.clicks7d += d.clicks_now ?? 0
    // Track latest position seen for this product
    if (d.position_now != null) {
      if (!a.posSnapshot || d.snapshot_date > a.posSnapshot) {
        a.posSnapshot = d.snapshot_date
        a.position    = d.position_now
      }
    }
  }
  // GSC prev 7d
  for (const d of dropsPrev7d.data ?? []) {
    const tid = matchByUrl(d.page)
    if (!tid) continue
    agg.get(tid)!.clicksPrev7d += d.clicks_now ?? 0
  }

  // Opps — by target_url first, fall back to topic
  for (const o of opps.data ?? []) {
    const tid = matchByUrl(o.target_url) ?? matchByKeyword(o.topic)
    if (!tid) continue
    agg.get(tid)!.oppsOpen += 1
  }

  // Briefs — match by primary_keyword
  for (const b of briefs.data ?? []) {
    const tid = matchByKeyword(b.primary_keyword)
    if (!tid) continue
    const a = agg.get(tid)!
    if (b.status === 'published')      a.briefsLive  += 1
    else if (['draft', 'agent_generated', 'reviewed', 'generating'].includes(b.status))
                                        a.briefsDraft += 1
  }

  // Outreach — match by source_keyword (≈ topic)
  // "in flight" = sent but no reply OR awaiting follow-up. Count replies separately.
  for (const p of prospects.data ?? []) {
    const tid = matchByKeyword(p.source_keyword)
    if (!tid) continue
    const a = agg.get(tid)!
    const status = p.status as string
    if (status === 'replied' || status === 'accepted' || status === 'published') {
      a.outreachReplies += 1
    } else if (['contacted', 'sent', 'needs_followup', 'pending'].includes(status)) {
      a.outreachInFlight += 1
    }
  }

  // Backlinks — MTD count, only active
  for (const bl of backlinks.data ?? []) {
    if (bl.link_status !== 'active') continue
    const tid = matchByUrl(bl.target_page)
    if (!tid) continue
    agg.get(tid)!.backlinksMtd += 1
  }

  // ── 5. Build response rows + compute health ────────────────────────────────
  function computeHealth(s: ReturnType<typeof agg.get> & object): ProductRow['health'] {
    // Hierarchy:
    //   - critical  : clicks dropped >25% wow OR many open opps (>=3)
    //   - attention : clicks dropped 10-25% OR has draft brief blocked OR 1+ opp
    //   - monitor   : modest drop OR brief in flight
    //   - healthy   : stable / growing / no open issues
    const wowPct = s.clicksPrev7d > 0
      ? ((s.clicks7d - s.clicksPrev7d) / s.clicksPrev7d) * 100
      : null

    if (wowPct != null && wowPct < -25) return 'critical'
    if (s.oppsOpen >= 3)                 return 'critical'
    if (wowPct != null && wowPct < -10)  return 'attention'
    if (s.oppsOpen >= 1)                 return 'attention'
    if (s.briefsDraft >= 1)              return 'monitor'
    return 'healthy'
  }

  const products: ProductRow[] = tiers
    .map(t => {
      const a = agg.get(t.id)!
      return {
        id:           t.id,
        tier:         t.tier,
        market:       (t.market ?? 'us') as 'us' | 'id',   // Sprint TIER.PER.MARKET
        productName:  t.product_name,
        category:     t.category ?? null,
        relationId:   t.relation_id ?? null,
        url:          t.url ?? null,
        notes:        t.notes ?? null,
        clicks7d:     a.clicks7d,
        clicksPrev7d: a.clicksPrev7d,
        position:     a.position,
        oppsOpen:     a.oppsOpen,
        briefsDraft:  a.briefsDraft,
        briefsLive:   a.briefsLive,
        outreachInFlight: a.outreachInFlight,
        outreachReplies:  a.outreachReplies,
        backlinksMtd: a.backlinksMtd,
        health:       computeHealth(a),
      }
    })
    // Tier 1 first, then T2; within tier, "needs attention" rises to top
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier
      const healthOrder = { critical: 0, attention: 1, monitor: 2, healthy: 3 }
      return healthOrder[a.health] - healthOrder[b.health]
    })

  const summary = {
    total:     products.length,
    t1:        products.filter(p => p.tier === 1).length,
    t2:        products.filter(p => p.tier === 2).length,
    healthy:   products.filter(p => p.health === 'healthy').length,
    monitor:   products.filter(p => p.health === 'monitor').length,
    attention: products.filter(p => p.health === 'attention').length,
    critical:  products.filter(p => p.health === 'critical').length,
    // Aggregate output stats for KPI strip
    briefsInFlight:  products.reduce((s, p) => s + p.briefsDraft, 0),
    outreach7d:      products.reduce((s, p) => s + p.outreachInFlight, 0),
    backlinksMtd:    products.reduce((s, p) => s + p.backlinksMtd, 0),
  }

  return NextResponse.json({ products, summary })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractSlug(url: string): string | null {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    return parts.length ? parts[parts.length - 1].toLowerCase() : null
  } catch {
    const parts = url.split('/').filter(Boolean)
    return parts.length ? parts[parts.length - 1].toLowerCase() : null
  }
}
