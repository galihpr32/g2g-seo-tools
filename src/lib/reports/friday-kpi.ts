// Sprint FRIDAY.KPI (v2) — KPI Dashboard rewrite.
//
// Old version was a generic action-items digest. The spec was actually a
// per-(brand × market) KPI dashboard:
//
//   🥇 MOST COMPETITIVE KEYWORD RANKINGS
//       For each brand × market: Avg pos, Top 3, Top 10 — all with WoW delta
//   📈 SEO TRAFFIC — Clicks WoW
//       Per-brand totals last 7d vs prior 7d (GSC)
//   📈 SEO TRAFFIC — Impressions WoW
//       Same matrix
//
// "Most competitive" = all keywords currently tracked in tier_keywords
// for products on this brand (they're pre-curated as priority — counts as
// the competitive set). When SV data is available, we surface it; when
// not, we still report the structural KPIs.
//
// Market mapping per the wider app: 'us' → "Global", 'id' → "ID".

import type { SupabaseClient } from '@supabase/supabase-js'

export const MARKET_LABELS: Record<string, string> = { us: 'Global', id: 'ID' }
const MARKETS = ['us', 'id'] as const
type Market = typeof MARKETS[number]

const WOW_DAYS = 7

export interface MarketKpi {
  market:         Market
  market_label:   string
  kw_count:       number
  avg_position:   number | null
  avg_pos_delta:  number | null         // positive = improved
  top3:           number
  top3_delta:     number
  top10:          number
  top10_delta:    number
}

export interface ClickKpi {
  market:        Market
  market_label:  string
  clicks:        number
  clicks_pct:    number | null          // WoW % (positive = up)
  impressions:   number
  imp_pct:       number | null
}

export interface BrandKpi {
  site_slug:    string
  serp:         MarketKpi[]
  traffic:      ClickKpi[]
}

export interface FridayKpiPayload {
  week_label:   string
  iso_week:     number
  generated_at: string
  brands:       BrandKpi[]
  /** Public weekly report URL (kalau ada) */
  public_url:   string | null
  /** Methodology page URL */
  methodology_url: string
  /** Priority products page URL */
  priority_url:    string
}

/**
 * Build the KPI payload across the given brands. Per-brand × per-market
 * lookups are done sequentially to keep this readable; total queries
 * scale as O(brands × markets × 2) which is small.
 */
export async function buildFridayKpi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>,
  ownerId:   string,
  siteSlugs: string[],
): Promise<FridayKpiPayload> {
  const brands: BrandKpi[] = []
  for (const slug of siteSlugs) {
    // eslint-disable-next-line no-await-in-loop
    const brand = await buildBrandKpi(db, ownerId, slug)
    brands.push(brand)
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')

  return {
    week_label:   weekLabel(),
    iso_week:     isoWeek(),
    generated_at: new Date().toISOString(),
    brands,
    public_url:        appUrl ? `${appUrl}/reports/weekly` : null,
    methodology_url:   `${appUrl}/methodology/competitive-keywords`,
    priority_url:      `${appUrl}/priority-products`,
  }
}

async function buildBrandKpi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any>,
  ownerId:  string,
  siteSlug: string,
): Promise<BrandKpi> {
  // ── Per-market SERP aggregates ────────────────────────────────────────
  const serp: MarketKpi[] = []
  for (const market of MARKETS) {
    // eslint-disable-next-line no-await-in-loop
    const m = await buildMarketSerp(db, ownerId, siteSlug, market)
    serp.push(m)
  }

  // ── Per-market traffic (GSC clicks + impressions) ──────────────────────
  const traffic = await buildBrandTraffic(db, ownerId, siteSlug)

  return { site_slug: siteSlug, serp, traffic }
}

async function buildMarketSerp(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any>,
  ownerId:  string,
  siteSlug: string,
  market:   Market,
): Promise<MarketKpi> {
  const empty: MarketKpi = {
    market, market_label: MARKET_LABELS[market], kw_count: 0,
    avg_position: null, avg_pos_delta: null,
    top3: 0, top3_delta: 0,
    top10: 0, top10_delta: 0,
  }

  // 1. Find all tier-product IDs for this brand
  const { data: products } = await db
    .from('product_tiers')
    .select('id')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pIds = ((products ?? []) as any[]).map(p => String(p.id))
  if (pIds.length === 0) return empty

  // 2. Pull latest + ~7-day-ago SERP snapshots for this brand × market.
  //    Window of 14 days covers the comparison; we pick the two anchor
  //    dates in JS to avoid two round-trips.
  const sinceDate = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10)
  const { data: snaps } = await db
    .from('tier_serp_snapshots')
    .select('product_tier_id, keyword, market, snapshot_date, our_position')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', pIds)
    .eq('market', market)
    .gte('snapshot_date', sinceDate)
    .order('snapshot_date', { ascending: false })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (snaps ?? []) as any[]
  if (rows.length === 0) return empty

  // Latest snapshot per (product × keyword): the most recent date present.
  // The "WoW prior" comparison: pick the latest snapshot strictly older
  // than (latestDate - 5 days). 5 days lets us flex around weekly cadence
  // without missing a comparison when the cron skips a day.
  const dates = Array.from(new Set(rows.map(r => String(r.snapshot_date)))).sort().reverse()
  const latestDate = dates[0]
  const latestMs   = new Date(latestDate).getTime()
  const priorCutoff = latestMs - 5 * 86_400_000   // cutoff: must be older than this
  const priorDate  = dates.find(d => new Date(d).getTime() < priorCutoff) ?? null

  type PerKw = { latest: number | null; prior: number | null }
  const perKw = new Map<string, PerKw>()
  for (const r of rows) {
    const key = `${r.product_tier_id}|${r.keyword}`
    const cur = perKw.get(key) ?? { latest: null, prior: null }
    const pos = r.our_position == null ? null : Number(r.our_position)
    if (r.snapshot_date === latestDate && cur.latest === null) cur.latest = pos
    if (priorDate && r.snapshot_date === priorDate && cur.prior === null) cur.prior = pos
    perKw.set(key, cur)
  }

  let posSum = 0, posCount = 0, top3 = 0, top10 = 0
  let posSumPrev = 0, posCountPrev = 0, top3Prev = 0, top10Prev = 0
  for (const v of perKw.values()) {
    if (v.latest != null) {
      posSum += v.latest; posCount++
      if (v.latest <= 3)  top3++
      if (v.latest <= 10) top10++
    }
    if (v.prior != null) {
      posSumPrev += v.prior; posCountPrev++
      if (v.prior <= 3)  top3Prev++
      if (v.prior <= 10) top10Prev++
    }
  }

  const avgPos     = posCount     > 0 ? +(posSum     / posCount).toFixed(1)     : null
  const avgPosPrev = posCountPrev > 0 ? +(posSumPrev / posCountPrev).toFixed(1) : null

  return {
    market,
    market_label: MARKET_LABELS[market],
    kw_count:     perKw.size,
    avg_position:  avgPos,
    // Convention: positive delta = improvement (= prior - current; lower pos # is better)
    avg_pos_delta: (avgPos != null && avgPosPrev != null) ? +(avgPosPrev - avgPos).toFixed(1) : null,
    top3,
    top3_delta:    top3 - top3Prev,
    top10,
    top10_delta:   top10 - top10Prev,
  }
}

async function buildBrandTraffic(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any>,
  ownerId:  string,
  siteSlug: string,
): Promise<ClickKpi[]> {
  // Resolve site_url for this brand from site_configs.
  const { data: cfg } = await db
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', siteSlug)
    .maybeSingle()
  const siteUrl = cfg?.gsc_property as string | undefined
  if (!siteUrl) {
    return MARKETS.map(m => ({ market: m, market_label: MARKET_LABELS[m], clicks: 0, clicks_pct: null, impressions: 0, imp_pct: null }))
  }

  // We don't have country split on gsc_ranking_snapshots in this schema —
  // surface combined totals per brand under "Global" and zero for ID.
  // Future enhancement: pull country-split via GSC API directly.
  // (Acknowledged in the Slack message footnote.)
  const today    = Date.now()
  const sinceCur = new Date(today - WOW_DAYS * 86_400_000).toISOString().slice(0, 10)
  const sincePrev = new Date(today - 2 * WOW_DAYS * 86_400_000).toISOString().slice(0, 10)

  const { data: snaps } = await db
    .from('gsc_ranking_snapshots')
    .select('snapshot_date, clicks, impressions')
    .eq('site_url', siteUrl)
    .gte('snapshot_date', sincePrev)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (snaps ?? []) as any[]

  let curClicks = 0, curImp = 0, prevClicks = 0, prevImp = 0
  for (const r of rows) {
    const isCur = String(r.snapshot_date) >= sinceCur
    const c = Number(r.clicks      ?? 0)
    const i = Number(r.impressions ?? 0)
    if (isCur) { curClicks += c; curImp += i } else { prevClicks += c; prevImp += i }
  }

  const pct = (cur: number, prev: number): number | null => {
    if (prev <= 0) return cur > 0 ? 100 : null
    return +(((cur - prev) / prev) * 100).toFixed(1)
  }

  // We don't have country-split in gsc_ranking_snapshots → expose combined
  // totals as "Global"; "ID" slot left zero with a footnote in the Slack
  // template. (Acceptable v1; future cron can split per-country via the
  // GSC client directly.)
  return [
    { market: 'us', market_label: MARKET_LABELS.us, clicks: curClicks, clicks_pct: pct(curClicks, prevClicks), impressions: curImp, imp_pct: pct(curImp, prevImp) },
    { market: 'id', market_label: MARKET_LABELS.id, clicks: 0,         clicks_pct: null,                       impressions: 0,      imp_pct: null },
  ]
}

function weekLabel(now: Date = new Date()): string {
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return `Week ${isoWeek(d)} · ${d.toISOString().slice(0, 10)}`
}

function isoWeek(d: Date = new Date()): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}

// ─── Slack block-kit builder ─────────────────────────────────────────────────

export function buildFridayKpiSlackBlocks(p: FridayKpiPayload): {
  text:   string
  blocks: Array<Record<string, unknown>>
} {
  const blocks: Array<Record<string, unknown>> = []

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `📊 Weekly Friday KPI Wrap · ${p.week_label}`, emoji: true },
  })

  // ── SERP rankings section ──
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*🥇 MOST COMPETITIVE KEYWORD RANKINGS*' },
  })

  // One block per brand — two-column layout (Global vs ID) using mrkdwn fields.
  for (const brand of p.brands) {
    const global = brand.serp.find(s => s.market === 'us') ?? null
    const id     = brand.serp.find(s => s.market === 'id') ?? null
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${brand.site_slug.toUpperCase()}* · ${(global?.kw_count ?? 0) + (id?.kw_count ?? 0)} tracked kws` },
      fields: [
        { type: 'mrkdwn', text: `*🌐 Global*\n${formatSerpCell(global)}` },
        { type: 'mrkdwn', text: `*🇮🇩 ID*\n${formatSerpCell(id)}` },
      ],
    })
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `_Most competitive = tier-tracked keywords (curated set per <${p.methodology_url}|methodology>). WoW delta = latest snapshot vs ~7 days prior._`,
    }],
  })

  // ── Traffic section ──
  blocks.push({ type: 'divider' })
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*📈 SEO TRAFFIC — Clicks WoW (GSC)*' },
  })
  for (const brand of p.brands) {
    const global = brand.traffic.find(t => t.market === 'us') ?? null
    const id     = brand.traffic.find(t => t.market === 'id') ?? null
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${brand.site_slug.toUpperCase()}*` },
      fields: [
        { type: 'mrkdwn', text: `*🌐 Global*\n${formatClickCell(global)}` },
        { type: 'mrkdwn', text: `*🇮🇩 ID*\n${formatClickCell(id)}` },
      ],
    })
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*📈 SEO TRAFFIC — Impressions WoW (GSC)*' },
  })
  for (const brand of p.brands) {
    const global = brand.traffic.find(t => t.market === 'us') ?? null
    const id     = brand.traffic.find(t => t.market === 'id') ?? null
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${brand.site_slug.toUpperCase()}*` },
      fields: [
        { type: 'mrkdwn', text: `*🌐 Global*\n${formatImpCell(global)}` },
        { type: 'mrkdwn', text: `*🇮🇩 ID*\n${formatImpCell(id)}` },
      ],
    })
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '_GSC-verified · last 7 days vs prior 7 days · ID country-split coming once GSC country-dim is enabled (currently combined under Global)._',
    }],
  })

  // ── Action buttons ──
  if (p.public_url || p.methodology_url || p.priority_url) {
    blocks.push({
      type: 'actions',
      elements: [
        ...(p.public_url ? [{
          type: 'button',
          text: { type: 'plain_text', text: '📄 Public Report' },
          url:  p.public_url,
        }] : []),
        {
          type: 'button',
          text: { type: 'plain_text', text: '🎯 Methodology Doc' },
          url:  p.methodology_url,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📊 Priority Products' },
          url:  p.priority_url,
        },
      ],
    })
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `_Generated ${p.generated_at.slice(0, 16).replace('T', ' ')} UTC · Combined G2G + OG channel · notification_type=friday_kpi_`,
    }],
  })

  const totalKws = p.brands.reduce((s, b) => s + b.serp.reduce((ss, m) => ss + m.kw_count, 0), 0)
  const text = `📊 Friday KPI ${p.week_label} — ${totalKws} kws across ${p.brands.length} brands`
  return { text, blocks }
}

function formatSerpCell(m: MarketKpi | null): string {
  if (!m || m.kw_count === 0) return '_no tracked kws_'
  return [
    `Avg #${m.avg_position?.toFixed(1) ?? '—'} ${deltaArrow(m.avg_pos_delta, true)}`,
    `Top 3: ${m.top3} ${signedCount(m.top3_delta)}`,
    `Top 10: ${m.top10} ${signedCount(m.top10_delta)}`,
  ].join('\n')
}

function formatClickCell(t: ClickKpi | null): string {
  if (!t) return '_n/a_'
  if (t.clicks === 0 && t.clicks_pct === null) return '_n/a_'
  return `${formatK(t.clicks)} ${deltaPctArrow(t.clicks_pct)}`
}

function formatImpCell(t: ClickKpi | null): string {
  if (!t) return '_n/a_'
  if (t.impressions === 0 && t.imp_pct === null) return '_n/a_'
  return `${formatK(t.impressions)} ${deltaPctArrow(t.imp_pct)}`
}

function deltaArrow(d: number | null, positiveIsGood: boolean): string {
  if (d == null) return ''
  if (Math.abs(d) < 0.05) return '·'
  const good = (d > 0) === positiveIsGood
  const arrow = d > 0 ? '↑' : '↓'
  const color = good ? '✅' : '⚠️'
  return `${arrow}${Math.abs(d).toFixed(1)} ${color}`
}

function signedCount(d: number): string {
  if (d === 0) return ''
  return d > 0 ? `(+${d})` : `(${d})`
}

function deltaPctArrow(d: number | null): string {
  if (d == null) return ''
  if (Math.abs(d) < 0.1) return '(flat)'
  const arrow = d > 0 ? '↑' : '↓'
  return `(${arrow}${Math.abs(d).toFixed(0)}%)`
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}
