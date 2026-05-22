import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { buildContentKit } from '@/lib/content-kit/builder'
import type { BuildKitInput } from '@/lib/content-kit/types'

export const runtime     = 'nodejs'
export const maxDuration = 60
export const dynamic     = 'force-dynamic'

/**
 * Sprint CKB.3 — Start a new Content Kit build.
 *
 * POST /api/content-kit/build
 * Body: {
 *   product_tier_id:    string  (required)
 *   primary_keyword_id: string  (required)
 *   target_sections?:   number  (default 6, max 10)
 *   include_diy?:       boolean (default false; opt-in counter-content)
 * }
 *
 * Returns 202 with { kit_id } immediately. The actual build runs in the
 * background via Next's after() so the HTTP response doesn't hang for 45s.
 * Client should poll GET /api/content-kit/:id for status.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    product_tier_id?:    string
    primary_keyword_id?: string
    target_sections?:    number
    include_diy?:        boolean
  }
  const productTierId    = String(body.product_tier_id ?? '').trim()
  const primaryKeywordId = String(body.primary_keyword_id ?? '').trim()
  if (!productTierId || !primaryKeywordId) {
    return NextResponse.json({ error: 'product_tier_id and primary_keyword_id required' }, { status: 400 })
  }

  // Validate the (product, keyword) belongs to caller's workspace
  const { data: kw } = await db
    .from('tier_keywords')
    .select('id, keyword, product_tier_id, owner_user_id, cluster_market, cluster_language')
    .eq('id', primaryKeywordId)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (!kw || kw.product_tier_id !== productTierId) {
    return NextResponse.json({ error: 'keyword/product mismatch or not found' }, { status: 404 })
  }
  const market   = (kw.cluster_market   === 'id' ? 'id' : 'us') as 'us' | 'id'
  const language = (kw.cluster_language === 'id' ? 'id' : 'en') as 'en' | 'id'

  // Supersede any prior non-superseded kit for this (product × primary KW)
  await db
    .from('content_kits')
    .update({ status: 'superseded', updated_at: new Date().toISOString() })
    .eq('owner_user_id',      ownerId)
    .eq('product_tier_id',    productTierId)
    .eq('primary_keyword_id', primaryKeywordId)
    .neq('status',            'superseded')

  // Insert the new pending row
  const { data: kit, error: insertErr } = await db
    .from('content_kits')
    .insert({
      owner_user_id:      ownerId,
      product_tier_id:    productTierId,
      primary_keyword_id: primaryKeywordId,
      primary_keyword:    String(kw.keyword),
      market,
      language,
      status:             'pending',
    })
    .select('id')
    .single()

  if (insertErr || !kit) {
    return NextResponse.json({ error: insertErr?.message ?? 'insert failed' }, { status: 500 })
  }

  const kitId = String(kit.id)
  const input: BuildKitInput = {
    ownerId,
    productTierId,
    primaryKeywordId,
    primaryKeyword:    String(kw.keyword),
    market,
    language,
    targetSections:    body.target_sections,
    includeDiyCounter: body.include_diy,
  }

  // Schedule the real build to run AFTER the HTTP response. The client polls
  // /api/content-kit/:id until status flips to 'ready' (or 'failed').
  after(async () => {
    const buildDb = createServiceClient()
    try {
      await buildDb.from('content_kits').update({
        status: 'building', build_started_at: new Date().toISOString(),
      }).eq('id', kitId)

      const kitData = await buildContentKit(buildDb, input)

      await buildDb.from('content_kits').update({
        status:             'ready',
        kit_data:           kitData,
        build_completed_at: new Date().toISOString(),
        updated_at:         new Date().toISOString(),
      }).eq('id', kitId)
    } catch (err) {
      console.error('[content-kit build] failed:', err)
      await buildDb.from('content_kits').update({
        status:        'failed',
        error_message: err instanceof Error ? err.message : String(err),
        updated_at:    new Date().toISOString(),
      }).eq('id', kitId)
    }
  })

  return NextResponse.json({
    ok:        true,
    kit_id:    kitId,
    status:    'pending',
    poll_url:  `/api/content-kit/${kitId}`,
    estimate:  { runtime_seconds: 45, cost_usd: 0.037 },
  }, { status: 202 })
}
