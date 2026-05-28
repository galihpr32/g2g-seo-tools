import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * GET /api/forseti/threads
 *
 * Sprint FORSETI.PAGE.TRIAGE — list endpoint with filters.
 *
 * Query params:
 *   tab=spotted|mine|awaiting|resolved|all   (default 'spotted')
 *   subreddit=<name>                          (filter to one sub)
 *   q=<text>                                  (search title)
 *   status=<single status>                    (override tab logic)
 *   limit=<n>                                 (default 100, max 500)
 *
 * Returns threads with effective_category + effective_severity computed
 * server-side (manual override wins over auto). UI never has to recompute.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const { searchParams } = new URL(req.url)
  const tab        = searchParams.get('tab')       ?? 'spotted'
  const subreddit  = (searchParams.get('subreddit') ?? '').trim()
  const q          = (searchParams.get('q')         ?? '').trim()
  const statusOne  = (searchParams.get('status')    ?? '').trim()
  const limit      = Math.min(500, parseInt(searchParams.get('limit') ?? '100', 10) || 100)

  let query = db
    .from('forseti_threads')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
    .order('first_seen_at', { ascending: false })
    .limit(limit)

  if (statusOne) {
    query = query.eq('status', statusOne)
  } else {
    // Tab-based status filter
    if (tab === 'spotted')      query = query.in('status', ['spotted', 'drafted'])
    else if (tab === 'mine')    query = query.eq('assignee_user_id', user.id).in('status', ['spotted', 'drafted', 'sent', 'op_replied'])
    else if (tab === 'awaiting') query = query.in('status', ['sent', 'op_replied'])
    else if (tab === 'resolved') {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      query = query.in('status', ['resolved', 'escalated']).gte('resolved_at', sevenDaysAgo)
    }
    // tab === 'all' → no status filter
  }

  if (subreddit) query = query.eq('subreddit', subreddit)
  if (q) {
    const safe = q.replace(/[%,()]/g, ' ')
    query = query.ilike('thread_title', `%${safe}%`)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Compute effective_category + effective_severity. Sort by severity DESC,
  // then upvotes DESC, then most recent. Postgres can't do the conditional
  // sort easily, so we re-sort in app.
  type Row = {
    auto_category:            string
    manual_category_override: string | null
    auto_severity:            number
    manual_severity_override: number | null
    op_post_score:            number
    first_seen_at:            string
  } & Record<string, unknown>

  const enriched = (data as Row[] ?? []).map(r => ({
    ...r,
    effective_category: r.manual_category_override ?? r.auto_category,
    effective_severity: r.manual_severity_override ?? r.auto_severity,
  }))
  enriched.sort((a, b) => {
    if (b.effective_severity !== a.effective_severity) return b.effective_severity - a.effective_severity
    if (b.op_post_score !== a.op_post_score) return b.op_post_score - a.op_post_score
    return new Date(b.first_seen_at).getTime() - new Date(a.first_seen_at).getTime()
  })

  // Per-tab counts (for header tab badges)
  const { data: countRows } = await db
    .from('forseti_threads')
    .select('status, assignee_user_id, resolved_at')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
    .limit(2000)

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const counts = { spotted: 0, mine: 0, awaiting: 0, resolved: 0 }
  for (const r of countRows ?? []) {
    const status = r.status as string
    if (status === 'spotted' || status === 'drafted') counts.spotted++
    if (r.assignee_user_id === user.id && ['spotted', 'drafted', 'sent', 'op_replied'].includes(status)) counts.mine++
    if (status === 'sent' || status === 'op_replied') counts.awaiting++
    if ((status === 'resolved' || status === 'escalated') && r.resolved_at && new Date(r.resolved_at).getTime() >= sevenDaysAgo) counts.resolved++
  }

  // Also surface the subreddit list (for filter dropdown)
  const { data: subs } = await db
    .from('forseti_subreddit_configs')
    .select('subreddit, enabled')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
    .order('subreddit', { ascending: true })

  return NextResponse.json({
    threads:     enriched,
    counts,
    subreddits:  (subs ?? []).map(s => s.subreddit),
  })
}

// ─── PATCH /api/forseti/threads?id= — inline override + status change ──────
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = { updated_at: new Date().toISOString() }

  // Manual overrides — when user explicitly sets, store. When they reset to null
  // (clear button), scraper's auto values take over again.
  if ('manual_category_override' in body) patch.manual_category_override = body.manual_category_override
  if ('manual_severity_override' in body) {
    const v = body.manual_severity_override
    patch.manual_severity_override = (v === null || v === undefined) ? null : Math.max(1, Math.min(5, Number(v)))
  }

  // Status workflow
  if (typeof body.status === 'string') {
    patch.status = body.status
    // Record lifecycle timestamps
    if (body.status === 'sent' || body.status === 'op_replied') patch.responded_at = patch.responded_at ?? new Date().toISOString()
    if (body.status === 'resolved' || body.status === 'escalated') patch.resolved_at = new Date().toISOString()
  }

  // Assignment — accept 'self' sentinel from UI for self-assign convenience
  if ('assignee_user_id' in body) {
    const raw = body.assignee_user_id
    patch.assignee_user_id = raw === 'self' ? user.id : raw
    if (patch.assignee_user_id) patch.assigned_at = new Date().toISOString()
  }

  const { data, error } = await db
    .from('forseti_threads')
    .update(patch)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Log status changes to the activity log (auto-generated entry)
  if (typeof body.status === 'string') {
    await db.from('forseti_thread_responses').insert({
      thread_id:         id,
      owner_user_id:     ownerId,
      response_type:     'status_change',
      posted_by_user_id: user.id,
      status_after:      body.status,
    })
  }

  return NextResponse.json({ thread: data })
}
