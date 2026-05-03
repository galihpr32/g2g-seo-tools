import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

/**
 * POST /api/automation/claude-review/[briefId]
 *
 * Endpoint for the Cowork-scheduled Claude reviewer task. Submits an
 * independent QA verdict for a brief that already passed Tyr review.
 *
 * Auth: Bearer CRON_SECRET (same token used by Vercel + GitHub Actions
 *       crons; consolidated here per Phase 1 design).
 *
 * Body:
 *   {
 *     status: 'passed' | 'failed' | 'skipped',
 *     score:  number   (0-100),
 *     notes:  string   (markdown — review reasoning, suggestions, flags)
 *   }
 *
 * Effects:
 *   - Updates seo_content_briefs.claude_review_status / score / notes / reviewed_at
 *   - Does NOT change brief.status or tyr_status — those are managed elsewhere.
 *   - Pipeline UI + Writer Inbox automatically respect the new state.
 *
 * Returns: { ok: true, briefId, status, score }
 */

const ALLOWED_STATUS = new Set(['passed', 'failed', 'skipped'])

function isCronAuth(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ briefId: string }> },
) {
  if (!isCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { briefId } = await ctx.params
  if (!briefId || !/^[0-9a-f-]{36}$/i.test(briefId)) {
    return NextResponse.json({ error: 'Invalid briefId' }, { status: 400 })
  }

  const body = await request.json().catch(() => null) as {
    status?: string
    score?:  number
    notes?:  string
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  if (!body.status || !ALLOWED_STATUS.has(body.status)) {
    return NextResponse.json(
      { error: `status must be one of ${[...ALLOWED_STATUS].join(', ')}` },
      { status: 400 },
    )
  }
  if (typeof body.score !== 'number' || body.score < 0 || body.score > 100) {
    return NextResponse.json({ error: 'score must be 0-100' }, { status: 400 })
  }
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 4000) : null

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: updated, error } = await db
    .from('seo_content_briefs')
    .update({
      claude_review_status: body.status,
      claude_review_score:  body.score,
      claude_review_notes:  notes,
      claude_reviewed_at:   new Date().toISOString(),
    })
    .eq('id', briefId)
    .select('id, claude_review_status, claude_review_score')
    .single()

  if (error) {
    console.error(`[automation/claude-review] update failed for ${briefId}:`, error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!updated) {
    return NextResponse.json({ error: 'Brief not found' }, { status: 404 })
  }

  console.log(`[automation/claude-review] ${briefId} → ${body.status} (${body.score})`)

  return NextResponse.json({
    ok:      true,
    briefId: updated.id,
    status:  updated.claude_review_status,
    score:   updated.claude_review_score,
  })
}

/**
 * GET /api/automation/claude-review/[briefId]
 *
 * Lightweight read for the Cowork task to check current review state.
 * Useful for idempotency: scheduled task can re-check before re-running.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ briefId: string }> },
) {
  if (!isCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { briefId } = await ctx.params
  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: brief, error } = await db
    .from('seo_content_briefs')
    .select(`
      id, primary_keyword, brief_type, tyr_status, tyr_score,
      claude_review_status, claude_review_score, claude_review_notes, claude_reviewed_at,
      content_outline, content_draft, faq_suggestions, new_keywords, notes
    `)
    .eq('id', briefId)
    .single()

  if (error || !brief) {
    return NextResponse.json({ error: 'Brief not found' }, { status: 404 })
  }
  return NextResponse.json({ brief })
}
