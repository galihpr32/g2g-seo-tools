import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * /api/experiments
 *
 * CRUD for the Start/Stop/Continue tracker. Site-scoped via
 * resolveSiteSlugFromRequest, so OG strategies don't leak into G2G.
 *
 * GET    — list (?status=start|continue|stop, ?period=YYYY-MM)
 * POST   — create  body: { title, hypothesis, category, success_metric, ... }
 * PATCH  — update  body: { id, ...fields }
 * DELETE — delete  ?id=...
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const url      = new URL(req.url)
  const status   = url.searchParams.get('status')          // optional filter
  const period   = url.searchParams.get('period')          // optional 'YYYY-MM'
  const db       = createServiceClient()

  let q = db
    .from('experiments')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('updated_at', { ascending: false })

  if (status) q = q.eq('status', status)
  if (period) q = q.eq('period_started', period)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ experiments: data ?? [] })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => ({}))
  const siteSlug = resolveSiteSlugFromRequest(req, body)
  const db = createServiceClient()

  const { title, hypothesis, category, success_metric, baseline_value,
          target_value, linked_keywords, linked_pages, source,
          source_context, period_started } = body

  if (!title?.trim()) return NextResponse.json({ error: 'title required' }, { status: 400 })

  // Default period_started to current month if not supplied.
  const now = new Date()
  const defaultPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const { data, error } = await db
    .from('experiments')
    .insert({
      owner_user_id:   ownerId,
      site_slug:       siteSlug,
      title:           String(title).trim(),
      hypothesis:      hypothesis?.trim() ?? null,
      category:        category?.trim() ?? null,
      success_metric:  success_metric?.trim() ?? null,
      baseline_value:  baseline_value ?? null,
      target_value:    target_value ?? null,
      linked_keywords: Array.isArray(linked_keywords) ? linked_keywords.filter(Boolean) : [],
      linked_pages:    Array.isArray(linked_pages)    ? linked_pages.filter(Boolean)    : [],
      source:          source ?? 'manual',
      source_context:  source_context ?? null,
      status:          'start',
      period_started:  period_started ?? defaultPeriod,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ experiment: data })
}

export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => ({}))
  const { id, ...fields } = body
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  // Whitelist editable fields. Lifecycle transitions need extra logic
  // (period_ended fill on stop, decision_notes on stop). Keep simple — clients
  // pass status='stop' + decision_notes; we stamp period_ended.
  const updates: Record<string, unknown> = {}
  const allowed = [
    'title', 'hypothesis', 'category', 'success_metric',
    'baseline_value', 'target_value', 'current_value',
    'linked_keywords', 'linked_pages', 'status',
    'decision_notes', 'outcome', 'period_started',
  ]
  for (const k of allowed) {
    if (fields[k] !== undefined) updates[k] = fields[k]
  }

  // Auto-stamp period_ended when transitioning to stop. Don't unstamp on
  // re-activation since the prior end month is still historically true.
  if (fields.status === 'stop' && !fields.period_ended) {
    const now = new Date()
    updates.period_ended = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  }

  // RLS via supabase user client (anon) — the service client would bypass
  // ownership checks. Since the row is small, RLS path is fine here.
  const { data, error } = await supabase
    .from('experiments')
    .update(updates)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ experiment: data })
}

export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await supabase
    .from('experiments')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
