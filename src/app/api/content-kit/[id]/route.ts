import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Sprint CKB.3 — Fetch a single Content Kit by id. Used by the UI modal to
 * poll until status flips to 'ready' (or 'failed').
 *
 * GET /api/content-kit/:id
 * Returns: { id, status, primary_keyword, kit_data?, error_message?, ... }
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { data, error } = await db
    .from('content_kits')
    .select(`
      id, owner_user_id, product_tier_id, primary_keyword_id, primary_keyword,
      market, language, status, error_message, kit_data,
      build_started_at, build_completed_at, sent_to_bragi_at, brief_id,
      created_at, updated_at
    `)
    .eq('id',            id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'not found' }, { status: 404 })

  return NextResponse.json({ ok: true, kit: data })
}

/**
 * Sprint CKB.3 — PATCH a Content Kit. Used by UI to:
 *   • Edit/remove individual sections, FAQ entries, fan-out passages
 *   • Adjust cross-links
 *
 * Body: { kit_data: <full updated ContentKitData> }
 *
 * We do a full-replace on kit_data (caller is responsible for sending the
 * complete object). Status must be 'ready' or 'sent_to_bragi' to allow edits.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as { kit_data?: unknown }
  if (!body.kit_data || typeof body.kit_data !== 'object') {
    return NextResponse.json({ error: 'kit_data object required' }, { status: 400 })
  }

  // Verify status is editable + pull the old kit_data for diff (Mimir hook)
  const { data: existing } = await db
    .from('content_kits')
    .select('id, status, kit_data, primary_keyword, product_tier_id, market, language')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (existing.status !== 'ready' && existing.status !== 'sent_to_bragi') {
    return NextResponse.json({ error: `kit status ${existing.status} not editable` }, { status: 409 })
  }

  const { error } = await db
    .from('content_kits')
    .update({ kit_data: body.kit_data, updated_at: new Date().toISOString() })
    .eq('id',            id)
    .eq('owner_user_id', ownerId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // ─── Sprint CKB.5 — Mimir learning hook ─────────────────────────────────
  // Detect what was REMOVED in this edit and record a memory note so future
  // kit builds for similar products skip the same kinds of sections.
  // Best-effort; failures must not block the save.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldData = existing.kit_data as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newData = body.kit_data as any
    const removedSections: string[] = []
    if (oldData?.sections && newData?.sections) {
      const newTargets = new Set((newData.sections as Array<{ target_kw: string }>).map(s => s.target_kw.toLowerCase()))
      for (const s of oldData.sections as Array<{ target_kw: string; h2_title: string }>) {
        if (!newTargets.has(s.target_kw.toLowerCase())) removedSections.push(s.h2_title)
      }
    }
    if (removedSections.length > 0) {
      // Resolve product category for scoped memory
      const { data: prod } = await db
        .from('product_tiers')
        .select('category, product_name, site_slug')
        .eq('id', existing.product_tier_id)
        .maybeSingle()
      const summary = `Kit-edit signal: user removed sections for "${existing.primary_keyword}" → ${removedSections.slice(0, 3).join(' · ')}`
      await db.from('mimir_memories').insert({
        owner_user_id:   ownerId,
        memory_type:     'LESSON',
        summary,
        content:         `When building a content kit for "${existing.primary_keyword}" on ${prod?.product_name ?? 'this product'}, the user removed these sections: ${removedSections.join(', ')}. Avoid suggesting these or close variants for similar (category=${prod?.category ?? 'n/a'}) products.`,
        importance:      6,
        category:        prod?.category ?? null,
        product_name:    prod?.product_name ?? null,
        product_tier_id: existing.product_tier_id,
        site_slug:       prod?.site_slug ?? null,
        market:          existing.market,
        source:          'content_kit_edit',
      })
    }
  } catch (e) {
    console.warn('[content-kit PATCH] Mimir hook failed (non-blocking):', e instanceof Error ? e.message : String(e))
  }

  return NextResponse.json({ ok: true })
}

/**
 * DELETE — remove a kit row entirely. Mostly for testing / cleanup.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { error } = await db
    .from('content_kits')
    .delete()
    .eq('id',            id)
    .eq('owner_user_id', ownerId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
