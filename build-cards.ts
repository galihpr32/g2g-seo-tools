import { buildMonthlyReportPptx } from './src/lib/reports/pptx-builder'
import { writeFileSync, readFileSync } from 'node:fs'

const sample = JSON.parse(readFileSync('/sessions/nifty-gracious-mayer/mnt/outputs/april-2026-real.json', 'utf-8'))

// Hand-authored highlights for stakeholder slide.
// Distilled from the full AI narrative — 6 cards in priority order.
sample.narrativeHighlights = [
  {
    icon: '⚠️',
    headline: 'GSC ↔ GA4 divergence is the #1 priority',
    body: 'Search clicks +1% but organic sessions –14%. Measurement layer is unreliable until this is diagnosed — every conversion + revenue insight is suspect.',
    trend: 'warning',
  },
  {
    icon: '💰',
    headline: 'Revenue dropped $3.3M — biggest single-month decline',
    body: 'GA4 revenue $19.7M → $16.4M (–17%). Conversion value held better (–4%) than sessions (–14%) — fewer sessions reaching checkout, mid-funnel friction or traffic-mix shift.',
    trend: 'down',
  },
  {
    icon: '📉',
    headline: 'Quality slipped despite click growth',
    body: 'CTR 9.93% → 9.03% and avg. position drifted to 6.7. Indexing more queries but in weaker positions — likely diluted by lower-intent emerging categories.',
    trend: 'down',
  },
  {
    icon: '🚀',
    headline: 'AI accounts dominated gains',
    body: 'Claude Accounts +6.4K clicks, ChatGPT Accounts +4.5K, Valorant Accounts +4.7K. Earlier content bets are paying off — double down with CRO + supply.',
    trend: 'up',
  },
  {
    icon: '🩸',
    headline: 'Legacy categories hemorrhaging traffic',
    body: 'Homepage –72K clicks, WoW Classic Gold –8.7K, Diablo 2 Items –5.8K, PoE Currency –5.8K. Seasonal cycles + Eldorado/PlayerAuctions/G2A pressure. Defend before May.',
    trend: 'down',
  },
  {
    icon: '🛠️',
    headline: 'Tooling failure: SEMrush returned all zeros',
    body: 'No competitive ranking benchmarks captured this month. Not a real ranking wipeout — API/integration broken. Restore before May report.',
    trend: 'warning',
  },
]

// Hand-authored action plan cards — 7 prioritized items with category tags.
sample.actionItems = [
  {
    priority: 'P0',
    category: 'Foundation',
    title: 'Diagnose GSC vs GA4 session gap',
    body: 'Audit GA4 tag firing, consent-mode, referral exclusions, bot filtering. Every revenue insight is unreliable until the measurement layer is fixed.',
  },
  {
    priority: 'P0',
    category: 'Foundation',
    title: 'Restore SEMrush tracking',
    body: 'Reconnect API integration, re-verify tracked keyword list, backfill April where possible. Competitive benchmarking must be live for May review.',
  },
  {
    priority: 'P1',
    category: 'Growth',
    title: 'Launch CR Cards category page',
    body: 'Loki found a 1M-search-volume gap with PlayerAuctions at #8 and zero G2G presence. Build category + buyer-guide brief in 30 days.',
  },
  {
    priority: 'P1',
    category: 'Defense',
    title: 'Refresh declining legacy pages',
    body: 'On-page refreshes for WoW Classic Gold, Diablo 2 Items, PoE Currency, Rocket League. These four lost 22.7K clicks combined.',
  },
  {
    priority: 'P0',
    category: 'Defense',
    title: 'Investigate /offers/sell –90% drop',
    body: 'Heimdall flagged a 294-click loss on the seller-side funnel. If sellers can\'t list, buyer supply collapses and conversions follow. Diagnose immediately.',
  },
  {
    priority: 'P1',
    category: 'Velocity',
    title: 'Clear the 18-item execution backlog',
    body: 'Only 4 of 22 action items completed (18% rate). Triage by revenue impact, assign weekly owners, tune Vor\'s threshold to cut the 90% rejection rate.',
  },
  {
    priority: 'P2',
    category: 'Growth',
    title: 'Optimize CRO on AI account categories',
    body: 'Claude / ChatGPT / Valorant Accounts driving traffic but likely converting below average. Add trust signals, streamline add-to-cart, surface seller ratings.',
  },
]

;(async () => {
  const buf = await buildMonthlyReportPptx(sample)
  const out = '/sessions/nifty-gracious-mayer/mnt/g2g-seo-tools/G2G-Monthly-Report-April-2026.pptx'
  writeFileSync(out, buf)
  console.log('OK', buf.length, 'bytes →', out)
})().catch(e => { console.error('FAIL:', e); process.exit(1) })
