import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * Sprint MIMIR.POLISH.2 — Product dropdown source.
 *
 * GET /api/mimir/memories/products
 *
 * Returns the list of product_tier_ids that have at least one mimir_memory,
 * joined with product_tiers for the human-readable name. Plus a memory count
 * per product so the dropdown can show "BNS NEO (12)".
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Step 1 — pull all memories with product_tier_id set, group by it.
  const { data: memRows, error: memErr } = await db
    .from('mimir_memories')
    .select('product_tier_id')
    .eq('owner_user_id', ownerId)
    .eq('archived', false)
    .not('product_tier_id', 'is', null)
  if (memErr) return NextResponse.json({ error: memErr.message }, { status: 500 })

  const countByProduct = new Map<string, number>()
  for (const row of memRows ?? []) {
    if (!row.product_tier_id) continue
    countByProduct.set(row.product_tier_id, (countByProduct.get(row.product_tier_id) ?? 0) + 1)
  }
  const productIds = Array.from(countByProduct.keys())
  if (productIds.length === 0) return NextResponse.json({ products: [] })

  // Step 2 — fetch product names
  const { data: products, error: prodErr } = await db
    .from('product_tiers')
    .select('id, product_name, tier, market, category, site_slug')
    .in('id', productIds)
  if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 500 })

  const result = (products ?? [])
    .map(p => ({
      id:           p.id as string,
      product_name: p.product_name as string,
      tier:         p.tier as number | null,
      market:       p.market as string | null,
      category:     p.category as string | null,
      site_slug:    p.site_slug as string,
      memory_count: countByProduct.get(p.id as string) ?? 0,
    }))
    .sort((a, b) => b.memory_count - a.memory_count)

  return NextResponse.json({ products: result })
}
