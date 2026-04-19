import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 30

// ── GET /api/backlinks — list all backlinks for owner ─────────────────────────
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { data, error } = await supabase
    .from('paid_backlinks')
    .select('*')
    .eq('owner_user_id', ownerId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ backlinks: data ?? [] })
}

// ── POST /api/backlinks — create a new backlink ───────────────────────────────
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const body = await request.json()
  const {
    site_name, external_url, anchor_text, target_page, target_keyword,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content,
    cost_amount, cost_currency, live_date, notes,
  } = body

  if (!site_name || !external_url || !anchor_text || !target_page) {
    return NextResponse.json({ error: 'Missing required fields: site_name, external_url, anchor_text, target_page' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('paid_backlinks')
    .insert({
      owner_user_id: ownerId,
      site_name, external_url, anchor_text, target_page,
      target_keyword: target_keyword || null,
      utm_source: utm_source || null,
      utm_medium: utm_medium || 'referral',
      utm_campaign: utm_campaign || null,
      utm_term: utm_term || null,
      utm_content: utm_content || null,
      cost_amount: cost_amount ? parseFloat(cost_amount) : null,
      cost_currency: cost_currency || 'USD',
      live_date: live_date || null,
      notes: notes || null,
      link_status: 'active',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ backlink: data })
}
