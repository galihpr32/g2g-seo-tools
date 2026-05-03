import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

/**
 * GET /api/automation/claude-review/pending
 *
 * Returns briefs that need Claude independent review:
 *   tyr_status = 'reviewed'  AND  claude_review_status = 'pending'
 *
 * Auth: Bearer CRON_SECRET
 *
 * Query params:
 *   limit  = max rows (default 5, hard cap 20)
 *
 * Used by the Cowork-scheduled hourly task to discover work.
 */

function isCronAuth(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(request: Request) {
  if (!isCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '5'), 20)

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Order by oldest pending first — fairness, prevents new briefs jumping queue.
  const { data: briefs, error } = await db
    .from('seo_content_briefs')
    .select(`
      id, owner_user_id, site_url, page, primary_keyword, brief_type,
      tyr_status, tyr_score, updated_at,
      content_outline, content_draft, faq_suggestions, new_keywords, notes
    `)
    .eq('tyr_status', 'reviewed')
    .eq('claude_review_status', 'pending')
    .order('updated_at', { ascending: true })
    .limit(limit)

  if (error) {
    console.error('[automation/claude-review/pending] DB error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    count:  briefs?.length ?? 0,
    briefs: briefs ?? [],
  })
}
