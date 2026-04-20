import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

// GET /api/keyword-tags
// Returns { tags: { [keyword]: category_name } }
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { data, error } = await supabase
    .from('keyword_tags')
    .select('keyword, category_name')
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const tags: Record<string, string> = {}
  for (const row of data ?? []) {
    tags[row.keyword] = row.category_name
  }

  return NextResponse.json({ tags })
}

// POST /api/keyword-tags
// Body: { keyword: string, category_name: string }
// Upserts — overwrites existing tag for that keyword
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { keyword, category_name } = await req.json()

  if (!keyword?.trim() || !category_name?.trim()) {
    return NextResponse.json({ error: 'keyword and category_name required' }, { status: 400 })
  }

  const { error } = await supabase
    .from('keyword_tags')
    .upsert(
      { owner_user_id: ownerId, keyword: keyword.trim(), category_name: category_name.trim() },
      { onConflict: 'owner_user_id,keyword' }
    )

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// DELETE /api/keyword-tags
// Body: { keyword: string }
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { keyword } = await req.json()

  if (!keyword?.trim()) {
    return NextResponse.json({ error: 'keyword required' }, { status: 400 })
  }

  const { error } = await supabase
    .from('keyword_tags')
    .delete()
    .eq('owner_user_id', ownerId)
    .eq('keyword', keyword.trim())

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
