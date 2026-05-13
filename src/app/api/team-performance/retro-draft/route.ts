import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 30

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const RETRO_MODEL = 'claude-haiku-4-5-20251001'

/**
 * POST /api/team-performance/retro-draft
 *
 * Generates a weekly/monthly retro draft from team-performance data.
 * Specialist 1 / Asst Manager / Head can edit + paste to Slack/Notion.
 *
 * Body: { period?: 'weekly' | 'monthly' }   // default 'weekly'
 *
 * Output: { draft: string, stats: {...used to build it} }
 *
 * Uses Haiku because retro is summarization, not strategy. Cheap + fast.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const body     = await req.json().catch(() => ({}))
  const siteSlug = resolveSiteSlugFromRequest(req, body)
  const period: 'weekly' | 'monthly' = body.period === 'monthly' ? 'monthly' : 'weekly'
  const days = period === 'weekly' ? 7 : 30
  const db = createServiceClient()

  const since = new Date(Date.now() - days * 86400_000).toISOString()
  const periodLabel = period === 'weekly' ? 'past 7 days' : 'past 30 days'

  // ── Pull stats in parallel ────────────────────────────────────────────────
  const [briefsRes, actionsRes, briefOutcomesRes] = await Promise.all([
    // Briefs activity
    db.from('seo_content_briefs')
      .select('id, status, tyr_score, tyr_status, primary_keyword, published_at, created_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .gte('updated_at', since),
    // Action items activity
    db.from('seo_action_items')
      .select('id, status, action_type, completed_at, created_at')
      .eq('site_url', `https://www.${siteSlug === 'g2g' ? 'g2g' : 'offgamers'}.com/`)
      .gte('updated_at', since),
    // Brief outcomes that have NEW snapshots in window (signals "did our published work land?")
    db.from('brief_outcomes')
      .select('brief_id, primary_keyword, pos_0, pos_30, pos_60, pos_90, snapshot_30_at, snapshot_60_at, snapshot_90_at')
      .eq('owner_user_id', ownerId)
      .or(`snapshot_30_at.gte.${since},snapshot_60_at.gte.${since},snapshot_90_at.gte.${since}`)
      .limit(100),
  ])

  const briefs    = briefsRes.data ?? []
  const actions   = actionsRes.data ?? []
  const outcomes  = briefOutcomesRes.data ?? []

  const published        = briefs.filter(b => b.status === 'published')
  const publishedInWindow = published.filter(b => b.published_at && new Date(b.published_at) >= new Date(since))
  const draftedInWindow  = briefs.filter(b => new Date(b.created_at) >= new Date(since))
  const tyrReviewedInWindow = briefs.filter(b => b.tyr_status && b.tyr_score != null)
  const tyrScores = tyrReviewedInWindow.map(b => b.tyr_score as number).filter(s => s != null)
  const tyrMedian = tyrScores.length > 0
    ? tyrScores.sort((a, b) => a - b)[Math.floor(tyrScores.length / 2)]
    : null
  const tyrFailedCount = briefs.filter(b => b.tyr_status === 'failed').length
  const tyrPassedCount = briefs.filter(b => b.tyr_status === 'reviewed').length

  const actionsDone   = actions.filter(a => a.status === 'done').length
  const actionsOpen   = actions.filter(a => a.status === 'pending' || a.status === 'in_progress').length
  const actionsClosed = actions.filter(a => a.completed_at && new Date(a.completed_at) >= new Date(since)).length

  // Outcome wins/losses in window
  const wins: { keyword: string; pos: number }[] = []
  const losses: { keyword: string; pos: number }[] = []
  for (const o of outcomes) {
    const latest = o.pos_90 ?? o.pos_60 ?? o.pos_30
    if (latest == null) continue
    if (latest <= 8) wins.push({ keyword: String(o.primary_keyword ?? '?'), pos: Number(latest) })
    if (latest > 25 && o.pos_0 != null && Number(o.pos_0) > 25) losses.push({ keyword: String(o.primary_keyword ?? '?'), pos: Number(latest) })
  }

  const stats = {
    period:       periodLabel,
    publishedInWindow: publishedInWindow.length,
    draftedInWindow:   draftedInWindow.length,
    tyrMedian,
    tyrPassedCount,
    tyrFailedCount,
    actionsDone:   actionsDone,
    actionsClosed: actionsClosed,
    actionsOpen,
    winsCount:     wins.length,
    lossesCount:   losses.length,
    topPublished:  publishedInWindow.slice(0, 5).map(b => b.primary_keyword).filter(Boolean),
    topWins:       wins.slice(0, 4),
    topLosses:     losses.slice(0, 4),
  }

  const prompt = `You are MIMIR drafting a candid retro for the SEO team for the ${periodLabel}. Write in the voice of a senior teammate — direct, evidence-based, mildly poetic but never fluffy.

DATA:
- Briefs published this period: ${stats.publishedInWindow}
- Briefs drafted this period: ${stats.draftedInWindow}
- Tyr median score: ${stats.tyrMedian != null ? stats.tyrMedian + '/100' : 'n/a'}
- Tyr passed/failed: ${stats.tyrPassedCount} / ${stats.tyrFailedCount}
- Action items closed: ${stats.actionsClosed}, still open: ${stats.actionsOpen}
- Briefs that LANDED top 8 this period: ${stats.winsCount} ${stats.topWins.map(w => `(${w.keyword} → pos ${w.pos})`).join(', ')}
- Briefs still STUCK >25: ${stats.lossesCount} ${stats.topLosses.map(l => `(${l.keyword} → pos ${l.pos})`).join(', ')}
- Top published keywords: ${stats.topPublished.join(', ') || 'n/a'}

OUTPUT FORMAT — markdown, exactly this shape:

**${period === 'weekly' ? 'Weekly' : 'Monthly'} Retro — ${periodLabel}**

📈 **What worked:**
- bullet 1 (cite a specific metric or brief)
- bullet 2

📉 **What didn't:**
- bullet 1 (cite specific stuck briefs / failed Tyr)
- bullet 2

🎯 **What to focus next ${period === 'weekly' ? 'week' : 'month'}:**
- bullet 1 (1 concrete action)
- bullet 2

RULES:
- 2-3 bullets per section, no more.
- Cite numbers. "Published 6, all passed Tyr median 87/100" beats "good output this week".
- DO NOT congratulate generically. If everything was bad, say so.
- DO NOT propose vague "improve quality" — name a SPECIFIC tactic.
- If data is thin, write only what's supported. Empty bullets > made-up content.`

  let draft = ''
  try {
    const res = await anthropic.messages.create({
      model:      RETRO_MODEL,
      max_tokens: 800,
      messages:   [{ role: 'user', content: prompt }],
    })
    draft = res.content[0]?.type === 'text' ? res.content[0].text.trim() : ''
  } catch (err) {
    return NextResponse.json({
      ok:    false,
      error: `Haiku error: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 502 })
  }

  return NextResponse.json({
    ok:    true,
    period,
    draft,
    stats,
  })
}
