import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * /api/feedback — bug reports + scratch / feedback intake
 *
 * GET   — list (Head sees all; submitter sees own). ?status filter optional.
 * POST  — create new bug report (any logged-in user).
 * PATCH — update status / resolution / append reply (Head only via service client).
 *
 * Slack notification fires on new submission (best-effort, non-blocking).
 */

async function notifySlack(report: { id: string; title: string; submitter_email: string | null; severity: string; page_url: string | null }) {
  const webhook = process.env.SLACK_WEBHOOK_URL
  if (!webhook) return
  const sevColor = report.severity === 'high' ? '#EF4444' : report.severity === 'medium' ? '#F59E0B' : '#9CA3AF'
  const blocks = [
    {
      color: sevColor,
      pretext: '🐛 *New feedback from in-app bug report*',
      fields: [
        { title: 'Severity', value: report.severity.toUpperCase(), short: true },
        { title: 'Submitter', value: report.submitter_email ?? 'unknown', short: true },
        { title: 'Title', value: report.title, short: false },
        { title: 'Page', value: report.page_url ?? 'n/a', short: false },
      ],
    },
  ]
  await fetch(webhook, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ attachments: blocks }),
  }).catch(err => console.warn('[feedback] slack notify failed:', err))
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url    = new URL(req.url)
  const status = url.searchParams.get('status')
  const scope  = url.searchParams.get('scope') ?? 'all'   // 'mine' | 'all'

  const db = createServiceClient()
  let q = db
    .from('bug_reports')
    .select('id, submitter_id, site_slug, title, description, page_url, severity, status, attachments, replies, resolution_notes, triaged_at, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(200)

  // Submitters only see their own; Head sees all (controlled by scope).
  // For now, gate "all" view by env var FEEDBACK_ADMINS (comma-separated user IDs).
  // Until that's set, default to mine-only for non-matching users.
  const adminIds = (process.env.FEEDBACK_ADMINS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const isAdmin  = adminIds.includes(user.id)

  if (scope === 'mine' || !isAdmin) {
    q = q.eq('submitter_id', user.id)
  }
  if (status) q = q.eq('status', status)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Hydrate submitter emails for admin view (one query, then merge)
  if (isAdmin && (data?.length ?? 0) > 0) {
    const submitterIds = Array.from(new Set((data ?? []).map(r => r.submitter_id)))
    const { data: profiles } = await db
      .from('profiles')
      .select('id, email')
      .in('id', submitterIds)
    const byId = new Map((profiles ?? []).map(p => [p.id, p.email]))
    return NextResponse.json({
      reports: (data ?? []).map(r => ({ ...r, submitter_email: byId.get(r.submitter_id) ?? null })),
      isAdmin,
    })
  }

  return NextResponse.json({ reports: data ?? [], isAdmin })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body     = await req.json().catch(() => ({}))
  const siteSlug = resolveSiteSlugFromRequest(req, body)
  const db       = createServiceClient()

  const { title, description, page_url, severity, attachments } = body
  if (!title?.trim() || !description?.trim()) {
    return NextResponse.json({ error: 'title and description required' }, { status: 400 })
  }

  const { data, error } = await db
    .from('bug_reports')
    .insert({
      submitter_id: user.id,
      site_slug:    siteSlug,
      title:        String(title).trim().slice(0, 200),
      description:  String(description).trim().slice(0, 5000),
      page_url:     page_url?.toString().slice(0, 500) ?? null,
      severity:     ['low','medium','high'].includes(severity) ? severity : 'medium',
      // Sprint FB.1 — attachments are data URLs (client-side resized JPEG).
      // Cap to 3 × ~1.5MB each so payload + DB row stay sane. The client
      // resize keeps real values around 200-500KB, so this is a guard rail,
      // not an expected ceiling.
      attachments:  Array.isArray(attachments)
        ? attachments
            .filter(s => typeof s === 'string' && s.length < 1_500_000)
            .slice(0, 3)
        : [],
    })
    .select('id, title, severity, page_url')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Best-effort Slack notif — fire-and-forget (don't block POST response)
  ;(async () => {
    try {
      const { data: profile } = await db.from('profiles').select('email').eq('id', user.id).maybeSingle()
      await notifySlack({
        id:               String(data.id),
        title:            String(data.title),
        severity:         String(data.severity),
        page_url:         data.page_url as string | null,
        submitter_email:  (profile?.email as string | null) ?? null,
      })
    } catch (e) { console.warn('[feedback] slack notify wrapper failed:', e) }
  })()

  return NextResponse.json({ report: data })
}

export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const { id, status, resolution_notes, reply } = body
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const adminIds = (process.env.FEEDBACK_ADMINS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const isAdmin  = adminIds.includes(user.id)

  const db = createServiceClient()

  // Submitters can only append a reply to their own report. Status changes
  // are admin-only.
  const { data: existing } = await db
    .from('bug_reports')
    .select('id, submitter_id, replies')
    .eq('id', id)
    .single()

  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const isOwner = existing.submitter_id === user.id
  if (!isAdmin && !isOwner) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const updates: Record<string, unknown> = {}

  // Status / resolution — admin only
  if (status !== undefined) {
    if (!isAdmin) return NextResponse.json({ error: 'Status changes require admin' }, { status: 403 })
    if (!['new','in_progress','resolved','wont_fix'].includes(status)) {
      return NextResponse.json({ error: 'invalid status' }, { status: 400 })
    }
    updates.status = status
    updates.triaged_by = user.id
    updates.triaged_at = new Date().toISOString()
  }
  if (resolution_notes !== undefined) {
    if (!isAdmin) return NextResponse.json({ error: 'Resolution requires admin' }, { status: 403 })
    updates.resolution_notes = resolution_notes ?? null
  }

  // Replies — anyone with access can append. Each reply is { author_id, ts, content }.
  if (reply !== undefined) {
    if (typeof reply !== 'string' || !reply.trim()) {
      return NextResponse.json({ error: 'reply must be a non-empty string' }, { status: 400 })
    }
    const existingReplies = Array.isArray(existing.replies) ? existing.replies : []
    updates.replies = [
      ...existingReplies,
      {
        author_id: user.id,
        author_role: isAdmin ? 'admin' : 'submitter',
        ts:        new Date().toISOString(),
        content:   reply.trim().slice(0, 2000),
      },
    ]
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await db
    .from('bug_reports')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ report: data })
}
