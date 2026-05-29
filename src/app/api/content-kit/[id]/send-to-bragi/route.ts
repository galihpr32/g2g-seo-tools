import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getSiteUrlForSlug } from '@/lib/agents/site-helpers'
import { kitToBriefNotes } from '@/lib/content-kit/to-brief'
import type { ContentKitData } from '@/lib/content-kit/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Sprint CKB.5 — Send a ready Content Kit to Bragi as an enriched brief.
 *
 * POST /api/content-kit/:id/send-to-bragi
 * Body: { output_type?: 'optimize_existing' | 'new_page' }
 *
 * 1. Validates kit ownership + status='ready'
 * 2. Resolves product URL + site_url for the brief row
 * 3. Assembles a rich `notes` string via kitToBriefNotes (section blueprint,
 *    FAQ, fan-out, cross-links, gap analysis, schema)
 * 4. Inserts seo_content_briefs row with status='draft'
 * 5. Records brief_id back on content_kits and flips status='sent_to_bragi'
 *
 * Bragi picks up draft briefs via /api/cron/process-briefs (existing cron).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as { output_type?: string }
  const outputType = body.output_type === 'new_page' ? 'new_page' : 'optimize_existing'

  // ─── 1. Lookup kit + verify state ────────────────────────────────────────
  const { data: kit } = await db
    .from('content_kits')
    .select(`
      id, status, kit_data, product_tier_id, primary_keyword_id, primary_keyword,
      market, language
    `)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (!kit) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (kit.status !== 'ready') {
    return NextResponse.json({ error: `kit status ${kit.status} not sendable (need 'ready')` }, { status: 409 })
  }
  const kitData = kit.kit_data as ContentKitData | null
  if (!kitData) return NextResponse.json({ error: 'kit_data missing' }, { status: 500 })

  // ─── 2. Resolve product + site URLs ──────────────────────────────────────
  const { data: product } = await db
    .from('product_tiers')
    .select('id, product_name, url, site_slug')
    .eq('id', kit.product_tier_id)
    .maybeSingle()
  if (!product) return NextResponse.json({ error: 'product not found' }, { status: 404 })

  const siteSlug = String(product.site_slug ?? 'g2g')
  const site = await getSiteUrlForSlug(db, siteSlug)
  const pageUrl: string = (product.url as string | null) ?? `${site.siteUrl.replace(/\/+$/, '')}/`

  // ─── 3. Assemble brief notes (this is the kit hand-off vehicle) ──────────
  const notes = kitToBriefNotes({
    kitId:          String(kit.id),
    primaryKeyword: String(kit.primary_keyword),
    productName:    String(product.product_name),
    data:           kitData,
  })

  // ─── 4. Insert brief into Bragi queue ────────────────────────────────────
  const { data: newBrief, error: insertErr } = await db
    .from('seo_content_briefs')
    .insert({
      owner_user_id:   ownerId,
      site_url:        site.siteUrl,
      page:            pageUrl,
      brief_type:      outputType === 'new_page' ? 'create_from_scratch' : 'optimize_existing',
      primary_keyword: String(kit.primary_keyword),
      status:          'draft',
      notes,
    })
    .select('id')
    .single()
  if (insertErr || !newBrief) {
    return NextResponse.json({ error: insertErr?.message ?? 'brief insert failed' }, { status: 500 })
  }

  // ─── 5. Link brief_id back to kit + flip status ──────────────────────────
  const { error: updErr } = await db
    .from('content_kits')
    .update({
      status:           'sent_to_bragi',
      brief_id:         newBrief.id,
      sent_to_bragi_at: new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    })
    .eq('id',            id)
    .eq('owner_user_id', ownerId)
  if (updErr) {
    // Brief inserted but link failed — still return success (brief exists).
    console.warn('[content-kit send-to-bragi] kit link failed but brief exists:', updErr.message)
  }

  return NextResponse.json({
    ok:           true,
    kit_id:       id,
    brief_id:     newBrief.id,
    output_type:  outputType,
    page_url:     pageUrl,
    status:       'sent_to_bragi',
    next_step:    `Brief queued (status=draft). Bragi cron will generate within minutes. Track at /content/briefs/${newBrief.id}`,
  })
}
