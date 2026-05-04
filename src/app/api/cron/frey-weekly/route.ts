import { NextResponse } from 'next/server'
import { runFrey } from '@/lib/agents/frey'

export const maxDuration = 300   // up to 5 min — Frey hits 60+ LLM calls

/**
 * GET /api/cron/frey-weekly
 *
 * Weekly Frey AI visibility scan. Triggered by GH Actions.
 * Auth: Bearer CRON_SECRET.
 *
 * Required env:
 *   - ANTHROPIC_API_KEY (for Claude queries + parser)
 *   - OPENAI_API_KEY    (for GPT-4o-mini queries)
 *   - G2G_OWNER_USER_ID (workspace owner)
 *   - SLACK_BOT_TOKEN + SLACK_CHANNEL_ID (for sentiment-drop alerts)
 *
 * Cost projection: 30 prompts × 2 LLMs × ~1,000 token responses + 60 Haiku
 * parser calls ≈ $1-3 per run. Weekly = ~$5-15/month.
 */

function isCronAuth(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(request: Request) {
  if (!isCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ownerId  = process.env.G2G_OWNER_USER_ID
  const siteSlug = 'g2g'

  if (!ownerId) {
    return NextResponse.json({ error: 'G2G_OWNER_USER_ID not configured' }, { status: 500 })
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 })
  }

  try {
    const result = await runFrey(ownerId, siteSlug)
    return NextResponse.json({
      ok: result.errors.length === 0,
      ...result,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[frey-weekly] failed:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
