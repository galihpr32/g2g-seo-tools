// ─── Monthly Report → PPTX builder ──────────────────────────────────────────
// Builds a stakeholder/leadership-focused deck from `monthly_reports.report_data`
// + `ai_narrative` + `ai_action_plan`.
//
// Design system (G2G branded — dark + red):
//   bgPrimary    0F1218   (deep near-black, like the dashboard root)
//   bgCard       1A1F2A   (lifted card surface)
//   bgHero       0B0E13   (slightly darker than primary, for hero/cover)
//   accentRed    DC2626   (G2G primary red — equivalent to bg-red-600)
//   accentRed2   F87171   (soft red for chart highlights)
//   textPrimary  F9FAFB   (near-white)
//   textMuted    9CA3AF   (gray-400)
//   textDim      6B7280   (gray-500, captions)
//   borderDim    27303F   (faint card border)
//   gainGreen    10B981   (positive deltas)
//   lossRed      EF4444   (negative deltas)
//
// Typography:
//   Header  — Trebuchet MS Bold, 36-44pt
//   Section — Trebuchet MS Bold, 20-24pt
//   Body    — Calibri, 14-16pt
//   Caption — Calibri, 10-12pt muted
//
// Visual motif: thin red left border on each content card. Carries across
// every slide except cover + final.
//
// Slides:
//   1. Cover  — month label, site, brand
//   2. Executive summary — KPI grid (clicks, impressions, sessions, revenue) + headline
//   3. AI narrative — 4-5 paragraph executive narrative
//   4. GSC trend chart — clicks + impressions trend (line chart)
//   5. Top queries — top 8 queries by clicks
//   6. Top pages — top 6 organic pages by sessions
//   7. Competitive — Share of Voice bar chart + tracked competitor list
//   8. Backlinks — gains, losses, totals
//   9. Action plan — AI-generated bullets

import PptxGenJS from 'pptxgenjs'

// ── Types matching monthly_reports.report_data ──────────────────────────────

export interface MonthlyReportData {
  monthStart:     string
  monthEnd:       string
  monthLabel:     string
  prevMonthLabel: string
  siteSlug:       string
  siteName:       string
  generatedAt:    string

  gsc?: {
    monthClicks:       number
    prevMonthClicks:   number
    clicksPct:         number | null
    monthImpressions:  number
    prevImpressions:   number
    impressionsPct:    number | null
    monthCtr:          number
    prevCtr:           number
    ctrPct:            number | null
    avgPosition:       number
    totalUniquePages:  number
    topGainers:        { page: string; delta: number; clicks: number }[]
    topDroppers:       { page: string; delta: number; clicks: number }[]
    topPagesByClicks:  { page: string; clicks: number; impressions: number }[]
    // Optional daily series — when present, drives the trend chart.
    dailySeries?:      { date: string; clicks: number; impressions: number }[]
    topQueries?:       { query: string; clicks: number; impressions: number; position: number }[]
  } | null

  ga4?: {
    monthSessions:    number
    prevSessions:     number
    sessionsPct:      number | null
    engagedSessions:  number
    bounceRate:       number
    totalConversions: number
    prevConversions:  number
    conversionsPct:   number | null
    totalRevenue:     number
    prevRevenue:      number
    revenuePct:       number | null
    // `prevSessions` and `sessionsPct` are optional — the route fills them
    // in v2 of monthly report; older reports persisted in monthly_reports
    // before that change won't have them, so the slide must tolerate undefined.
    topPages:         { pagePath: string; sessions: number; conversions: number; revenue: number; prevSessions?: number; sessionsPct?: number | null }[]
  } | null

  // ── v2 additions — channel breakdown, ranking analysis, experiments ──────
  // All optional so older monthly_reports rows still render through the same
  // builder. Each new slide checks for presence before rendering.
  channelBreakdown?: {
    rows: {
      channel:        string
      sessions:       number
      prevSessions:   number
      sessionsPct:    number | null
      conversions:    number
      prevConversions: number
      conversionsPct: number | null
      revenue:        number
      prevRevenue:    number
      revenuePct:     number | null
      share:          number
    }[]
    totalCur:  { sessions: number; conversions: number; revenue: number }
    totalPrev: { sessions: number; conversions: number; revenue: number }
  } | null

  trackedRankings?: {
    bucketsCur:  { top3: number; top5: number; top10: number; top20: number; top100: number; total: number; ranked: number }
    bucketsPrev: { top3: number; top5: number; top10: number; top20: number; top100: number; total: number; ranked: number }
    movements: {
      keyword: string; productName: string; productPath: string
      curPosition: number | null; prevPosition: number | null
      movement: number | null; bestPosition: number | null
      searchVolume: number | null; url: string | null
    }[]
    topImprovers: { keyword: string; productName: string; curPosition: number | null; movement: number | null }[]
    topDroppers:  { keyword: string; productName: string; curPosition: number | null; movement: number | null }[]
    actionPlan:   { keyword: string; productName: string; curPosition: number | null; movement: number | null; recommendation: string; priority: 'P0'|'P1'|'P2'; category: string }[] | null
  } | null

  experiments?: {
    period: string
    start:    { id: string; title: string; hypothesis: string | null; category: string | null; success_metric: string | null; source: string | null }[]
    continue: { id: string; title: string; hypothesis: string | null; category: string | null; success_metric: string | null; source: string | null; current_value?: number | null; target_value?: number | null }[]
    stop:     { id: string; title: string; outcome: string | null; decision_notes: string | null; category: string | null }[]
  } | null

  semrush?: {
    totalKeywords:  number
    top3:           number
    top10:          number
    top20:          number
    avgPosition:    number
    organicTraffic: number
  } | null

  competitive?: {
    trackedCompetitors: { domain: string; name?: string }[]
    sovTable:           { domain: string; sov: number; keywords: number }[]
    sovEstimated:       boolean
  }

  // Both naming conventions accepted — the monthly_reports.report_data
  // shape uses totalActive/newThisMonth (route writes those) but earlier
  // sample fixtures used activeCount/newThisMonthCount. Builder normalises
  // via a `??` fallback below so either shape feeds the slide.
  backlinks?: {
    activeCount?:        number
    totalActive?:        number
    newThisMonthCount?:  number
    newThisMonth?:       number
    totalCostThisMonth?: number
    totalCostAllTime?:   number
    costsByCurrency?:    Record<string, number> | { currency: string; total: number }[]
    avgPositionImprovement?: number | null
  }
}

export interface BuildPptxInput {
  reportData:  MonthlyReportData
  aiNarrative: string
  aiActionPlan: string
  /** Optional executive-friendly card overrides. When supplied, the
   *  narrative slide renders as a 2x3 grid of insight cards instead of
   *  a wall of prose. Falls back to paragraph layout if absent. */
  narrativeHighlights?: NarrativeHighlight[]
  /** Optional structured action items. When supplied, the action plan
   *  slide renders as a 2x4 grid of priority cards instead of a numbered
   *  list. Falls back to numbered list if absent. */
  actionItems?: ActionItemCard[]
  /** Optional per-brand color override. Defaults to G2G's red palette.
   *  - `accent`  drives card strips, headers, badges (default 'DC2626')
   *  - `accent2` drives chart line/bar highlights (default 'F87171')
   *  Both values are 6-char hex (no #). Leaving fields undefined keeps
   *  defaults so callers can pass `{ accent: 'XYZ' }` without the second. */
  theme?: { accent?: string; accent2?: string }
}

export interface NarrativeHighlight {
  /** Optional emoji or single character glyph displayed top-left of the card. */
  icon?:     string
  /** Short bold statement — what happened. Max ~80 chars. */
  headline:  string
  /** 1-2 sentence supporting detail. Max ~180 chars. */
  body:      string
  /** Drives accent color: up=green, down=red, flat=muted, warning=amber. */
  trend?:    'up' | 'down' | 'flat' | 'warning'
}

export interface ActionItemCard {
  /** Imperative short title. Max ~60 chars. */
  title:     string
  /** Why it matters. Max ~180 chars. */
  body:      string
  /** Priority badge — drives card accent + label. */
  priority?: 'P0' | 'P1' | 'P2'
  /** Optional small grouping label shown above the title. */
  category?: string
}

// ── Theme ───────────────────────────────────────────────────────────────────

// Default theme — G2G branded (dark + red).
// The two `accent*` colors can be overridden per build via
// `BuildPptxInput.theme` so other brands (OG → blue, etc.) reuse the same
// dark layout with their own accent. Property names retain the legacy
// `accentRed*` for backwards compatibility — they hold whatever brand
// accent is active for the current build.
const DEFAULT_THEME = {
  bgPrimary:   '0F1218',
  bgCard:      '1A1F2A',
  bgHero:      '0B0E13',
  accentRed:   'DC2626',
  accentRed2:  'F87171',
  textPrimary: 'F9FAFB',
  textMuted:   '9CA3AF',
  textDim:     '6B7280',
  borderDim:   '27303F',
  gainGreen:   '10B981',
  lossRed:     'EF4444',
}
const T = { ...DEFAULT_THEME }   // mutable on purpose — see applyTheme()

const FH = 'Trebuchet MS'   // Header font
const FB = 'Calibri'        // Body font

// ── Layout — LAYOUT_WIDE = 13.3" x 7.5" ─────────────────────────────────────
// Wider canvas gives KPI cards + tables more breathing room.
const SLIDE_W = 13.333
const SLIDE_H = 7.5
const M = 0.6             // outer margin

// Helper — short number formatter (2.4K, 1.6M)
// `compact` mode drops decimals for K-tier values >= 100K so the result
// stays compact for KPI cards (892K instead of 892.3K). Used on slide 2 to
// prevent text wrap.
function fmt(n: number | null | undefined, compact = false): string {
  if (n == null || isNaN(n)) return '—'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 100_000 && compact) return `${Math.round(n / 1_000)}K`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function fmtMoney(n: number | null | undefined, currency = 'USD', compact = false): string {
  if (n == null || isNaN(n)) return '—'
  const sym = currency === 'USD' ? '$' : currency === 'IDR' ? 'Rp' : `${currency} `
  if (Math.abs(n) >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 100_000 && compact) return `${sym}${Math.round(n / 1_000)}K`
  if (Math.abs(n) >= 1_000) return `${sym}${(n / 1_000).toFixed(1)}K`
  return `${sym}${n.toFixed(0)}`
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n}%`
}

function deltaColor(n: number | null | undefined): string {
  if (n == null) return T.textMuted
  return n >= 0 ? T.gainGreen : T.lossRed
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// ── Reusable card primitive ─────────────────────────────────────────────────
// Visual motif: card with thin red left border. Returns nothing — call for
// side effects (drawing on the slide).
function drawCard(slide: PptxGenJS.Slide, x: number, y: number, w: number, h: number) {
  slide.addShape('rect' as PptxGenJS.ShapeType, {
    x, y, w, h,
    fill: { color: T.bgCard },
    line: { color: T.borderDim, width: 0.5 },
    shadow: { type: 'outer', color: '000000', blur: 8, offset: 2, angle: 90, opacity: 0.25 },
  })
  // Red accent strip on the left edge — the recurring brand motif.
  slide.addShape('rect' as PptxGenJS.ShapeType, {
    x, y, w: 0.06, h,
    fill: { color: T.accentRed }, line: { type: 'none' },
  })
}

// Section header band — used at the top of every content slide
function drawSlideHeader(slide: PptxGenJS.Slide, title: string, eyebrow?: string) {
  if (eyebrow) {
    slide.addText(eyebrow.toUpperCase(), {
      x: M, y: 0.4, w: SLIDE_W - 2 * M, h: 0.3,
      fontFace: FH, fontSize: 11, bold: true, charSpacing: 4,
      color: T.accentRed, align: 'left', margin: 0,
    })
  }
  slide.addText(title, {
    x: M, y: eyebrow ? 0.7 : 0.5, w: SLIDE_W - 2 * M, h: 0.7,
    fontFace: FH, fontSize: 32, bold: true,
    color: T.textPrimary, align: 'left', margin: 0,
  })
}

// Footer slide number + branding
function drawFooter(slide: PptxGenJS.Slide, slideNum: number, total: number, monthLabel: string, siteName: string) {
  slide.addText(`${siteName} Monthly Report`, {
    x: M, y: SLIDE_H - 0.4, w: 4, h: 0.25,
    fontFace: FB, fontSize: 9, color: T.textDim, align: 'left', margin: 0,
  })
  slide.addText(`${monthLabel}  ·  ${slideNum} / ${total}`, {
    x: SLIDE_W - 4 - M, y: SLIDE_H - 0.4, w: 4, h: 0.25,
    fontFace: FB, fontSize: 9, color: T.textDim, align: 'right', margin: 0,
  })
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function buildMonthlyReportPptx(input: BuildPptxInput): Promise<Buffer> {
  const { reportData: r, aiNarrative, aiActionPlan, narrativeHighlights, actionItems } = input

  // Apply per-brand theme override (if any) on the shared T object. We
  // restore defaults in the finally block at the end so that the next
  // build (potentially a different brand) doesn't inherit our colours.
  // This is sequential-only safe — if two parallel calls race, one may
  // see the other's theme momentarily. In practice monthly/weekly
  // generation isn't parallel, so this trade-off is fine.
  if (input.theme?.accent)  T.accentRed  = input.theme.accent
  if (input.theme?.accent2) T.accentRed2 = input.theme.accent2

  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_WIDE'
  pres.title  = `${r.siteName} Monthly Report — ${r.monthLabel}`
  pres.author = `${r.siteName} SEO Tools`
  pres.company = r.siteName

  // Build slides in order. Total count is used by drawFooter.
  // ── Order rationale ─────────────────────────────────────────────────────
  //   Cover → Exec KPIs → Narrative → Channel breakdown → Search trend →
  //   Top queries → Top pages → Tracked rankings → Ranking action plan →
  //   Competitive SoV → Backlinks → Experiments → Strategic action plan
  // Channel breakdown sits right after the narrative because exec wants to
  // see WHICH channel drove the headline numbers before drilling into
  // search-specific charts. Experiments goes near the END (right before
  // the strategic plan) since it's "what we're betting on going forward".
  const buildFns: ((slide: PptxGenJS.Slide, idx: number, total: number) => void | Promise<void>)[] = [
    s => buildCoverSlide(s, r),
    (s, i, t) => buildExecKpisSlide(s, r, i, t),
    (s, i, t) => narrativeHighlights && narrativeHighlights.length > 0
      ? buildHighlightsSlide(s, r, narrativeHighlights, i, t)
      : buildNarrativeSlide(s, r, aiNarrative, i, t),
  ]

  // Channel breakdown (v2) — only if data present
  if (r.channelBreakdown && r.channelBreakdown.rows.length > 0) {
    buildFns.push((s, i, t) => buildChannelBreakdownSlide(s, r, i, t))
  }

  // GSC trend — only if we have data
  if (r.gsc && (r.gsc.dailySeries?.length || (r.gsc.monthClicks ?? 0) > 0)) {
    buildFns.push((s, i, t) => buildGscTrendSlide(s, r, i, t))
  }

  // Top queries — only if we have queries
  if (r.gsc?.topQueries?.length) {
    buildFns.push((s, i, t) => buildTopQueriesSlide(s, r, i, t))
  }

  // Top pages — GA4 if present, otherwise GSC top pages
  if (r.ga4?.topPages?.length || r.gsc?.topPagesByClicks?.length) {
    buildFns.push((s, i, t) => buildTopPagesSlide(s, r, i, t))
  }

  // Tracked-product ranking analysis (v2) — bucket counts + top movers
  if (r.trackedRankings && (r.trackedRankings.bucketsCur.total > 0)) {
    buildFns.push((s, i, t) => buildRankingAnalysisSlide(s, r, i, t))
    // AI action plan — separate slide to give each item room to breathe
    if (r.trackedRankings.actionPlan && r.trackedRankings.actionPlan.length > 0) {
      buildFns.push((s, i, t) => buildRankingActionPlanSlide(s, r, i, t))
    }
  }

  // Competitive
  if (r.competitive?.sovTable?.length) {
    buildFns.push((s, i, t) => buildCompetitiveSlide(s, r, i, t))
  }

  // Backlinks
  const blActive  = r.backlinks?.activeCount       ?? r.backlinks?.totalActive       ?? 0
  const blNew     = r.backlinks?.newThisMonthCount  ?? r.backlinks?.newThisMonth      ?? 0
  if (r.backlinks && (blActive || blNew)) {
    buildFns.push((s, i, t) => buildBacklinksSlide(s, r, i, t))
  }

  // Experiments (v2) — Start / Stop / Continue Kanban snapshot
  if (r.experiments && (r.experiments.start.length || r.experiments.continue.length || r.experiments.stop.length)) {
    buildFns.push((s, i, t) => buildExperimentsSlide(s, r, i, t))
  }

  // Action plan
  if (actionItems && actionItems.length > 0) {
    buildFns.push((s, i, t) => buildActionItemsCardsSlide(s, r, actionItems, i, t))
  } else if (aiActionPlan?.trim()) {
    buildFns.push((s, i, t) => buildActionPlanSlide(s, r, aiActionPlan, i, t))
  }

  const total = buildFns.length
  try {
    for (let i = 0; i < buildFns.length; i++) {
      const slide = pres.addSlide()
      slide.background = { color: i === 0 ? T.bgHero : T.bgPrimary }
      await buildFns[i](slide, i + 1, total)
    }

    // Render to Node Buffer
    const arr = await pres.write({ outputType: 'nodebuffer' })
    return arr as Buffer
  } finally {
    // Restore theme defaults so the next call starts from a clean slate.
    // Always runs — including if pres.write throws.
    Object.assign(T, DEFAULT_THEME)
  }
}

// ── Slide builders ──────────────────────────────────────────────────────────

function buildCoverSlide(slide: PptxGenJS.Slide, r: MonthlyReportData) {
  // Big diagonal red accent in the corner — gives the cover visual punch
  // without needing an actual logo. We use TWO rectangles: a wide one near
  // the top (heavy weight) and a thin one as a sister stripe.
  slide.addShape('rect' as PptxGenJS.ShapeType, {
    x: 0, y: 0, w: SLIDE_W, h: 0.18,
    fill: { color: T.accentRed }, line: { type: 'none' },
  })
  slide.addShape('rect' as PptxGenJS.ShapeType, {
    x: 0, y: 0.32, w: 4.5, h: 0.04,
    fill: { color: T.accentRed }, line: { type: 'none' },
  })

  slide.addText('MONTHLY SEO REPORT', {
    x: M, y: 1.6, w: SLIDE_W - 2 * M, h: 0.5,
    fontFace: FH, fontSize: 14, bold: true, charSpacing: 8,
    color: T.accentRed2, align: 'left', margin: 0,
  })

  slide.addText(r.monthLabel, {
    x: M, y: 2.1, w: SLIDE_W - 2 * M, h: 1.7,
    fontFace: FH, fontSize: 78, bold: true,
    color: T.textPrimary, align: 'left', margin: 0,
  })

  slide.addText(r.siteName ?? r.siteSlug, {
    x: M, y: 4.0, w: SLIDE_W - 2 * M, h: 0.5,
    fontFace: FB, fontSize: 22, color: T.textMuted, align: 'left', margin: 0,
  })

  slide.addText(`vs. ${r.prevMonthLabel}`, {
    x: M, y: 4.5, w: SLIDE_W - 2 * M, h: 0.4,
    fontFace: FB, fontSize: 14, italic: true, color: T.textDim, align: 'left', margin: 0,
  })

  // Footer: brand + generated date
  slide.addText(`Prepared by ${r.siteName} SEO Tools`, {
    x: M, y: SLIDE_H - 0.7, w: 6, h: 0.25,
    fontFace: FB, fontSize: 10, color: T.textDim, align: 'left', margin: 0,
  })
  slide.addText(`Generated ${new Date(r.generatedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}`, {
    x: SLIDE_W - 6 - M, y: SLIDE_H - 0.7, w: 6, h: 0.25,
    fontFace: FB, fontSize: 10, color: T.textDim, align: 'right', margin: 0,
  })
}

// ── Slide 2 — Executive KPIs ────────────────────────────────────────────────
function buildExecKpisSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, idx: number, total: number) {
  drawSlideHeader(slide, 'Executive Summary', 'Headline numbers')

  // 4 KPI cards in a row
  type KPI = { label: string; value: string; delta: string; deltaColor: string; sub?: string }
  const kpis: KPI[] = []

  // KPI value formatting uses `compact: true` so 892K renders instead of
  // 892.3K — keeps the headline number on a single line at 38pt.
  if (r.gsc) {
    kpis.push({
      label: 'Search clicks',
      value: fmt(r.gsc.monthClicks, true),
      delta: fmtPct(r.gsc.clicksPct),
      deltaColor: deltaColor(r.gsc.clicksPct),
      sub: `${fmt(r.gsc.monthImpressions, true)} impressions`,
    })
    kpis.push({
      label: 'CTR',
      value: `${(r.gsc.monthCtr ?? 0).toFixed(2)}%`,
      delta: fmtPct(r.gsc.ctrPct),
      deltaColor: deltaColor(r.gsc.ctrPct),
      sub: `Avg. position ${r.gsc.avgPosition.toFixed(1)}`,
    })
  }
  if (r.ga4) {
    kpis.push({
      label: 'Sessions',
      value: fmt(r.ga4.monthSessions, true),
      delta: fmtPct(r.ga4.sessionsPct),
      deltaColor: deltaColor(r.ga4.sessionsPct),
      sub: `${fmt(r.ga4.totalConversions, true)} conversions`,
    })
    kpis.push({
      label: 'Revenue',
      value: fmtMoney(r.ga4.totalRevenue, 'USD', true),
      delta: fmtPct(r.ga4.revenuePct),
      deltaColor: deltaColor(r.ga4.revenuePct),
      sub: `vs ${fmtMoney(r.ga4.prevRevenue, 'USD', true)} prior`,
    })
  }

  // If we don't have all 4, pad with a generic Keywords / Backlinks card so
  // the row stays balanced.
  if (kpis.length < 4 && r.semrush) {
    kpis.push({
      label: 'Tracked keywords',
      value: fmt(r.semrush.totalKeywords),
      delta: `${fmt(r.semrush.top10)} in top 10`,
      deltaColor: T.textMuted,
      sub: `Avg. position ${r.semrush.avgPosition.toFixed(1)}`,
    })
  }
  if (kpis.length < 4 && r.backlinks) {
    const blActiveK = r.backlinks.activeCount ?? r.backlinks.totalActive ?? 0
    const blNewK    = r.backlinks.newThisMonthCount ?? r.backlinks.newThisMonth ?? 0
    kpis.push({
      label: 'Active backlinks',
      value: fmt(blActiveK),
      delta: `+${fmt(blNewK)} new`,
      deltaColor: T.gainGreen,
      sub: `${fmtMoney(r.backlinks.totalCostThisMonth)} spent`,
    })
  }

  const cardCount = Math.min(4, kpis.length)
  if (cardCount === 0) {
    slide.addText('No KPI data available for this period.', {
      x: M, y: 2.0, w: SLIDE_W - 2 * M, h: 0.5,
      fontFace: FB, fontSize: 14, color: T.textMuted,
    })
  } else {
    const gap   = 0.25
    const totalW = SLIDE_W - 2 * M
    const cardW  = (totalW - gap * (cardCount - 1)) / cardCount
    const cardH  = 2.6
    const top    = 1.7

    for (let i = 0; i < cardCount; i++) {
      const x = M + i * (cardW + gap)
      drawCard(slide, x, top, cardW, cardH)

      slide.addText(kpis[i].label.toUpperCase(), {
        x: x + 0.3, y: top + 0.2, w: cardW - 0.6, h: 0.3,
        fontFace: FH, fontSize: 11, bold: true, charSpacing: 4,
        color: T.textMuted, margin: 0,
      })
      slide.addText(kpis[i].value, {
        x: x + 0.3, y: top + 0.55, w: cardW - 0.6, h: 1.0,
        fontFace: FH, fontSize: 38, bold: true,
        color: T.textPrimary, margin: 0, shrinkText: true,
      })
      slide.addText(kpis[i].delta, {
        x: x + 0.3, y: top + 1.55, w: cardW - 0.6, h: 0.4,
        fontFace: FH, fontSize: 16, bold: true,
        color: kpis[i].deltaColor, margin: 0,
      })
      if (kpis[i].sub) {
        slide.addText(kpis[i].sub!, {
          x: x + 0.3, y: top + 2.0, w: cardW - 0.6, h: 0.4,
          fontFace: FB, fontSize: 11, color: T.textDim, italic: true, margin: 0,
        })
      }
    }
  }

  // Site context callout below the KPIs
  slide.addText([
    { text: 'Site:  ',  options: { color: T.textDim, bold: false } },
    { text: r.siteName ?? r.siteSlug, options: { color: T.textPrimary, bold: true } },
    { text: '          Period:  ', options: { color: T.textDim, breakLine: false } },
    { text: `${r.monthStart} → ${r.monthEnd}`, options: { color: T.textPrimary } },
    { text: '          Comparison:  ', options: { color: T.textDim } },
    { text: r.prevMonthLabel, options: { color: T.textPrimary } },
  ], {
    x: M, y: 4.6, w: SLIDE_W - 2 * M, h: 0.4,
    fontFace: FB, fontSize: 12, margin: 0,
  })

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── Slide 3 — AI Narrative ──────────────────────────────────────────────────
function buildNarrativeSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, narrative: string, idx: number, total: number) {
  drawSlideHeader(slide, "What happened this month", 'Narrative')

  // Split on double-newlines for paragraphs. Cap at 5 paragraphs to fit slide.
  const paragraphs = narrative.split(/\n\n+/).map(p => p.trim()).filter(Boolean).slice(0, 5)

  // Single content card. Each paragraph as a bullet-less line block.
  const cardX = M
  const cardY = 1.5
  const cardW = SLIDE_W - 2 * M
  const cardH = SLIDE_H - cardY - 0.7

  drawCard(slide, cardX, cardY, cardW, cardH)

  if (paragraphs.length === 0) {
    slide.addText('AI narrative not available for this report.', {
      x: cardX + 0.4, y: cardY + 0.4, w: cardW - 0.8, h: 0.5,
      fontFace: FB, fontSize: 14, color: T.textMuted, italic: true, margin: 0,
    })
  } else {
    const textBlocks: PptxGenJS.TextProps[] = []
    for (let i = 0; i < paragraphs.length; i++) {
      textBlocks.push({
        text: paragraphs[i],
        options: { breakLine: true, paraSpaceAfter: 10 },
      })
    }
    slide.addText(textBlocks, {
      x: cardX + 0.5, y: cardY + 0.4, w: cardW - 1.0, h: cardH - 0.8,
      fontFace: FB, fontSize: 14, color: T.textPrimary,
      align: 'left', valign: 'top', margin: 0,
    })
  }

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── Slide 4 — GSC Trend chart ───────────────────────────────────────────────
// Shows month-name x-axis labels (not "1, 2") + a delta KPI strip above the
// chart so the exec doesn't have to mental-math from bar heights.
function buildGscTrendSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, idx: number, total: number) {
  drawSlideHeader(slide, 'Search performance trend', 'Google Search Console')

  // Short month labels for tighter x-axis ('Mar 2026' instead of 'March 2026')
  const shortMonth = (label: string): string => {
    // input is e.g. 'April 2026' from monthLabel(); shrink to 'Apr 2026'
    const parts = label.split(' ')
    if (parts.length !== 2) return label
    return `${parts[0].slice(0, 3)} ${parts[1]}`
  }
  const prevLbl = shortMonth(r.prevMonthLabel)
  const curLbl  = shortMonth(r.monthLabel)

  // ── KPI delta strip — clicks / impressions / CTR / avg position ──────────
  // Drawn as a single card with 4 inline KPI cells. Each cell shows the
  // current value + colored delta vs prev month.
  const stripY = 1.45
  const stripH = 0.85
  drawCard(slide, M, stripY, SLIDE_W - 2 * M, stripH)

  const c          = r.gsc?.monthClicks         ?? 0
  const cPrev      = r.gsc?.prevMonthClicks     ?? 0
  const cPct       = r.gsc?.clicksPct
  const i          = r.gsc?.monthImpressions    ?? 0
  const iPct       = r.gsc?.impressionsPct
  const ctr        = (r.gsc?.monthCtr ?? 0)
  const ctrPrev    = (r.gsc?.prevCtr  ?? 0)
  const ctrPct     = r.gsc?.ctrPct
  const avgPos     = r.gsc?.avgPosition         ?? 0
  type Cell = { label: string; value: string; delta?: string; color: string }
  const cells: Cell[] = [
    { label: 'Clicks',       value: fmt(c, true), delta: fmtPct(cPct), color: deltaColor(cPct) },
    { label: 'Impressions',  value: fmt(i, true), delta: fmtPct(iPct), color: deltaColor(iPct) },
    { label: 'CTR',          value: `${ctr.toFixed(2)}%`,
      delta: ctrPct != null ? fmtPct(ctrPct) : (ctr - ctrPrev).toFixed(2) + 'pp',
      color: deltaColor(ctrPct ?? (ctr - ctrPrev)) },
    { label: 'Avg position', value: avgPos.toFixed(1),
      delta: undefined,           // position is contextual; don't fake a delta
      color: T.textMuted },
  ]
  const cellW = (SLIDE_W - 2 * M - 0.4) / cells.length
  for (let k = 0; k < cells.length; k++) {
    const cx = M + 0.2 + k * cellW
    slide.addText(cells[k].label.toUpperCase(), {
      x: cx, y: stripY + 0.08, w: cellW - 0.2, h: 0.22,
      fontFace: FH, fontSize: 9, bold: true, charSpacing: 3,
      color: T.textMuted, margin: 0,
    })
    slide.addText(cells[k].value, {
      x: cx, y: stripY + 0.28, w: cellW - 0.2, h: 0.42,
      fontFace: FH, fontSize: 22, bold: true,
      color: T.textPrimary, margin: 0,
    })
    if (cells[k].delta) {
      slide.addText(cells[k].delta!, {
        x: cx + 1.1, y: stripY + 0.34, w: cellW - 1.2, h: 0.32,
        fontFace: FH, fontSize: 13, bold: true,
        color: cells[k].color, margin: 0,
      })
    }
  }

  const series = r.gsc?.dailySeries ?? []

  if (series.length === 0) {
    // Fallback: just show the monthly totals as 2-bar comparison.
    drawCard(slide, M, 2.45, SLIDE_W - 2 * M, 4.45)
    const data = [
      { name: 'Clicks',      labels: [prevLbl, curLbl], values: [cPrev, c] },
      { name: 'Impressions', labels: [prevLbl, curLbl], values: [r.gsc?.prevImpressions ?? 0, i] },
    ]
    slide.addChart('bar' as const, data, {
      x: M + 0.3, y: 2.6, w: SLIDE_W - 2 * M - 0.6, h: 4.2, barDir: 'col',
      chartColors: [T.accentRed, T.accentRed2],
      chartArea: { fill: { color: T.bgCard }, roundedCorners: false },
      // Force category axis to show our string labels
      catAxisLabelColor: T.textPrimary, catAxisLabelFontSize: 13, catAxisLabelFontFace: FB,
      catAxisLabelRotate: 0,
      valAxisLabelColor: T.textMuted, valAxisLabelFontSize: 11,
      valGridLine: { color: T.borderDim, size: 0.5 },
      catGridLine: { style: 'none' },
      showValue: true, dataLabelPosition: 'outEnd', dataLabelColor: T.textPrimary,
      dataLabelFontSize: 10, dataLabelFontFace: FB,
      showLegend: true, legendPos: 't', legendColor: T.textMuted,
      legendFontFace: FB, legendFontSize: 11,
    })
  } else {
    // Two stacked line charts — clicks on top, impressions below — sharing x-axis.
    // KPI strip already takes y=1.45..2.30; charts start at 2.45.
    drawCard(slide, M, 2.45, SLIDE_W - 2 * M, 4.45)

    const labels = series.map(d => d.date.slice(5))   // MM-DD
    const clicks      = series.map(d => d.clicks)
    const impressions = series.map(d => d.impressions)

    slide.addChart('line' as const, [
      { name: 'Clicks',      labels, values: clicks },
    ], {
      x: M + 0.3, y: 2.6, w: SLIDE_W - 2 * M - 0.6, h: 1.95,
      chartColors: [T.accentRed],
      chartArea: { fill: { color: T.bgCard } },
      lineSize: 3, lineSmooth: true,
      showTitle: true, title: `Daily clicks — ${curLbl}`,
      titleColor: T.textPrimary, titleFontFace: FH, titleFontSize: 12,
      catAxisLabelColor: T.textMuted, catAxisLabelFontSize: 9,
      valAxisLabelColor: T.textMuted, valAxisLabelFontSize: 9,
      valGridLine: { color: T.borderDim, size: 0.5 },
      showLegend: false,
    })

    slide.addChart('line' as const, [
      { name: 'Impressions', labels, values: impressions },
    ], {
      x: M + 0.3, y: 4.7, w: SLIDE_W - 2 * M - 0.6, h: 1.95,
      chartColors: [T.accentRed2],
      chartArea: { fill: { color: T.bgCard } },
      lineSize: 3, lineSmooth: true,
      showTitle: true, title: `Daily impressions — ${curLbl}`,
      titleColor: T.textPrimary, titleFontFace: FH, titleFontSize: 12,
      catAxisLabelColor: T.textMuted, catAxisLabelFontSize: 9,
      valAxisLabelColor: T.textMuted, valAxisLabelFontSize: 9,
      valGridLine: { color: T.borderDim, size: 0.5 },
      showLegend: false,
    })
  }

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── Slide 5 — Top queries ───────────────────────────────────────────────────
function buildTopQueriesSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, idx: number, total: number) {
  drawSlideHeader(slide, 'Top search queries', 'Where the clicks come from')

  const rows = (r.gsc?.topQueries ?? []).slice(0, 8)

  drawCard(slide, M, 1.5, SLIDE_W - 2 * M, 5.4)

  const cellHeader = (text: string) => ({
    text,
    options: {
      bold:     true,
      color:    T.textMuted,
      fontFace: FH,
      fontSize: 11,
      fill:     { color: T.bgCard },
      valign:   'middle',
    } as PptxGenJS.TableCellProps,
  })

  const cellBody = (text: string, opts: Partial<PptxGenJS.TableCellProps> = {}) => ({
    text,
    options: {
      color:    T.textPrimary,
      fontFace: FB,
      fontSize: 12,
      fill:     { color: T.bgCard },
      valign:   'middle',
      ...opts,
    } as PptxGenJS.TableCellProps,
  })

  const tableData: PptxGenJS.TableRow[] = [
    [
      cellHeader('Query'),
      cellHeader('Clicks'),
      cellHeader('Impressions'),
      cellHeader('Avg. position'),
    ],
    ...rows.map(q => [
      cellBody(truncate(q.query, 60)),
      cellBody(fmt(q.clicks),      { align: 'right', bold: true }),
      cellBody(fmt(q.impressions), { align: 'right', color: T.textMuted }),
      cellBody(q.position.toFixed(1), { align: 'right', color: T.textMuted }),
    ]),
  ]

  slide.addTable(tableData, {
    x: M + 0.3, y: 1.7, w: SLIDE_W - 2 * M - 0.6,
    colW: [SLIDE_W - 2 * M - 0.6 - 4.5, 1.5, 1.5, 1.5],
    border: { type: 'solid', pt: 0.5, color: T.borderDim },
    rowH: 0.55,
  })

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── Slide 6 — Top pages ─────────────────────────────────────────────────────
function buildTopPagesSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, idx: number, total: number) {
  const ga4Pages = r.ga4?.topPages ?? []
  const useGa4   = ga4Pages.length > 0

  drawSlideHeader(slide, useGa4 ? 'Top organic pages' : 'Top pages by clicks',
                  useGa4 ? 'Google Analytics 4' : 'Google Search Console')

  drawCard(slide, M, 1.5, SLIDE_W - 2 * M, 5.4)

  const cellHeader = (text: string) => ({
    text,
    options: {
      bold: true, color: T.textMuted, fontFace: FH, fontSize: 11,
      fill: { color: T.bgCard }, valign: 'middle',
    } as PptxGenJS.TableCellProps,
  })
  const cellBody = (text: string, opts: Partial<PptxGenJS.TableCellProps> = {}) => ({
    text,
    options: {
      color: T.textPrimary, fontFace: FB, fontSize: 12,
      fill: { color: T.bgCard }, valign: 'middle', ...opts,
    } as PptxGenJS.TableCellProps,
  })

  let tableData: PptxGenJS.TableRow[]
  let colW: number[]
  const rowCount = useGa4 ? Math.min(8, ga4Pages.length) : Math.min(8, r.gsc?.topPagesByClicks?.length ?? 0)

  if (useGa4) {
    // "vs Last Month" column: shows ▲/▼ % delta. NEW badge when prev=0.
    // Red text when drop >20% so the eye snaps to losses.
    const deltaCellFor = (p: { prevSessions?: number; sessionsPct?: number | null }) => {
      // No prev-month data captured (legacy reports) → blank cell
      if (p.prevSessions === undefined) return cellBody('—', { align: 'right', color: T.textDim })
      // Brand new page this month
      if ((p.prevSessions ?? 0) === 0) {
        return cellBody('NEW', { align: 'right', bold: true, color: T.gainGreen })
      }
      const pct = p.sessionsPct ?? null
      if (pct == null) return cellBody('—', { align: 'right', color: T.textDim })
      const isBigDrop = pct <= -20
      const arrow = pct >= 0 ? '▲' : '▼'
      return cellBody(`${arrow}${Math.abs(pct)}%`, {
        align: 'right',
        bold:  isBigDrop || pct >= 20,
        color: pct >= 0 ? T.gainGreen : isBigDrop ? T.lossRed : T.textMuted,
      })
    }

    tableData = [
      [
        cellHeader('Page'),
        cellHeader('Sessions'),
        cellHeader('vs Last Month'),
        cellHeader('Conversions'),
        cellHeader('Revenue'),
      ],
      ...ga4Pages.slice(0, 8).map(p => [
        cellBody(truncate(p.pagePath, 70)),
        cellBody(fmt(p.sessions),    { align: 'right', bold: true }),
        deltaCellFor(p),
        cellBody(fmt(p.conversions), { align: 'right', color: T.textMuted }),
        cellBody(fmtMoney(p.revenue), { align: 'right', color: T.gainGreen }),
      ]),
    ]
    // 5 cols: page (flex), sessions, delta, conversions, revenue
    colW = [SLIDE_W - 2 * M - 0.6 - 6.0, 1.5, 1.5, 1.5, 1.5]
  } else {
    const rows = r.gsc?.topPagesByClicks?.slice(0, 8) ?? []
    tableData = [
      [ cellHeader('Page'), cellHeader('Clicks'), cellHeader('Impressions') ],
      ...rows.map(p => [
        cellBody(truncate(p.page, 70)),
        cellBody(fmt(p.clicks),      { align: 'right', bold: true }),
        cellBody(fmt(p.impressions), { align: 'right', color: T.textMuted }),
      ]),
    ]
    colW = [SLIDE_W - 2 * M - 0.6 - 3.0, 1.5, 1.5]
  }

  slide.addTable(tableData, {
    x: M + 0.3, y: 1.7, w: SLIDE_W - 2 * M - 0.6,
    colW,
    border: { type: 'solid', pt: 0.5, color: T.borderDim },
    rowH: rowCount > 6 ? 0.55 : 0.65,
  })

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── Slide 7 — Competitive Share of Voice ────────────────────────────────────
function buildCompetitiveSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, idx: number, total: number) {
  drawSlideHeader(slide, 'Competitive landscape', 'Share of voice')

  const sov = (r.competitive?.sovTable ?? []).slice(0, 8)

  if (sov.length === 0) {
    drawCard(slide, M, 1.5, SLIDE_W - 2 * M, 5)
    slide.addText('No SERP snapshots tracked for this period — start SERP tracking to populate Share of Voice.', {
      x: M + 0.4, y: 2.5, w: SLIDE_W - 2 * M - 0.8, h: 0.6,
      fontFace: FB, fontSize: 14, color: T.textMuted, italic: true, align: 'center', margin: 0,
    })
    drawFooter(slide, idx, total, r.monthLabel, r.siteName)
    return
  }

  // Left: bar chart. Right: table with keyword counts.
  const leftW = 7.0
  drawCard(slide, M, 1.5, leftW, 5.4)

  // Highlight G2G's row in red, others in muted gray
  const colors = sov.map(s => /g2g\.com$/i.test(s.domain) ? T.accentRed : '64748B')

  slide.addChart('bar' as const, [
    {
      name:   'Share of Voice (%)',
      labels: sov.map(s => truncate(s.domain.replace(/^www\./, ''), 24)),
      values: sov.map(s => +s.sov.toFixed(1)),
    },
  ], {
    x: M + 0.3, y: 1.7, w: leftW - 0.6, h: 5.0, barDir: 'bar',
    chartColors: colors,
    chartColorsOpacity: 90,
    chartArea: { fill: { color: T.bgCard } },
    catAxisLabelColor: T.textPrimary, catAxisLabelFontFace: FB, catAxisLabelFontSize: 11,
    valAxisLabelColor: T.textMuted, valAxisLabelFontSize: 10,
    valGridLine: { color: T.borderDim, size: 0.5 },
    catGridLine: { style: 'none' },
    showValue: true, dataLabelPosition: 'outEnd', dataLabelColor: T.textPrimary,
    dataLabelFontFace: FB, dataLabelFontSize: 10,
    showLegend: false,
  })

  // Right card — keyword counts mini-table
  const rightX = M + leftW + 0.25
  const rightW = SLIDE_W - rightX - M
  drawCard(slide, rightX, 1.5, rightW, 5.4)

  slide.addText('TRACKED', {
    x: rightX + 0.3, y: 1.7, w: rightW - 0.6, h: 0.3,
    fontFace: FH, fontSize: 11, bold: true, charSpacing: 4,
    color: T.textMuted, margin: 0,
  })

  const compRows: PptxGenJS.TextProps[] = []
  for (const s of sov) {
    const isUs = /g2g\.com$/i.test(s.domain)
    compRows.push({
      text: truncate(s.domain.replace(/^www\./, ''), 32),
      options: {
        color: isUs ? T.accentRed : T.textPrimary,
        bold: isUs, breakLine: false,
      },
    })
    compRows.push({
      text: `   ${s.keywords} kws  ·  ${s.sov.toFixed(1)}% SoV`,
      options: { color: T.textMuted, fontSize: 10, italic: true, breakLine: true },
    })
  }

  slide.addText(compRows, {
    x: rightX + 0.3, y: 2.05, w: rightW - 0.6, h: 4.7,
    fontFace: FB, fontSize: 12, color: T.textPrimary,
    paraSpaceAfter: 8, valign: 'top', margin: 0,
  })

  if (r.competitive?.sovEstimated) {
    slide.addText('* SoV based on most recent 60-day SERP data (no snapshots within target month)', {
      x: M, y: SLIDE_H - 0.65, w: SLIDE_W - 2 * M, h: 0.25,
      fontFace: FB, fontSize: 9, italic: true, color: T.textDim, margin: 0,
    })
  }

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── Slide 8 — Backlinks ─────────────────────────────────────────────────────
function buildBacklinksSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, idx: number, total: number) {
  drawSlideHeader(slide, 'Backlink portfolio', 'Off-page')

  const bl     = r.backlinks!
  // Normalise field-name variants (totalActive vs activeCount, etc.)
  const active = bl.activeCount       ?? bl.totalActive  ?? 0
  const fresh  = bl.newThisMonthCount ?? bl.newThisMonth ?? 0

  // 3 KPI cards
  const cards = [
    { label: 'Active backlinks',      value: fmt(active), sub: 'live as of report date' },
    { label: 'New this month',        value: `+${fmt(fresh)}`, sub: 'acquired during period' },
    { label: 'Spend this month',      value: fmtMoney(bl.totalCostThisMonth), sub: `${fmtMoney(bl.totalCostAllTime)} all-time` },
  ]

  const gap = 0.25
  const totalW = SLIDE_W - 2 * M
  const cardW  = (totalW - gap * 2) / 3
  const cardH  = 2.2
  const top    = 1.7

  for (let i = 0; i < cards.length; i++) {
    const x = M + i * (cardW + gap)
    drawCard(slide, x, top, cardW, cardH)
    slide.addText(cards[i].label.toUpperCase(), {
      x: x + 0.3, y: top + 0.2, w: cardW - 0.6, h: 0.3,
      fontFace: FH, fontSize: 11, bold: true, charSpacing: 4,
      color: T.textMuted, margin: 0,
    })
    slide.addText(cards[i].value, {
      x: x + 0.3, y: top + 0.55, w: cardW - 0.6, h: 0.9,
      fontFace: FH, fontSize: 40, bold: true,
      color: i === 1 ? T.gainGreen : T.textPrimary, margin: 0,
    })
    slide.addText(cards[i].sub, {
      x: x + 0.3, y: top + 1.55, w: cardW - 0.6, h: 0.3,
      fontFace: FB, fontSize: 11, italic: true, color: T.textDim, margin: 0,
    })
  }

  // Position improvement callout if available
  if (bl.avgPositionImprovement != null) {
    drawCard(slide, M, 4.4, SLIDE_W - 2 * M, 1.4)
    slide.addText('AVERAGE POSITION IMPROVEMENT FROM ACTIVE BACKLINKS', {
      x: M + 0.4, y: 4.55, w: SLIDE_W - 2 * M - 0.8, h: 0.3,
      fontFace: FH, fontSize: 11, bold: true, charSpacing: 4,
      color: T.textMuted, margin: 0,
    })
    const improvement = bl.avgPositionImprovement
    slide.addText(`${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)} positions`, {
      x: M + 0.4, y: 4.85, w: SLIDE_W - 2 * M - 0.8, h: 0.7,
      fontFace: FH, fontSize: 28, bold: true,
      color: improvement >= 0 ? T.gainGreen : T.lossRed, margin: 0,
    })
  }

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── Slide 9 — Action plan ───────────────────────────────────────────────────
function buildActionPlanSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, plan: string, idx: number, total: number) {
  drawSlideHeader(slide, 'Recommended action plan', 'Next month')

  // Parse plan as bullet list — strip leading markers like "- ", "* ",
  // "1. ", "•". Preserve any surviving structure.
  const lines = plan.split(/\n/).map(l => l.trim()).filter(Boolean)
  const bullets: string[] = []
  for (const line of lines) {
    const cleaned = line
      .replace(/^([-*•]|\d+[.)])\s+/, '')
      .replace(/^\*\*([^*]+)\*\*\s*[:.]?\s*/, '$1: ')   // Markdown bold leader
    if (cleaned.length < 3) continue
    bullets.push(cleaned)
  }
  const top8 = bullets.slice(0, 8)

  drawCard(slide, M, 1.5, SLIDE_W - 2 * M, 5.4)

  if (top8.length === 0) {
    slide.addText('No action plan generated for this report.', {
      x: M + 0.5, y: 2.5, w: SLIDE_W - 2 * M - 1.0, h: 0.6,
      fontFace: FB, fontSize: 14, color: T.textMuted, italic: true, margin: 0,
    })
  } else {
    // Note: pptxgenjs's `bullet: { type: 'number' }` resets to "1." for every
    // text run when items are passed as an array of TextProps. We sidestep
    // that by injecting the index manually + using rich-text styling so the
    // number gets the brand red while the body stays primary white.
    const blocks: PptxGenJS.TextProps[] = []
    for (let i = 0; i < top8.length; i++) {
      blocks.push({
        text: `${i + 1}.  `,
        options: { color: T.accentRed, bold: true, fontSize: 16 },
      })
      blocks.push({
        text: top8[i],
        options: {
          color: T.textPrimary, fontSize: 14,
          breakLine: i < top8.length - 1,
          paraSpaceAfter: 14,
        },
      })
    }
    slide.addText(blocks, {
      x: M + 0.6, y: 1.8, w: SLIDE_W - 2 * M - 1.2, h: 4.8,
      fontFace: FB, color: T.textPrimary,
      align: 'left', valign: 'top', margin: 0,
    })
  }

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── Slide 3 (alt) — Highlight cards ─────────────────────────────────────────
// Replaces the prose narrative slide when `narrativeHighlights` is provided.
// Renders a 2x3 grid of insight cards (or 2x2 for ≤4 highlights).
function buildHighlightsSlide(
  slide: PptxGenJS.Slide,
  r: MonthlyReportData,
  highlights: NarrativeHighlight[],
  idx: number,
  total: number,
) {
  drawSlideHeader(slide, 'What happened this month', 'Key takeaways')

  // Pick layout — 2x2 if 4 or fewer, else 2x3 (max 6 displayed)
  const items = highlights.slice(0, 6)
  const cols = 3
  const rows = Math.ceil(items.length / cols)
  const gap  = 0.25
  const top  = 1.7
  const totalW = SLIDE_W - 2 * M
  const cardW  = (totalW - gap * (cols - 1)) / cols
  const availH = SLIDE_H - top - 0.7
  const cardH  = (availH - gap * (rows - 1)) / rows

  const trendColor = (t?: NarrativeHighlight['trend']) => {
    if (t === 'up')      return T.gainGreen
    if (t === 'down')    return T.lossRed
    if (t === 'warning') return 'F59E0B'
    return T.textMuted
  }
  const trendLabel = (t?: NarrativeHighlight['trend']) => {
    if (t === 'up')      return 'GAIN'
    if (t === 'down')    return 'DECLINE'
    if (t === 'warning') return 'WATCH'
    return 'NEUTRAL'
  }

  for (let i = 0; i < items.length; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const x = M + col * (cardW + gap)
    const y = top + row * (cardH + gap)
    const h = items[i]
    const tColor = trendColor(h.trend)

    // Card background
    slide.addShape('rect' as const, {
      x, y, w: cardW, h: cardH,
      fill: { color: T.bgCard }, line: { color: T.borderDim, width: 0.5 },
      shadow: { type: 'outer', color: '000000', blur: 8, offset: 2, angle: 90, opacity: 0.25 },
    })
    // Trend-colored top border (replaces left-strip motif so cards feel
    // distinct from the rest of the deck)
    slide.addShape('rect' as const, {
      x, y, w: cardW, h: 0.07,
      fill: { color: tColor }, line: { type: 'none' },
    })

    // Optional icon + trend pill (top row of card)
    if (h.icon) {
      slide.addText(h.icon, {
        x: x + 0.25, y: y + 0.18, w: 0.6, h: 0.6,
        fontSize: 28, color: tColor, margin: 0,
      })
    }
    slide.addText(trendLabel(h.trend), {
      x: x + cardW - 1.2, y: y + 0.22, w: 1.0, h: 0.3,
      fontFace: FH, fontSize: 9, bold: true, charSpacing: 4,
      color: tColor, align: 'right', margin: 0,
    })

    // Headline (bold, ~16pt)
    slide.addText(h.headline, {
      x: x + 0.3, y: y + 0.85, w: cardW - 0.6, h: 1.0,
      fontFace: FH, fontSize: 16, bold: true,
      color: T.textPrimary, align: 'left', valign: 'top', margin: 0,
    })

    // Body (smaller, muted-ish)
    slide.addText(h.body, {
      x: x + 0.3, y: y + 1.85, w: cardW - 0.6, h: cardH - 2.1,
      fontFace: FB, fontSize: 11.5, color: T.textPrimary,
      align: 'left', valign: 'top', margin: 0, paraSpaceAfter: 4,
    })
  }

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── Action plan (alt) — Priority cards ──────────────────────────────────────
// Replaces the numbered list when `actionItems` is provided. 2x4 grid, with
// red number badge, optional priority pill, bold title, short body.
function buildActionItemsCardsSlide(
  slide: PptxGenJS.Slide,
  r: MonthlyReportData,
  items: ActionItemCard[],
  idx: number,
  total: number,
) {
  drawSlideHeader(slide, 'Recommended action plan', 'Next month')

  const list = items.slice(0, 8)
  const cols = 2
  const rows = Math.ceil(list.length / cols)
  const gap  = 0.25
  const top  = 1.7
  const totalW = SLIDE_W - 2 * M
  const cardW  = (totalW - gap * (cols - 1)) / cols
  const availH = SLIDE_H - top - 0.7
  const cardH  = (availH - gap * (rows - 1)) / rows

  const priorityColor = (p?: ActionItemCard['priority']) => {
    if (p === 'P0') return T.lossRed
    if (p === 'P1') return 'F59E0B'
    if (p === 'P2') return T.textMuted
    return T.accentRed
  }

  for (let i = 0; i < list.length; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const x = M + col * (cardW + gap)
    const y = top + row * (cardH + gap)
    const it = list[i]
    const pColor = priorityColor(it.priority)

    // Card body
    slide.addShape('rect' as const, {
      x, y, w: cardW, h: cardH,
      fill: { color: T.bgCard }, line: { color: T.borderDim, width: 0.5 },
      shadow: { type: 'outer', color: '000000', blur: 8, offset: 2, angle: 90, opacity: 0.25 },
    })
    // Left red strip — keeps the visual motif consistent with KPI/data cards
    slide.addShape('rect' as const, {
      x, y, w: 0.08, h: cardH,
      fill: { color: pColor }, line: { type: 'none' },
    })

    // Number badge (red circle, top-left)
    const badgeSize = 0.6
    slide.addShape('ellipse' as const, {
      x: x + 0.3, y: y + 0.3, w: badgeSize, h: badgeSize,
      fill: { color: pColor }, line: { type: 'none' },
    })
    slide.addText(String(i + 1), {
      x: x + 0.3, y: y + 0.3, w: badgeSize, h: badgeSize,
      fontFace: FH, fontSize: 22, bold: true,
      color: 'FFFFFF', align: 'center', valign: 'middle', margin: 0,
    })

    // Optional priority pill (top-right)
    if (it.priority) {
      slide.addText(it.priority, {
        x: x + cardW - 1.0, y: y + 0.32, w: 0.7, h: 0.3,
        fontFace: FH, fontSize: 9, bold: true, charSpacing: 3,
        color: pColor, align: 'right', margin: 0,
      })
    }
    if (it.category) {
      slide.addText(it.category.toUpperCase(), {
        x: x + 1.05, y: y + 0.32, w: cardW - 2.2, h: 0.25,
        fontFace: FH, fontSize: 9, bold: true, charSpacing: 4,
        color: T.textMuted, align: 'left', margin: 0,
      })
    }

    // Title (bold)
    slide.addText(it.title, {
      x: x + 1.05, y: y + 0.62, w: cardW - 1.3, h: 0.55,
      fontFace: FH, fontSize: 15, bold: true,
      color: T.textPrimary, align: 'left', valign: 'top', margin: 0,
    })

    // Body
    slide.addText(it.body, {
      x: x + 1.05, y: y + 1.18, w: cardW - 1.3, h: cardH - 1.4,
      fontFace: FB, fontSize: 11, color: T.textPrimary,
      align: 'left', valign: 'top', margin: 0,
    })
  }

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── v2 Slide — Channel Breakdown (GA4 sessionDefaultChannelGroup) ──────────
// Stacked bar comparison + table. Shows which channel grew/shrank MoM.
function buildChannelBreakdownSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, idx: number, total: number) {
  drawSlideHeader(slide, 'Traffic by channel', 'Google Analytics 4')

  const cb = r.channelBreakdown
  if (!cb || cb.rows.length === 0) {
    drawCard(slide, M, 1.5, SLIDE_W - 2 * M, 5)
    slide.addText('No channel breakdown data — GA4 either not configured or has no traffic for this period.', {
      x: M + 0.4, y: 2.5, w: SLIDE_W - 2 * M - 0.8, h: 0.6,
      fontFace: FB, fontSize: 14, color: T.textMuted, italic: true, align: 'center', margin: 0,
    })
    drawFooter(slide, idx, total, r.monthLabel, r.siteName)
    return
  }

  // Top 8 channels — keeps the chart readable + table compact
  const rows = cb.rows.slice(0, 8)

  // Left: bar chart (sessions cur vs prev). Right: data table with deltas.
  const leftW = 6.8
  drawCard(slide, M, 1.5, leftW, 5.4)

  slide.addChart('bar' as const, [
    { name: r.prevMonthLabel, labels: rows.map(rw => truncate(rw.channel, 18)), values: rows.map(rw => rw.prevSessions) },
    { name: r.monthLabel,     labels: rows.map(rw => truncate(rw.channel, 18)), values: rows.map(rw => rw.sessions) },
  ], {
    x: M + 0.3, y: 1.7, w: leftW - 0.6, h: 5.0, barDir: 'bar',
    chartColors: ['64748B', T.accentRed],
    chartArea: { fill: { color: T.bgCard } },
    catAxisLabelColor: T.textPrimary, catAxisLabelFontFace: FB, catAxisLabelFontSize: 11,
    valAxisLabelColor: T.textMuted, valAxisLabelFontSize: 10,
    valGridLine: { color: T.borderDim, size: 0.5 },
    catGridLine: { style: 'none' },
    showValue: false,
    showLegend: true, legendPos: 't', legendColor: T.textMuted,
    legendFontFace: FB, legendFontSize: 10,
  })

  // Right card — table
  const rightX = M + leftW + 0.25
  const rightW = SLIDE_W - rightX - M
  drawCard(slide, rightX, 1.5, rightW, 5.4)

  const cellHeader = (text: string) => ({
    text,
    options: { bold: true, color: T.textMuted, fontFace: FH, fontSize: 10, fill: { color: T.bgCard }, valign: 'middle' as const },
  })
  const cellBody = (text: string, opts: Partial<PptxGenJS.TableCellProps> = {}) => ({
    text,
    options: { color: T.textPrimary, fontFace: FB, fontSize: 11, fill: { color: T.bgCard }, valign: 'middle' as const, ...opts },
  })

  const fmtPctCell = (n: number | null) => {
    if (n == null) return cellBody('—', { align: 'right', color: T.textDim })
    const big   = Math.abs(n) >= 20
    const arrow = n >= 0 ? '▲' : '▼'
    return cellBody(`${arrow}${Math.abs(n)}%`, {
      align: 'right',
      bold:  big,
      color: n >= 0 ? T.gainGreen : (big ? T.lossRed : T.textMuted),
    })
  }

  const tableData: PptxGenJS.TableRow[] = [
    [ cellHeader('Channel'), cellHeader('Sessions'), cellHeader('Δ MoM'), cellHeader('Share') ],
    ...rows.map(rw => [
      cellBody(truncate(rw.channel, 22), { bold: true }),
      cellBody(fmt(rw.sessions, true), { align: 'right' }),
      fmtPctCell(rw.sessionsPct),
      cellBody(`${rw.share.toFixed(1)}%`, { align: 'right', color: T.textMuted }),
    ]),
  ]

  slide.addTable(tableData, {
    x: rightX + 0.2, y: 1.7, w: rightW - 0.4,
    colW: [(rightW - 0.4) * 0.40, (rightW - 0.4) * 0.22, (rightW - 0.4) * 0.20, (rightW - 0.4) * 0.18],
    border: { type: 'solid', pt: 0.5, color: T.borderDim },
    rowH: 0.42,
  })

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── v2 Slide — Tracked Product Ranking Analysis ────────────────────────────
// Bucket KPI cards (top 3 / 5 / 10 / 20) with MoM deltas + top movers + AI
// action plan summary (when monthly).
function buildRankingAnalysisSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, idx: number, total: number) {
  drawSlideHeader(slide, 'Tracked product rankings', 'DataForSEO daily SERP')

  const tr = r.trackedRankings
  if (!tr || tr.bucketsCur.total === 0) {
    drawCard(slide, M, 1.5, SLIDE_W - 2 * M, 5)
    slide.addText(
      tr ? 'Tracked-product ranking history is empty for this period — daily DataForSEO cron needs at least one cycle to populate this.'
         : 'No tracked products configured. Add some at /gsc/product-rankings to surface ranking analysis here.',
      {
        x: M + 0.4, y: 2.5, w: SLIDE_W - 2 * M - 0.8, h: 0.6,
        fontFace: FB, fontSize: 14, color: T.textMuted, italic: true, align: 'center', margin: 0,
      }
    )
    drawFooter(slide, idx, total, r.monthLabel, r.siteName)
    return
  }

  // 4 bucket cards across the top
  const buckets = [
    { label: 'Top 3',  cur: tr.bucketsCur.top3,  prev: tr.bucketsPrev.top3 },
    { label: 'Top 5',  cur: tr.bucketsCur.top5,  prev: tr.bucketsPrev.top5 },
    { label: 'Top 10', cur: tr.bucketsCur.top10, prev: tr.bucketsPrev.top10 },
    { label: 'Top 20', cur: tr.bucketsCur.top20, prev: tr.bucketsPrev.top20 },
  ]

  const gap = 0.2
  const totalW = SLIDE_W - 2 * M
  const cardW = (totalW - gap * 3) / 4
  const cardH = 1.55
  const top   = 1.45

  for (let i = 0; i < buckets.length; i++) {
    const x = M + i * (cardW + gap)
    const b = buckets[i]
    const delta = b.cur - b.prev
    drawCard(slide, x, top, cardW, cardH)
    slide.addText(b.label.toUpperCase(), {
      x: x + 0.25, y: top + 0.15, w: cardW - 0.5, h: 0.25,
      fontFace: FH, fontSize: 10, bold: true, charSpacing: 4, color: T.textMuted, margin: 0,
    })
    slide.addText(String(b.cur), {
      x: x + 0.25, y: top + 0.4, w: cardW - 0.5, h: 0.7,
      fontFace: FH, fontSize: 32, bold: true, color: T.textPrimary, margin: 0,
    })
    slide.addText(`${delta >= 0 ? '+' : ''}${delta} vs prev`, {
      x: x + 0.25, y: top + 1.1, w: cardW - 0.5, h: 0.3,
      fontFace: FH, fontSize: 11, bold: true,
      color: delta > 0 ? T.gainGreen : delta < 0 ? T.lossRed : T.textMuted, margin: 0,
    })
  }

  // Two columns below buckets: improvers (left) + droppers (right)
  const colY = top + cardH + 0.2
  const colH = SLIDE_H - colY - 0.7
  const colW2 = (totalW - gap) / 2

  drawCard(slide, M,                         colY, colW2, colH)
  drawCard(slide, M + colW2 + gap,           colY, colW2, colH)

  slide.addText('TOP IMPROVERS', {
    x: M + 0.25, y: colY + 0.15, w: colW2 - 0.5, h: 0.3,
    fontFace: FH, fontSize: 11, bold: true, charSpacing: 4, color: T.gainGreen, margin: 0,
  })
  slide.addText('TOP DROPPERS', {
    x: M + colW2 + gap + 0.25, y: colY + 0.15, w: colW2 - 0.5, h: 0.3,
    fontFace: FH, fontSize: 11, bold: true, charSpacing: 4, color: T.lossRed, margin: 0,
  })

  // Improvers list
  const improvers = tr.topImprovers.slice(0, 6)
  const droppers  = tr.topDroppers.slice(0, 6)
  const renderMover = (kw: { keyword: string; productName: string; curPosition: number | null; movement: number | null }, x: number, y: number, w: number) => {
    const positionLine = `${kw.curPosition != null ? `pos ${kw.curPosition}` : 'unranked'}${kw.movement != null ? ` · ${kw.movement > 0 ? `▲${kw.movement}` : `▼${Math.abs(kw.movement)}`}` : ''}`
    slide.addText(truncate(kw.keyword, 60), {
      x, y, w, h: 0.25, fontFace: FB, fontSize: 11, bold: true, color: T.textPrimary, margin: 0,
    })
    slide.addText(`${truncate(kw.productName, 30)} · ${positionLine}`, {
      x, y: y + 0.25, w, h: 0.22, fontFace: FB, fontSize: 9, color: (kw.movement ?? 0) >= 0 ? T.gainGreen : T.lossRed, margin: 0,
    })
  }

  for (let i = 0; i < improvers.length; i++) {
    const y = colY + 0.5 + i * 0.55
    renderMover(improvers[i], M + 0.3, y, colW2 - 0.5)
  }
  for (let i = 0; i < droppers.length; i++) {
    const y = colY + 0.5 + i * 0.55
    renderMover(droppers[i], M + colW2 + gap + 0.3, y, colW2 - 0.5)
  }

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── v2 Slide — AI Action Plan from ranking analysis (monthly only) ─────────
function buildRankingActionPlanSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, idx: number, total: number) {
  drawSlideHeader(slide, 'Ranking action plan', 'AI-generated · what to ship')

  const items = r.trackedRankings?.actionPlan ?? []
  if (items.length === 0) {
    drawCard(slide, M, 1.5, SLIDE_W - 2 * M, 5)
    slide.addText('No action items — keyword rankings are stable, or there isn\'t enough history yet.', {
      x: M + 0.4, y: 2.5, w: SLIDE_W - 2 * M - 0.8, h: 0.6,
      fontFace: FB, fontSize: 14, color: T.textMuted, italic: true, align: 'center', margin: 0,
    })
    drawFooter(slide, idx, total, r.monthLabel, r.siteName)
    return
  }

  // Up to 6 items rendered as 2x3 grid of cards, sorted P0 > P1 > P2
  const sorted = [...items].sort((a, b) => {
    const order: Record<string, number> = { P0: 0, P1: 1, P2: 2 }
    return (order[a.priority] ?? 9) - (order[b.priority] ?? 9)
  }).slice(0, 6)

  const gap = 0.2
  const cols = 2
  const rows = Math.ceil(sorted.length / cols)
  const totalW = SLIDE_W - 2 * M
  const cardW = (totalW - gap * (cols - 1)) / cols
  const cardH = (SLIDE_H - 2.0 - gap * (rows - 1)) / rows
  const topY  = 1.5

  const priorityColor = (p: 'P0' | 'P1' | 'P2'): string =>
    p === 'P0' ? T.lossRed : p === 'P1' ? 'F59E0B' : T.textMuted

  for (let i = 0; i < sorted.length; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const x = M + col * (cardW + gap)
    const y = topY + row * (cardH + gap)
    const it = sorted[i]
    const pColor = priorityColor(it.priority)

    drawCard(slide, x, y, cardW, cardH)
    // Override the left strip color with priority color
    slide.addShape('rect' as const, {
      x, y, w: 0.08, h: cardH,
      fill: { color: pColor }, line: { type: 'none' },
    })

    // Priority + category badges
    slide.addText(it.priority, {
      x: x + 0.25, y: y + 0.2, w: 0.5, h: 0.28,
      fontFace: FH, fontSize: 10, bold: true, charSpacing: 3, color: pColor, margin: 0,
    })
    slide.addText(it.category.toUpperCase(), {
      x: x + 0.85, y: y + 0.22, w: cardW - 1.1, h: 0.25,
      fontFace: FH, fontSize: 9, bold: true, charSpacing: 3, color: T.textMuted, margin: 0,
    })

    // Keyword + product
    slide.addText(`"${truncate(it.keyword, 50)}"`, {
      x: x + 0.25, y: y + 0.55, w: cardW - 0.5, h: 0.35,
      fontFace: FH, fontSize: 14, bold: true, color: T.textPrimary, margin: 0,
    })
    const posLine = `${it.productName ? truncate(it.productName, 40) : ''}${it.curPosition != null ? ` · pos ${it.curPosition}` : ''}${it.movement != null ? ` · ${it.movement > 0 ? `▲${it.movement}` : `▼${Math.abs(it.movement)}`}` : ''}`
    slide.addText(posLine, {
      x: x + 0.25, y: y + 0.92, w: cardW - 0.5, h: 0.25,
      fontFace: FB, fontSize: 10, italic: true, color: T.textMuted, margin: 0,
    })

    // Recommendation body
    slide.addText(it.recommendation, {
      x: x + 0.25, y: y + 1.25, w: cardW - 0.5, h: cardH - 1.45,
      fontFace: FB, fontSize: 11, color: T.textPrimary, valign: 'top', margin: 0,
    })
  }

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}

// ── v2 Slide — Experiments (Start / Stop / Continue) ──────────────────────
// 3-column layout mirroring the in-tools Kanban so an exec sees the same
// thing on the slide as in the dashboard.
function buildExperimentsSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, idx: number, total: number) {
  drawSlideHeader(slide, 'Experiments — Start / Stop / Continue', 'Monthly bets')

  const e = r.experiments
  if (!e || (e.start.length === 0 && e.continue.length === 0 && e.stop.length === 0)) {
    drawCard(slide, M, 1.5, SLIDE_W - 2 * M, 5)
    slide.addText('No experiments tracked for this period yet. Mimir is waiting at /experiments to help generate ideas.', {
      x: M + 0.4, y: 2.5, w: SLIDE_W - 2 * M - 0.8, h: 0.6,
      fontFace: FB, fontSize: 14, color: T.textMuted, italic: true, align: 'center', margin: 0,
    })
    drawFooter(slide, idx, total, r.monthLabel, r.siteName)
    return
  }

  const gap = 0.2
  const totalW = SLIDE_W - 2 * M
  const colW = (totalW - gap * 2) / 3
  const colH = SLIDE_H - 1.45 - 0.7
  const topY = 1.45

  const columns: { label: string; icon: string; tint: string; items: { title: string; sub?: string; tail?: string }[] }[] = [
    {
      label: 'Start',
      icon: '🌱',
      tint: T.gainGreen,
      items: e.start.map(it => ({
        title: it.title,
        sub:   it.hypothesis ?? undefined,
        tail:  [it.category, it.source === 'mimir' ? '🪶 Mimir' : null].filter(Boolean).join(' · '),
      })),
    },
    {
      label: 'Continue',
      icon: '🔄',
      tint: '60A5FA',
      items: e.continue.map(it => ({
        title: it.title,
        sub:   it.success_metric ?? it.hypothesis ?? undefined,
        tail:  [
          it.category,
          it.target_value != null && it.current_value != null ? `${it.current_value}/${it.target_value}` : null,
        ].filter(Boolean).join(' · '),
      })),
    },
    {
      label: 'Stop',
      icon: '🛑',
      tint: T.lossRed,
      items: e.stop.map(it => ({
        title: it.title,
        sub:   it.decision_notes ?? undefined,
        tail:  [it.outcome, it.category].filter(Boolean).join(' · '),
      })),
    },
  ]

  for (let c = 0; c < columns.length; c++) {
    const col = columns[c]
    const x = M + c * (colW + gap)
    drawCard(slide, x, topY, colW, colH)

    // Column header
    slide.addText(`${col.icon}  ${col.label.toUpperCase()}  ·  ${col.items.length}`, {
      x: x + 0.25, y: topY + 0.15, w: colW - 0.5, h: 0.32,
      fontFace: FH, fontSize: 12, bold: true, charSpacing: 3, color: col.tint, margin: 0,
    })

    // Up to 5 items per column to keep slide readable
    const items = col.items.slice(0, 5)
    const startY = topY + 0.55
    const itemH  = (colH - 0.7) / Math.max(5, items.length || 1)
    for (let i = 0; i < items.length; i++) {
      const ix = x + 0.25
      const iy = startY + i * itemH
      const it = items[i]
      slide.addText(truncate(it.title, 80), {
        x: ix, y: iy, w: colW - 0.5, h: 0.32,
        fontFace: FH, fontSize: 12, bold: true, color: T.textPrimary, margin: 0,
      })
      if (it.sub) {
        slide.addText(truncate(it.sub, 130), {
          x: ix, y: iy + 0.32, w: colW - 0.5, h: itemH - 0.62,
          fontFace: FB, fontSize: 9.5, color: T.textMuted, valign: 'top', margin: 0,
        })
      }
      if (it.tail) {
        slide.addText(it.tail, {
          x: ix, y: iy + itemH - 0.3, w: colW - 0.5, h: 0.25,
          fontFace: FB, fontSize: 9, italic: true, color: T.textDim, margin: 0,
        })
      }
    }

    if (col.items.length > 5) {
      slide.addText(`+ ${col.items.length - 5} more`, {
        x: x + 0.25, y: topY + colH - 0.4, w: colW - 0.5, h: 0.25,
        fontFace: FB, fontSize: 10, italic: true, color: T.textDim, margin: 0,
      })
    }
  }

  drawFooter(slide, idx, total, r.monthLabel, r.siteName)
}
