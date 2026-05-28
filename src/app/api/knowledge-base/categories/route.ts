import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 10

/**
 * GET /api/knowledge-base/categories
 *
 * Returns the canonical list of product categories for the current owner ×
 * site, sourced from knowledge_base_items where category='category'. This is
 * THE single source of truth — tier admin dropdowns, filter pickers, bulk
 * insert flows all read from here so naming stays consistent across the app.
 *
 * Response shape:
 *   {
 *     categories: [{ name: 'Top Up', description?: string, ... }]
 *   }
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const { data, error } = await db
    .from('knowledge_base_items')
    .select('name, data')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('category', 'category')
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const categories = (data ?? []).map(r => {
    const d = (r.data ?? {}) as Record<string, unknown>
    return {
      name:                  String(r.name),
      description:           (d.description  as string) ?? '',
      buyer_intent:          (d.buyer_intent as string) ?? '',
      angle:                 (d.angle        as string) ?? '',
      // Optional manual override — pin a specific catalog service_name for
      // this KB category. When absent, mapping lib falls back to fuzzy match.
      catalog_service_match: (d.catalog_service_match as string) ?? null,
    }
  })

  return NextResponse.json({ categories })
}
