import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * /api/knowledge-base/proposals
 *
 * Review queue for KB rule proposals from any source (cron extractor,
 * brief-promote button, experiment-promote button).
 *
 * GET    — list, filterable by ?status=pending|approved|rejected|applied
 * POST   — create (used by Promote-to-KB buttons + manual entries)
 * PATCH  — update status / review_notes; on status='applied' also update
 *          applied_kb_item_id + applied_kb_field
 * DELETE — remove a proposal entirely (for cleanup; rare)
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const url      = new URL(req.url)
  const status   = url.searchParams.get('status')
  const source   = url.searchParams.get('source')
  const limit    = Math.max(10, Math.min(200, Number(url.searchParams.get('limit') ?? '50')))

  const db = createServiceClient()
  let q = db
    .from('kb_rule_proposals')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status) q = q.eq('status', status)
  if (source) q = q.eq('source', source)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ proposals: data ?? [] })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body    = await req.json().catch(() => ({}))
  const siteSlug = resolveSiteSlugFromRequest(req, body)
  const db = createServiceClient()

  const { title, rule_text, pattern_kind, source, source_brief_ids,
          source_loser_ids, source_experiment_id, suggested_kb_item_id,
          suggested_kb_field, confidence } = body

  if (!title?.trim() || !rule_text?.trim()) {
    return NextResponse.json({ error: 'title and rule_text required' }, { status: 400 })
  }

  const allowedKinds = ['winning','cautionary','exclusion','tone','format','generic']
  const allowedSources = ['cron_extractor','brief_promote','experiment_promote','manual']

  const { data, error } = await db
    .from('kb_rule_proposals')
    .insert({
      owner_user_id:        ownerId,
      site_slug:            siteSlug,
      title:                String(title).trim(),
      rule_text:            String(rule_text).trim(),
      pattern_kind:         allowedKinds.includes(pattern_kind) ? pattern_kind : 'generic',
      source:               allowedSources.includes(source) ? source : 'manual',
      source_brief_ids:     Array.isArray(source_brief_ids) ? source_brief_ids.filter(Boolean) : [],
      source_loser_ids:     Array.isArray(source_loser_ids) ? source_loser_ids.filter(Boolean) : [],
      source_experiment_id: source_experiment_id ?? null,
      suggested_kb_item_id: suggested_kb_item_id ?? null,
      suggested_kb_field:   suggested_kb_field ?? null,
      confidence:           typeof confidence === 'number' ? confidence : null,
      status:               'pending',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ proposal: data })
}

export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body    = await req.json().catch(() => ({}))
  const { id, status, review_notes, applied_kb_item_id, applied_kb_field } = body
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const db = createServiceClient()

  const updates: Record<string, unknown> = {
    status_changed_at: new Date().toISOString(),
    status_changed_by: user.id,
  }
  if (status) {
    if (!['pending','approved','rejected','applied'].includes(status)) {
      return NextResponse.json({ error: 'invalid status' }, { status: 400 })
    }
    updates.status = status
  }
  if (review_notes !== undefined) updates.review_notes = review_notes ?? null
  if (applied_kb_item_id !== undefined) updates.applied_kb_item_id = applied_kb_item_id
  if (applied_kb_field   !== undefined) updates.applied_kb_field   = applied_kb_field
  if (status === 'applied') updates.applied_at = new Date().toISOString()

  // ── Side-effect: when status='applied', actually write into the KB item ──
  // The user picks which item + field to extend. We append the rule_text to
  // an array field (dos/donts/writing_rules) or to a notes string.
  if (status === 'applied' && applied_kb_item_id && applied_kb_field) {
    const { data: proposal, error: pErr } = await db
      .from('kb_rule_proposals')
      .select('rule_text')
      .eq('id', id)
      .eq('owner_user_id', ownerId)
      .single()
    if (pErr || !proposal) {
      return NextResponse.json({ error: 'Proposal not found' }, { status: 404 })
    }

    const { data: item, error: iErr } = await db
      .from('knowledge_base_items')
      .select('id, data')
      .eq('id', applied_kb_item_id)
      .eq('owner_user_id', ownerId)
      .single()
    if (iErr || !item) {
      return NextResponse.json({ error: 'KB item not found' }, { status: 404 })
    }

    const data = (item.data as Record<string, unknown>) ?? {}
    const existing = data[applied_kb_field as string]
    // Heuristic: if existing is array, push. If string, append with newline. If undefined, set.
    if (Array.isArray(existing)) {
      data[applied_kb_field as string] = [...existing, proposal.rule_text]
    } else if (typeof existing === 'string' && existing.length > 0) {
      data[applied_kb_field as string] = `${existing}\n\n${proposal.rule_text}`
    } else {
      data[applied_kb_field as string] = proposal.rule_text
    }

    const { error: uErr } = await db
      .from('knowledge_base_items')
      .update({ data })
      .eq('id', applied_kb_item_id)
      .eq('owner_user_id', ownerId)
    if (uErr) return NextResponse.json({ error: `KB update failed: ${uErr.message}` }, { status: 500 })
  }

  const { data, error } = await db
    .from('kb_rule_proposals')
    .update(updates)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ proposal: data })
}

export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await supabase
    .from('kb_rule_proposals')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
