import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

export const maxDuration = 30

/**
 * GET /api/cron/tech-escalation
 *
 * Daily cron — finds technical action items aged >14 days that are still
 * open + critical/high priority, posts a digest to Slack via existing
 * SLACK_WEBHOOK_URL. Asst Manager's Workflow #3 step 3.7.
 *
 * Avoids spamming: groups all stale items into ONE Slack message per day,
 * even when multiple sites have stale items.
 *
 * Auth: Bearer CRON_SECRET via GitHub Actions.
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    return NextResponse.json({
      ok:      false,
      message: 'SLACK_WEBHOOK_URL not configured. Skipping escalation.',
    })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Stale tech action items: >14 days old, not done, technical category
  // Heuristic for "technical": action_type contains 'fix' or matches known
  // technical types like fix_broken_url_high_traffic, fix_server_error,
  // recover_lost_page, etc.
  const stale = new Date(Date.now() - 14 * 86400_000).toISOString()

  const { data: items } = await db
    .from('seo_action_items')
    .select('id, title, page, action_type, priority, status, created_at, owner_user_id, site_slug')
    .neq('status', 'done')
    .lte('created_at', stale)
    .or('action_type.ilike.%fix%,action_type.ilike.%recover%,action_type.ilike.%error%')
    .in('priority', ['high', 'medium'])
    .order('created_at', { ascending: true })
    .limit(20)

  if (!items || items.length === 0) {
    return NextResponse.json({ ok: true, message: 'No stale tech action items.' })
  }

  // Group by site_slug for Slack message clarity
  const bySite = new Map<string, typeof items>()
  for (const it of items) {
    const slug = String(it.site_slug ?? 'unknown')
    if (!bySite.has(slug)) bySite.set(slug, [])
    bySite.get(slug)!.push(it)
  }

  // Build Slack attachments — one per site, listing aged items
  const attachments = Array.from(bySite.entries()).map(([slug, list]) => {
    const lines = list.slice(0, 8).map(it => {
      const ageDays = Math.floor((Date.now() - new Date(it.created_at).getTime()) / 86400_000)
      const path = it.page ? String(it.page).replace(/^https?:\/\/[^/]+/, '') : '(no page)'
      return `• *[${it.priority?.toUpperCase()}]* ${it.title?.slice(0, 80)} — \`${path.slice(0, 50)}\` (${ageDays}d old)`
    }).join('\n')
    return {
      color:   '#F59E0B',                                   // amber — urgent but not P0
      pretext: `🛠 *${slug.toUpperCase()} — ${list.length} stale tech action item${list.length > 1 ? 's' : ''} (>14d)*`,
      text:    lines + (list.length > 8 ? `\n_… and ${list.length - 8} more_` : ''),
      mrkdwn_in: ['text', 'pretext'],
    }
  })

  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        text: `Daily tech-debt digest — ${items.length} action items aged >14 days. Triage at /gsc/action-items.`,
        attachments,
      }),
    })
    const ok = res.ok
    return NextResponse.json({
      ok,
      sites_count: bySite.size,
      items_count: items.length,
      slack_status: res.status,
    })
  } catch (err) {
    return NextResponse.json({
      ok:    false,
      error: `Slack post failed: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 502 })
  }
}
