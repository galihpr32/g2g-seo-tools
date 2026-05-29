import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * GET /api/hugin/baseline/[id]
 * DELETE /api/hugin/baseline/[id]  (cancel a running job)
 *
 * Sprint HUGIN.BASELINE.1 — status polling + cancel.
 */
export async function GET(
  _req: Request,
  ctx:  { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()
  const { id }  = await ctx.params

  const { data, error } = await db
    .from('hugin_baseline_runs')
    .select('*')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Run not found' }, { status: 404 })

  return NextResponse.json({ run: data })
}

export async function DELETE(
  _req: Request,
  ctx:  { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()
  const { id }  = await ctx.params

  const { data, error } = await db
    .from('hugin_baseline_runs')
    .update({
      status:       'cancelled',
      completed_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .in('status', ['pending', 'running', 'aggregating'])
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ run: data })
}
