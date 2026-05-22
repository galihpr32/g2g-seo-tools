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

interface BuildOptions {
  payload:     FridayKpiPayload
  actionPlans: Array<{ brand: string; plan: ActionPlanItem[] }>
  /**
   * Sprint FRIDAY.KPI.PNG-UNSPLIT — optional historical data for the new
   * AI Visibility chart section. When omitted or empty, renderer falls back
   * to the existing summary table (or nothing if no data at all).
   */
  aiHistory?: AiVisibilityHistory
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
      <p class="caption">Last 7 days vs prior 7 days (3-day GSC freshness lag) · ID = country=idn; Global = all other countries.</p>
    </section>
  `
}

function chartSection(brands: BrandKpi[]): string {
  // Sprint FRIDAY.KPI.PNG-CHART-SWAP (314) ─────────────────────────────────
  // Replaces the prior Clicks/Impressions bars with Top 3 + Top 10 keyword
  // count bars per brand × market, each annotated with WoW delta (+/-).
  // Rationale: ranking position counts are the truer "did we win this week"
  // signal for a competitive-keywords-first weekly report. Clicks/imp data
  // is still in the traffic table further down the report.
  const labels = brands.flatMap(b =>
    b.serp.map(m => `${b.site_slug.toUpperCase()} · ${m.market_label}`),
  )
  const top3        = brands.flatMap(b => b.serp.map(m => m.top3))
  const top3Delta   = brands.flatMap(b => b.serp.map(m => m.top3_delta))
  const top10       = brands.flatMap(b => b.serp.map(m => m.top10))
  const top10Delta  = brands.flatMap(b => b.serp.map(m => m.top10_delta))
  const colors      = brands.flatMap(b => b.serp.map(() => brandColor(b.site_slug)))
  return `
    <section class="card">
      <h2>📊 This Week — Top 3 &amp; Top 10 Rank Count (WoW Δ)</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div><canvas id="chart-top3" width="540" height="240"></canvas></div>
        <div><canvas id="chart-top10" width="540" height="240"></canvas></div>
      </div>
      <p class="caption">Bars = current week count of keywords ranking in Top 3 / Top 10. Labels above bars show change vs prior week.</p>
      <script>
        window.__chartData = {
          labels:     ${JSON.stringify(labels)},
          top3:       ${JSON.stringify(top3)},
          top3Delta:  ${JSON.stringify(top3Delta)},
          top10:      ${JSON.stringify(top10)},
          top10Delta: ${JSON.stringify(top10Delta)},
          colors:     ${JSON.stringify(colors)},
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
  const { payload, actionPlans, aiHistory } = opts
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

  ${chartSection(payload.brands)}

  <div class="grid">
    ${competitiveSection(payload.brands)}
    ${trafficSection(payload.brands)}
  </div>

  ${aiVisibilitySection(payload)}

  ${showAiHistoryChart ? aiHistoryChartSection(aiHistory!, aiHistoryBrands) : ''}

  ${actionPlanSection(actionPlans)}

  <footer>
    <span>🎯 ${escapeHtml(payload.methodology_url)}</span>
    <span>📊 ${escapeHtml(payload.priority_url)}</span>
  </footer>

  <script>
    // Sprint FRIDAY.KPI.PNG-CHART-SWAP (314) — render Top 3 / Top 10 bars
    // with WoW delta tags drawn ABOVE each bar. Custom plugin handles the
    // delta annotations so we don't have to pull in chartjs-plugin-datalabels.
    //
    // Sprint FRIDAY.KPI.PNG-SPLIT (319) — when the chart canvases aren't on
    // the page (ai / actions modes), short-circuit and signal kpiReady so
    // puppeteer can screenshot without waiting on Chart.js.
    (function () {
      const top3El      = document.getElementById('chart-top3');
      const top10El     = document.getElementById('chart-top10');
      const aiCitEl     = document.getElementById('chart-ai-citations');
      const aiPagesEl   = document.getElementById('chart-ai-cited-pages');

      // ── AI Visibility historical line charts (independent of top3/top10) ──
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

      if (!top3El || !top10El) {
        requestAnimationFrame(() => requestAnimationFrame(() => { window.kpiReady = true; }));
        return;
      }
      const d = window.__chartData || { labels: [], top3: [], top3Delta: [], top10: [], top10Delta: [], colors: [] };

      function fmtDelta(v) {
        if (v == null || v === 0) return '·';
        return v > 0 ? '+' + v : String(v);
      }
      function deltaColor(v) {
        if (v == null || v === 0) return '${COLORS.muted}';
        return v > 0 ? '${COLORS.emerald}' : '${COLORS.red}';
      }

      // Custom plugin: draw delta text above each bar in the dataset.
      const deltaLabelPlugin = (deltas) => ({
        id: 'deltaLabel-' + Math.random().toString(36).slice(2),
        afterDatasetsDraw(chart) {
          const { ctx } = chart;
          const meta = chart.getDatasetMeta(0);
          ctx.save();
          ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          meta.data.forEach((bar, i) => {
            const v = deltas[i];
            ctx.fillStyle = deltaColor(v);
            ctx.fillText(fmtDelta(v), bar.x, bar.y - 4);
          });
          ctx.restore();
        },
      });

      const common = {
        type: 'bar',
        options: {
          responsive: false,
          animation: false,
          layout: { padding: { top: 20 } },
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '${COLORS.muted}', font: { size: 10 } }, grid: { color: '${COLORS.borderSoft}' } },
            y: { ticks: { color: '${COLORS.muted}', font: { size: 10 } }, grid: { color: '${COLORS.borderSoft}' }, beginAtZero: true, precision: 0 },
          },
        },
      };

      new Chart(top3El.getContext('2d'), {
        ...common,
        data: { labels: d.labels, datasets: [{ label: 'Top 3', data: d.top3, backgroundColor: d.colors, borderRadius: 4 }] },
        options: {
          ...common.options,
          plugins: {
            ...common.options.plugins,
            title: { display: true, text: 'Top 3 keyword count (Δ vs last week)', color: '${COLORS.text}', font: { size: 12 } },
          },
        },
        plugins: [deltaLabelPlugin(d.top3Delta)],
      });
      new Chart(top10El.getContext('2d'), {
        ...common,
        data: { labels: d.labels, datasets: [{ label: 'Top 10', data: d.top10, backgroundColor: d.colors, borderRadius: 4 }] },
        options: {
          ...common.options,
          plugins: {
            ...common.options.plugins,
            title: { display: true, text: 'Top 10 keyword count (Δ vs last week)', color: '${COLORS.text}', font: { size: 12 } },
          },
        },
        plugins: [deltaLabelPlugin(d.top10Delta)],
      });

      // give Chart.js one frame to paint, then signal ready
      requestAnimationFrame(() => requestAnimationFrame(() => { window.kpiReady = true; }));
    })();
  </script>
</body>
</html>`
}
