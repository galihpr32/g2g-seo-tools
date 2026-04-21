import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// ── GET /api/knowledge-base ───────────────────────────────────────────────────
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { data, error } = await db
    .from('knowledge_base_items')
    .select('id, category, name, data, created_at, updated_at')
    .eq('owner_user_id', ownerId)
    .order('category').order('name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}

// ── POST /api/knowledge-base — create item ────────────────────────────────────
// Body: { category, name, data }
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const body = await request.json() as { category: string; name: string; data: Record<string, unknown> }

  if (!body.category || !body.name?.trim()) {
    return NextResponse.json({ error: 'category and name are required' }, { status: 400 })
  }

  const { data: item, error } = await db
    .from('knowledge_base_items')
    .upsert({
      owner_user_id: ownerId,
      category:      body.category,
      name:          body.name.trim(),
      data:          body.data ?? {},
    }, { onConflict: 'owner_user_id,category,name' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item })
}
