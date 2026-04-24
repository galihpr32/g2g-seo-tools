import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// GET /api/agents/logs
// Query params:
//   ?tab=runs|actions      (default: runs)
//   ?agent=heimdall          (filter by agent, optional)
//   ?status=success|error  (filter by status, optional)
//   ?limit=50              (default: 50)
//   ?offset=0              (default: 0)
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const tab    = searchParams.get('tab')    ?? 'runs'
  const agent  = searchParams.get('agent')  ?? null
  const status = searchParams.get('status') ?? null
  const limit  = Math.min(parseInt(searchParams.get('limit')  ?? '50'), 200)
  const offset = parseInt(searchParams.get('offset') ?? '0')

  if (tab === 'runs') {
    let query = db
      .from('agent_runs')
      .select('id, agent_key, site_slug, status, summary, findings_count, actions_queued, error_message, triggered_by_action_id, started_at, finished_at')
      .eq('owner_user_id', ownerId)
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (agent)  query = query.eq('agent_key', agent)
    if (status) query = query.eq('status', status)

    const { data, error, count } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Compute duration for each run
    const runs = (data ?? []).map(r => ({
      ...r,
      durationMs: r.finished_at && r.started_at
        ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()
        : null,
    }))

    return NextResponse.json({ runs, total: count ?? runs.length })
  }

  if (tab === 'actions') {
    let query = db
      .from('agent_actions')
      .select('id, agent_key, run_id, site_slug, action_type, title, description, priority, status, approved_at, executed_at, created_at')
      .eq('owner_user_id', ownerId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (agent)  query = query.eq('agent_key', agent)
    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ actions: data ?? [] })
  }

  return NextResponse.json({ error: 'Invalid tab' }, { status: 400 })
}
