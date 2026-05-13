import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

/**
 * GET  /api/sprints?site=<slug>     — list sprints (active first)
 * POST /api/sprints                 — create { label, started_at, ended_at?, goal? }
 * PATCH and DELETE on /api/sprints/[id]
 */

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const { data, error } = await db
    .from('sprints')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('started_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ sprints: data ?? [] })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req, body)

  const label = typeof body.label === 'string' ? body.label.trim() : ''
  const startedAt = typeof body.started_at === 'string' ? body.started_at : ''
  if (!label || !startedAt) return NextResponse.json({ error: 'label + started_at required' }, { status: 400 })

  const db = createServiceClient()
  const { data, error } = await db
    .from('sprints')
    .insert({
      owner_user_id: ownerId,
      site_slug:     siteSlug,
      label,
      started_at:    startedAt,
      ended_at:      typeof body.ended_at === 'string' ? body.ended_at : null,
      goal:          typeof body.goal === 'string' ? body.goal : null,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'Sprint with this label exists' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ sprint: data })
}
