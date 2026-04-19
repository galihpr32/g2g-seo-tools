export interface SlackBlock {
  type: string
  [key: string]: unknown
}

async function sendSlackMessage(blocks: SlackBlock[], text: string) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl || webhookUrl === 'placeholder') return false

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, blocks }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function sendRankingDropAlert(drops: {
  page: string
  clicksDrop: number
  impressionsDrop: number
  positionChange: number
  currentClicks: number
  previousClicks: number
}[]) {
  if (drops.length === 0) return

  const rows = drops.slice(0, 10).map(d =>
    `• *${new URL(d.page).pathname}* — Clicks ↓${Math.round(d.clicksDrop * 100)}% | Position ${d.positionChange > 0 ? '+' : ''}${d.positionChange.toFixed(1)}`
  ).join('\n')

  return sendSlackMessage([
    {
      type: 'header',
      text: { type: 'plain_text', text: '📉 GSC Clicks Drop Alert' }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${drops.length} page(s) dropped >15% clicks WoW*\n${rows}`
      }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `G2G SEO Tools · ${new Date().toLocaleDateString('en-GB')}` }]
    }
  ], `📉 ${drops.length} pages lost >15% clicks WoW`)
}

export async function sendIndexCoverageAlert(data: {
  indexedPages: number
  previousIndexed: number
  errors: number
  previousErrors: number
}) {
  const indexDrop = data.previousIndexed - data.indexedPages
  const newErrors = data.errors - data.previousErrors

  if (indexDrop < 50 && newErrors <= 0) return

  const lines = []
  if (indexDrop >= 50) lines.push(`• Indexed pages dropped by *${indexDrop}* (${data.previousIndexed} → ${data.indexedPages})`)
  if (newErrors > 0) lines.push(`• *${newErrors}* new crawl errors detected (total: ${data.errors})`)

  return sendSlackMessage([
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔍 GSC Index Coverage Alert' }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `G2G SEO Tools · ${new Date().toLocaleDateString('en-GB')}` }]
    }
  ], `🔍 GSC Index Coverage issue detected`)
}

export async function sendCWVAlert(degradations: {
  origin: string
  metric: string
  current: number
  previous: number
}[]) {
  if (degradations.length === 0) return

  const rows = degradations.map(d =>
    `• *${d.metric}* on ${d.origin} — Poor: ${Math.round(d.previous * 100)}% → ${Math.round(d.current * 100)}%`
  ).join('\n')

  return sendSlackMessage([
    {
      type: 'header',
      text: { type: 'plain_text', text: '⚡ Core Web Vitals Degradation' }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${degradations.length} metric(s) degraded beyond threshold*\n${rows}` }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `G2G SEO Tools · ${new Date().toLocaleDateString('en-GB')}` }]
    }
  ], `⚡ Core Web Vitals degradation detected`)
}
