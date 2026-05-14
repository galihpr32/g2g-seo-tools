import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { TIER_MARKETS, T1_DROP_THRESHOLD, t1DropMagnitude, isT2FallOutOfTop10, type TierMarket } from '@/lib/ranking-tracker'

export const maxDuration = 60

/**
 * GET /api/cron/tier-rank-alerts
 *
 * Daily 09:00 cron — scans the latest tier_serp_snapshots vs the prior one
 * for every (product × keyword × market) and surfaces alert-worthy moves:
 *   • Tier 1: drop ≥3 positions       → flag (Galih's spec)
 *   • Tier 2: fall out of top 10      → flag
 *
 * All flags from BOTH brands are consolidated into ONE Slack message so the
 * channel doesn't get fragmented by brand. Surface-only — no auto-trigger of
 * other agents. Mimir will learn from these patterns in a later sprint.
 *
 * Schedule: every day 09:00 UTC via GitHub Actions (`.github/workflows/
 * tier-rank-alerts.yml`).
 *
 * Auth: Bearer CRON_SECRET.
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

interface SnapRow {
  owner_user_id:   string
  product_tier_id: string
  keyword:         string
  market:          string
  snapshot_date:   string
  our_position:    number | null
}

interface ProductMeta {
  id:            string
  tier:          number
  site_slug:     string
  product_name:  string
  category:      string | null
  url:           string | null
}

interface Alert {
  tier:          1 | 2
  brand:         string
  productName:   string
  productId:     string
  category:      string | null
  keyword:       string
  market:        string
  prevPosition:  number | null
  currPosition:  number | null
  delta:         number   // positive = dropped (worse), negative = improved
  url:           string | null
  reason:        'T1_DROP' | 'T2_OUT_OF_TOP10'
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // ── 1. Pull the two most recent snapshot batches ─────────────────────────
  // We can't just take "latest 2 dates per (product, keyword, market)" with
  // a single SQL query in Supabase without a window function, so we pull the
  // last ~21 days of snapshots and bucket client-side. 21 days = the longest
  // realistic gap between weekly runs we'd tolerate before treating data as
  // stale.
  const sinceIso = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10)
  const { data: rows } = await db
    .from('tier_serp_snapshots')
    .select('owner_user_id, product_tier_id, keyword, market, snapshot_date, our_position')
    .gte('snapshot_date', sinceIso)
    .order('snapshot_date', { ascending: false })

  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, message: 'No recent snapshots — skipping alerts.' })
  }

  // Bucket by (owner, product, keyword, market) and keep the 2 most recent dates.
  type KeyPath = string   // `${owner}|${product}|${keyword}|${market}`
  const buckets = new Map<KeyPath, SnapRow[]>()
  for (const r of rows as SnapRow[]) {
    const k = `${r.owner_user_id}|${r.product_tier_id}|${r.keyword}|${r.market}`
    const arr = buckets.get(k) ?? []
    if (arr.length < 2) {
      arr.push(r)
      buckets.set(k, arr)
    }
  }

  // ── 2. Fetch product metadata for the products that have snapshots ───────
  const productIds = Array.from(new Set([...buckets.values()].flatMap(arr => arr.map(s => s.product_tier_id))))
  const { data: products } = await db
    .from('product_tiers')
    .select('id, tier, site_slug, product_name, category, url')
    .in('id', productIds)
  const productMap = new Map<string, ProductMeta>((products ?? []).map((p: ProductMeta) => [p.id, p]))

  // ── 3. Evaluate each bucket against alert thresholds ─────────────────────
  const alerts: Alert[] = []
  for (const [, snaps] of buckets) {
    if (snaps.length < 2) continue   // first-ever snapshot, no prior to compare
    const [curr, prev] = snaps      // sorted desc
    const product = productMap.get(curr.product_tier_id)
    if (!product) continue
    if (product.tier !== 1 && product.tier !== 2) continue

    let reason: Alert['reason'] | null = null
    let delta: number = 0

    if (product.tier === 1) {
      const drop = t1DropMagnitude(prev.our_position, curr.our_position)
      if (drop > 0) {
        reason = 'T1_DROP'
        delta  = drop
      }
    } else if (product.tier === 2) {
      if (isT2FallOutOfTop10(prev.our_position, curr.our_position)) {
        reason = 'T2_OUT_OF_TOP10'
        delta  = (curr.our_position ?? 999) - (prev.our_position ?? 0)
      }
    }

    if (!reason) continue
    alerts.push({
      tier:         product.tier as 1 | 2,
      brand:        product.site_slug.toUpperCase(),
      productName:  product.product_name,
      productId:    product.id,
      category:     product.category,
      keyword:      curr.keyword,
      market:       curr.market,
      prevPosition: prev.our_position,
      currPosition: curr.our_position,
      delta,
      url:          product.url,
      reason,
    })
  }

  // Sprint ALLCLEAR — even when no alerts, still post "all clear" to Slack
  // so managers see proof the cron ran. Silence breeds doubt.
  const { resolveSlackWebhook } = await import('@/lib/slack/routing')
  if (alerts.length === 0) {
    const { data: firstRouteOwnerClear } = await db
      .from('slack_routing_config')
      .select('owner_user_id')
      .eq('notification_type', 'daily_alerts')
      .eq('enabled', true)
      .limit(1)
      .maybeSingle()
    const ownerForRouteClear = firstRouteOwnerClear?.owner_user_id
      ?? (await db.from('gsc_connections').select('user_id').limit(1).maybeSingle()).data?.user_id
      ?? null
    const webhookUrlClear = ownerForRouteClear
      ? await resolveSlackWebhook(db, ownerForRouteClear, 'daily_alerts')
      : process.env.SLACK_WEBHOOK_URL ?? null
    if (!webhookUrlClear) {
      return NextResponse.json({ ok: true, alerts: 0, message: 'No alert-worthy moves today; no webhook resolved.' })
    }
    const allClearBlocks = [
      { type: 'header', text: { type: 'plain_text', text: '✅ Tier Rankings — All Clear', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `No Tier 1 drops ≥${T1_DROP_THRESHOLD} pos · No Tier 2 fall-outs from top 10 detected today.\n_Last check: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC_` } },
    ]
    try {
      const slackRes = await fetch(webhookUrlClear, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: allClearBlocks }),
      })
      return NextResponse.json({ ok: true, alerts: 0, delivered: slackRes.ok ? 'slack' : 'failed', message: 'All-clear posted.' })
    } catch (e) {
      return NextResponse.json({ ok: true, alerts: 0, error: String(e) })
    }
  }

  // ── 4. Group alerts by brand and post SEPARATE Slack message per brand ──
  // Sprint OG.SLACK.FIX — used to consolidate G2G + OG into one message.
  // Now per-brand so OG admin sees their stream isolated.
  const alertsByBrand = new Map<string, Alert[]>()
  for (const a of alerts) {
    const bucket = alertsByBrand.get(a.brand) ?? []
    bucket.push(a)
    alertsByBrand.set(a.brand, bucket)
  }

  const brandStyle: Record<string, { color: string; emoji: string }> = {
    G2G:       { color: '#DC2626', emoji: '🎯' },
    OFFGAMERS: { color: '#2563EB', emoji: '🕹️' },
  }

  let postedBrands = 0
  const perBrandResults: Record<string, { ok: boolean; alerts: number; reason?: string }> = {}

  for (const [brand, brandAlerts] of alertsByBrand) {
    // Resolve webhook per-brand: try product_tiers.owner_user_id for this site,
    // then env fallback. site_slug is lowercase, brand is uppercase.
    const siteSlugForBrand = brand.toLowerCase()
    const { data: firstRouteOwner } = await db
      .from('slack_routing_config')
      .select('owner_user_id')
      .eq('notification_type', 'daily_alerts')
      .eq('enabled', true)
      .or(`site_slug.eq.${siteSlugForBrand},site_slug.is.null`)
      .limit(1)
      .maybeSingle()
    const ownerForRoute = firstRouteOwner?.owner_user_id
      ?? (await db.from('product_tiers').select('owner_user_id').eq('site_slug', siteSlugForBrand).limit(1).maybeSingle()).data?.owner_user_id
      ?? null
    const webhookUrl = ownerForRoute
      ? await resolveSlackWebhook(db, ownerForRoute, 'daily_alerts', { siteSlug: siteSlugForBrand })
      : process.env.SLACK_WEBHOOK_URL ?? null
    if (!webhookUrl) {
      perBrandResults[brand] = { ok: false, alerts: brandAlerts.length, reason: 'no_webhook' }
      continue
    }

    // Sort: critical first (biggest drop in T1), then T2 fall-outs by depth
    brandAlerts.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier
      return b.delta - a.delta
    })

    const t1Count = brandAlerts.filter(a => a.tier === 1).length
    const t2Count = brandAlerts.filter(a => a.tier === 2).length
    const MAX_ROWS_IN_MSG = 30
    const visible  = brandAlerts.slice(0, MAX_ROWS_IN_MSG)
    const overflow = brandAlerts.length - visible.length
    const style    = brandStyle[brand] ?? brandStyle.G2G

    const tableLines = visible.map(a => {
      const marketLabel = TIER_MARKETS[a.market as TierMarket]?.label ?? a.market.toUpperCase()
      const tag = a.reason === 'T1_DROP' ? '🟠' : '🔴'
      const move = a.prevPosition != null && a.currPosition != null
        ? `#${a.prevPosition} → #${a.currPosition} (${a.delta > 0 ? '+' : ''}${a.delta})`
        : a.currPosition == null
          ? `#${a.prevPosition ?? '?'} → ❌ out of SERP`
          : `#${a.prevPosition ?? '?'} → #${a.currPosition}`
      return `${tag} *T${a.tier}* | _${a.productName}_ | \`${a.keyword}\` (${marketLabel}) — ${move}`
    })

    const blocks: unknown[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${style.emoji} ${brand} — Tier Ranking Alerts (${brandAlerts.length} flag${brandAlerts.length === 1 ? '' : 's'})`, emoji: true },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `Tier 1 drops ≥${T1_DROP_THRESHOLD} pos: *${t1Count}*  ·  Tier 2 fell out of top 10: *${t2Count}*` },
        ],
      },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: tableLines.join('\n') || '_no rows_' } },
    ]
    if (overflow > 0) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `+${overflow} more drops — view in Priority Products page.` }],
      })
    }

    try {
      const slackRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Wrap in attachments with brand color stripe (per Sprint OG.SLACK.FIX)
        body: JSON.stringify({ attachments: [{ color: style.color, blocks }] }),
      })
      if (slackRes.ok) {
        postedBrands++
        perBrandResults[brand] = { ok: true, alerts: brandAlerts.length }
      } else {
        perBrandResults[brand] = { ok: false, alerts: brandAlerts.length, reason: `http_${slackRes.status}` }
      }
    } catch (e) {
      perBrandResults[brand] = { ok: false, alerts: brandAlerts.length, reason: String(e) }
    }
  }

  return NextResponse.json({
    ok:           postedBrands > 0,
    alerts:       alerts.length,
    brands_posted: postedBrands,
    per_brand:    perBrandResults,
    delivered:    postedBrands > 0 ? 'slack' : 'none',
  })
}
