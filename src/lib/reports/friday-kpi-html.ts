// ── Friday KPI HTML renderer ───────────────────────────────────────────────
//
// Sprint FRIDAY.KPI.GRAPH.4 — pure string-based HTML template that the
// puppeteer renderer loads via setContent(). No Tailwind, no React, no Next.
// Everything inline so puppeteer doesn't have to wait on network bundles.
// Chart.js is the only external dep (CDN) and we wait for `window.kpiReady`
// before screenshotting.

import type { FridayKpiPayload, BrandKpi } from './friday-kpi'
import type { ActionPlanItem } from './action-plan-synthesizer'

/**
 * Sprint FRIDAY.KPI.PNG-UNSPLIT — historical AI Visibility series per brand.
 * Loaded by friday-kpi-deliver from ai_visibility_snapshots (bing_ai source).
 * Empty arrays = no data, renderer hides the chart section in that case.
 */
export interface AiVisibilityHistory {
  [siteSlug: string]: {
    dates:       string[]   // 'YYYY-MM-DD'
    citations:   number[]
    cited_pages: number[]
  }
}

/**
 * Sprint FRIDAY.KPI.HERO-HISTORICAL (336) — historical GSC clicks +
 * impressions per brand × market for the new hero chart that replaces the
 * Top 3/Top 10 bar visualization. 12 weekly buckets (oldest → newest),
 * Thu→Wed windows matching the rest of Friday KPI. Loaded by
 * friday-kpi-deliver from a single 84-day GSC API call per brand.
 */
export interface GscHistorical {
  [siteSlug: string]: {
    weekLabels: string[]               // e.g. ['Mar 6','Mar 13',...,'May 22']
    us: { clicks: number[]; impressions: number[] }
    id: { clicks: number[]; impressions: number[] }
  }
}

/**
 * Sprint FRIDAY.KPI.COMPETITIVE-TREND (341) — 12-week historical of Top 3
 * count, Top 10 count, and Avg Position per brand × market, filtered to
 * is_cluster_winner=true (same curated set as `kw_count` in the existing
 * tables — keeps the report internally consistent).
 *
 * Each metric gets its own line chart in the PNG so the slope of Top 3,
 * Top 10, and Avg Pos can be read at a glance. Avg Position uses inverted
 * Y-axis semantically (lower number = better rank) but Chart.js renders
 * raw values; chart title clarifies "lower is better".
 */
export interface CompetitiveTrend {
  [siteSlug: string]: {
    weekLabels: string[]                   // newest-rightmost
    us: { top3: number[]; top10: number[]; avg_position: (number | null)[] }
    id: { top3: number[]; top10: number[]; avg_position: (number | null)[] }
  }
}

interface BuildOptions {
  payload:     FridayKpiPayload
  actionPlans: Array<{ brand: string; plan: ActionPlanItem[] }>
  /**
   * Sprint FRIDAY.KPI.PNG-UNSPLIT — optional historical data for the new
   * AI Visibility chart section. When omitted or empty, renderer falls back
   * to the existing summary table (or nothing if no data at all).
   */
  aiHistory?: AiVisibilityHistory
  /**
   * Sprint FRIDAY.KPI.HERO-HISTORICAL (336) — historical GSC clicks +
   * impressions for the new hero chart. When omitted/empty, renderer hides
   * the hero chart section entirely (no fallback bar chart now — bar chart
   * was replaced per Galih's spec; if no historical data is loadable the
   * report skips straight to the tables).
   */
  gscHistorical?: GscHistorical
  /**
   * Sprint FRIDAY.KPI.COMPETITIVE-TREND (341) — 12-week trend for Top 3 /
   * Top 10 / Avg Position. When omitted/empty, renderer hides the section.
   */
  competitiveTrend?: CompetitiveTrend
}

// Color tokens (kept in sync with app brand palette where it matters)
const COLORS = {
  bg:         '#0a0a0f',
  card:       '#10131c',
  cardSoft:   'rgba(20, 24, 36, 0.6)',
  border:     '#1f2433',
  borderSoft: 'rgba(31, 36, 51, 0.6)',
  text:       '#f5f5f7',
  muted:      '#7b818f',
  emerald:    '#34d399',
  red:        '#f87171',
  amber:      '#fbbf24',
  violet:     '#a78bfa',
  blue:       '#60a5fa',
  brandG2g:   '#a78bfa',
  brandOg:    '#34d399',
}

function fmtPct(v: number | null): string {
  if (v == null) return '—'
  if (Math.abs(v) < 0.1) return 'flat'
  return v > 0 ? `↑${v.toFixed(0)}%` : `↓${Math.abs(v).toFixed(0)}%`
}

function fmtSign(n: number): string {
  if (n === 0) return ''
  return n > 0 ? `(+${n})` : `(${n})`
}

function brandColor(slug: string): string {
  if (slug === 'g2g') return COLORS.brandG2g
  if (slug === 'offgamers') return COLORS.brandOg
  return COLORS.blue
}

function sourceLabel(src: string): string {
  switch (src) {
    case 'mimir':   return '🧠 Mimir'
    case 'forseti': return '⚖️ Forseti'
    case 'hugin':   return '🐦 Hugin'
    case 'loki':    return '🦊 Loki'
    case 'serp':    return '📉 SERP'
    default:        return src
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function competitiveSection(brands: BrandKpi[]): string {
  const rows = brands.flatMap(b => b.serp.map(m => `
    <tr>
      <td class="brand"><span class="dot" style="background:${brandColor(b.site_slug)}"></span>${b.site_slug.toUpperCase()}</td>
      <td>${m.market_label}</td>
      <td class="num">${m.kw_count}</td>
      <td class="num">${m.avg_position ?? '—'}</td>
      <td class="num ${(m.avg_pos_delta ?? 0) > 0 ? 'up' : (m.avg_pos_delta ?? 0) < 0 ? 'down' : 'flat'}">
        ${m.avg_pos_delta == null ? '—' : m.avg_pos_delta > 0 ? `↑${m.avg_pos_delta}` : m.avg_pos_delta < 0 ? `↓${Math.abs(m.avg_pos_delta)}` : '·'}
      </td>
      <td class="num">${m.top3} <span class="delta">${fmtSign(m.top3_delta)}</span></td>
      <td class="num">${m.top10} <span class="delta">${fmtSign(m.top10_delta)}</span></td>
    </tr>
  `)).join('')
  return `
    <section class="card">
      <h2>🥇 Most Competitive Keyword Rankings</h2>
      <table>
        <thead>
          <tr>
            <th>Brand</th><th>Market</th>
            <th class="num">KWs</th><th class="num">Avg Pos</th>
            <th class="num">Δ</th><th class="num">Top 3</th><th class="num">Top 10</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `
}

function trafficSection(brands: BrandKpi[]): string {
  const rows = brands.flatMap(b => b.traffic.map(t => `
    <tr>
      <td class="brand"><span class="dot" style="background:${brandColor(b.site_slug)}"></span>${b.site_slug.toUpperCase()}</td>
      <td>${t.market_label}</td>
      <td class="num">${t.clicks.toLocaleString()}</td>
      <td class="num ${(t.clicks_pct ?? 0) > 0 ? 'up' : (t.clicks_pct ?? 0) < 0 ? 'down' : 'flat'}">${fmtPct(t.clicks_pct)}</td>
      <td class="num">${t.impressions.toLocaleString()}</td>
      <td class="num ${(t.imp_pct ?? 0) > 0 ? 'up' : (t.imp_pct ?? 0) < 0 ? 'down' : 'flat'}">${fmtPct(t.imp_pct)}</td>
    </tr>
  `)).join('')
  return `
    <section class="card">
      <h2>📈 SEO Traffic — GSC clicks/impressions WoW</h2>
      <table>
        <thead>
          <tr>
            <th>Brand</th><th>Market</th>
            <th class="num">Clicks</th><th class="num">Δ%</th>
            <th class="num">Impressions</th><th class="num">Δ%</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="caption">Thu→Wed week vs prior Thu→Wed · ID = country=idn; US = all other countries.</p>
    </section>
  `
}

/**
 * Sprint FRIDAY.KPI.HERO-HISTORICAL (336) — hero historical chart section.
 *
 * Side-by-side line charts:
 *   • Left  → Clicks per week, 4 series (G2G-US, G2G-ID, OG-US, OG-ID)
 *   • Right → Impressions per week, same 4 series
 *
 * Replaces the prior current-week-only Top 3/Top 10 bars. Sibos's spec:
 * trend matters more than this-week snapshot — the W-o-W delta is already
 * visible in the table below. With 12 weeks of points the eye picks up
 * the slope (recovering vs decaying vs seasonal) at a glance.
 *
 * Each brand × market gets a distinct color/line style so the four lines
 * stay readable even when they cross.
 */
function heroHistoricalSection(history: GscHistorical): string {
  const brandSlugs = Object.keys(history).filter(slug => (history[slug]?.weekLabels?.length ?? 0) > 0)
  if (brandSlugs.length === 0) return ''

  // Use the longest weekLabel array as the x-axis (all brands should match
  // since loader uses the same windows — but defensive in case one brand
  // had a partial fetch).
  const labels = brandSlugs
    .map(s => history[s].weekLabels)
    .reduce((a, b) => (b.length > a.length ? b : a), [])

  // Build 4 series per metric: G2G-US (solid violet), G2G-ID (dashed violet),
  // OG-US (solid green), OG-ID (dashed green). Falls back to blue if a new
  // brand shows up unexpectedly.
  const series = brandSlugs.flatMap(slug => {
    const h     = history[slug]
    const color = brandColor(slug)
    const upper = slug.toUpperCase()
    return [
      { slug, market: 'us', label: `${upper} · US`, color, dash: [],     clicks: h.us.clicks, impressions: h.us.impressions },
      { slug, market: 'id', label: `${upper} · ID`, color, dash: [6, 4], clicks: h.id.clicks, impressions: h.id.impressions },
    ]
  })

  const weekCount = labels.length

  return `
    <section class="card">
      <h2>📈 Weekly Trend — Clicks &amp; Impressions (last ${weekCount} weeks)</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div><canvas id="chart-clicks-history" width="540" height="260"></canvas></div>
        <div><canvas id="chart-imps-history"   width="540" height="260"></canvas></div>
      </div>
      <p class="caption">GSC Thu→Wed weeks · solid line = US (country ≠ idn) · dashed line = ID (country = idn) · most recent week is the rightmost point and matches the WoW delta in the table below.</p>
      <script>
        window.__historicalData = {
          labels: ${JSON.stringify(labels)},
          series: ${JSON.stringify(series)},
        };
      </script>
    </section>
  `
}

/**
 * Sprint FRIDAY.KPI.COMPETITIVE-TREND (341) — 3 side-by-side line charts
 * showing the 12-week trend of cluster-winner ranking metrics:
 *   • Top 3 count   (higher = more keywords winning Top 3)
 *   • Top 10 count  (higher = more keywords on page 1)
 *   • Avg Position  (LOWER is better — title clarifies)
 *
 * 4 lines per chart: G2G-US (solid violet), G2G-ID (dashed violet),
 * OG-US (solid emerald), OG-ID (dashed emerald). Matches the hero
 * historical line styling so reader visual gymnastics are minimal.
 */
function competitiveTrendSection(trend: CompetitiveTrend): string {
  const brandSlugs = Object.keys(trend).filter(slug => (trend[slug]?.weekLabels?.length ?? 0) > 0)
  if (brandSlugs.length === 0) return ''

  const labels = brandSlugs
    .map(s => trend[s].weekLabels)
    .reduce((a, b) => (b.length > a.length ? b : a), [])

  const series = brandSlugs.flatMap(slug => {
    const t     = trend[slug]
    const color = brandColor(slug)
    const upper = slug.toUpperCase()
    return [
      { slug, market: 'us', label: `${upper} · US`, color, dash: [] as number[],     top3: t.us.top3, top10: t.us.top10, avg_position: t.us.avg_position },
      { slug, market: 'id', label: `${upper} · ID`, color, dash: [6, 4] as number[], top3: t.id.top3, top10: t.id.top10, avg_position: t.id.avg_position },
    ]
  })

  const weekCount = labels.length

  return `
    <section class="card">
      <h2>🥇 Most Competitive Keywords — Trend (last ${weekCount} weeks)</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;">
        <div><canvas id="chart-top3-trend"   width="360" height="220"></canvas></div>
        <div><canvas id="chart-top10-trend"  width="360" height="220"></canvas></div>
        <div><canvas id="chart-avgpos-trend" width="360" height="220"></canvas></div>
      </div>
      <p class="caption">Cluster winners only (top 3 keywords per cluster by competitive_score) — consistent with the Most Competitive table above. solid = US, dashed = ID. Avg Position chart: <strong>lower line = better rank</strong>.</p>
      <script>
        window.__competitiveTrendData = {
          labels: ${JSON.stringify(labels)},
          series: ${JSON.stringify(series)},
        };
      </script>
    </section>
  `
}

function aiVisibilitySection(payload: FridayKpiPayload): string {
  if (!payload.ai_visibility?.length) return ''
  const rows = payload.ai_visibility.map(a => {
    const top = a.top_sources?.[0]
    return `
    <tr>
      <td class="brand"><span class="dot" style="background:${brandColor(a.site_slug)}"></span>${a.site_slug.toUpperCase()}</td>
      <td class="num">${a.total_mentions ?? '—'}</td>
      <td class="num ${(a.mentions_wow_pct ?? 0) > 0 ? 'up' : (a.mentions_wow_pct ?? 0) < 0 ? 'down' : 'flat'}">${fmtPct(a.mentions_wow_pct)}</td>
      <td class="num">${a.total_citations ?? '—'}</td>
      <td class="num ${(a.citations_wow_pct ?? 0) > 0 ? 'up' : (a.citations_wow_pct ?? 0) < 0 ? 'down' : 'flat'}">${fmtPct(a.citations_wow_pct)}</td>
      <td>${top ? escapeHtml(top.label) : '—'}</td>
    </tr>
  `}).join('')
  return `
    <section class="card">
      <h2>🤖 AI Visibility</h2>
      <table>
        <thead><tr><th>Brand</th><th class="num">Mentions</th><th class="num">WoW</th><th class="num">Citations</th><th class="num">WoW</th><th>Top Source</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `
}

// Sprint FRIDAY.KPI.GRAPH.NO-FORSETI — Forseti section removed from PNG
// digest per Galih request (2026-05-22). Data still surfaced in /forseti
// page + action plan signal collector; just not rendered in the weekly PNG
// to keep the report focused on commercial metrics. Helper deleted to keep
// the file lean — recreate from git history if/when re-enabling.

/**
 * Sprint FRIDAY.KPI.PNG-UNSPLIT — AI Visibility historical chart.
 * Side-by-side line charts: Citations (left) + Cited Pages (right), each
 * with one line per brand colored by brandColor(). Drawn by the same
 * Chart.js script at the bottom of the HTML; data is stashed in
 * window.__aiHistoryData.
 */
function aiHistoryChartSection(history: AiVisibilityHistory, brands: string[]): string {
  // Build a unified date axis across all brands (sorted union).
  const allDates = Array.from(new Set(brands.flatMap(b => history[b]?.dates ?? []))).sort()
  // Per-brand series aligned to unified axis (null for missing days).
  const series = brands.map(slug => {
    const h = history[slug]
    if (!h) return { slug, citations: [] as (number | null)[], cited_pages: [] as (number | null)[] }
    const map = new Map<string, { c: number; p: number }>()
    h.dates.forEach((d, i) => map.set(d, { c: h.citations[i] ?? 0, p: h.cited_pages[i] ?? 0 }))
    return {
      slug,
      citations:   allDates.map(d => map.get(d)?.c ?? null),
      cited_pages: allDates.map(d => map.get(d)?.p ?? null),
    }
  })
  const totalDays = allDates.length

  return `
    <section class="card">
      <h2>🤖 AI Visibility — Bing AI Performance (last ${totalDays} days)</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div><canvas id="chart-ai-citations"   width="540" height="240"></canvas></div>
        <div><canvas id="chart-ai-cited-pages" width="540" height="240"></canvas></div>
      </div>
      <p class="caption">Daily counts from Bing Webmaster Tools · Citations = times brand was cited as source · Cited Pages = distinct URLs cited.</p>
      <script>
        window.__aiHistoryData = {
          labels:  ${JSON.stringify(allDates)},
          series:  ${JSON.stringify(series.map(s => ({
            slug:        s.slug,
            color:       brandColor(s.slug),
            citations:   s.citations,
            cited_pages: s.cited_pages,
          })))},
        };
      </script>
    </section>
  `
}

function actionPlanSection(plans: BuildOptions['actionPlans']): string {
  if (plans.length === 0) return ''
  const blocks = plans.map(p => {
    if (p.plan.length === 0) return ''
    const items = p.plan.map(it => `
      <li>
        <div class="num-circle ${it.is_manual ? 'manual' : 'auto'}">${it.index + 1}</div>
        <div class="action-body">
          <p>${escapeHtml(it.text)}</p>
          <div class="badges">
            ${it.is_manual ? '<span class="badge badge-manual">✎ manual override</span>' : ''}
            ${it.sources.map(s => `<span class="badge">${sourceLabel(s)}</span>`).join('')}
          </div>
        </div>
      </li>
    `).join('')
    return `
      <div class="brand-actions">
        <h3><span class="dot" style="background:${brandColor(p.brand)}"></span>${p.brand.toUpperCase()} — Action Plan for Next Week</h3>
        <ol>${items}</ol>
      </div>
    `
  }).join('')
  return `
    <section class="card">
      <h2>🎯 Action Plan</h2>
      ${blocks}
    </section>
  `
}

export function renderFridayKpiHtml(opts: BuildOptions): string {
  const { payload, actionPlans, aiHistory, gscHistorical, competitiveTrend } = opts
  const canonBadge = payload.canon_source === 'gsc'
    ? `<span class="canon-pill canon-gsc">GSC</span>`
    : `<span class="canon-pill canon-dfs">DFS</span>`
  const generatedAt = new Date(payload.generated_at).toLocaleString('en-US', {
    timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short',
  })

  // Sprint FRIDAY.KPI.PNG-UNSPLIT — does the AI history chart have data?
  const aiHistoryBrands = Object.keys(aiHistory ?? {})
    .filter(slug => (aiHistory?.[slug]?.dates?.length ?? 0) > 0)
  const showAiHistoryChart = aiHistoryBrands.length > 0

  // Sprint FRIDAY.KPI.HERO-HISTORICAL (336) — does the hero historical
  // chart have data? Empty = renderer skips hero section entirely.
  const heroHistoryBrands = Object.keys(gscHistorical ?? {})
    .filter(slug => (gscHistorical?.[slug]?.weekLabels?.length ?? 0) > 0)
  const showHeroHistorical = heroHistoryBrands.length > 0

  // Sprint FRIDAY.KPI.COMPETITIVE-TREND (341) — does the competitive
  // trend chart have data?
  const competitiveTrendBrands = Object.keys(competitiveTrend ?? {})
    .filter(slug => (competitiveTrend?.[slug]?.weekLabels?.length ?? 0) > 0)
  const showCompetitiveTrend = competitiveTrendBrands.length > 0

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Friday KPI · ${escapeHtml(payload.week_label)}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.6/dist/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 28px;
      width: 1280px;
      background: ${COLORS.bg};
      color: ${COLORS.text};
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    header {
      display: flex; justify-content: space-between; align-items: flex-start;
      margin-bottom: 20px; padding-bottom: 16px;
      border-bottom: 1px solid ${COLORS.border};
    }
    h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; }
    header .meta { font-size: 12px; color: ${COLORS.muted}; }
    .canon-pill {
      display: inline-block;
      font-size: 10px; font-weight: 600;
      padding: 2px 8px; border-radius: 5px; margin-left: 6px;
      border: 1px solid;
    }
    .canon-gsc { background: rgba(52, 211, 153, 0.12); color: ${COLORS.emerald}; border-color: rgba(52, 211, 153, 0.35); }
    .canon-dfs { background: rgba(251, 191, 36, 0.12); color: ${COLORS.amber}; border-color: rgba(251, 191, 36, 0.35); }
    .timestamp { text-align: right; font-size: 11px; color: ${COLORS.muted}; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .card {
      background: ${COLORS.card};
      border: 1px solid ${COLORS.border};
      border-radius: 12px; padding: 18px;
      margin-bottom: 16px;
    }
    .card h2 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
    .card h3 { margin: 16px 0 8px; font-size: 13px; font-weight: 600; color: ${COLORS.text}; display: flex; align-items: center; gap: 8px; }
    .card .caption { font-size: 10px; color: ${COLORS.muted}; font-style: italic; margin: 8px 0 0; }

    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; padding: 6px 10px; font-size: 10px; text-transform: uppercase; color: ${COLORS.muted}; font-weight: 500; background: rgba(0,0,0,0.2); }
    td { padding: 8px 10px; border-top: 1px solid ${COLORS.borderSoft}; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
    .up { color: ${COLORS.emerald}; }
    .down { color: ${COLORS.red}; }
    .flat { color: ${COLORS.muted}; }
    .delta { color: ${COLORS.muted}; font-size: 10px; }

    .brand-actions { margin-bottom: 18px; }
    .brand-actions:last-child { margin-bottom: 0; }
    ol { margin: 0; padding: 0; list-style: none; }
    ol li {
      display: flex; gap: 12px; align-items: flex-start;
      padding: 10px 12px; margin-bottom: 6px;
      background: ${COLORS.cardSoft};
      border: 1px solid ${COLORS.borderSoft};
      border-radius: 8px;
    }
    .num-circle {
      flex-shrink: 0;
      width: 26px; height: 26px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 700;
      border: 1px solid;
    }
    .num-circle.auto { background: rgba(52, 211, 153, 0.12); color: ${COLORS.emerald}; border-color: rgba(52, 211, 153, 0.35); }
    .num-circle.manual { background: rgba(251, 191, 36, 0.12); color: ${COLORS.amber}; border-color: rgba(251, 191, 36, 0.35); }
    .action-body { flex: 1; min-width: 0; }
    .action-body p { margin: 0 0 6px; font-size: 13px; line-height: 1.5; }
    .badges { display: flex; flex-wrap: wrap; gap: 5px; }
    .badge {
      font-size: 10px; font-weight: 500;
      padding: 2px 7px; border-radius: 4px;
      background: rgba(255,255,255,0.04);
      border: 1px solid ${COLORS.borderSoft};
      color: ${COLORS.muted};
    }
    .badge-manual { background: rgba(251, 191, 36, 0.1); color: ${COLORS.amber}; border-color: rgba(251, 191, 36, 0.35); }

    footer {
      margin-top: 18px; padding-top: 12px;
      border-top: 1px solid ${COLORS.border};
      font-size: 10px; color: ${COLORS.muted};
      display: flex; justify-content: space-between;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>📊 Weekly Report <span style="color:${COLORS.muted};font-weight:400;font-size:14px;">· ${escapeHtml(payload.week_label)}</span></h1>
      <div class="meta">
        Canon source ${canonBadge}
        · ${payload.brands.length} brand${payload.brands.length === 1 ? '' : 's'}
        · ISO week ${payload.iso_week}
      </div>
    </div>
    <div class="timestamp">
      Generated<br />
      <strong style="color:${COLORS.text};">${escapeHtml(generatedAt)} WIB</strong>
    </div>
  </header>

  ${showHeroHistorical ? heroHistoricalSection(gscHistorical!) : ''}

  <div class="grid">
    ${competitiveSection(payload.brands)}
    ${trafficSection(payload.brands)}
  </div>

  ${showCompetitiveTrend ? competitiveTrendSection(competitiveTrend!) : ''}

  ${aiVisibilitySection(payload)}

  ${showAiHistoryChart ? aiHistoryChartSection(aiHistory!, aiHistoryBrands) : ''}

  ${actionPlanSection(actionPlans)}

  <footer>
    <span>🎯 ${escapeHtml(payload.methodology_url)}</span>
    <span>📊 ${escapeHtml(payload.priority_url)}</span>
  </footer>

  <script>
    // Sprint FRIDAY.KPI.HERO-HISTORICAL (336) — render two historical line
    // charts (Clicks + Impressions, 4 series each: G2G-US, G2G-ID, OG-US,
    // OG-ID) as the new hero. Replaces the prior Top 3 / Top 10 WoW-delta
    // bar visualization. The W-o-W delta is still visible in the
    // competitive + traffic tables further down the report.
    //
    // AI Visibility historical (Bing AI citations + cited pages) is
    // independent of the hero chart and still drawn when its canvas exists.
    (function () {
      const clicksEl    = document.getElementById('chart-clicks-history');
      const impsEl      = document.getElementById('chart-imps-history');
      const aiCitEl     = document.getElementById('chart-ai-citations');
      const aiPagesEl   = document.getElementById('chart-ai-cited-pages');
      const top3TrendEl   = document.getElementById('chart-top3-trend');
      const top10TrendEl  = document.getElementById('chart-top10-trend');
      const avgPosTrendEl = document.getElementById('chart-avgpos-trend');

      // Compact number formatter for axis ticks and legend.
      function fmtCompact(n) {
        if (n == null) return '';
        const abs = Math.abs(n);
        if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return String(n);
      }

      // ── Hero historical line charts ───────────────────────────────────
      function renderHero() {
        const d = window.__historicalData;
        if (!d || !clicksEl || !impsEl) return;
        const buildLineConfig = (yKey, title) => ({
          type: 'line',
          data: {
            labels: d.labels,
            datasets: d.series.map(s => ({
              label:           s.label,
              data:            s[yKey],
              borderColor:     s.color,
              backgroundColor: s.color,
              borderDash:      Array.isArray(s.dash) && s.dash.length > 0 ? s.dash : undefined,
              pointRadius:     2,
              pointHoverRadius:4,
              borderWidth:     2,
              tension:         0.25,
              spanGaps:        true,
            })),
          },
          options: {
            responsive: false,
            animation:  false,
            plugins: {
              legend: {
                display: true,
                position: 'bottom',
                labels: { color: '${COLORS.text}', font: { size: 10 }, boxWidth: 14, padding: 8 },
              },
              title:  { display: true, text: title, color: '${COLORS.text}', font: { size: 12, weight: '600' } },
            },
            scales: {
              x: {
                ticks: { color: '${COLORS.muted}', font: { size: 9 }, maxTicksLimit: 8, autoSkip: true },
                grid:  { color: '${COLORS.borderSoft}' },
              },
              y: {
                ticks: { color: '${COLORS.muted}', font: { size: 10 }, callback: v => fmtCompact(v) },
                grid:  { color: '${COLORS.borderSoft}' },
                beginAtZero: true,
              },
            },
          },
        });
        new Chart(clicksEl.getContext('2d'), buildLineConfig('clicks',      'Clicks / week'));
        new Chart(impsEl.getContext('2d'),   buildLineConfig('impressions', 'Impressions / week'));
      }
      renderHero();

      // ── Competitive trend (Top 3 / Top 10 / Avg Position) ───────────────
      function renderCompetitiveTrend() {
        const d = window.__competitiveTrendData;
        if (!d || !top3TrendEl || !top10TrendEl || !avgPosTrendEl) return;
        const buildLineConfig = (yKey, title, opts) => ({
          type: 'line',
          data: {
            labels: d.labels,
            datasets: d.series.map(s => ({
              label:           s.label,
              data:            s[yKey],
              borderColor:     s.color,
              backgroundColor: s.color,
              borderDash:      Array.isArray(s.dash) && s.dash.length > 0 ? s.dash : undefined,
              pointRadius:     2,
              pointHoverRadius:4,
              borderWidth:     2,
              tension:         0.25,
              spanGaps:        true,
            })),
          },
          options: {
            responsive: false,
            animation:  false,
            plugins: {
              legend: { display: true, position: 'bottom', labels: { color: '${COLORS.text}', font: { size: 9 }, boxWidth: 10, padding: 6 } },
              title:  { display: true, text: title, color: '${COLORS.text}', font: { size: 11, weight: '600' } },
            },
            scales: {
              x: {
                ticks: { color: '${COLORS.muted}', font: { size: 8 }, maxTicksLimit: 6, autoSkip: true },
                grid:  { color: '${COLORS.borderSoft}' },
              },
              y: {
                ticks: { color: '${COLORS.muted}', font: { size: 9 }, callback: v => fmtCompact(v) },
                grid:  { color: '${COLORS.borderSoft}' },
                beginAtZero: opts && opts.beginAtZero === false ? false : true,
                reverse:     opts && opts.reverse === true,
              },
            },
          },
        });
        new Chart(top3TrendEl.getContext('2d'),   buildLineConfig('top3',         'Top 3 count'));
        new Chart(top10TrendEl.getContext('2d'),  buildLineConfig('top10',        'Top 10 count'));
        new Chart(avgPosTrendEl.getContext('2d'), buildLineConfig('avg_position', 'Avg Position (lower = better)', { beginAtZero: false, reverse: true }));
      }
      renderCompetitiveTrend();

      // ── AI Visibility historical line charts (unchanged) ──
      function renderAiHistory() {
        const d = window.__aiHistoryData;
        if (!d || !aiCitEl || !aiPagesEl) return;
        const buildLineConfig = (yKey, title) => ({
          type: 'line',
          data: {
            labels: d.labels,
            datasets: d.series.map(s => ({
              label:           s.slug.toUpperCase(),
              data:            s[yKey],
              borderColor:     s.color,
              backgroundColor: s.color,
              pointRadius:     0,
              pointHoverRadius:3,
              borderWidth:     2,
              tension:         0.25,
              spanGaps:        true,
            })),
          },
          options: {
            responsive: false,
            animation:  false,
            plugins: {
              legend: { display: true, labels: { color: '${COLORS.text}', font: { size: 10 }, boxWidth: 12 } },
              title:  { display: true, text: title, color: '${COLORS.text}', font: { size: 12 } },
            },
            scales: {
              x: {
                ticks: {
                  color: '${COLORS.muted}', font: { size: 9 },
                  maxTicksLimit: 6, autoSkip: true,
                },
                grid: { color: '${COLORS.borderSoft}' },
              },
              y: {
                ticks: { color: '${COLORS.muted}', font: { size: 10 } },
                grid:  { color: '${COLORS.borderSoft}' },
                beginAtZero: true,
              },
            },
          },
        });
        new Chart(aiCitEl.getContext('2d'),   buildLineConfig('citations',   'Citations / day'));
        new Chart(aiPagesEl.getContext('2d'), buildLineConfig('cited_pages', 'Cited pages / day'));
      }
      renderAiHistory();

      // give Chart.js one frame to paint, then signal ready for puppeteer
      requestAnimationFrame(() => requestAnimationFrame(() => { window.kpiReady = true; }));
    })();
  </script>
</body>
</html>`
}
