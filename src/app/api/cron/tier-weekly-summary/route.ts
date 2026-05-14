import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { TIER_MARKETS, type TierMarket } from '@/lib/ranking-tracker'
import { resolveSlackWebhook } from '@/lib/slack/routing'

export const maxDuration = 120

/**
 * GET /api/cron/tier-weekly-summary
 *
 * Monday-morning POSITIVE summary across all Tier 1 + Tier 2 keywords.
 * Distinct from /api/cron/tier-rank-alerts (which only flags DROPS):
 *   • This cron posts a comprehensive scorecard of where every tier
 *     keyword sits AND week-over-week change.
 *   • One consolidated Slack message covering both brands.
 *
 * Schedule: Monday 03:00 UTC (= 10:00 WIB) — runs AFTER the weekly SERP
 * refresh at 02:00 UTC so the freshest snapshot is in the DB.
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
  id:           string
  owner_user_id: string
  site_slug:    string
  tier:         1 | 2
  product_name: string
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // ── 1. Pull all tier products ─────────────────────────────────────────────
  const { data: products } = await db
    .from('product_tiers')
    .select('id, owner_user_id, site_slug, tier, product_name')

  const tierProducts = (products ?? []) as ProductMeta[]
  if (tierProducts.length === 0) {
    return NextResponse.json({ ok: true, message: 'No tier products — skipping.' })
  }

  const productMap = new Map(tierProducts.map(p => [p.id, p]))

  // ── 2. Pull last 21 days of snapshots so we can compute current + 1-week-ago
  const sinceIso = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10)
  const { data: snapsRaw } = await db
    .from('tier_serp_snapshots')
    .select('owner_user_id, product_tier_id, keyword, market, snapshot_date, our_position')
    .gte('snapshot_date', sinceIso)
    .order('snapshot_date', { ascending: false })

  const snapshots = (snapsRaw ?? []) as SnapRow[]
  if (snapshots.length === 0) {
    return NextResponse.json({ ok: true, message: 'No SERP snapshots — run /api/cron/tier-serp-weekly first.' })
  }

  // ── 3. Bucket: latest snapshot per (product × keyword × market) + previous
  type Bucket = { latest: SnapRow; prev?: SnapRow }
  const buckets = new Map<string, Bucket>()
  for (const s of snapshots) {
    const k = `${s.product_tier_id}|${s.keyword}|${s.market}`
    const cur = buckets.get(k)
    if (!cur) buckets.set(k, { latest: s })
    else if (!cur.prev && s.snapshot_date < cur.latest.snapshot_date) cur.prev = s
  }

  // ── 4. Aggregate stats per (brand × tier) ─────────────────────────────────
  // Galih ops both G2G and OffGamers from the same Slack workspace, so one
  // message with two sections is the right shape (not 2 messages).
  type Agg = {
    kwCount:        number
    posSum:         number
    posCount:       number
    posSumPrev:     number
    posCountPrev:   number
    top3:           number
    top10:          number
    top3Prev:       number
    top10Prev:      number
    gainers:        Array<{ kw: string; product: string; market: string; prev: number | null; curr: number | null; delta: number }>
    losers:         Array<{ kw: string; product: string; market: string; prev: number | null; curr: number | null; delta: number }>
  }
  const emptyAgg = (): Agg => ({
    kwCount: 0, posSum: 0, posCount: 0, posSumPrev: 0, posCountPrev: 0,
    top3: 0, top10: 0, top3Prev: 0, top10Prev: 0,
    gainers: [], losers: [],
  })

  // key = `${siteSlug}|t${tier}`
  const grid: Record<string, Agg> = {}

  for (const b of buckets.values()) {
    const p = productMap.get(b.latest.product_tier_id)
    if (!p) continue
    const key = `${p.site_slug}|t${p.tier}`
    grid[key] ??= emptyAgg()
    const a = grid[key]

    a.kwCount++

    const cur = b.latest.our_position
    if (cur != null) {
      a.posSum += cur
      a.posCount++
      if (cur <= 3) a.top3++
      else if (cur <= 10) a.top10++
    }

    const prev = b.prev?.our_position ?? null
    if (prev != null) {
      a.posSumPrev += prev
      a.posCountPrev++
      if (prev <= 3) a.top3Prev++
      else if (prev <= 10) a.top10Prev++
    }

    // Track top movers (per brand+tier)
    if (cur != null && prev != null) {
      const delta = prev - cur   // positive = improved (e.g., 15 → 8 → delta 7)
      if (Math.abs(delta) >= 2) {
        const entry = {
          kw:      b.latest.keyword,
          product: p.product_name,
          market:  b.latest.market,
          prev, curr: cur, delta,
        }
        if (delta > 0) a.gainers.push(entry)
        else            a.losers.push(entry)
      }
    }
  }

  // Sort gainers/losers by magnitude, keep top 3 each per (brand × tier)
  for (const a of Object.values(grid)) {
    a.gainers.sort((x, y) => y.delta - x.delta).splice(3)
    a.losers.sort((x, y) => x.delta - y.delta).splice(3)
  }

  // ── 5. Format Slack message — Sprint OG.SLACK.FIX ─────────────────────────
  // Used to send ONE consolidated message with both brand sections. Now per
  // brand so OG admin gets their stream isolated. Each brand routes via its
  // own slack_routing_config row (site_slug='offgamers' or 'g2g').
  const brandOrder = ['g2g', 'offgamers']
  const brandStyle: Record<string, { color: string; emoji: string }> = {
    g2g:       { color: '#DC2626', emoji: '🎯' },
    offgamers: { color: '#2563EB', emoji: '🕹️' },
  }
  const today = new Date().toISOString().slice(0, 10)

  const perBrandResults: Record<string, { ok: boolean; reason?: string }> = {}
  let postedBrands = 0

  for (const slug of brandOrder) {
    const t1 = grid[`${slug}|t1`]
    const t2 = grid[`${slug}|t2`]
    if (!t1 && !t2) {
      perBrandResults[slug] = { ok: false, reason: 'no_data' }
      continue
    }

    // Resolve webhook for THIS brand
    const { data: brandOwner } = await db
      .from('slack_routing_config')
      .select('owner_user_id')
      .eq('notification_type', 'tier_summary')
      .eq('enabled', true)
      .or(`site_slug.eq.${slug},site_slug.is.null`)
      .limit(1)
      .maybeSingle()
    const ownerForRoute = brandOwner?.owner_user_id
      ?? (await db.from('product_tiers').select('owner_user_id').eq('site_slug', slug).limit(1).maybeSingle()).data?.owner_user_id
      ?? null
    const webhookUrl = ownerForRoute
      ? await resolveSlackWebhook(db, ownerForRoute, 'tier_summary', { siteSlug: slug })
      : process.env.SLACK_WEBHOOK_URL ?? null
    if (!webhookUrl) {
      perBrandResults[slug] = { ok: false, reason: 'no_webhook' }
      continue
    }

    const style = brandStyle[slug] ?? brandStyle.g2g
    const blocks: unknown[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${style.emoji} ${slug.toUpperCase()} — Weekly Tier Rankings`, emoji: true },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `Snapshot: *${today}* · Markets: ${Object.values(TIER_MARKETS).map(m => m.label).join(', ')}` },
        ],
      },
      { type: 'divider' },
    ]
    if (t1) blocks.push(...renderTierBlock(1, t1))
    if (t2) blocks.push(...renderTierBlock(2, t2))
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_View full breakdown in `/priority-products/rankings`_' }],
    })

    try {
      const slackRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Brand-colored attachment stripe
        body: JSON.stringify({ attachments: [{ color: style.color, blocks }] }),
      })
      if (slackRes.ok) {
        postedBrands++
        perBrandResults[slug] = { ok: true }
      } else {
        perBrandResults[slug] = { ok: false, reason: `http_${slackRes.status}` }
      }
    } catch (e) {
      perBrandResults[slug] = { ok: false, reason: String(e) }
    }
  }

  return NextResponse.json({
    ok:         postedBrands > 0,
    delivered:  postedBrands > 0 ? 'slack' : 'none',
    brands:     Object.keys(perBrandResults).filter(k => perBrandResults[k].ok),
    per_brand:  perBrandResults,
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderTierBlock(tier: 1 | 2, a: { kwCount: number; posSum: number; posCount: number; posSumPrev: number; posCountPrev: number; top3: number; top10: number; top3Prev: number; top10Prev: number; gainers: Array<{ kw: string; product: string; market: string; prev: number | null; curr: number | null; delta: number }>; losers: Array<{ kw: string; product: string; market: string; prev: number | null; curr: number | null; delta: number }> }): unknown[] {
  const avgCur  = a.posCount     > 0 ? (a.posSum     / a.posCount).toFixed(1)     : '—'
  const avgPrev = a.posCountPrev > 0 ? (a.posSumPrev / a.posCountPrev).toFixed(1) : null
  const avgDelta = avgPrev != null
    ? +((parseFloat(avgPrev) - parseFloat(avgCur))).toFixed(1)   // positive = improved
    : null
  const top3D  = a.top3  - a.top3Prev
  const top10D = a.top10 - a.top10Prev
  const tag = tier === 1 ? '🥇 *Tier 1*' : '🥈 *Tier 2*'

  // Summary header
  const summary = `${tag} — *${a.kwCount}* kws tracked\n` +
    `• Avg position: *#${avgCur}*${avgDelta != null ? ` (${avgDelta > 0 ? '↑' : avgDelta < 0 ? '↓' : '→'} ${Math.abs(avgDelta).toFixed(1)})` : ''}\n` +
    `• Top 3: *${a.top3}*${top3D !== 0 ? ` (${top3D > 0 ? '+' : ''}${top3D})` : ''}    Top 10: *${a.top10}*${top10D !== 0 ? ` (${top10D > 0 ? '+' : ''}${top10D})` : ''}`

  const out: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
  ]

  // Top movers (compact)
  const moverLines: string[] = []
  if (a.gainers.length > 0) {
    moverLines.push('📈 _Gainers:_ ' + a.gainers.map(g =>
      `\`${truncKw(g.kw)}\` ${marketTag(g.market)} #${g.prev} → #${g.curr} (+${g.delta})`,
    ).join(' · '))
  }
  if (a.losers.length > 0) {
    moverLines.push('📉 _Losers:_ ' + a.losers.map(l =>
      `\`${truncKw(l.kw)}\` ${marketTag(l.market)} #${l.prev} → #${l.curr} (${l.delta})`,
    ).join(' · '))
  }
  if (moverLines.length > 0) {
    out.push({ type: 'section', text: { type: 'mrkdwn', text: moverLines.join('\n') } })
  }
  return out
}

function truncKw(kw: string): string {
  return kw.length > 24 ? kw.slice(0, 24) + '…' : kw
}
function marketTag(m: string): string {
  const lbl = TIER_MARKETS[m as TierMarket]?.label
  return lbl ? `(${m.toUpperCase()})` : `(${m})`
}
