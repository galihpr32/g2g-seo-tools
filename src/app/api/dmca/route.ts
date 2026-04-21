import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// ── GET /api/dmca ─────────────────────────────────────────────────────────────
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { data, error } = await db
    .from('dmca_terms')
    .select('id, original_term, replacement_term, notes, active, created_at')
    .eq('owner_user_id', ownerId)
    .order('original_term')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ terms: data ?? [] })
}

// ── POST /api/dmca — create term ──────────────────────────────────────────────
// Body: { original_term, replacement_term, notes? }
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const body = await request.json() as {
    original_term: string
    replacement_term: string
    notes?: string
  }

  if (!body.original_term?.trim() || !body.replacement_term?.trim()) {
    return NextResponse.json(
      { error: 'original_term and replacement_term are required' },
      { status: 400 }
    )
  }

  const { data: term, error } = await db
    .from('dmca_terms')
    .upsert({
      owner_user_id:    ownerId,
      original_term:    body.original_term.trim(),
      replacement_term: body.replacement_term.trim(),
      notes:            body.notes?.trim() ?? null,
      active:           true,
    }, { onConflict: 'owner_user_id,original_term' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ term })
}
