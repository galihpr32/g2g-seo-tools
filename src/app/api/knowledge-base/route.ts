import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

// ── GET /api/knowledge-base ───────────────────────────────────────────────────
// Returns items for the active site PLUS any 'brand' rows tagged with site
// slug '*' (workspace-wide brand definitions that apply to every brand).
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const { data, error } = await db
    .from('knowledge_base_items')
    .select('id, category, name, data, site_slug, created_at, updated_at')
    .eq('owner_user_id', ownerId)
    .in('site_slug', [siteSlug, '*'])
    .order('category').order('name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}

// ── POST /api/knowledge-base — create item ────────────────────────────────────
// Body: { category, name, data, site_slug? }
//   site_slug = '*' for workspace-wide brand rows; omit (or pass active slug)
//   for site-specific category/platform rows.
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const body = await request.json() as {
    category: string
    name: string
    data: Record<string, unknown>
    site_slug?: string
  }

  if (!body.category || !body.name?.trim()) {
    return NextResponse.json({ error: 'category and name are required' }, { status: 400 })
  }

  // Resolve target site_slug:
  //   - If body.site_slug='*' explicitly → workspace-wide (brand-level)
  //   - Else → fall back to active site (cookie/query)
  const activeSlug   = resolveSiteSlugFromRequest(request, body)
  const targetSlug   = body.site_slug === '*' ? '*' : activeSlug

  const { data: item, error } = await db
    .from('knowledge_base_items')
    .upsert({
      owner_user_id: ownerId,
      site_slug:     targetSlug,
      category:      body.category,
      name:          body.name.trim(),
      data:          body.data ?? {},
    }, { onConflict: 'owner_user_id,site_slug,category,name' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item })
}
