import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getActiveSiteSlug } from '@/lib/sites-server'
import Link from 'next/link'

/**
 * Command-center dashboard. Replaces the legacy widget grid with a focused
 * 5-row layout:
 *
 *   1. Top KPIs (briefs · backlinks · sends · drops)   — last 7d + WoW delta
 *   2. PIC cards (Strategy · Technical · Content · Off-Page)
 *   3. News + AI viz (left) | API spend (right)
 *   4. Alert center (consolidated urgent items)
 *   5. Output trend (4-series line chart, last 7d)
 *
 * Audience: Galih (daily check-in). Multi-brand-safe via getActiveSiteSlug().
 * Single SSR fetch — no client-side polling. Page revalidates on nav.
 */

// ── Approximate cost rates per call (USD). Used for "approx" labelling so
// the user understands these are estimated spend, not invoiced amounts.
const COST_PER_CALL = {
  claude_haiku:    0.001,   // ~$0.001 per call (Haiku 4.5 avg in/out tokens)
  claude_sonnet:   0.012,   // ~$0.012 per call (Sonnet 4.6 avg)
  claude_opus:     0.060,   // ~$0.060 per call (Opus on big-doc generation)
  dataforseo:      0.0006,  // ~$0.0006 per SERP/keyword call
  firecrawl:       0.001,   // ~$0.001 per scrape
  psi:             0.0,     // Free quota
} as const

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3_600_000)
  if (h < 1)  return `${Math.floor(diff / 60_000)}m ago`
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function fmtUSD(n: number, decimals = 2): string {
  return `$${n.toFixed(decimals)}`
}

function deltaLabel(current: number, previous: number): { text: string; color: string } {
  if (previous === 0 && current === 0) return { text: '→ flat', color: 'text-gray-500' }
  if (previous === 0) return { text: 'NEW', color: 'text-emerald-400' }
  const pct = Math.round(((current - previous) / previous) * 100)
  if (pct === 0) return { text: '→ flat',           color: 'text-gray-500' }
  if (pct > 0)   return { text: `↑ ${pct}% wow`,    color: 'text-emerald-400' }
  return                { text: `↓ ${Math.abs(pct)}% wow`, color: 'text-red-400' }
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function KpiCard({ value, label, sub, accent, delta }: {
  value: string | number
  label: string
  sub?: string
  accent: string
  delta?: { text: string; color: string }
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: accent }} />
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5 font-semibold">{label}</p>
      <p className="text-3xl font-bold text-white leading-tight">{value}</p>
      <div className="flex items-baseline justify-between mt-1.5">
        <span className="text-xs text-gray-500">{sub ?? ''}</span>
        {delta && <span className={`text-xs font-medium ${delta.color}`}>{delta.text}</span>}
      </div>
    </div>
  )
}

// ── PIC card with sparkline ───────────────────────────────────────────────────
function PicCard({ title, accent, output, alert, alertColor, sparkData, href, fallbackNote }: {
  title:        string
  accent:       string
  output:       string
  alert:        string
  alertColor:   string
  sparkData?:   number[]
  fallbackNote?: string
  href:         string
}) {
  // Mini sparkline (10 points max)
  const data = sparkData ?? []
  const max = data.length > 0 ? Math.max(...data, 1) : 1
  const w = 200, h = 32
  const pts = data.map((v, i) => {
    const x = data.length === 1 ? w / 2 : (i / (data.length - 1)) * w
    const y = h - (v / max) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  return (
    <Link href={href} className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-4 transition group relative overflow-hidden flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: accent }} />
      <p className="text-[10px] uppercase tracking-wider font-bold mb-3" style={{ color: accent }}>{title}</p>

      {/* Output */}
      <div className="mb-3">
        <p className="text-2xl font-bold text-white leading-tight">{output}</p>
      </div>

      {/* Alert */}
      <div className="mb-3">
        <p className={`text-xs ${alertColor}`}>{alert}</p>
      </div>

      {/* Sparkline or fallback note */}
      <div className="mt-auto">
        {data.length >= 2 ? (
          <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: h }}>
            <polyline points={pts} fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <p className="text-[10px] text-gray-600 italic">{fallbackNote ?? 'No 7d data yet'}</p>
        )}
        <p className="text-[10px] text-gray-500 mt-2 group-hover:text-amber-400 transition">View details →</p>
      </div>
    </Link>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()
  const activeSlug = await getActiveSiteSlug()

  // ── Resolve site ───────────────────────────────────────────────────────────
  const { data: site } = await db
    .from('site_configs')
    .select('slug, gsc_property, favicon_domain, display_name')
    .eq('slug', activeSlug)
    .eq('is_active', true)
    .maybeSingle()

  const siteUrl  = site?.gsc_property ?? null
  const siteSlug = site?.slug ?? activeSlug
  const siteName = site?.display_name ?? activeSlug.toUpperCase()

  // ── Time windows ───────────────────────────────────────────────────────────
  const now = Date.now()
  const last7Iso  = new Date(now -  7 * 86_400_000).toISOString()
  const prev7Iso  = new Date(now - 14 * 86_400_000).toISOString()
  const last7Date = new Date(now -  7 * 86_400_000).toISOString().slice(0, 10)
  const prev7Date = new Date(now - 14 * 86_400_000).toISOString().slice(0, 10)
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()

  // ── Parallel fetches ───────────────────────────────────────────────────────
  type CountQ<T = unknown> = Promise<{ data: T[] | null }>
  const [
    briefs7d,         briefsPrev7d,
    backlinks7d,      backlinksPrev7d,
    outreachSent7d,   outreachSentPrev7d,
    drops7d,          dropsPrev7d,
    monthlyReports,
    kbProposals,
    schemaCritical,
    aiVisLatest,      aiVisPrev,
    bifrostNews,
    apiUsageMtd,
    backlinksAcquiredMtd,
    briefsBlocked,
    briefsStale,
    outreachNeedsFollowup,
    backlinksBroken,
    productStuck,
    contentDailyHistory,
    backlinksDailyHistory,
    outreachDailyHistory,
    productContentDailyHistory,
    aiVisHistory,
    techCriticalHistory,
  ] = await Promise.all([
    // Briefs published last 7d
    db.from('seo_content_briefs').select('id, published_at').eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .eq('status', 'published').gte('published_at', last7Iso) as unknown as CountQ<{ id: string; published_at: string }>,
    db.from('seo_content_briefs').select('id').eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .eq('status', 'published').gte('published_at', prev7Iso).lt('published_at', last7Iso) as unknown as CountQ<{ id: string }>,

    // Backlinks acquired last 7d (link_status=active, verified within window)
    // Sprint DASH.OFFPAGE.FIX — column is link_status not status; using wrong
    // name silently filtered to 0 rows. paid_backlinks check constraint:
    // link_status IN ('active', 'broken', 'pending').
    db.from('paid_backlinks').select('id, verified_at, created_at').eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .eq('link_status', 'active').gte('created_at', last7Iso) as unknown as CountQ<{ id: string; verified_at: string | null; created_at: string }>,
    db.from('paid_backlinks').select('id').eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .eq('link_status', 'active').gte('created_at', prev7Iso).lt('created_at', last7Iso) as unknown as CountQ<{ id: string }>,

    // Outreach sends — count rows where last_sent_at within window
    db.from('outreach_prospects').select('id, last_sent_at').eq('owner_user_id', ownerId)
      .gte('last_sent_at', last7Iso) as unknown as CountQ<{ id: string; last_sent_at: string }>,
    db.from('outreach_prospects').select('id').eq('owner_user_id', ownerId)
      .gte('last_sent_at', prev7Iso).lt('last_sent_at', last7Iso) as unknown as CountQ<{ id: string }>,

    // Drops detected — distinct page count from gsc_ranking_drops
    siteUrl
      ? db.from('gsc_ranking_drops').select('page').eq('site_url', siteUrl)
          .gte('snapshot_date', last7Date) as unknown as CountQ<{ page: string }>
      : Promise.resolve({ data: [] as { page: string }[] }),
    siteUrl
      ? db.from('gsc_ranking_drops').select('page').eq('site_url', siteUrl)
          .gte('snapshot_date', prev7Date).lt('snapshot_date', last7Date) as unknown as CountQ<{ page: string }>
      : Promise.resolve({ data: [] as { page: string }[] }),

    // ── Strategy section sources
    db.from('monthly_reports').select('id, generated_at').eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .gte('generated_at', last7Iso) as unknown as CountQ<{ id: string; generated_at: string }>,
    db.from('kb_rule_proposals').select('id').eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .eq('status', 'pending') as unknown as CountQ<{ id: string }>,

    // ── Technical section: critical schema/PSI/site_audit issues
    db.from('schema_health_snapshots').select('valid_count, total_count')
      .eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .order('snapshot_date', { ascending: false }).limit(1) as unknown as CountQ<{ valid_count: number; total_count: number }>,

    // ── AI visibility latest + previous
    db.from('ai_visibility_snapshots').select('week_starting, mention_rate, visibility_score, llm_breakdown')
      .eq('owner_user_id', ownerId).eq('site_slug', siteSlug).is('topic_slug', null)
      .order('week_starting', { ascending: false }).limit(1) as unknown as CountQ<{ week_starting: string; mention_rate: number; visibility_score: number; llm_breakdown: Record<string, unknown> }>,
    db.from('ai_visibility_snapshots').select('mention_rate, visibility_score')
      .eq('owner_user_id', ownerId).eq('site_slug', siteSlug).is('topic_slug', null)
      .order('week_starting', { ascending: false }).range(1, 1) as unknown as CountQ<{ mention_rate: number; visibility_score: number }>,

    // ── Bifrost news (newsjackable, last 3 days, kb_matched)
    db.from('news_game_extractions').select(`
      id, game_name, news_type, kb_matched,
      news_items!inner (id, title, url, published_at)
    `).eq('owner_user_id', ownerId).eq('kb_matched', true)
      .gte('created_at', new Date(now - 3 * 86_400_000).toISOString())
      .in('news_type', ['release', 'event', 'update', 'sale', 'esports'])
      .order('created_at', { ascending: false }).limit(5) as unknown as CountQ<{ id: string; game_name: string; news_type: string; kb_matched: boolean; news_items: { id: string; title: string; url: string; published_at: string | null } | { id: string; title: string; url: string; published_at: string | null }[] }>,

    // ── API usage MTD (for cost panel)
    db.from('api_usage_logs').select('api_name, endpoint, call_count, metadata, created_at')
      .eq('owner_user_id', ownerId)
      .gte('created_at', monthStart) as unknown as CountQ<{ api_name: string; endpoint: string | null; call_count: number; metadata: Record<string, unknown>; created_at: string }>,

    // ── Backlinks acquired MTD (for cost-per-win calc)
    db.from('paid_backlinks').select('id').eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .eq('link_status', 'active').gte('created_at', monthStart) as unknown as CountQ<{ id: string }>,

    // ── Alert sources
    db.from('seo_content_briefs').select('id, primary_keyword, blocker_reason').eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .not('blocker_reason', 'is', null).limit(20) as unknown as CountQ<{ id: string; primary_keyword: string | null; blocker_reason: string | null }>,
    db.from('seo_content_briefs').select('id, primary_keyword, created_at').eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .eq('status', 'draft').lt('created_at', new Date(now - 5 * 86_400_000).toISOString()).limit(20) as unknown as CountQ<{ id: string; primary_keyword: string | null; created_at: string }>,
    db.from('outreach_prospects').select('id, domain, last_sent_at').eq('owner_user_id', ownerId)
      .eq('needs_followup', true).order('last_sent_at', { ascending: true }).limit(20) as unknown as CountQ<{ id: string; domain: string; last_sent_at: string }>,
    db.from('paid_backlinks').select('id, source_url, target_url').eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .eq('link_status', 'broken').limit(20) as unknown as CountQ<{ id: string; source_url: string; target_url: string }>,
    db.from('product_content_queue').select('id, product_name, updated_at').eq('owner_user_id', ownerId)
      .eq('status', 'generating').lt('updated_at', new Date(now - 10 * 60_000).toISOString()).limit(20) as unknown as CountQ<{ id: string; product_name: string; updated_at: string }>,

    // ── Sparkline source data: per-day counts last 7 days
    db.from('seo_content_briefs').select('published_at').eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .eq('status', 'published').gte('published_at', last7Iso) as unknown as CountQ<{ published_at: string }>,
    db.from('paid_backlinks').select('created_at').eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .eq('link_status', 'active').gte('created_at', last7Iso) as unknown as CountQ<{ created_at: string }>,
    db.from('outreach_prospects').select('last_sent_at').eq('owner_user_id', ownerId)
      .gte('last_sent_at', last7Iso) as unknown as CountQ<{ last_sent_at: string }>,
    db.from('product_content_queue').select('generated_at').eq('owner_user_id', ownerId)
      .eq('status', 'generated').gte('generated_at', last7Iso) as unknown as CountQ<{ generated_at: string | null }>,

    // ── AI visibility 4-week history (Strategy sparkline)
    db.from('ai_visibility_snapshots').select('week_starting, mention_rate')
      .eq('owner_user_id', ownerId).eq('site_slug', siteSlug).is('topic_slug', null)
      .order('week_starting', { ascending: true }).limit(8) as unknown as CountQ<{ week_starting: string; mention_rate: number }>,

    // ── Technical: schema validity history (Technical sparkline)
    db.from('schema_health_snapshots').select('snapshot_date, valid_count, total_count')
      .eq('owner_user_id', ownerId).eq('site_slug', siteSlug)
      .gte('snapshot_date', last7Date)
      .order('snapshot_date', { ascending: true }) as unknown as CountQ<{ snapshot_date: string; valid_count: number; total_count: number }>,
  ])

  // ── Compute derived values ────────────────────────────────────────────────-
  const briefs7dCount      = briefs7d.data?.length ?? 0
  const briefsPrev7dCount  = briefsPrev7d.data?.length ?? 0
  const backlinks7dCount   = backlinks7d.data?.length ?? 0
  const backlinksPrev7dCt  = backlinksPrev7d.data?.length ?? 0
  const sends7dCount       = outreachSent7d.data?.length ?? 0
  const sendsPrev7dCount   = outreachSentPrev7d.data?.length ?? 0

  // Drops: distinct page count
  const drops7dPages    = new Set((drops7d.data ?? []).map(r => r.page))
  const dropsPrev7dPages = new Set((dropsPrev7d.data ?? []).map(r => r.page))

  // Per-day buckets for sparklines
  function dailyBuckets(rows: Array<{ [k: string]: string | null }>, dateField: string): number[] {
    const buckets: number[] = Array.from({ length: 7 }, () => 0)
    for (const r of rows) {
      const v = r[dateField]
      if (!v) continue
      const day = Math.floor((Date.now() - new Date(v).getTime()) / 86_400_000)
      if (day < 0 || day >= 7) continue
      buckets[6 - day] += 1
    }
    return buckets
  }
  const contentSpark   = dailyBuckets(contentDailyHistory.data ?? [], 'published_at')
  const backlinksSpark = dailyBuckets(backlinksDailyHistory.data ?? [], 'created_at')
  const outreachSpark  = dailyBuckets(outreachDailyHistory.data ?? [], 'last_sent_at')
  const productSpark   = dailyBuckets(productContentDailyHistory.data ?? [], 'generated_at')

  // ── AI visibility for Strategy
  const aiViz = aiVisLatest.data?.[0]
  const aiVizPrev2 = aiVisPrev.data?.[0]
  const aiVizMentionRate = aiViz?.mention_rate ?? null
  const aiVizPrevRate    = aiVizPrev2?.mention_rate ?? null
  const aiVisSparkValues = (aiVisHistory.data ?? []).map(r => Number(r.mention_rate ?? 0) * 100)

  // ── Technical: schema validity %
  const schemaSnap = schemaCritical.data?.[0]
  const schemaValidPct = schemaSnap && schemaSnap.total_count > 0
    ? Math.round((schemaSnap.valid_count / schemaSnap.total_count) * 100)
    : null
  const techSparkValues = (techCriticalHistory.data ?? []).map(r => {
    if (!r.total_count) return 100
    return Math.round((r.valid_count / r.total_count) * 100)
  })

  // ── Cost panel: aggregate by API
  const costByApi: Record<string, number> = { claude: 0, dataforseo: 0, firecrawl: 0, psi: 0 }
  const callsByApi: Record<string, number> = { claude: 0, dataforseo: 0, firecrawl: 0, psi: 0 }
  for (const log of (apiUsageMtd.data ?? [])) {
    const calls = log.call_count ?? 1
    const meta  = (log.metadata ?? {}) as { model?: string; input_tokens?: number; output_tokens?: number }
    let unitCost = 0
    if (log.api_name === 'claude') {
      // Differentiate Claude tier when metadata.model is set
      const model = String(meta.model ?? '').toLowerCase()
      if (model.includes('opus'))   unitCost = COST_PER_CALL.claude_opus
      else if (model.includes('sonnet')) unitCost = COST_PER_CALL.claude_sonnet
      else                                unitCost = COST_PER_CALL.claude_haiku
    } else if (log.api_name === 'dataforseo') unitCost = COST_PER_CALL.dataforseo
    else if (log.api_name === 'firecrawl')    unitCost = COST_PER_CALL.firecrawl
    else if (log.api_name === 'psi')          unitCost = COST_PER_CALL.psi
    costByApi[log.api_name]   = (costByApi[log.api_name]   ?? 0) + calls * unitCost
    callsByApi[log.api_name]  = (callsByApi[log.api_name]  ?? 0) + calls
  }
  const totalCost = Object.values(costByApi).reduce((s, v) => s + v, 0)

  // Per-brief / per-win efficiency (approx)
  const briefsPublishedMtd = (briefs7d.data?.length ?? 0) + (briefsPrev7d.data?.length ?? 0)
  // Use actual MTD by re-querying not necessary — approximate from 7d trend
  const monthBriefsApprox  = Math.max(briefsPublishedMtd * 2, 1)   // doubles 14d window to roughly month
  const winsMtd = backlinksAcquiredMtd.data?.length ?? 0
  const costPerBriefApprox = monthBriefsApprox > 0 ? totalCost / monthBriefsApprox : null
  const costPerWinApprox   = winsMtd > 0 ? totalCost / winsMtd : null

  // ── Bifrost news shape normalisation
  type NewsItem = { id: string; title: string; url: string; published_at: string | null }
  const newsRows = (bifrostNews.data ?? []) as Array<{
    game_name: string; news_type: string;
    news_items: NewsItem | NewsItem[];
  }>
  const newsList = newsRows.slice(0, 5).map(r => {
    const ni = Array.isArray(r.news_items) ? r.news_items[0] : r.news_items
    return ni ? { game: r.game_name, type: r.news_type, ...ni } : null
  }).filter((x): x is NonNullable<typeof x> => x !== null)

  // ── Alert center
  const alerts: Array<{ severity: 'critical' | 'important' | 'info'; text: string; href: string }> = []
  for (const b of (backlinksBroken.data ?? [])) {
    alerts.push({ severity: 'critical', text: `Broken backlink: ${b.source_url}`, href: '/backlinks' })
  }
  for (const p of (productStuck.data ?? [])) {
    alerts.push({ severity: 'critical', text: `Stuck product content: ${p.product_name}`, href: '/content/products' })
  }
  for (const b of (briefsStale.data ?? [])) {
    alerts.push({ severity: 'important', text: `Brief stale >5d: ${b.primary_keyword ?? 'untitled'}`, href: `/content/briefs/${b.id}` })
  }
  for (const b of (briefsBlocked.data ?? [])) {
    alerts.push({ severity: 'important', text: `Brief blocked: ${b.primary_keyword ?? 'untitled'} (${b.blocker_reason})`, href: `/content/briefs/${b.id}` })
  }
  for (const o of (outreachNeedsFollowup.data ?? [])) {
    alerts.push({ severity: 'important', text: `Outreach needs follow-up: ${o.domain}`, href: '/outreach' })
  }

  const criticalAlerts   = alerts.filter(a => a.severity === 'critical')
  const importantAlerts  = alerts.filter(a => a.severity === 'important')

  // ── Output trend for chart (7-day series) — already computed via daily buckets
  const dayLabels = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now - (6 - i) * 86_400_000)
    return d.toLocaleDateString('en-US', { weekday: 'short' })
  })

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5">
      {/* Header */}
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-amber-400 uppercase tracking-wider font-semibold mb-1">Command Center · {siteName}</p>
          <h1 className="text-2xl font-bold text-white">Welcome back, {(user.email ?? '').split('@')[0]}.</h1>
          <p className="text-sm text-gray-400 mt-1">SEO operations snapshot · last 7 days</p>
        </div>
      </header>

      {/* ── Row 1 — Top KPIs ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          value={briefs7dCount}
          label="Briefs published"
          sub="last 7 days"
          accent="#7C3AED"
          delta={deltaLabel(briefs7dCount, briefsPrev7dCount)}
        />
        <KpiCard
          value={backlinks7dCount}
          label="Backlinks acquired"
          sub="last 7 days · status=active"
          accent="#DC2626"
          delta={deltaLabel(backlinks7dCount, backlinksPrev7dCt)}
        />
        <KpiCard
          value={sends7dCount}
          label="Outreach sends"
          sub="last 7 days"
          accent="#F59E0B"
          delta={deltaLabel(sends7dCount, sendsPrev7dCount)}
        />
        <KpiCard
          value={drops7dPages.size}
          label="Drops detected"
          sub="page count · last 7 days"
          accent="#0891B2"
          delta={deltaLabel(drops7dPages.size, dropsPrev7dPages.size)}
        />
      </div>

      {/* ── Row 2 — PIC cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <PicCard
          title="Strategy"
          accent="#1E3A5F"
          output={`${monthlyReports.data?.length ?? 0} report${(monthlyReports.data?.length ?? 0) === 1 ? '' : 's'} this week`}
          alert={
            (kbProposals.data?.length ?? 0) > 0
              ? `⚠ ${kbProposals.data?.length} KB proposal${(kbProposals.data?.length ?? 0) === 1 ? '' : 's'} pending`
              : '✓ no pending KB proposals'
          }
          alertColor={(kbProposals.data?.length ?? 0) > 0 ? 'text-amber-400' : 'text-emerald-400'}
          sparkData={aiVisSparkValues.length >= 2 ? aiVisSparkValues : undefined}
          fallbackNote="Track AI visibility weekly + KB rule velocity"
          href="/reports/monthly"
        />
        <PicCard
          title="Technical"
          accent="#0891B2"
          output={
            schemaValidPct != null
              ? `${schemaValidPct}% schema valid`
              : 'no audit yet'
          }
          alert={
            schemaValidPct != null && schemaValidPct < 90
              ? `⚠ schema dropped below 90%`
              : '✓ all green'
          }
          alertColor={schemaValidPct != null && schemaValidPct < 90 ? 'text-amber-400' : 'text-emerald-400'}
          sparkData={techSparkValues.length >= 2 ? techSparkValues : undefined}
          fallbackNote="Run schema cron to populate"
          href="/site-health"
        />
        <PicCard
          title="Content"
          accent="#7C3AED"
          output={`${briefs7dCount} brief${briefs7dCount === 1 ? '' : 's'} shipped`}
          alert={
            (briefsStale.data?.length ?? 0) > 0
              ? `⚠ ${briefsStale.data?.length} stale in draft`
              : '✓ no stale briefs'
          }
          alertColor={(briefsStale.data?.length ?? 0) > 0 ? 'text-amber-400' : 'text-emerald-400'}
          sparkData={contentSpark}
          href="/content/briefs"
        />
        <PicCard
          title="Off-Page"
          accent="#DC2626"
          output={`${backlinks7dCount} backlink${backlinks7dCount === 1 ? '' : 's'} acquired`}
          alert={
            (outreachNeedsFollowup.data?.length ?? 0) > 0
              ? `⚠ ${outreachNeedsFollowup.data?.length} need follow-up`
              : '✓ no follow-ups due'
          }
          alertColor={(outreachNeedsFollowup.data?.length ?? 0) > 0 ? 'text-amber-400' : 'text-emerald-400'}
          sparkData={backlinksSpark}
          href="/backlinks"
        />
      </div>

      {/* ── Row 3 — News + AI viz / Cost panel ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Left: News + AI viz */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] uppercase tracking-wider text-orange-400 font-bold">🔥 Newsjack queue</p>
            <Link href="/content/news-signals" className="text-[10px] text-gray-500 hover:text-amber-400">View all →</Link>
          </div>
          {newsList.length === 0 ? (
            <p className="text-xs text-gray-500 italic">No fresh news in the last 3 days.</p>
          ) : (
            <ul className="space-y-2 mb-4">
              {newsList.map(n => (
                <li key={n.id}>
                  <a href={n.url} target="_blank" rel="noopener noreferrer" className="block hover:bg-gray-800/40 rounded px-2 py-1.5 transition">
                    <p className="text-xs text-white line-clamp-1">{n.title}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">
                      <span className="text-orange-300/70">{n.game}</span> · {n.type} · {n.published_at ? timeAgo(n.published_at) : 'recent'}
                    </p>
                  </a>
                </li>
              ))}
            </ul>
          )}

          {/* AI visibility */}
          <div className="border-t border-gray-800 pt-3">
            <p className="text-[10px] uppercase tracking-wider text-purple-400 font-bold mb-2">AI visibility (this week)</p>
            {aiViz ? (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Mention rate</span>
                  <span className="text-white font-semibold">
                    {Math.round((aiVizMentionRate ?? 0) * 100)}%
                    {aiVizPrevRate != null && (
                      <span className={`ml-2 text-[10px] ${
                        (aiVizMentionRate ?? 0) > aiVizPrevRate ? 'text-emerald-400' :
                        (aiVizMentionRate ?? 0) < aiVizPrevRate ? 'text-red-400' : 'text-gray-500'
                      }`}>
                        {aiVizPrevRate != null ? `(${(aiVizMentionRate ?? 0) > aiVizPrevRate ? '↑' : (aiVizMentionRate ?? 0) < aiVizPrevRate ? '↓' : '→'} ${Math.abs(Math.round(((aiVizMentionRate ?? 0) - aiVizPrevRate) * 100))}pp)` : ''}
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-400">Visibility score</span>
                  <span className="text-white font-semibold">{aiViz.visibility_score ?? '—'}/100</span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-500 italic">No AI visibility snapshot yet.</p>
            )}
          </div>
        </div>

        {/* Right: API spend */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] uppercase tracking-wider text-emerald-400 font-bold">💰 API spend · MTD</p>
            <span className="text-[10px] text-gray-500 italic">approx ~ usage-based</span>
          </div>
          <p className="text-3xl font-bold text-white mb-3">~{fmtUSD(totalCost)}</p>

          <div className="space-y-1.5 mb-4">
            {Object.entries(costByApi).filter(([, c]) => c > 0).sort(([, a], [, b]) => b - a).map(([api, cost]) => {
              const pct = totalCost > 0 ? Math.round((cost / totalCost) * 100) : 0
              return (
                <div key={api} className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 w-24 capitalize">{api}</span>
                  <div className="flex-1 bg-gray-800 rounded-full h-1.5 overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-white w-20 text-right">~{fmtUSD(cost)} ({pct}%)</span>
                </div>
              )
            })}
            {totalCost === 0 && (
              <p className="text-xs text-gray-500 italic">No API calls this month yet.</p>
            )}
          </div>

          {/* Efficiency */}
          <div className="border-t border-gray-800 pt-3 grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] uppercase text-gray-500 mb-1">Per brief (approx)</p>
              <p className="text-sm font-semibold text-white">
                {costPerBriefApprox != null ? `~${fmtUSD(costPerBriefApprox, 3)}` : '—'}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-gray-500 mb-1">Per backlink win (approx)</p>
              <p className="text-sm font-semibold text-white">
                {costPerWinApprox != null ? `~${fmtUSD(costPerWinApprox, 2)}` : '—'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Row 4 — Alert center ─────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] uppercase tracking-wider text-red-400 font-bold">🚨 Alert center</p>
          <p className="text-[10px] text-gray-500">
            <span className="text-red-400">{criticalAlerts.length} critical</span> ·
            <span className="text-amber-400 ml-1">{importantAlerts.length} important</span>
          </p>
        </div>
        {alerts.length === 0 ? (
          <p className="text-xs text-emerald-400 italic">✓ All clear — nothing urgent right now.</p>
        ) : (
          <ul className="space-y-1.5">
            {[...criticalAlerts, ...importantAlerts].slice(0, 8).map((a, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className={a.severity === 'critical' ? 'text-red-400' : 'text-amber-400'}>
                  {a.severity === 'critical' ? '🚨' : '⚠'}
                </span>
                <Link href={a.href} className="flex-1 text-xs text-white hover:text-amber-400 transition truncate">
                  {a.text}
                </Link>
                <span className="text-[10px] text-gray-500">→</span>
              </li>
            ))}
            {alerts.length > 8 && (
              <li className="text-[10px] text-gray-500 italic pl-7">+{alerts.length - 8} more — open the relevant page to see all</li>
            )}
          </ul>
        )}
      </div>

      {/* ── Row 5 — Output trend ─────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <p className="text-[10px] uppercase tracking-wider text-amber-400 font-bold mb-3">📈 Output trend · last 7 days</p>
        <OutputTrendChart
          labels={dayLabels}
          series={[
            { name: 'Briefs',   color: '#7C3AED', values: contentSpark },
            { name: 'Backlinks', color: '#DC2626', values: backlinksSpark },
            { name: 'Sends',     color: '#F59E0B', values: outreachSpark },
            { name: 'Product content', color: '#0891B2', values: productSpark },
          ]}
        />
      </div>

      <p className="text-[10px] text-center text-gray-600 italic pt-1">
        Data refreshes on page navigation. Last computed at {new Date().toLocaleTimeString()}.
      </p>
    </div>
  )
}

// ── Output trend chart — 4-series mini line chart in SVG ─────────────────────
function OutputTrendChart({ labels, series }: {
  labels: string[]
  series: Array<{ name: string; color: string; values: number[] }>
}) {
  const w = 1200, h = 200, padX = 40, padY = 20

  // Find global max across series
  const allValues = series.flatMap(s => s.values)
  const max = Math.max(...allValues, 1)

  const xStep = (w - 2 * padX) / Math.max(labels.length - 1, 1)

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxHeight: 200 }}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((p, i) => (
          <line key={i}
            x1={padX} y1={padY + (h - 2 * padY) * (1 - p)}
            x2={w - padX} y2={padY + (h - 2 * padY) * (1 - p)}
            stroke="#1F2937" strokeWidth="0.5"
          />
        ))}

        {/* X-axis labels */}
        {labels.map((label, i) => (
          <text key={i}
            x={padX + i * xStep} y={h - 2}
            fontSize="10" fill="#64748B" textAnchor="middle"
          >{label}</text>
        ))}

        {/* Y-axis labels (max value) */}
        <text x={padX - 8} y={padY + 4} fontSize="9" fill="#64748B" textAnchor="end">{max}</text>
        <text x={padX - 8} y={h - padY + 4} fontSize="9" fill="#64748B" textAnchor="end">0</text>

        {/* Series */}
        {series.map(s => {
          const points = s.values.map((v, i) => {
            const x = padX + i * xStep
            const y = padY + (1 - v / max) * (h - 2 * padY)
            return `${x.toFixed(1)},${y.toFixed(1)}`
          }).join(' ')
          return (
            <g key={s.name}>
              <polyline points={points} fill="none" stroke={s.color} strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" />
              {/* Endpoint dots */}
              {s.values.map((v, i) => (
                <circle key={i}
                  cx={padX + i * xStep}
                  cy={padY + (1 - v / max) * (h - 2 * padY)}
                  r="2.5" fill={s.color}
                />
              ))}
            </g>
          )
        })}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 mt-2 pl-10">
        {series.map(s => (
          <div key={s.name} className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 rounded" style={{ backgroundColor: s.color }} />
            <span className="text-[10px] text-gray-400">{s.name}</span>
            <span className="text-[10px] text-gray-600">
              ({s.values.reduce((a, b) => a + b, 0)} total)
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
