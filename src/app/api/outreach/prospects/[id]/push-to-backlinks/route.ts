import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * POST /api/outreach/prospects/[id]/push-to-backlinks
 *
 * Creates a paid_backlinks record from an outreach_prospect that has
 * been accepted or published. Idempotent — if a backlink already exists
 * for the same external_url, returns the existing record.
 *
 * Also updates the prospect's status to 'published' if it's currently
 * 'accepted' and a published_url is provided.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()
  const { id }  = await params

  // ── Optional overrides from body ─────────────────────────────────────────
  let bodyOverrides: {
    cost_amount?:   number | null
    cost_currency?: string
    live_date?:     string | null
    notes?:         string
  } = {}
  try { bodyOverrides = await req.json() } catch { /* no body */ }

  // ── Load prospect ────────────────────────────────────────────────────────
  const { data: prospect } = await db
    .from('outreach_prospects')
    .select('*')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .single()

  if (!prospect) return NextResponse.json({ error: 'Prospect not found' }, { status: 404 })

  if (!['accepted', 'published'].includes(prospect.status as string)) {
    return NextResponse.json(
      { error: 'Prospect must be accepted or published before pushing to backlinks' },
      { status: 400 }
    )
  }

  if (!prospect.target_url || !prospect.anchor_text) {
    return NextResponse.json(
      { error: 'Prospect is missing target_url or anchor_text — fill these in first' },
      { status: 400 }
    )
  }

  const externalUrl = (prospect.published_url as string | null) ?? `https://${prospect.domain}`
  const siteName    = String(prospect.domain)

  // ── Idempotency: check if backlink already exists ───────────────────────
  const { data: existing } = await db
    .from('paid_backlinks')
    .select('id, external_url')
    .eq('owner_user_id', ownerId)
    .eq('external_url', externalUrl)
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ ok: true, backlinkId: existing.id, existing: true })
  }

  // ── Create the backlink record ───────────────────────────────────────────
  const { data: backlink, error: insertErr } = await db
    .from('paid_backlinks')
    .insert({
      owner_user_id:  ownerId,
      site_name:      siteName,
      external_url:   externalUrl,
      anchor_text:    prospect.anchor_text,
      target_page:    prospect.target_url,
      target_keyword: (prospect.source_keyword as string | null) ?? null,
      utm_source:     siteName.replace(/\./g, '_'),
      utm_medium:     'referral',
      utm_campaign:   'guestpost',
      link_status:    'active',
      live_date:      (bodyOverrides.live_date ?? prospect.published_date ?? null),
      cost_amount:    bodyOverrides.cost_amount ?? null,
      cost_currency:  bodyOverrides.cost_currency ?? 'USD',
      notes: [
        `Pushed from Outreach tracker (prospect id: ${id})`,
        prospect.topic ? `Topic: ${prospect.topic}` : null,
        bodyOverrides.notes ?? null,
      ].filter(Boolean).join('\n'),
    })
    .select('id')
    .single()

  if (insertErr || !backlink) {
    return NextResponse.json({ error: insertErr?.message ?? 'Insert failed' }, { status: 500 })
  }

  // ── If prospect was 'accepted' and has a published_url, promote to 'published' ─
  if (prospect.status === 'accepted' && prospect.published_url) {
    await db
      .from('outreach_prospects')
      .update({ status: 'published', updated_at: new Date().toISOString() })
      .eq('id', id)
  }

  return NextResponse.json({ ok: true, backlinkId: backlink.id, existing: false })
}
