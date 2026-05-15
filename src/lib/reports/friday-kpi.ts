// Sprint FRIDAY.KPI — Combined G2G + OffGamers weekly digest.
//
// Galih wants one Slack message every Friday afternoon that summarizes the
// week's worth of action items + numbers — basically the "what should I
// stress about this weekend" pulse. The digest pulls from infrastructure
// we already have:
//
//   • seo_action_items                   — Sprint FRIDAY.KPI.INFRA columns
//                                          (notification_type, search_volume, intent)
//   • tier_serp_snapshots                — top movers across both brands
//   • cost_alert_state + api_usage_logs  — month-to-date spend status
//   • seo_content_briefs (id_experiment) — A/B cohort progress
//
// Output is a single Slack block-kit message. Combined channel (per
// settings/slack-routing) shows G2G on top, OffGamers below, divider in
// between — the same channel decides whether the read is for one or
// both brands.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getMonthlySpend, type MonthlySpend } from '@/lib/costs/monthly-spend'

const TOP_ITEMS_PER_BUCKET = 5
const LOOKBACK_DAYS        = 7

export interface ActionItem {
  id:                 string
  site_slug:          string | null
  page:               string | null
  title:              string
  action_type:        string | null
  priority:           string | null
  notification_type:  string | null
  search_volume:      number | null
  intent:             string | null
  created_at:         string
}

export interface FridayKpiBucket {
  notification_type: string
  count:             number
  top_items:         ActionItem[]
}

export interface FridayKpiBrandData {
  site_slug:          string
  total_items:        number
  buckets:            FridayKpiBucket[]
  top_movers_up:      Array<{ keyword: string; market: string; from: number | null; to: number | null; product: string | null }>
  top_movers_down:    Array<{ keyword: string; market: string; from: number | null; to: number | null; product: string | null }>
}

export interface FridayKpiPayload {
  week_label:    string                       // e.g. "Week of 2026-05-11"
  generated_at:  string
  brands:        FridayKpiBrandData[]         // typically G2G + OG
  cost:          MonthlySpend                 // shared (one Anthropic key)
  experiments: {
    id_native_ab: {
      enrolled_total: number
      en_translate:   number
      id_native:      number
      note:           string
    }
  }
}

/**
 * Build the digest payload. Brand-agnostic at the top level — caller
 * passes in the list of site_slugs to include.
 *
 * @param db        — service-role supabase client
 * @param ownerId   — workspace owner ID. Note: the actual data is pulled
 *                    per-site via site_slug; ownerId scopes the lookups so
 *                    a multi-tenant deployment doesn't cross workspaces.
 * @param siteSlugs — brands to include in the combined digest, e.g.
 *                    ['g2g', 'offgamers']. Order = render order.
 */
export async function buildFridayKpi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>,
  ownerId:   string,
  siteSlugs: string[],
): Promise<FridayKpiPayload> {
  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()

  // ── 1. Per-brand action items + top movers ──────────────────────────────
  const brands: FridayKpiBrandData[] = []
  for (const slug of siteSlugs) {
    // eslint-disable-next-line no-await-in-loop
    const brand = await buildBrandData(db, ownerId, slug, sinceIso)
    brands.push(brand)
  }

  // ── 2. Anthropic spend (shared across brands — one API key) ─────────────
  const cost = await getMonthlySpend(db, ownerId)

  // ── 3. ID-native A/B cohort snapshot ────────────────────────────────────
  const { data: variantRows } = await db
    .from('seo_content_briefs')
    .select('id_experiment_variant')
    .eq('owner_user_id', ownerId)
    .not('id_experiment_variant', 'is', null)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const variants = (variantRows ?? []) as any[]
  const enrolledTotal = variants.length
  const enTranslate   = variants.filter(v => v.id_experiment_variant === 'en_translate').length
  const idNative      = variants.filter(v => v.id_experiment_variant === 'id_native').length

  return {
    week_label:   weekLabel(),
    generated_at: new Date().toISOString(),
    brands,
    cost,
    experiments: {
      id_native_ab: {
        enrolled_total: enrolledTotal,
        en_translate:   enTranslate,
        id_native:      idNative,
        note: enrolledTotal < 30
          ? 'Cohort < 30 — too early for a directional read.'
          : 'See /api/reports/id-native-ab for combined-score winner.',
      },
    },
  }
}

async function buildBrandData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>,
  ownerId:   string,
  siteSlug:  string,
  sinceIso:  string,
): Promise<FridayKpiBrandData> {
  // Action items created in the last 7 days, scoped to this brand.
  // We fetch broadly then bucket in JS so we have one DB round-trip.
  const { data } = await db
    .from('seo_action_items')
    .select('id, site_slug, page, title, action_type, priority, notification_type, search_volume, intent, created_at')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .gte('created_at', sinceIso)
    .order('search_volume', { ascending: false, nullsFirst: false })

  const items = (data ?? []) as ActionItem[]

  // Bucket by notification_type — items without a type fall into 'manual'.
  const byType = new Map<string, ActionItem[]>()
  for (const it of items) {
    const t = (it.notification_type ?? 'manual').toLowerCase()
    const list = byType.get(t) ?? []
    list.push(it)
    byType.set(t, list)
  }

  // Stable display order — most actionable buckets first.
  const ORDER = ['tier_rank', 'gsc_signal', 'cms_alert', 'cost_alert', 'backlink', 'mimir', 'manual']
  const buckets: FridayKpiBucket[] = ORDER
    .filter(t => byType.has(t))
    .map(t => {
      const all = byType.get(t) ?? []
      // Sort each bucket by search_volume DESC, then by priority (critical > high > med > low).
      const sorted = [...all].sort((a, b) => {
        const sv = (b.search_volume ?? 0) - (a.search_volume ?? 0)
        if (sv !== 0) return sv
        return priorityRank(b.priority) - priorityRank(a.priority)
      })
      return {
        notification_type: t,
        count:             all.length,
        top_items:         sorted.slice(0, TOP_ITEMS_PER_BUCKET),
      }
    })

  // Also surface any custom notification_type values that weren't in the ORDER list.
  for (const [t, all] of byType.entries()) {
    if (ORDER.includes(t)) continue
    buckets.push({
      notification_type: t,
      count:             all.length,
      top_items:         all.slice(0, TOP_ITEMS_PER_BUCKET),
    })
  }

  // Top movers from tier_serp_snapshots — latest snapshot pair per
  // (product × keyword × market). We compare the two most-recent dates.
  const movers = await buildMovers(db, ownerId, siteSlug)

  return {
    site_slug:       siteSlug,
    total_items:     items.length,
    buckets,
    top_movers_up:   movers.up,
    top_movers_down: movers.down,
  }
}

function priorityRank(p: string | null): number {
  switch ((p ?? '').toLowerCase()) {
    case 'critical': return 4
    case 'high':     return 3
    case 'medium':   return 2
    case 'low':      return 1
    default:         return 0
  }
}

async function buildMovers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any>,
  ownerId:  string,
  siteSlug: string,
): Promise<{
  up:   Array<{ keyword: string; market: string; from: number | null; to: number | null; product: string | null }>
  down: Array<{ keyword: string; market: string; from: number | null; to: number | null; product: string | null }>
}> {
  // Pull last 14 days for this brand's tier products.
  const sinceDate = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)
  const { data: products } = await db
    .from('product_tiers')
    .select('id, product_name')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
  const productMap = new Map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((products ?? []) as any[]).map(p => [String(p.id), String(p.product_name)]),
  )
  const productIds = Array.from(productMap.keys())
  if (productIds.length === 0) return { up: [], down: [] }

  const { data: snaps } = await db
    .from('tier_serp_snapshots')
    .select('product_tier_id, keyword, market, snapshot_date, our_position')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', productIds)
    .gte('snapshot_date', sinceDate)
    .order('snapshot_date', { ascending: false })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (snaps ?? []) as any[]

  type Bucket = { latest: typeof rows[number] | null; previous: typeof rows[number] | null }
  const byKey = new Map<string, Bucket>()
  for (const s of rows) {
    const k = `${s.product_tier_id}|${s.keyword}|${s.market}`
    const cur = byKey.get(k) ?? { latest: null, previous: null }
    if (!cur.latest)        cur.latest   = s
    else if (!cur.previous && s.snapshot_date < cur.latest.snapshot_date) cur.previous = s
    byKey.set(k, cur)
  }

  type Mover = { keyword: string; market: string; from: number | null; to: number | null; product: string | null; delta: number }
  const movers: Mover[] = []
  for (const [, { latest, previous }] of byKey.entries()) {
    if (!latest || !previous) continue
    const a = previous.our_position
    const b = latest.our_position
    if (a == null && b == null) continue
    const delta = (a ?? 50) - (b ?? 50)   // positive = improved
    if (Math.abs(delta) < 2) continue      // skip noise
    movers.push({
      keyword: String(latest.keyword),
      market:  String(latest.market),
      from:    a,
      to:      b,
      product: productMap.get(String(latest.product_tier_id)) ?? null,
      delta,
    })
  }

  movers.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
  const up   = movers.filter(m => m.delta > 0).slice(0, 5).map(stripDelta)
  const down = movers.filter(m => m.delta < 0).slice(0, 5).map(stripDelta)
  return { up, down }
}

function stripDelta(m: { keyword: string; market: string; from: number | null; to: number | null; product: string | null }) {
  return { keyword: m.keyword, market: m.market, from: m.from, to: m.to, product: m.product }
}

function weekLabel(now: Date = new Date()): string {
  // Find Monday of this week (UTC)
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return `Week of ${d.toISOString().slice(0, 10)}`
}

// ─── Slack block-kit builder ─────────────────────────────────────────────────

/**
 * Convert the payload to a Slack block-kit message. Pure function — easy
 * to test, and reusable by both the cron and the manual trigger.
 */
export function buildFridayKpiSlackBlocks(payload: FridayKpiPayload): {
  text:   string
  blocks: Array<Record<string, unknown>>
} {
  const blocks: Array<Record<string, unknown>> = []

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `🗓 Friday KPI — ${payload.week_label}`, emoji: true },
  })

  // ── Headline summary ──
  const totalItems = payload.brands.reduce((s, b) => s + b.total_items, 0)
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*${totalItems} action item${totalItems !== 1 ? 's' : ''}* this week across ${payload.brands.length} brand${payload.brands.length !== 1 ? 's' : ''}.`,
        `*Anthropic spend MTD:* $${payload.cost.anthropicUsd.toFixed(2)} (${payload.cost.yearMonth})`,
        `*ID-native A/B cohort:* ${payload.experiments.id_native_ab.enrolled_total} briefs · EN-translate ${payload.experiments.id_native_ab.en_translate} / ID-native ${payload.experiments.id_native_ab.id_native}`,
      ].join('\n'),
    },
  })

  for (const brand of payload.brands) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${brand.site_slug.toUpperCase()}* — ${brand.total_items} item${brand.total_items !== 1 ? 's' : ''} this week`,
      },
    })

    // Bucketed items
    for (const bucket of brand.buckets) {
      const headline = `*${formatBucketLabel(bucket.notification_type)}* (${bucket.count})`
      const lines = bucket.top_items.slice(0, TOP_ITEMS_PER_BUCKET).map(it => {
        const sv     = it.search_volume ? `SV ${it.search_volume.toLocaleString()}` : 'SV —'
        const intent = it.intent ? ` · ${it.intent}` : ''
        const page   = it.page ? ` · \`${safePath(it.page)}\`` : ''
        return `• ${it.title} _(${sv}${intent})_${page}`
      }).join('\n')
      if (lines) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `${headline}\n${lines}` },
        })
      }
    }

    // Top movers
    if (brand.top_movers_up.length > 0 || brand.top_movers_down.length > 0) {
      const upLines = brand.top_movers_up.map(m =>
        `• 📈 *${m.keyword}* (${m.market.toUpperCase()}) — #${m.from ?? '—'} → #${m.to ?? '—'}`,
      ).join('\n')
      const downLines = brand.top_movers_down.map(m =>
        `• 📉 *${m.keyword}* (${m.market.toUpperCase()}) — #${m.from ?? '—'} → #${m.to ?? '—'}`,
      ).join('\n')
      const moverText = [upLines, downLines].filter(Boolean).join('\n')
      if (moverText) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `*Top movers (last 2 weeks)*\n${moverText}` },
        })
      }
    }

    if (brand.total_items === 0 && brand.top_movers_up.length === 0 && brand.top_movers_down.length === 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '_No action items or significant SERP movement — quiet week._' },
      })
    }
  }

  // Footer
  blocks.push({ type: 'divider' })
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `_Generated ${payload.generated_at.slice(0, 16).replace('T', ' ')} UTC · Combined G2G + OG channel · Routing: notification_type=friday_kpi_`,
    }],
  })

  const text = `🗓 Friday KPI — ${payload.week_label}: ${totalItems} action items across ${payload.brands.length} brands`
  return { text, blocks }
}

function formatBucketLabel(t: string): string {
  const map: Record<string, string> = {
    tier_rank:  '📊 Tier rank movement',
    gsc_signal: '🔎 GSC signal',
    cms_alert:  '📦 CMS alert',
    cost_alert: '💰 Cost alert',
    backlink:   '🔗 Backlink',
    mimir:      '🧠 Mimir learning',
    manual:     '✍️ Manual',
  }
  return map[t] ?? t
}

function safePath(url: string): string {
  try { return new URL(url).pathname.slice(0, 60) } catch { return url.slice(0, 60) }
}
