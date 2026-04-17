import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

// ── GET /api/campaigns — list all campaigns with page counts ─────────────────
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select(`
      id, name, description, color, position, goals, gsc_site_url,
      parent_campaign_id, created_at, updated_at,
      campaign_pages (id, page_url, action_item_id, position)
    `)
    .eq('owner_user_id', ownerId)
    .order('position', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ campaigns: campaigns ?? [] })
}

// ── POST /api/campaigns — create a new campaign ──────────────────────────────
// Body: { name, description?, color?, gsc_site_url?, parent_campaign_id?, goals? }
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const body = await request.json() as {
    name: string
    description?: string
    color?: string
    gsc_site_url?: string
    parent_campaign_id?: string
    goals?: Record<string, unknown>
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'Campaign name is required' }, { status: 400 })
  }

  // Put new campaign at the end
  const { count } = await supabase
    .from('campaigns')
    .select('*', { count: 'exact', head: true })
    .eq('owner_user_id', ownerId)

  const { data: campaign, error } = await supabase
    .from('campaigns')
    .insert({
      owner_user_id:      ownerId,
      name:               body.name.trim(),
      description:        body.description ?? null,
      color:              body.color ?? '#6366f1',
      gsc_site_url:       body.gsc_site_url ?? null,
      parent_campaign_id: body.parent_campaign_id ?? null,
      goals:              body.goals ?? {},
      position:           count ?? 0,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ campaign })
}

// ── PATCH /api/campaigns — reorder campaigns (bulk position update) ───────────
// Body: { order: string[] }  — array of campaign ids in new order
export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { order } = await request.json() as { order: string[] }

  if (!Array.isArray(order)) {
    return NextResponse.json({ error: 'order must be an array of ids' }, { status: 400 })
  }

  const updates = order.map((id, i) =>
    supabase
      .from('campaigns')
      .update({ position: i })
      .eq('id', id)
      .eq('owner_user_id', ownerId)
  )

  await Promise.all(updates)
  return NextResponse.json({ ok: true })
}
