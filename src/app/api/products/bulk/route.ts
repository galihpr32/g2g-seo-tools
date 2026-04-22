import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 30

interface ProductInput {
  name: string
  page_url: string
  keywords: string[]
  market?: string
  notes?: string | null
}

// POST /api/products/bulk — batch insert tracked products
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const body = await req.json().catch(() => ({}))

  const { products } = body as { products?: ProductInput[] }
  if (!Array.isArray(products) || products.length === 0) {
    return NextResponse.json({ error: 'products array is required' }, { status: 400 })
  }

  // Validate each product
  const valid = products.filter(p => p.name?.trim() && p.page_url?.trim())
  if (valid.length === 0) {
    return NextResponse.json({ error: 'No valid products to insert' }, { status: 400 })
  }

  const rows = valid.map(p => ({
    owner_user_id: ownerId,
    name:          p.name.trim(),
    page_url:      p.page_url.trim(),
    keywords:      Array.isArray(p.keywords) ? p.keywords.filter(Boolean) : [],
    market:        p.market ?? 'us',
    notes:         p.notes?.trim() ?? null,
  }))

  // Skip products whose page_url already exists for this owner
  const { data: existing } = await db
    .from('tracked_products')
    .select('page_url')
    .eq('owner_user_id', ownerId)

  const existingUrls = new Set((existing ?? []).map(r => r.page_url))
  const toInsert = rows.filter(r => !existingUrls.has(r.page_url))

  if (toInsert.length === 0) {
    return NextResponse.json({ inserted: 0, skipped: rows.length, message: 'All products already exist' })
  }

  const { data, error } = await db
    .from('tracked_products')
    .insert(toInsert)
    .select()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    inserted: data?.length ?? 0,
    skipped:  rows.length - (data?.length ?? 0),
    products: data,
  })
}
