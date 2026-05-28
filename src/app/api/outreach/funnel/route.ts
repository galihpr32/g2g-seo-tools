import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 10

/**
 * GET /api/outreach/funnel?days=90
 *
 * Aggregate funnel stats: prospects discovered → sent → replied → agreed →
 * live. Used by the funnel chart at /outreach.
 *
 * Definitions:
 *   discovered = total prospects in window
 *   sent       = ≥1 outbound entry in replies
 *   replied    = ≥1 inbound entry
 *   agreed     = status IN ('negotiating', 'accepted', 'published')
 *   live       = status='published' AND backlink_live=true
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const url      = new URL(req.url)
  const days     = Math.max(7, Math.min(365, Number(url.searchParams.get('days') ?? '90')))
  const _siteSlug = resolveSiteSlugFromRequest(req)
  void _siteSlug // outreach_prospects doesn't have site_slug yet — backlog
  const db       = createServiceClient()

  const since = new Date(Date.now() - days * 86400_000).toISOString()

  const { data: prospects, error } = await db
    .from('outreach_prospects')
    .select('id, status, replies, sent_count, last_sent_at, last_replied_at, backlink_live, created_at')
    .eq('owner_user_id', ownerId)
    .gte('created_at', since)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  type Reply = { direction?: 'outbound' | 'inbound'; sentiment?: string | null }

  const stats = { discovered: 0, sent: 0, replied: 0, agreed: 0, live: 0 }

  for (const p of prospects ?? []) {
    stats.discovered++
    const replies = Array.isArray(p.replies) ? (p.replies as Reply[]) : []
    const hasOutbound = (Number(p.sent_count) > 0) || replies.some(r => r.direction === 'outbound')
    const hasInbound  = !!p.last_replied_at || replies.some(r => r.direction === 'inbound')
    if (hasOutbound) stats.sent++
    if (hasInbound)  stats.replied++
    if (['negotiating', 'accepted', 'published'].includes(String(p.status))) stats.agreed++
    if (p.status === 'published' && p.backlink_live) stats.live++
  }

  // Conversion rates between adjacent stages (for sparklines / labels)
  const rates = {
    sentRate:    stats.discovered > 0 ? +(stats.sent     / stats.discovered * 100).toFixed(1) : 0,
    replyRate:   stats.sent       > 0 ? +(stats.replied  / stats.sent       * 100).toFixed(1) : 0,
    agreedRate:  stats.replied    > 0 ? +(stats.agreed   / stats.replied    * 100).toFixed(1) : 0,
    liveRate:    stats.agreed     > 0 ? +(stats.live     / stats.agreed     * 100).toFixed(1) : 0,
    overallRate: stats.discovered > 0 ? +(stats.live     / stats.discovered * 100).toFixed(1) : 0,
  }

  return NextResponse.json({ ok: true, days, stats, rates })
}
