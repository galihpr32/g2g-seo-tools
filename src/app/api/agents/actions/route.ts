import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { executeAction } from '@/lib/agents/executor'
import type { AgentAction } from '@/lib/agents/executor'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status') ?? 'pending'
  const agent = searchParams.get('agent')
  const site = resolveSiteSlugFromRequest(request)

  let query = db
    .from('agent_actions')
    .select('*')
    .eq('owner_user_id', effectiveOwnerId)
    .eq('site_slug', site)

  if (status) {
    query = query.eq('status', status)
  }

  if (agent) {
    query = query.eq('agent_key', agent)
  }

  const { data, error } = await query.order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ actions: data ?? [] })
}

export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await request.json()
  const { id, status } = body as { id: string; status: 'approved' | 'rejected' }

  if (!id || !status) {
    return NextResponse.json({ error: 'Missing id or status' }, { status: 400 })
  }

  // Get the action
  const { data: action, error: fetchErr } = await db
    .from('agent_actions')
    .select('*')
    .eq('id', id)
    .eq('owner_user_id', effectiveOwnerId)
    .single()

  if (fetchErr || !action) {
    return NextResponse.json({ error: 'Action not found' }, { status: 404 })
  }

  if (status === 'approved') {
    try {
      // Execute the action
      const result = await executeAction(action as AgentAction, user.id)
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 500 })
      }

      // If handoff occurred, include the new run ID in response
      if (result.handoffRunId) {
        return NextResponse.json({ ok: true, handoffRunId: result.handoffRunId })
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      return NextResponse.json({ error: errorMessage }, { status: 500 })
    }
  } else if (status === 'rejected') {
    // Just mark as rejected
    const { error } = await db
      .from('agent_actions')
      .update({
        status: 'rejected',
        approved_by: user.id,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  } else {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}
