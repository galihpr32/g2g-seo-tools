import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 10

// GET /api/settings/notifications — fetch current notification prefs
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { data } = await supabase
    .from('notification_settings')
    .select('*')
    .eq('user_id', ownerId)
    .single()

  // Return defaults if no row yet
  return NextResponse.json({
    slack_clicks_alerts: data?.slack_clicks_alerts ?? false,
    slack_cwv_alerts:    data?.slack_cwv_alerts    ?? false,
    slack_index_alerts:  data?.slack_index_alerts  ?? true,
  })
}

// PUT /api/settings/notifications — upsert prefs
export async function PUT(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => ({}))

  const { error } = await supabase
    .from('notification_settings')
    .upsert({
      user_id:            ownerId,
      slack_clicks_alerts: body.slack_clicks_alerts ?? false,
      slack_cwv_alerts:    body.slack_cwv_alerts    ?? false,
      slack_index_alerts:  body.slack_index_alerts  ?? true,
      updated_at:          new Date().toISOString(),
    }, { onConflict: 'user_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
