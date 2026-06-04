// ─── Friday KPI — Boss View data layer ──────────────────────────────────────
//
// Sprint #361 WEEKLY.BOSS.VIEW — per-brand exec-friendly weekly snapshot:
//   1. Chart 1 — traffic bars (this wk vs last wk) + revenue lines per market
//      (US + ID), grouped by brand
//   2. Chart 2 — scatter rank movement for top 5 focus KW per brand, dots per
//      market × week (US-LW, US-TW, ID-LW, ID-TW)
//   3. AI Source slice — GA4 sessionSource filtered to AI assistant domains
//      (ChatGPT, Perplexity, Gemini, Claude, Copilot, Syntx) — traffic +
//      revenue + WoW delta per source
//
// Focus KW selection per brand = composite z-score of (clicks + revenue):
//   - Universe = cluster_winners (tier_keywords with is_cluster_winner=true)
//   - clicks  = GSC clicks per query, summed across US + ID
//   - revenue = GA4 purchaseRevenue of the top landing page that ranks for
//               the query (best-effort attribution; LP-level not KW-level)
//   - z-score each metric independently, sum, top 5 by composite
//
// Window: same Thu→Wed pair as friday-kpi.ts so the boss view aligns with
// existing weekly digest numbers.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OAuth2Client } from 'google-auth-library'
import { getRefreshedClientFull } from '@/lib/gsc/auth'
import { getSearchAnalytics } from '@/lib/gsc/client'
import { getGA4Report, parseGA4Rows } from '@/lib/ga4/client'
import { normalizePath } from './friday-kpi-keyword-breakdown'

// ─── Window helper (Thu→Wed, current + previous) ────────────────────────────

export function bossViewWindows(now: Date = new Date()): {
  cur:  { start: string; end: string }
  prev: { start: string; end: string }
} {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = today.getDay()
  const daysSinceCompletedWed = day === 3 ? 7 : (day + 4) % 7 || 7
  const curEnd = new Date(today)
  curEnd.setDate(today.getDate() - daysSinceCompletedWed)
  const curStart = new Date(curEnd)
  curStart.setDate(curEnd.getDate() - 6)
  const prevEnd = new Date(curStart)
  prevEnd.setDate(curStart.getDate() - 1)
  const prevStart = new Date(prevEnd)
  prevStart.setDate(prevEnd.getDate() - 6)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return {
    cur:  { start: iso(curStart), end: iso(curEnd) },
    prev: { start: iso(prevStart), end: iso(prevEnd) },
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface BossViewMarketSlice {
  thisWeek: number
  lastWeek: number
  /** Positive = increase (good for traffic/revenue) */
  pct:      number | null
}

export interface BossViewFocusKeyword {
  keyword:    string
  /** True when this KW was picked from G2G's cluster_winners (vs OG). Used by
   *  the renderer to color/label rows; the same KW could appear on both
   *  brands' lists in theory, but composite z-scores are computed per-brand. */
  brand:      string
  /** Composite z-score (clicks_z + revenue_z). Higher = more important. */
  score:      number
  /** Current-week stats that drove the selection. Surfaced in the table so
   *  the reader sees "why is this KW on the list?" without guessing. */
  clicks:     number      // total clicks (US + ID) for THIS week
  revenue:    number      // proxy: GA4 revenue of top landing page for this KW
  topLandingPage: string  // normalized path
  /** Rank per (market × week). null = no tier_serp_snapshots row in that
   *  (market × Thu→Wed window) — typically means the KW isn't tracked in
   *  that market, or DataForSEO scrape missed it. UI renders "—" for null. */
  us: { lastWeek: number | null; thisWeek: number | null }
  id: { lastWeek: number | null; thisWeek: number | null }
}

export interface BossViewBrand {
  siteSlug: string
  siteName: string

  // Chart 1 — per-market traffic + revenue, WoW
  traffic: { us: BossViewMarketSlice; id: BossViewMarketSlice }
  revenue: { us: BossViewMarketSlice; id: BossViewMarketSlice }

  // Chart 2 — top 5 focus KW
  focusKeywords: BossViewFocusKeyword[]

  // Diagnostics — surfaced in preview UI footer so reader can debug
  diagnostics: {
    cluster_winner_count:  number
    gsc_queries_fetched:   number
    ga4_rev_pages_fetched: number
    kw_with_ga4_match:     number
    skip_reason?:          string
  }
}

export interface BossViewAiSource {
  domain:   string           // 'chatgpt.com', 'perplexity.ai', etc.
  label:    string           // 'ChatGPT', 'Perplexity', etc.
  users:    number           // current week
  sessions: number
  revenue:  number
  prevUsers:    number
  prevSessions: number
  prevRevenue:  number
}

export interface BossViewAiSlice {
  bySite: Record<string, {            // 'g2g' | 'offgamers'
    sources:        BossViewAiSource[]
    totalUsers:     number
    totalSessions:  number
    totalRevenue:   number
    prevTotalUsers:    number
    prevTotalSessions: number
    prevTotalRevenue:  number
    /** Set when GA4 OAuth missing or the property id can't be resolved — UI
     *  shows a "Not connected" badge and skips the panel for that brand. */
    skipReason?: string
  }>
}

export interface BossViewPayload {
  weekLabel:   string                 // e.g. "Week 23 · May 22-28"
  curStart:    string
  curEnd:      string
  prevStart:   string
  prevEnd:     string
  generatedAt: string                 // ISO

  brands:   BossViewBrand[]
  aiSource: BossViewAiSlice
}

// ─── AI source whitelist ────────────────────────────────────────────────────
// Domains GA4 reports for AI-assistant referrals. Source: Galih's GA4
// "AI Source - Test" custom channel group screenshot (2026-06-04). We
// filter via dimensionFilter on sessionSource directly instead of depending
// on the channel group being deployed to both properties.
const AI_SOURCES: Array<{ domains: string[]; label: string }> = [
  { label: 'ChatGPT',     domains: ['chatgpt.com', 'chat.openai.com'] },
  { label: 'Perplexity',  domains: ['perplexity.ai', 'perplexity.oneaccessbd.com'] },
  { label: 'Gemini',      domains: ['gemini.google.com'] },
  { label: 'Claude',      domains: ['claude.ai'] },
  { label: 'Copilot',     domains: ['copilot.microsoft.com'] },
  { label: 'Other AI',    domains: ['syntx.ai'] },
]
const ALL_AI_DOMAINS = AI_SOURCES.flatMap(s => s.domains)

// (Domain → label resolution lives inline in buildAiSourceForBrand so it can
// share the AI_SOURCES table without exporting; kept here as a top-level
// concept for future callers.)

// ─── Composite z-score helper ───────────────────────────────────────────────

function zScores(values: number[]): number[] {
  if (values.length === 0) return []
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  const std = Math.sqrt(variance)
  if (std === 0) return values.map(() => 0)   // all equal → all-zero z
  return values.map(v => (v - mean) / std)
}

function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null
  return Math.round(((cur - prev) / prev) * 1000) / 10
}

function weekLabel(curStart: string, curEnd: string): string {
  const start = new Date(curStart)
  const end   = new Date(curEnd)
  const isoWeek = (() => {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
    const dayNr  = (d.getUTCDay() + 6) % 7
    d.setUTCDate(d.getUTCDate() - dayNr + 3)
    const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
    return 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)
  })()
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `Week ${isoWeek} · ${fmt(start)}–${fmt(end)}`
}

// ─── Main: build the boss view payload ──────────────────────────────────────

export interface BuildBossViewOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>
  ownerId:   string
  siteSlugs: string[]
}

export async function buildBossView(opts: BuildBossViewOptions): Promise<BossViewPayload> {
  const { db, ownerId, siteSlugs } = opts
  const { cur, prev } = bossViewWindows()

  // ── Shared OAuth resolver ─────────────────────────────────────────────────
  const { data: conn } = await db
    .from('gsc_connections')
    .select('user_id, access_token, refresh_token, expires_at')
    .eq('user_id', ownerId)
    .maybeSingle()

  let auth: OAuth2Client | null = null
  if (conn?.access_token && conn?.refresh_token) {
    try {
      auth = await getRefreshedClientFull(
        conn.access_token  as string,
        conn.refresh_token as string,
        conn.expires_at    as string | null,
      )
    } catch (e) {
      console.warn('[boss-view] OAuth refresh failed:', e)
    }
  }

  // ── Per-brand boss-view rows (serial — small N) ───────────────────────────
  const brands: BossViewBrand[] = []
  for (const slug of siteSlugs) {
    const brand = await buildBrandBossView(db, ownerId, slug, auth, cur, prev)
    brands.push(brand)
  }

  // ── AI source (parallel per brand) ────────────────────────────────────────
  const aiSource: BossViewAiSlice = { bySite: {} }
  await Promise.all(siteSlugs.map(async slug => {
    aiSource.bySite[slug] = await buildAiSourceForBrand(db, slug, auth, cur, prev)
  }))

  return {
    weekLabel:   weekLabel(cur.start, cur.end),
    curStart:    cur.start,
    curEnd:      cur.end,
    prevStart:   prev.start,
    prevEnd:     prev.end,
    generatedAt: new Date().toISOString(),
    brands,
    aiSource,
  }
}

// ─── Per-brand boss view ────────────────────────────────────────────────────

async function buildBrandBossView(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any>,
  ownerId:  string,
  siteSlug: string,
  auth:     OAuth2Client | null,
  cur:      { start: string; end: string },
  prev:     { start: string; end: string },
): Promise<BossViewBrand> {
  const empty: BossViewBrand = {
    siteSlug,
    siteName: siteSlug === 'offgamers' ? 'OffGamers' : 'G2G',
    traffic: {
      us: { thisWeek: 0, lastWeek: 0, pct: null },
      id: { thisWeek: 0, lastWeek: 0, pct: null },
    },
    revenue: {
      us: { thisWeek: 0, lastWeek: 0, pct: null },
      id: { thisWeek: 0, lastWeek: 0, pct: null },
    },
    focusKeywords: [],
    diagnostics: {
      cluster_winner_count:  0,
      gsc_queries_fetched:   0,
      ga4_rev_pages_fetched: 0,
      kw_with_ga4_match:     0,
    },
  }

  // ── site_configs ──────────────────────────────────────────────────────────
  const { data: cfg } = await db
    .from('site_configs')
    .select('slug, display_name, gsc_property, ga4_property_id')
    .eq('slug', siteSlug)
    .maybeSingle()
  if (!cfg) {
    empty.diagnostics.skip_reason = `site_configs row missing for ${siteSlug}`
    return empty
  }

  empty.siteName = (cfg.display_name as string | null) ?? empty.siteName
  const gscProperty   = (cfg.gsc_property as string | null) ?? null
  const ga4PropertyId = (cfg.ga4_property_id as string | null) ?? null

  // ── Cluster winners universe (for focus KW selection) ─────────────────────
  // tier_keywords with is_cluster_winner=true → join product_tiers for brand
  // scoping. The keyword strings are what we'll look up in GSC + tier_serp_snapshots.
  const { data: tierProducts } = await db
    .from('product_tiers')
    .select('id, market')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const productIds = ((tierProducts ?? []) as any[]).map(p => String(p.id))
  if (productIds.length === 0) {
    empty.diagnostics.skip_reason = `no product_tiers for brand ${siteSlug}`
    return empty
  }
  // Map productId → market so we can later infer per-market rank presence.
  const productMarket = new Map<string, string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const p of (tierProducts ?? []) as any[]) productMarket.set(String(p.id), String(p.market))

  const { data: winnerRows } = await db
    .from('tier_keywords')
    .select('id, keyword, product_tier_id')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', productIds)
    .eq('is_cluster_winner', true)
  type WinnerRow = { id: string; keyword: string; product_tier_id: string }
  const winners = (winnerRows ?? []) as WinnerRow[]
  empty.diagnostics.cluster_winner_count = winners.length
  if (winners.length === 0) {
    empty.diagnostics.skip_reason = 'no cluster_winners for brand'
    return empty
  }

  // Dedup keyword strings (same KW can appear under multiple product_tiers
  // when shared across clusters). Keep all tier_keyword_ids per keyword
  // string for the rank lookup below.
  const idsByKeyword = new Map<string, string[]>()    // keyword → tier_keyword_ids
  for (const w of winners) {
    const k = w.keyword.toLowerCase().trim()
    if (!idsByKeyword.has(k)) idsByKeyword.set(k, [])
    idsByKeyword.get(k)!.push(w.id)
  }
  const uniqueKeywords = Array.from(idsByKeyword.keys())

  // ── Traffic + revenue per (market × week) from GSC + GA4 (brand-level) ────
  // Two GSC calls per brand × week: dim=['date','country'] gives us click /
  // impression totals split by US vs ID. Used to drive Chart 1 bars.
  let trafficUsCur = 0, trafficIdCur = 0, trafficUsPrev = 0, trafficIdPrev = 0
  if (auth && gscProperty) {
    try {
      const [curRows, prevRows] = await Promise.all([
        getSearchAnalytics(auth, gscProperty, cur.start,  cur.end,  ['date', 'country'], 25000),
        getSearchAnalytics(auth, gscProperty, prev.start, prev.end, ['date', 'country'], 25000),
      ])
      for (const r of curRows) {
        const country = String(r.keys?.[1] ?? '').toLowerCase()
        const clicks  = Number(r.clicks ?? 0)
        if (country === 'idn') trafficIdCur += clicks
        else                    trafficUsCur += clicks
      }
      for (const r of prevRows) {
        const country = String(r.keys?.[1] ?? '').toLowerCase()
        const clicks  = Number(r.clicks ?? 0)
        if (country === 'idn') trafficIdPrev += clicks
        else                    trafficUsPrev += clicks
      }
    } catch (e) {
      console.warn(`[boss-view ${siteSlug}] GSC brand traffic failed:`, e)
    }
  }

  // ── GA4 organic revenue per (market × week) ───────────────────────────────
  // Filter to channel = Organic Search, dim=country.
  let revUsCur = 0, revIdCur = 0, revUsPrev = 0, revIdPrev = 0
  if (auth && ga4PropertyId) {
    try {
      const [curResp, prevResp] = await Promise.all([
        getGA4Report(auth, ga4PropertyId, cur.start,  cur.end,
          ['country', 'sessionDefaultChannelGroup'], ['purchaseRevenue'], 1000),
        getGA4Report(auth, ga4PropertyId, prev.start, prev.end,
          ['country', 'sessionDefaultChannelGroup'], ['purchaseRevenue'], 1000),
      ])
      const accumulate = (rows: ReturnType<typeof parseGA4Rows>, isCur: boolean) => {
        for (const r of rows) {
          if (!(r.sessionDefaultChannelGroup ?? '').toLowerCase().includes('organic')) continue
          const country = (r.country ?? '').toLowerCase()
          const rev     = parseFloat(r.purchaseRevenue ?? '0')
          const isId    = country === 'indonesia'
          if (isCur) {
            if (isId) revIdCur += rev
            else      revUsCur += rev
          } else {
            if (isId) revIdPrev += rev
            else      revUsPrev += rev
          }
        }
      }
      accumulate(parseGA4Rows(curResp),  true)
      accumulate(parseGA4Rows(prevResp), false)
    } catch (e) {
      console.warn(`[boss-view ${siteSlug}] GA4 organic revenue failed:`, e)
    }
  }

  // ── Per-KW clicks (GSC dim=['query','country']) ───────────────────────────
  // Filter post-fetch to cluster_winner keywords. GSC dimensionFilter could
  // pre-filter but with 100s of KWs the URL gets huge. Post-filter is fine.
  const clicksByKeyword = new Map<string, number>()     // KW → total clicks (US + ID)
  if (auth && gscProperty) {
    try {
      const rows = await getSearchAnalytics(auth, gscProperty, cur.start, cur.end, ['query', 'country'], 25000)
      empty.diagnostics.gsc_queries_fetched = rows.length
      const winnerSet = new Set(uniqueKeywords)
      for (const r of rows) {
        const q = String(r.keys?.[0] ?? '').toLowerCase().trim()
        if (!winnerSet.has(q)) continue
        clicksByKeyword.set(q, (clicksByKeyword.get(q) ?? 0) + Number(r.clicks ?? 0))
      }
    } catch (e) {
      console.warn(`[boss-view ${siteSlug}] GSC per-query failed:`, e)
    }
  }

  // ── Per-KW top landing page (GSC dim=['page','query']) ────────────────────
  // For each cluster_winner KW, find the page with the most clicks. That's
  // the "primary LP" we'll attribute GA4 revenue to.
  const topPageByKeyword = new Map<string, { path: string; clicks: number }>()
  if (auth && gscProperty) {
    try {
      const rows = await getSearchAnalytics(auth, gscProperty, cur.start, cur.end, ['page', 'query'], 25000)
      const winnerSet = new Set(uniqueKeywords)
      for (const r of rows) {
        const page = String(r.keys?.[0] ?? '')
        const q    = String(r.keys?.[1] ?? '').toLowerCase().trim()
        if (!winnerSet.has(q)) continue
        const clicks = Number(r.clicks ?? 0)
        const cur    = topPageByKeyword.get(q)
        if (!cur || clicks > cur.clicks) {
          topPageByKeyword.set(q, { path: normalizePath(page), clicks })
        }
      }
    } catch (e) {
      console.warn(`[boss-view ${siteSlug}] GSC page×query failed:`, e)
    }
  }

  // ── GA4 revenue per landing page (Organic Search filter, this week) ──────
  // Used to attribute revenue to each cluster_winner KW via its top LP.
  const revenueByPath = new Map<string, number>()
  if (auth && ga4PropertyId) {
    try {
      const resp = await getGA4Report(auth, ga4PropertyId, cur.start, cur.end,
        ['landingPage', 'sessionDefaultChannelGroup'], ['purchaseRevenue'], 5000)
      const rows = parseGA4Rows(resp)
      empty.diagnostics.ga4_rev_pages_fetched = rows.length
      for (const r of rows) {
        if (!(r.sessionDefaultChannelGroup ?? '').toLowerCase().includes('organic')) continue
        const path = normalizePath(r.landingPage ?? '')
        const rev  = parseFloat(r.purchaseRevenue ?? '0')
        if (!path) continue
        revenueByPath.set(path, (revenueByPath.get(path) ?? 0) + rev)
      }
    } catch (e) {
      console.warn(`[boss-view ${siteSlug}] GA4 LP revenue failed:`, e)
    }
  }

  // ── Compose: per-KW (clicks, revenue) → composite z-score → top 5 ────────
  type Candidate = { keyword: string; clicks: number; revenue: number; lp: string }
  const candidates: Candidate[] = []
  for (const kw of uniqueKeywords) {
    const clicks = clicksByKeyword.get(kw) ?? 0
    const lp     = topPageByKeyword.get(kw)?.path ?? ''
    const rev    = lp ? (revenueByPath.get(lp) ?? 0) : 0
    candidates.push({ keyword: kw, clicks, revenue: rev, lp })
  }
  empty.diagnostics.kw_with_ga4_match = candidates.filter(c => c.revenue > 0).length

  // Drop candidates with zero clicks AND zero revenue — noise.
  const meaningful = candidates.filter(c => c.clicks > 0 || c.revenue > 0)
  if (meaningful.length === 0) {
    empty.diagnostics.skip_reason = 'no cluster_winners had GSC clicks or GA4 revenue this week'
    return {
      ...empty,
      traffic: {
        us: { thisWeek: trafficUsCur, lastWeek: trafficUsPrev, pct: pctChange(trafficUsCur, trafficUsPrev) },
        id: { thisWeek: trafficIdCur, lastWeek: trafficIdPrev, pct: pctChange(trafficIdCur, trafficIdPrev) },
      },
      revenue: {
        us: { thisWeek: revUsCur, lastWeek: revUsPrev, pct: pctChange(revUsCur, revUsPrev) },
        id: { thisWeek: revIdCur, lastWeek: revIdPrev, pct: pctChange(revIdCur, revIdPrev) },
      },
    }
  }

  const clicksZ  = zScores(meaningful.map(c => c.clicks))
  const revZ     = zScores(meaningful.map(c => c.revenue))
  const scored   = meaningful.map((c, i) => ({ ...c, score: clicksZ[i] + revZ[i] }))
  const top5     = scored.sort((a, b) => b.score - a.score).slice(0, 5)

  // ── Rank lookup for top 5 KW (tier_serp_snapshots, cur + prev windows) ───
  // We need rank per (KW × market × week). Pull all snapshots in the
  // [prevStart, curEnd] window, filtered to the chosen KW IDs. Bucket by
  // (kw, market, week) and pick the latest snapshot.
  const focusKwIds: string[] = []
  const idToKeyword = new Map<string, string>()
  for (const k of top5) {
    const ids = idsByKeyword.get(k.keyword) ?? []
    for (const id of ids) {
      focusKwIds.push(id)
      idToKeyword.set(id, k.keyword)
    }
  }

  type SnapRow = {
    tier_keyword_id: string | null
    market:          string
    snapshot_date:   string
    our_position:    number | null
  }
  const snaps: SnapRow[] = []
  if (focusKwIds.length > 0) {
    const { data } = await db
      .from('tier_serp_snapshots')
      .select('tier_keyword_id, market, snapshot_date, our_position')
      .eq('owner_user_id', ownerId)
      .in('tier_keyword_id', focusKwIds)
      .gte('snapshot_date', prev.start)
      .lte('snapshot_date', cur.end)
    snaps.push(...((data ?? []) as SnapRow[]))
  }

  // Bucket per (kw, market, window). Window detection by date range.
  type RankCell = { date: string; pos: number | null }
  const ranks = new Map<string, RankCell>()   // key = `${kw}|${market}|${win}`
  for (const r of snaps) {
    if (!r.tier_keyword_id) continue
    const kw = idToKeyword.get(String(r.tier_keyword_id))
    if (!kw) continue
    const market = r.market === 'id' ? 'id' : 'us'
    const win    = r.snapshot_date >= cur.start && r.snapshot_date <= cur.end ? 'cur' :
                   r.snapshot_date >= prev.start && r.snapshot_date <= prev.end ? 'prev' : null
    if (!win) continue
    const k = `${kw}|${market}|${win}`
    const prevCell = ranks.get(k)
    if (!prevCell || r.snapshot_date > prevCell.date) {
      ranks.set(k, { date: r.snapshot_date, pos: r.our_position })
    }
  }

  const focusKeywords: BossViewFocusKeyword[] = top5.map(k => ({
    keyword:        k.keyword,
    brand:          siteSlug,
    score:          +k.score.toFixed(3),
    clicks:         k.clicks,
    revenue:        +k.revenue.toFixed(2),
    topLandingPage: k.lp,
    us: {
      lastWeek: ranks.get(`${k.keyword}|us|prev`)?.pos ?? null,
      thisWeek: ranks.get(`${k.keyword}|us|cur`)?.pos  ?? null,
    },
    id: {
      lastWeek: ranks.get(`${k.keyword}|id|prev`)?.pos ?? null,
      thisWeek: ranks.get(`${k.keyword}|id|cur`)?.pos  ?? null,
    },
  }))

  return {
    siteSlug,
    siteName: empty.siteName,
    traffic: {
      us: { thisWeek: trafficUsCur, lastWeek: trafficUsPrev, pct: pctChange(trafficUsCur, trafficUsPrev) },
      id: { thisWeek: trafficIdCur, lastWeek: trafficIdPrev, pct: pctChange(trafficIdCur, trafficIdPrev) },
    },
    revenue: {
      us: { thisWeek: revUsCur, lastWeek: revUsPrev, pct: pctChange(revUsCur, revUsPrev) },
      id: { thisWeek: revIdCur, lastWeek: revIdPrev, pct: pctChange(revIdCur, revIdPrev) },
    },
    focusKeywords,
    diagnostics: empty.diagnostics,
  }
}

// ─── AI source slice per brand ──────────────────────────────────────────────

async function buildAiSourceForBrand(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any>,
  siteSlug: string,
  auth:     OAuth2Client | null,
  cur:      { start: string; end: string },
  prev:     { start: string; end: string },
): Promise<BossViewAiSlice['bySite'][string]> {
  const empty = {
    sources: [] as BossViewAiSource[],
    totalUsers:     0,
    totalSessions:  0,
    totalRevenue:   0,
    prevTotalUsers:    0,
    prevTotalSessions: 0,
    prevTotalRevenue:  0,
  }

  const { data: cfg } = await db
    .from('site_configs')
    .select('ga4_property_id')
    .eq('slug', siteSlug)
    .maybeSingle()
  const ga4PropertyId = (cfg?.ga4_property_id as string | null) ?? null
  if (!auth || !ga4PropertyId) {
    return { ...empty, skipReason: 'GA4 not connected for this brand' }
  }

  try {
    const [curResp, prevResp] = await Promise.all([
      getGA4Report(auth, ga4PropertyId, cur.start,  cur.end,
        ['sessionSource'], ['totalUsers', 'sessions', 'purchaseRevenue'], 200),
      getGA4Report(auth, ga4PropertyId, prev.start, prev.end,
        ['sessionSource'], ['totalUsers', 'sessions', 'purchaseRevenue'], 200),
    ])
    const curRows  = parseGA4Rows(curResp)
    const prevRows = parseGA4Rows(prevResp)

    // Bucket per AI source label (group same-label domains, e.g. chatgpt.com
    // and chat.openai.com both → 'ChatGPT'). Domain match is case-insensitive
    // and tolerates www. / regional subdomains.
    type Bucket = { users: number; sessions: number; revenue: number }
    const labelMatchesDomain = (source: string): string | null => {
      const lower = source.toLowerCase().replace(/^www\./, '')
      for (const s of AI_SOURCES) {
        if (s.domains.some(d => lower === d || lower.endsWith('.' + d))) return s.label
      }
      return null
    }
    const accumulate = (rows: ReturnType<typeof parseGA4Rows>) => {
      const buckets = new Map<string, Bucket>()
      let totUsers = 0, totSessions = 0, totRevenue = 0
      for (const r of rows) {
        const src   = String(r.sessionSource ?? '')
        const label = labelMatchesDomain(src)
        if (!label) continue
        const u = Number(r.totalUsers ?? 0)
        const s = Number(r.sessions ?? 0)
        const v = parseFloat(r.purchaseRevenue ?? '0')
        const bucket = buckets.get(label) ?? { users: 0, sessions: 0, revenue: 0 }
        bucket.users    += u
        bucket.sessions += s
        bucket.revenue  += v
        buckets.set(label, bucket)
        totUsers    += u
        totSessions += s
        totRevenue  += v
      }
      return { buckets, totUsers, totSessions, totRevenue }
    }

    const curAcc  = accumulate(curRows)
    const prevAcc = accumulate(prevRows)

    // Build merged source list (every label that appears in either window)
    const allLabels = new Set<string>([
      ...Array.from(curAcc.buckets.keys()),
      ...Array.from(prevAcc.buckets.keys()),
    ])
    const sources: BossViewAiSource[] = []
    for (const label of allLabels) {
      const c = curAcc.buckets.get(label)  ?? { users: 0, sessions: 0, revenue: 0 }
      const p = prevAcc.buckets.get(label) ?? { users: 0, sessions: 0, revenue: 0 }
      sources.push({
        // Domain field shows the primary domain for the label group (display
        // hint; the actual filter joined multiple).
        domain:   AI_SOURCES.find(s => s.label === label)?.domains[0] ?? label.toLowerCase(),
        label,
        users:        c.users,
        sessions:     c.sessions,
        revenue:      +c.revenue.toFixed(2),
        prevUsers:    p.users,
        prevSessions: p.sessions,
        prevRevenue:  +p.revenue.toFixed(2),
      })
    }
    sources.sort((a, b) => b.users - a.users)

    return {
      sources,
      totalUsers:        curAcc.totUsers,
      totalSessions:     curAcc.totSessions,
      totalRevenue:      +curAcc.totRevenue.toFixed(2),
      prevTotalUsers:    prevAcc.totUsers,
      prevTotalSessions: prevAcc.totSessions,
      prevTotalRevenue:  +prevAcc.totRevenue.toFixed(2),
    }
  } catch (e) {
    console.warn(`[boss-view ${siteSlug}] GA4 AI source failed:`, e)
    return { ...empty, skipReason: `GA4 query failed: ${e instanceof Error ? e.message : 'unknown'}` }
  }
}

// Re-export so callers don't have to import from the keyword-breakdown module
export { ALL_AI_DOMAINS, AI_SOURCES }
