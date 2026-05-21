import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * Sprint FRIDAY.KPI.GRAPH.2 — CRUD for action plan manual overrides.
 *
 * Body: { week_iso, brand, action_index, action_text? }
 *   action_text undefined or empty → DELETE the override (revert to auto)
 *   action_text provided          → UPSERT
 */
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    week_iso?:     string
    brand?:        string
    action_index?: number
    action_text?:  string
  }
  const weekIso     = body.week_iso?.trim()
  const brand       = body.brand?.trim().toLowerCase()
  const actionIndex = Number(body.action_index)
  const actionText  = body.action_text?.trim() ?? ''

  if (!weekIso || !brand || !Number.isInteger(actionIndex) || actionIndex < 0 || actionIndex > 9) {
    return NextResponse.json({ error: 'week_iso, brand, action_index (0-9) all required' }, { status: 400 })
  }

  if (!actionText) {
    // Revert to auto
    const { error } = await db
      .from('friday_kpi_action_overrides')
      .delete()
      .eq('owner_user_id', ownerId)
      .eq('week_iso',      weekIso)
      .eq('brand',         brand)
      .eq('action_index',  actionIndex)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, reverted: true })
  }

  const { error } = await db
    .from('friday_kpi_action_overrides')
    .upsert({
      owner_user_id: ownerId,
      week_iso:      weekIso,
      brand,
      action_index:  actionIndex,
      action_text:   actionText.slice(0, 500),
      edited_by:     user.id,
      edited_at:     new Date().toISOString(),
    }, { onConflict: 'owner_user_id,week_iso,brand,action_index' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, action_text: actionText })
}
