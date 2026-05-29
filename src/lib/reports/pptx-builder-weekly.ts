// ─── Weekly Report → PPTX builder ───────────────────────────────────────────
// Focused 5-slide weekly deck. Lighter weight than the monthly version since
// weekly cadence calls for a quick-glance scorecard, not a deep dive.
//
// Slides:
//   1. Cover                 — brand, week range, generated date
//   2. KPIs                  — clicks/impressions/CTR/avg position with WoW deltas
//   3. Top Movers            — top 5 gainer + 5 dropper pages
//   4. AI Narrative          — what happened (issues / wins)
//   5. AI Action Plan        — recommended team actions
//
// Caller is the Vercel route /api/reports/weekly/export-pptx (download stream)
// and /api/cron/weekly-report-generator (Drive upload + Slack post).

import PptxGenJS from 'pptxgenjs'

// ── Theme (matches monthly's dark brand look) ──────────────────────────────
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
}
const FH = 'Trebuchet MS'
const FB = 'Calibri'

const SLIDE_W = 13.333
const SLIDE_H = 7.5
const M       = 0.6

// ── Data shape ──────────────────────────────────────────────────────────────
export interface WeeklyReportData {
  weekStart:  string
  weekEnd:    string
  weekLabel:  string
  prevLabel:  string
  siteSlug:   string
  siteName:   string
  generatedAt: string

  gsc?: {
    weekClicks:          number
    prevWeekClicks:      number
    clicksPct:           number | null
    weekImpressions:     number
    prevWeekImpressions: number
    impressionsPct:      number | null
    weekCtr:             number
    prevWeekCtr:         number
    ctrPct:              number | null
    avgPosition:         number
    totalUniquePages:    number
    topGainers:          { page: string; delta: number; clicks: number }[]
    topDroppers:         { page: string; delta: number; clicks: number }[]
  } | null
}

export interface BuildWeeklyPptxInput {
  reportData:  WeeklyReportData
  aiNarrative: string    // free-form narrative paragraph(s)
  aiActionPlan: string   // free-form action-plan text (numbered or bulleted)
  /** Optional per-brand accent override — defaults to G2G red. */
  theme?: { accent?: string }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
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
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function drawCard(slide: PptxGenJS.Slide, x: number, y: number, w: number, h: number, accent: string) {
  slide.addShape('rect' as PptxGenJS.ShapeType, {
    x, y, w, h,
    fill: { color: T.bgCard },
    line: { color: T.borderDim, width: 0.5 },
  })
  slide.addShape('rect' as PptxGenJS.ShapeType, {
    x, y, w: 0.06, h,
    fill: { color: accent }, line: { type: 'none' },
  })
}

function drawSlideHeader(slide: PptxGenJS.Slide, title: string, eyebrow: string, accent: string) {
  slide.addText(eyebrow.toUpperCase(), {
    x: M, y: 0.4, w: SLIDE_W - 2 * M, h: 0.3,
    fontFace: FH, fontSize: 11, bold: true, charSpacing: 4,
    color: accent, align: 'left', margin: 0,
  })
  slide.addText(title, {
    x: M, y: 0.7, w: SLIDE_W - 2 * M, h: 0.7,
    fontFace: FH, fontSize: 28, bold: true,
    color: T.textPrimary, align: 'left', margin: 0,
  })
}

function drawFooter(slide: PptxGenJS.Slide, idx: number, total: number, weekLabel: string, siteName: string) {
  slide.addText(`${siteName} Weekly Report`, {
    x: M, y: SLIDE_H - 0.4, w: 4, h: 0.25,
    fontFace: FB, fontSize: 9, color: T.textDim, align: 'left', margin: 0,
  })
  slide.addText(`${weekLabel}  ·  ${idx} / ${total}`, {
    x: SLIDE_W - 4 - M, y: SLIDE_H - 0.4, w: 4, h: 0.25,
    fontFace: FB, fontSize: 9, color: T.textDim, align: 'right', margin: 0,
  })
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function buildWeeklyReportPptx(input: BuildWeeklyPptxInput): Promise<Buffer> {
  const r = input.reportData
  const accent = input.theme?.accent ?? T.accentRed

  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.defineLayout({ name: 'LAYOUT_WIDE', width: SLIDE_W, height: SLIDE_H })

  const total = 5

  // ── Slide 1: Cover ─────────────────────────────────────────────────────────
  const s1 = pptx.addSlide()
  s1.background = { color: T.bgHero }
  s1.addShape('rect' as PptxGenJS.ShapeType, {
    x: 0, y: 0, w: 0.15, h: SLIDE_H, fill: { color: accent }, line: { type: 'none' },
  })
  s1.addText(r.siteName.toUpperCase(), {
    x: M, y: 2.3, w: SLIDE_W - 2 * M, h: 0.5,
    fontFace: FH, fontSize: 14, bold: true, charSpacing: 6,
    color: accent, align: 'left',
  })
  s1.addText('Weekly Report', {
    x: M, y: 2.9, w: SLIDE_W - 2 * M, h: 0.9,
    fontFace: FH, fontSize: 48, bold: true, color: T.textPrimary, align: 'left',
  })
  s1.addText(r.weekLabel, {
    x: M, y: 3.9, w: SLIDE_W - 2 * M, h: 0.5,
    fontFace: FH, fontSize: 22, color: T.textMuted, align: 'left',
  })
  s1.addText(`Generated ${new Date(r.generatedAt).toLocaleString()}`, {
    x: M, y: SLIDE_H - 0.7, w: SLIDE_W - 2 * M, h: 0.3,
    fontFace: FB, fontSize: 10, color: T.textDim, align: 'left',
  })

  // ── Slide 2: KPIs ─────────────────────────────────────────────────────────
  const s2 = pptx.addSlide()
  s2.background = { color: T.bgPrimary }
  drawSlideHeader(s2, 'Key Metrics', 'Week Performance', accent)

  const kpis = [
    { label: 'Clicks',       value: fmt(r.gsc?.weekClicks),       delta: r.gsc?.clicksPct ?? null },
    { label: 'Impressions',  value: fmt(r.gsc?.weekImpressions),  delta: r.gsc?.impressionsPct ?? null },
    { label: 'CTR',          value: r.gsc?.weekCtr != null ? `${r.gsc.weekCtr.toFixed(2)}%` : '—', delta: r.gsc?.ctrPct ?? null },
    { label: 'Avg Position', value: r.gsc?.avgPosition != null ? `#${r.gsc.avgPosition.toFixed(1)}` : '—', delta: null },
  ]
  const cardW = (SLIDE_W - 2 * M - 0.3 * 3) / 4
  kpis.forEach((k, i) => {
    const x = M + i * (cardW + 0.3)
    const y = 1.8
    drawCard(s2, x, y, cardW, 2, accent)
    s2.addText(k.label.toUpperCase(), {
      x: x + 0.25, y: y + 0.25, w: cardW - 0.5, h: 0.3,
      fontFace: FH, fontSize: 10, bold: true, color: T.textMuted, charSpacing: 3,
    })
    s2.addText(k.value, {
      x: x + 0.25, y: y + 0.65, w: cardW - 0.5, h: 0.8,
      fontFace: FH, fontSize: 30, bold: true, color: T.textPrimary,
    })
    if (k.delta != null) {
      s2.addText(`${fmtPct(k.delta)} WoW`, {
        x: x + 0.25, y: y + 1.5, w: cardW - 0.5, h: 0.3,
        fontFace: FB, fontSize: 11, color: deltaColor(k.delta),
      })
    } else if (k.label === 'Avg Position') {
      s2.addText(`${r.gsc?.totalUniquePages ?? 0} unique pages`, {
        x: x + 0.25, y: y + 1.5, w: cardW - 0.5, h: 0.3,
        fontFace: FB, fontSize: 10, color: T.textDim,
      })
    }
  })

  drawFooter(s2, 2, total, r.weekLabel, r.siteName)

  // ── Slide 3: Top Movers ───────────────────────────────────────────────────
  const s3 = pptx.addSlide()
  s3.background = { color: T.bgPrimary }
  drawSlideHeader(s3, 'Top Page Movers', 'Click Changes WoW', accent)

  const halfW = (SLIDE_W - 2 * M - 0.4) / 2
  const colY  = 1.8
  const colH  = SLIDE_H - colY - 1.0

  // Gainers
  drawCard(s3, M, colY, halfW, colH, T.gainGreen)
  s3.addText('📈 TOP GAINERS', {
    x: M + 0.25, y: colY + 0.2, w: halfW - 0.5, h: 0.3,
    fontFace: FH, fontSize: 12, bold: true, color: T.gainGreen, charSpacing: 3,
  })
  ;(r.gsc?.topGainers ?? []).slice(0, 5).forEach((g, i) => {
    const rowY = colY + 0.65 + i * 0.85
    s3.addText(truncate(g.page.replace(/^https?:\/\//, ''), 50), {
      x: M + 0.25, y: rowY, w: halfW - 1.2, h: 0.3,
      fontFace: FB, fontSize: 10, color: T.textPrimary,
    })
    s3.addText(`+${fmt(g.delta)} clicks`, {
      x: M + halfW - 1.2, y: rowY, w: 0.9, h: 0.3,
      fontFace: FB, fontSize: 10, bold: true, color: T.gainGreen, align: 'right',
    })
    s3.addText(`now ${fmt(g.clicks)} clicks/wk`, {
      x: M + 0.25, y: rowY + 0.3, w: halfW - 0.5, h: 0.25,
      fontFace: FB, fontSize: 9, color: T.textDim,
    })
  })

  // Droppers
  drawCard(s3, M + halfW + 0.4, colY, halfW, colH, T.lossRed)
  s3.addText('📉 TOP DROPPERS', {
    x: M + halfW + 0.65, y: colY + 0.2, w: halfW - 0.5, h: 0.3,
    fontFace: FH, fontSize: 12, bold: true, color: T.lossRed, charSpacing: 3,
  })
  ;(r.gsc?.topDroppers ?? []).slice(0, 5).forEach((d, i) => {
    const rowY = colY + 0.65 + i * 0.85
    s3.addText(truncate(d.page.replace(/^https?:\/\//, ''), 50), {
      x: M + halfW + 0.65, y: rowY, w: halfW - 1.2, h: 0.3,
      fontFace: FB, fontSize: 10, color: T.textPrimary,
    })
    s3.addText(`${fmt(d.delta)} clicks`, {
      x: M + 2 * halfW - 0.55, y: rowY, w: 0.9, h: 0.3,
      fontFace: FB, fontSize: 10, bold: true, color: T.lossRed, align: 'right',
    })
    s3.addText(`now ${fmt(d.clicks)} clicks/wk`, {
      x: M + halfW + 0.65, y: rowY + 0.3, w: halfW - 0.5, h: 0.25,
      fontFace: FB, fontSize: 9, color: T.textDim,
    })
  })

  drawFooter(s3, 3, total, r.weekLabel, r.siteName)

  // ── Slide 4: AI Narrative ─────────────────────────────────────────────────
  const s4 = pptx.addSlide()
  s4.background = { color: T.bgPrimary }
  drawSlideHeader(s4, 'What Happened', 'AI Narrative', accent)

  drawCard(s4, M, 1.8, SLIDE_W - 2 * M, SLIDE_H - 2.8, accent)
  s4.addText(input.aiNarrative || '_No AI narrative generated for this week. Check Anthropic API key + retry._', {
    x: M + 0.3, y: 2.0, w: SLIDE_W - 2 * M - 0.6, h: SLIDE_H - 3.2,
    fontFace: FB, fontSize: 12, color: T.textPrimary, valign: 'top',
  })

  drawFooter(s4, 4, total, r.weekLabel, r.siteName)

  // ── Slide 5: Action Plan ──────────────────────────────────────────────────
  const s5 = pptx.addSlide()
  s5.background = { color: T.bgPrimary }
  drawSlideHeader(s5, 'Action Plan', 'Recommended Steps', accent)

  drawCard(s5, M, 1.8, SLIDE_W - 2 * M, SLIDE_H - 2.8, accent)
  s5.addText(input.aiActionPlan || '_No action plan generated. Add manually in the dashboard._', {
    x: M + 0.3, y: 2.0, w: SLIDE_W - 2 * M - 0.6, h: SLIDE_H - 3.2,
    fontFace: FB, fontSize: 12, color: T.textPrimary, valign: 'top',
  })

  drawFooter(s5, 5, total, r.weekLabel, r.siteName)

  // ── Return as Buffer ──────────────────────────────────────────────────────
  // pptxgenjs returns the file via write('arraybuffer') — convert to Node Buffer.
  const ab = await pptx.write({ outputType: 'arraybuffer' }) as ArrayBuffer
  return Buffer.from(ab)
}
