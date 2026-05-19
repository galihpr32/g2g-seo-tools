import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * Sprint T1.MANUAL.INPUT — Manual signal capture for T1/T2 priority products.
 *
 * The pipeline used to be fully passive (Heimdall/Loki/Saga detected opps;
 * Bragi wrote briefs from those). For T1 products we explicitly want a human
 * channel: the SEO lead types an observation, the system routes it to the
 * right place AND mirrors it into mimir_memories so Bragi/Mimir learns over
 * time.
 *
 *   kind=note          → mimir_memory only (no pipeline action). E.g.
 *                        "for BNS NEO, always emphasize the launch date urgency".
 *
 *   kind=opportunity   → seo_opportunity row (with status='new') AND a mimir_memory
 *                        so the manual signal still feeds memory learning.
 *
 *   kind=direct_brief  → seo_content_brief draft (so Bragi can pick it up later)
 *                        AND mirror to mimir_memory.
 *
 * Mimir mirror is the key insight — every manual input becomes both an action
 * (when applicable) and durable context for future briefs.
 */

const VALID_KINDS = ['note', 'opportunity', 'direct_brief'] as const
type Kind = typeof VALID_KINDS[number]

const VALID_CATEGORIES = ['preference', 'fact', 'rule', 'lesson'] as const

interface PostBody {
  kind:            Kind
  content:         string
  // optional
  category?:       string                  // memory category (preference/fact/rule/lesson)
  tags?:           string[]                // for kind=note
  topic?:          string                  // for kind=opportunity
  target_url?:     string                  // for kind=opportunity or direct_brief
  primary_keyword?: string                 // for kind=direct_brief
  importance?:     number
  // Sprint MIMIR.NOTES.APPLY — propagate this note to category peers
  apply_to_category?: boolean
}

export async function POST(
  req:  Request,
  ctx:  { params: Promise<{ id: string }> },
) {
  const { id: productId } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  // 1. Load the product (need tier, site_slug, name, relation_id for the signal)
  const { data: product, error: prodErr } = await db
    .from('product_tiers')
    .select('id, tier, site_slug, market, product_name, category, relation_id, url')
    .eq('id', productId)
    .eq('owner_user_id', ownerId)
    .single()

  if (prodErr || !product) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }

  // 2. Parse + validate body
  const body = await req.json().catch(() => ({})) as Partial<PostBody>
  const kind = String(body.kind ?? '').trim() as Kind
  if (!VALID_KINDS.includes(kind)) {
    return NextResponse.json({ error: `kind must be one of ${VALID_KINDS.join('|')}` }, { status: 400 })
  }
  const content = String(body.content ?? '').trim()
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 })
  if (content.length > 1000) {
    return NextResponse.json({ error: 'content too long (max 1000 chars)' }, { status: 400 })
  }

  const created: {
    memory_id?:      string | null
    opportunity_id?: string | null
    brief_id?:       string | null
  } = {}

  // 3. Branch by kind
  if (kind === 'opportunity') {
    const topic = String(body.topic ?? product.product_name).trim()
    if (!topic) return NextResponse.json({ error: 'topic required for opportunity' }, { status: 400 })
    const topicSlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)

    // Upsert by (owner, site, topic_slug) — see seo_opportunities unique index
    const { data: oppRow, error: oppErr } = await db
      .from('seo_opportunities')
      .upsert({
        owner_user_id: ownerId,
        site_slug:     product.site_slug,
        topic,
        topic_slug:    topicSlug,
        target_url:    body.target_url ?? product.url ?? null,
        status:        'new',
        heimdall_signals: [{
          action_id:  `manual_${Date.now()}`,
          source:     'manual_signal',
          summary:    content,
          tier:       product.tier,
          tier_id:    product.id,
          created_at: new Date().toISOString(),
          created_by: user.id,
        }],
        signal_count:    1,
        last_signal_at:  new Date().toISOString(),
      }, { onConflict: 'owner_user_id,site_slug,topic_slug' })
      .select('id')
      .single()

    if (oppErr) {
      return NextResponse.json({ error: `opportunity insert failed: ${oppErr.message}` }, { status: 500 })
    }
    created.opportunity_id = oppRow?.id ?? null
  }

  if (kind === 'direct_brief') {
    const primaryKeyword = String(body.primary_keyword ?? product.product_name).trim()
    if (!primaryKeyword) {
      return NextResponse.json({ error: 'primary_keyword required for direct_brief' }, { status: 400 })
    }

    // Resolve site_url from site_configs (briefs table requires site_url not just site_slug)
    const { data: siteConfig } = await db
      .from('site_configs')
      .select('gsc_property')
      .eq('slug', product.site_slug)
      .eq('is_active', true)
      .maybeSingle()
    const siteUrl = siteConfig?.gsc_property ?? `https://www.${product.site_slug}.com`

    const { data: briefRow, error: briefErr } = await db
      .from('seo_content_briefs')
      .insert({
        owner_user_id:   ownerId,
        site_slug:       product.site_slug,
        site_url:        siteUrl,
        page:            body.target_url ?? product.url ?? null,
        brief_type:      'on_page',
        primary_keyword: primaryKeyword,
        status:          'draft',
        output_type:     'optimize_existing',
        notes:           `[Manual signal from T${product.tier} product: ${product.product_name}]\n\n${content}`,
      })
      .select('id')
      .single()

    if (briefErr) {
      return NextResponse.json({ error: `brief insert failed: ${briefErr.message}` }, { status: 500 })
    }
    created.brief_id = briefRow?.id ?? null
  }

  // 4. ALWAYS mirror to mimir_memories — every kind feeds learning
  //    Content over 280 chars gets the first 280 (table cap), but we keep the
  //    full text in tags-prefix via the notes-style summary.
  const memoryContent = content.slice(0, 280)
  const category = VALID_CATEGORIES.includes(body.category as typeof VALID_CATEGORIES[number])
    ? body.category!
    : (kind === 'note' ? 'preference' : 'fact')

  const memoryTags = [
    `t${product.tier}`,
    product.market ?? 'us',
    ...(product.category ? [String(product.category).toLowerCase().replace(/\s+/g, '_')] : []),
    ...(Array.isArray(body.tags) ? body.tags.slice(0, 3) : []),
    'manual_signal',
  ]
    .map(t => String(t).toLowerCase().slice(0, 32))
    .slice(0, 6)

  const { data: memRow, error: memErr } = await db
    .from('mimir_memories')
    .insert({
      owner_user_id:   ownerId,
      scope:           'product',
      site_slug:       product.site_slug,
      relation_id:     product.relation_id ?? null,
      product_tier_id: product.id,
      tier:            product.tier,
      market:          product.market ?? null,
      category,
      content:         memoryContent,
      tags:            memoryTags,
      importance:      typeof body.importance === 'number'
        ? Math.max(0, Math.min(100, body.importance))
        : (product.tier === 1 ? 80 : 70),
      source_kind:     'manual',
      // Sprint MIMIR.NOTES.APPLY — denormalize product category so retriever
      // can find category peers without joining product_tiers.
      product_category:  product.category ?? null,
      apply_to_category: !!body.apply_to_category,
    })
    .select('id')
    .single()

  if (memErr) {
    // Memory failure is not fatal — the action already happened. Log and continue.
    console.warn('[priority-products/signal] memory insert failed:', memErr.message)
  }
  created.memory_id = memRow?.id ?? null

  return NextResponse.json({
    ok:      true,
    kind,
    product: { id: product.id, name: product.product_name, tier: product.tier },
    created,
  })
}

/**
 * GET /api/priority-products/[id]/signal
 *
 * Returns recent manual signals for this product so the modal can show "last
 * 5 notes" history.
 */
export async function GET(
  req:  Request,
  ctx:  { params: Promise<{ id: string }> },
) {
  const { id: productId } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  // Memories scoped to this tier-product
  const { data: memories } = await db
    .from('mimir_memories')
    .select('id, content, category, tags, importance, created_at, source_kind')
    .eq('owner_user_id', ownerId)
    .eq('product_tier_id', productId)
    .eq('archived', false)
    .order('created_at', { ascending: false })
    .limit(15)

  return NextResponse.json({ memories: memories ?? [] })
}
