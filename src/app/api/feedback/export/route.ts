import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export const maxDuration = 15

/**
 * GET /api/feedback/export?format=markdown|json&status=new|in_progress|all
 *
 * Dumps in-app feedback (bug_reports) in a format friendly for pasting into
 * Claude / Cursor / etc. for triage. Defaults:
 *   format = markdown
 *   status = new   (only fresh tickets)
 *
 * Markdown shape (one ticket per block):
 *   ## [{severity}] {title}
 *   **Status:** new · **Submitted:** 2026-05-13 17:27
 *   **Page:** /content/briefs/...
 *
 *   {description}
 *
 *   _Replies (N):_
 *   - 2026-05-13 — Galih: ...
 *   ---
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const format = (searchParams.get('format') ?? 'markdown').toLowerCase()
  const status = (searchParams.get('status') ?? 'new').toLowerCase()

  const db = createServiceClient()
  let query = db
    .from('bug_reports')
    .select('id, title, description, page_url, severity, status, replies, created_at, submitter_id')
    .order('created_at', { ascending: false })
    .limit(500)

  if (status !== 'all') query = query.eq('status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = data ?? []

  if (format === 'json') {
    return NextResponse.json({ count: rows.length, status, rows })
  }

  // Markdown rendering — easier to skim + paste into chat
  const lines: string[] = []
  lines.push(`# Feedback dump — ${rows.length} ticket(s), status=${status}`)
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')

  for (const r of rows) {
    lines.push(`## [${r.severity?.toUpperCase() ?? 'MEDIUM'}] ${r.title}`)
    const created = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16)
    lines.push(`**Status:** ${r.status} · **Submitted:** ${created}`)
    if (r.page_url) lines.push(`**Page:** \`${r.page_url}\``)
    lines.push('')
    lines.push(r.description?.trim() || '_(no description)_')
    lines.push('')

    const replies = Array.isArray(r.replies) ? r.replies : []
    if (replies.length > 0) {
      lines.push(`_Replies (${replies.length}):_`)
      for (const rep of replies) {
        const repAt = rep.at ? new Date(rep.at).toISOString().slice(0, 10) : ''
        const author = rep.author ?? rep.user_email ?? 'unknown'
        const body   = String(rep.body ?? rep.text ?? '').trim()
        lines.push(`- ${repAt} — ${author}: ${body}`)
      }
      lines.push('')
    }
    lines.push('---')
    lines.push('')
  }

  return new Response(lines.join('\n'), {
    status: 200,
    headers: {
      'Content-Type':        'text/markdown; charset=utf-8',
      'Content-Disposition': 'inline; filename="feedback.md"',
    },
  })
}
