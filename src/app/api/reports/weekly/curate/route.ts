import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export const maxDuration = 15

/**
 * Sprint WEEKLY.PUBLIC — Curatorial edit + publish controls.
 *
 *  GET    /api/reports/weekly/curate?id=X    → fetch report + edits + status
 *  PUT    /api/reports/weekly/curate         → save curatorial_edits (auto-save per field)
 *  POST   /api/reports/weekly/curate/publish → manually publish NOW (sets publish_status='published')
 *  POST   /api/reports/weekly/curate/hold    → mark as 'held' (skip auto-publish)
 *
 * Body for PUT:
 *   { id: string, edits: { narrative?, action_plan?, watch_list?[], top_priorities?[] } }
 *
 * Behaviour:
 *   - Saving edits does NOT publish; just updates curatorial_edits JSONB
 *   - Auto-publish cron (08:00 UTC Mon) sweeps draft rows → applies edits → Slack post
 */

// ─── GET ────────────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const db = createServiceClient()
  const { data, error } = await db
    .from('weekly_reports')
    .select('id, owner_user_id, site_slug, week_start, week_end, publish_status, public_token, ai_narrative, ai_action_plan, curatorial_edits, report_data, published_at')
    .eq('id', id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ report: data })
}

// ─── PUT (save edits) ──────────────────────────────────────────────────────
export async function PUT(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as {
    id?:    string
    edits?: {
      narrative?:      string
      action_plan?:    string
      watch_list?:     string[]
      top_priorities?: string[]
    }
  }
  if (!body.id || !body.edits) return NextResponse.json({ error: 'id + edits required' }, { status: 400 })

  // Whitelist allowed keys to avoid arbitrary JSONB injection
  const safeEdits: Record<string, unknown> = {}
  if (typeof body.edits.narrative === 'string')   safeEdits.narrative   = body.edits.narrative.slice(0, 8000)
  if (typeof body.edits.action_plan === 'string') safeEdits.action_plan = body.edits.action_plan.slice(0, 8000)
  if (Array.isArray(body.edits.watch_list))       safeEdits.watch_list     = body.edits.watch_list.slice(0, 20).map(s => String(s).slice(0, 500))
  if (Array.isArray(body.edits.top_priorities))   safeEdits.top_priorities = body.edits.top_priorities.slice(0, 10).map(s => String(s).slice(0, 500))

  const db = createServiceClient()
  const { data, error } = await db
    .from('weekly_reports')
    .update({ curatorial_edits: safeEdits })
    .eq('id', body.id)
    .select('id, curatorial_edits, publish_status')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, report: data })
}
