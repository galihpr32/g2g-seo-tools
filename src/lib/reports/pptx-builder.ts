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
    topPages:         { pagePath: string; sessions: number; conversions: number; revenue: number }[]
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

  backlinks?: {
    activeCount?:        number
    newThisMonthCount?:  number
    totalCostThisMonth?: number
    totalCostAllTime?:   number
    costsByCurrency?:    Record<string, number>
    avgPositionImprovement?: number
  }
}

export interface BuildPptxInput {
  reportData:  MonthlyReportData
  aiNarrative: string
  aiActionPlan: string
}

// ── Theme ───────────────────────────────────────────────────────────────────

const T = {
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
} as const

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
function drawFooter(slide: PptxGenJS.Slide, slideNum: number, total: number, monthLabel: string) {
  slide.addText('G2G Monthly Report', {
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
  const { reportData: r, aiNarrative, aiActionPlan } = input

  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_WIDE'
  pres.title  = `G2G Monthly Report — ${r.monthLabel}`
  pres.author = 'G2G SEO Tools'
  pres.company = 'G2G'

  // Build slides in order. Total count is used by drawFooter.
  const buildFns: ((slide: PptxGenJS.Slide, idx: number, total: number) => void | Promise<void>)[] = [
    s => buildCoverSlide(s, r),
    (s, i, t) => buildExecKpisSlide(s, r, i, t),
    (s, i, t) => buildNarrativeSlide(s, r, aiNarrative, i, t),
  ]

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

  // Competitive
  if (r.competitive?.sovTable?.length) {
    buildFns.push((s, i, t) => buildCompetitiveSlide(s, r, i, t))
  }

  // Backlinks
  if (r.backlinks && (r.backlinks.activeCount || r.backlinks.newThisMonthCount)) {
    buildFns.push((s, i, t) => buildBacklinksSlide(s, r, i, t))
  }

  // Action plan
  if (aiActionPlan?.trim()) {
    buildFns.push((s, i, t) => buildActionPlanSlide(s, r, aiActionPlan, i, t))
  }

  const total = buildFns.length
  for (let i = 0; i < buildFns.length; i++) {
    const slide = pres.addSlide()
    slide.background = { color: i === 0 ? T.bgHero : T.bgPrimary }
    await buildFns[i](slide, i + 1, total)
  }

  // Render to Node Buffer
  const arr = await pres.write({ outputType: 'nodebuffer' })
  return arr as Buffer
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
  slide.addText('Prepared by G2G SEO Tools', {
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
    kpis.push({
      label: 'Active backlinks',
      value: fmt(r.backlinks.activeCount),
      delta: `+${fmt(r.backlinks.newThisMonthCount)} new`,
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

  drawFooter(slide, idx, total, r.monthLabel)
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

  drawFooter(slide, idx, total, r.monthLabel)
}

// ── Slide 4 — GSC Trend chart ───────────────────────────────────────────────
function buildGscTrendSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, idx: number, total: number) {
  drawSlideHeader(slide, 'Search performance trend', 'Google Search Console')

  const series = r.gsc?.dailySeries ?? []

  if (series.length === 0) {
    // Fallback: just show the monthly totals as 2-bar comparison.
    drawCard(slide, M, 1.5, SLIDE_W - 2 * M, 4.8)
    const data = [
      { name: 'Clicks', labels: [r.prevMonthLabel, r.monthLabel],
        values: [r.gsc?.prevMonthClicks ?? 0, r.gsc?.monthClicks ?? 0] },
      { name: 'Impressions', labels: [r.prevMonthLabel, r.monthLabel],
        values: [r.gsc?.prevImpressions ?? 0, r.gsc?.monthImpressions ?? 0] },
    ]
    slide.addChart('bar' as 'bar', data, {
      x: M + 0.3, y: 1.7, w: SLIDE_W - 2 * M - 0.6, h: 4.5, barDir: 'col',
      chartColors: [T.accentRed, T.accentRed2],
      chartArea: { fill: { color: T.bgCard }, roundedCorners: false },
      catAxisLabelColor: T.textMuted, catAxisLabelFontSize: 12,
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
    drawCard(slide, M, 1.5, SLIDE_W - 2 * M, 4.8)

    const labels = series.map(d => d.date.slice(5))   // MM-DD
    const clicks      = series.map(d => d.clicks)
    const impressions = series.map(d => d.impressions)

    slide.addChart('line' as 'line', [
      { name: 'Clicks',      labels, values: clicks },
    ], {
      x: M + 0.3, y: 1.7, w: SLIDE_W - 2 * M - 0.6, h: 2.1,
      chartColors: [T.accentRed],
      chartArea: { fill: { color: T.bgCard } },
      lineSize: 3, lineSmooth: true,
      showTitle: true, title: 'Daily clicks',
      titleColor: T.textPrimary, titleFontFace: FH, titleFontSize: 13,
      catAxisLabelColor: T.textMuted, catAxisLabelFontSize: 9,
      valAxisLabelColor: T.textMuted, valAxisLabelFontSize: 9,
      valGridLine: { color: T.borderDim, size: 0.5 },
      showLegend: false,
    })

    slide.addChart('line' as 'line', [
      { name: 'Impressions', labels, values: impressions },
    ], {
      x: M + 0.3, y: 4.0, w: SLIDE_W - 2 * M - 0.6, h: 2.1,
      chartColors: [T.accentRed2],
      chartArea: { fill: { color: T.bgCard } },
      lineSize: 3, lineSmooth: true,
      showTitle: true, title: 'Daily impressions',
      titleColor: T.textPrimary, titleFontFace: FH, titleFontSize: 13,
      catAxisLabelColor: T.textMuted, catAxisLabelFontSize: 9,
      valAxisLabelColor: T.textMuted, valAxisLabelFontSize: 9,
      valGridLine: { color: T.borderDim, size: 0.5 },
      showLegend: false,
    })
  }

  drawFooter(slide, idx, total, r.monthLabel)
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

  drawFooter(slide, idx, total, r.monthLabel)
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
    tableData = [
      [
        cellHeader('Page'),
        cellHeader('Sessions'),
        cellHeader('Conversions'),
        cellHeader('Revenue'),
      ],
      ...ga4Pages.slice(0, 8).map(p => [
        cellBody(truncate(p.pagePath, 70)),
        cellBody(fmt(p.sessions),    { align: 'right', bold: true }),
        cellBody(fmt(p.conversions), { align: 'right', color: T.textMuted }),
        cellBody(fmtMoney(p.revenue), { align: 'right', color: T.gainGreen }),
      ]),
    ]
    colW = [SLIDE_W - 2 * M - 0.6 - 4.5, 1.5, 1.5, 1.5]
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

  drawFooter(slide, idx, total, r.monthLabel)
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
    drawFooter(slide, idx, total, r.monthLabel)
    return
  }

  // Left: bar chart. Right: table with keyword counts.
  const leftW = 7.0
  drawCard(slide, M, 1.5, leftW, 5.4)

  // Highlight G2G's row in red, others in muted gray
  const colors = sov.map(s => /g2g\.com$/i.test(s.domain) ? T.accentRed : '64748B')

  slide.addChart('bar' as 'bar', [
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

  drawFooter(slide, idx, total, r.monthLabel)
}

// ── Slide 8 — Backlinks ─────────────────────────────────────────────────────
function buildBacklinksSlide(slide: PptxGenJS.Slide, r: MonthlyReportData, idx: number, total: number) {
  drawSlideHeader(slide, 'Backlink portfolio', 'Off-page')

  const bl = r.backlinks!

  // 3 KPI cards
  const cards = [
    { label: 'Active backlinks',      value: fmt(bl.activeCount), sub: 'live as of report date' },
    { label: 'New this month',        value: `+${fmt(bl.newThisMonthCount)}`, sub: 'acquired during period' },
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

  drawFooter(slide, idx, total, r.monthLabel)
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

  drawFooter(slide, idx, total, r.monthLabel)
}
