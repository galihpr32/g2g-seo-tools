// ── Friday KPI HTML renderer ───────────────────────────────────────────────
//
// Sprint FRIDAY.KPI.GRAPH.4 — pure string-based HTML template that the
// puppeteer renderer loads via setContent(). No Tailwind, no React, no Next.
// Everything inline so puppeteer doesn't have to wait on network bundles.
// Chart.js is the only external dep (CDN) and we wait for `window.kpiReady`
// before screenshotting.

import type { FridayKpiPayload, BrandKpi } from './friday-kpi'
import type { ActionPlanItem } from './action-plan-synthesizer'

interface BuildOptions {
  payload:     FridayKpiPayload
  actionPlans: Array<{ brand: string; plan: ActionPlanItem[] }>
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
  // Build chart data: 1 group per brand × market, bars = clicks & impressions
  // Impressions divided by 100 to keep visually comparable next to clicks
  const labels = brands.flatMap(b => b.traffic.map(t => `${b.site_slug.toUpperCase()} · ${t.market_label}`))
  const clicks = brands.flatMap(b => b.traffic.map(t => t.clicks))
  const impressions = brands.flatMap(b => b.traffic.map(t => t.impressions))
  const colors = brands.flatMap(b => b.traffic.map(() => brandColor(b.site_slug)))
  return `
    <section class="card">
      <h2>📊 This Week — GSC Clicks & Impressions</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div><canvas id="chart-clicks" width="540" height="240"></canvas></div>
        <div><canvas id="chart-impressions" width="540" height="240"></canvas></div>
      </div>
      <script>
        window.__chartData = {
          labels: ${JSON.stringify(labels)},
          clicks: ${JSON.stringify(clicks)},
          impressions: ${JSON.stringify(impressions)},
          colors: ${JSON.stringify(colors)},
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

function forsetiSection(payload: FridayKpiPayload): string {
  if (!payload.forseti?.length) return ''
  const rows = payload.forseti.map(f => `
    <tr>
      <td class="brand"><span class="dot" style="background:${brandColor(f.site_slug)}"></span>${f.site_slug.toUpperCase()}</td>
      <td class="num">${f.spotted_this_week}</td>
      <td class="num">${f.responded}</td>
      <td class="num">${f.response_rate_pct}%</td>
      <td class="num ${f.sev4plus_pending > 0 ? 'down' : 'up'}">${f.sev4plus_pending}</td>
    </tr>
  `).join('')
  return `
    <section class="card">
      <h2>⚖️ Forseti — Community Response</h2>
      <table>
        <thead>
          <tr><th>Brand</th><th class="num">Spotted</th><th class="num">Responded</th><th class="num">Rate</th><th class="num">Sev-4+ Pending</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
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
  const { payload, actionPlans } = opts
  const canonBadge = payload.canon_source === 'gsc'
    ? `<span class="canon-pill canon-gsc">GSC</span>`
    : `<span class="canon-pill canon-dfs">DFS</span>`
  const generatedAt = new Date(payload.generated_at).toLocaleString('en-US', {
    timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short',
  })

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
      <h1>📊 Friday KPI Digest <span style="color:${COLORS.muted};font-weight:400;font-size:14px;">· ${escapeHtml(payload.week_label)}</span></h1>
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
  ${forsetiSection(payload)}

  ${actionPlanSection(actionPlans)}

  <footer>
    <span>🎯 ${escapeHtml(payload.methodology_url)}</span>
    <span>📊 ${escapeHtml(payload.priority_url)}</span>
  </footer>

  <script>
    // Render charts then flag ready so puppeteer screenshots after paint.
    (function () {
      const d = window.__chartData || { labels: [], clicks: [], impressions: [], colors: [] };
      const common = {
        type: 'bar',
        options: {
          responsive: false,
          animation: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '${COLORS.muted}', font: { size: 10 } }, grid: { color: '${COLORS.borderSoft}' } },
            y: { ticks: { color: '${COLORS.muted}', font: { size: 10 } }, grid: { color: '${COLORS.borderSoft}' }, beginAtZero: true },
          },
        },
      };
      new Chart(document.getElementById('chart-clicks').getContext('2d'), {
        ...common,
        data: { labels: d.labels, datasets: [{ label: 'Clicks', data: d.clicks, backgroundColor: d.colors, borderRadius: 4 }] },
        options: { ...common.options, plugins: { ...common.options.plugins, title: { display: true, text: 'Clicks (this week)', color: '${COLORS.text}', font: { size: 12 } } } },
      });
      new Chart(document.getElementById('chart-impressions').getContext('2d'), {
        ...common,
        data: { labels: d.labels, datasets: [{ label: 'Impressions', data: d.impressions, backgroundColor: d.colors, borderRadius: 4 }] },
        options: { ...common.options, plugins: { ...common.options.plugins, title: { display: true, text: 'Impressions (this week)', color: '${COLORS.text}', font: { size: 12 } } } },
      });
      // give Chart.js one frame to paint, then signal ready
      requestAnimationFrame(() => requestAnimationFrame(() => { window.kpiReady = true; }));
    })();
  </script>
</body>
</html>`
}
