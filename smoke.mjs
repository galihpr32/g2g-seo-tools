import { renderFridayKpiHtml } from './src/lib/reports/friday-kpi-html.ts'

const payload = {
  week_label: 'Week of May 18, 2026',
  iso_week: 21,
  generated_at: new Date().toISOString(),
  brands: [
    { site_slug: 'g2g',
      serp: [
        { market: 'us', market_label: 'Global', kw_count: 12, avg_position: 5.4, avg_pos_delta: 0.3, top3: 4, top3_delta: 1, top10: 9, top10_delta: 2, coverage_total: 14, coverage_with_winner: 12 },
        { market: 'id', market_label: 'ID', kw_count: 8, avg_position: 3.1, avg_pos_delta: -0.2, top3: 5, top3_delta: 0, top10: 7, top10_delta: -1, coverage_total: 10, coverage_with_winner: 9 } ],
      traffic: [
        { market: 'us', market_label: 'Global', clicks: 12000, clicks_pct: 12.5, impressions: 250000, imp_pct: 8.4 },
        { market: 'id', market_label: 'ID', clicks: 8500, clicks_pct: -3.1, impressions: 180000, imp_pct: 4.2 } ] },
    { site_slug: 'offgamers',
      serp: [
        { market: 'us', market_label: 'Global', kw_count: 6, avg_position: 8.2, avg_pos_delta: 1.5, top3: 1, top3_delta: 0, top10: 4, top10_delta: 1, coverage_total: 8, coverage_with_winner: 6 },
        { market: 'id', market_label: 'ID', kw_count: 4, avg_position: 6.0, avg_pos_delta: 0.0, top3: 1, top3_delta: 1, top10: 3, top10_delta: 0, coverage_total: 5, coverage_with_winner: 4 } ],
      traffic: [
        { market: 'us', market_label: 'Global', clicks: 4200, clicks_pct: 25.0, impressions: 88000, imp_pct: 18.0 },
        { market: 'id', market_label: 'ID', clicks: 1800, clicks_pct: 0, impressions: 32000, imp_pct: -2.0 } ] } ],
  public_url: 'https://example.com/reports/weekly',
  methodology_url: 'https://example.com/methodology/competitive-keywords',
  priority_url: 'https://example.com/priority-products',
  ai_visibility: [], ai_visibility_url: 'https://example.com/reports/ai-visibility',
  forseti: [], forseti_url: 'https://example.com/forseti',
  canon_source: 'gsc',
}
const actionPlans = [
  { brand: 'g2g', plan: [
    { index: 0, text: 'Forseti flagged a sev-4 thread on r/Genshin_Impact about account suspension — draft a public response by Tuesday.', sources: ['forseti'], is_manual: false },
    { index: 1, text: 'Hugin found "cheap valorant points" growing 180% MoM — claim it.', sources: ['hugin','serp'], is_manual: false },
    { index: 2, text: 'Manual override: reach out to Aion 2 cluster owners.', sources: [], is_manual: true } ] },
  { brand: 'offgamers', plan: [
    { index: 0, text: 'SERP movers: Steam gift card US dropped 4 positions.', sources: ['serp'], is_manual: false } ] },
]
const html = renderFridayKpiHtml({ payload, actionPlans })
console.log('HTML length:', html.length)
console.log('Has chart-clicks canvas:', html.includes('id="chart-clicks"'))
console.log('Has action plan section:', html.includes('🎯 Action Plan'))
console.log('Has canon GSC pill:', html.includes('canon-gsc'))
console.log('Has G2G brand color:', html.includes('#a78bfa'))
console.log('Has Forseti badge:', html.includes('⚖️ Forseti'))
console.log('Has manual override:', html.includes('manual override'))
