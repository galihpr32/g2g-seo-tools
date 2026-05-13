import { buildMonthlyReportPptx } from './src/lib/reports/pptx-builder'
import { writeFileSync, readFileSync } from 'node:fs'

const sample = JSON.parse(readFileSync('/sessions/nifty-gracious-mayer/mnt/outputs/og-april-2026.json', 'utf-8'))

// Brand theme — OffGamers blue.
//   accent  = sky-500   (#0EA5E9) — primary brand color, used on cards/strips/badges
//   accent2 = sky-300   (#7DD3FC) — chart highlights, secondary lines
sample.theme = { accent: '0EA5E9', accent2: '7DD3FC' }

sample.narrativeHighlights = [
  { icon: '💰', headline: 'Revenue dropped 44% — biggest single-month decline',
    body: 'GA4 revenue $7.4M → $4.1M (–$3.3M). Outpaces the 8% session decline + 11% conversion drop. Product-mix shift toward lower-AOV items + loss of high-value transactional traffic.',
    trend: 'down' },
  { icon: '🩸', headline: 'Homepage hemorrhaging — −5,974 clicks alone',
    body: 'Drives almost the entire traffic decline (–14% total). Single point-of-failure. Diagnose SERP feature displacement, branded query trends, algorithm volatility before May.',
    trend: 'down' },
  { icon: '⚠️', headline: 'SEMrush tracking blackout for the entire month',
    body: 'Zero tracked keywords, zero competitor data, zero SoV. Tooling failure — not a ranking wipeout. Must restore before May or we are flying blind for a second month.',
    trend: 'warning' },
  { icon: '📈', headline: 'CTR jumped 37% — quality of visibility improved',
    body: '3.4% → 4.67%. Avg. position held at 8.2. Where we appear, we now click better — likely title-tag wins or SERP-feature captures. Lone bright spot in the GSC numbers.',
    trend: 'up' },
  { icon: '🚀', headline: 'Fintech / regional payment cards dominated gains',
    body: "Touch 'n Go +181 clicks, Binance +95, Tango Coins +86, Razer Gold +74, Venmo +67. Category-expansion bet paying off — double down with topical authority + internal linking.",
    trend: 'up' },
  { icon: '🔧', headline: 'Indexation + cannibalization issues bleeding traffic',
    body: '/sso/login page picking up 62 organic clicks (should be noindexed). /id/ Binance –306 clicks while root Binance +95 — hreflang or duplicate-content cannibalization.',
    trend: 'warning' },
]

sample.actionItems = [
  { priority: 'P0', category: 'Foundation', title: 'Restore SEMrush tracking',
    body: 'Audit + reconfigure the integration. Re-verify tracked keywords and competitor list. Backfill April data where possible. May reporting depends on this.' },
  { priority: 'P0', category: 'Defense', title: 'Diagnose homepage −5,974 click collapse',
    body: 'Deep-dive GSC query-level data. Cross-reference Google update timeline + SERP feature changes (AI Overviews, shopping carousels) + branded search trends.' },
  { priority: 'P0', category: 'Defense', title: 'Recover high-revenue product pages',
    body: 'PS Store (–369), CoD Mobile (–205), OnlyFans (–208). Audit technical/content/competitive. Refresh on-page with updated pricing, FAQs, comparisons. Combined ~782 clicks lost.' },
  { priority: 'P1', category: 'Foundation', title: 'Fix SSO indexation + /id/ cannibalization',
    body: 'Apply noindex to /sso/login (62 clicks leaking to a non-content page). Audit /id/ Binance vs root Binance hreflang — they are cannibalizing each other (−306 vs +95).' },
  { priority: 'P1', category: 'Growth', title: "Double down on fintech & regional payment winners",
    body: "Touch 'n Go, Binance, Tango Coins, Razer Gold, Venmo. Build buying guides, comparison pages, FAQ schema. Topical authority + internal linking around the gaining cluster." },
  { priority: 'P1', category: 'Velocity', title: 'Launch backlink acquisition campaign',
    body: 'April: zero new backlinks. Target 8–12 quality placements in May focused on top 10 revenue pages. Gift card roundups, gaming press, fintech blogs.' },
]

;(async () => {
  const buf = await buildMonthlyReportPptx(sample)
  const out = '/sessions/nifty-gracious-mayer/mnt/g2g-seo-tools/OffGamers-Monthly-Report-April-2026.pptx'
  writeFileSync(out, buf)
  console.log('OK', buf.length, 'bytes →', out)
})().catch(e => { console.error('FAIL:', e); process.exit(1) })
