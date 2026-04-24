import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// ── GET /api/competitive/keyword-gap/snapshots ────────────────────────────────
// Returns list of saved analyses (metadata only — no full keyword lists)
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { data, error } = await db
    .from('keyword_gap_snapshots')
    .select('id, competitor_domain, location_code, language_code, summary, excluded_count, created_at')
    .eq('owner_user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(30)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ snapshots: data ?? [] })
}

// ── POST /api/competitive/keyword-gap/snapshots ───────────────────────────────
// Saves a full analysis result. Called automatically after each run.
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const {
    competitor_domain,
    location_code,
    language_code,
    summary,
    gaps,
    behind,
    winning,
    excluded_count = 0,
  } = body

  if (!competitor_domain) return NextResponse.json({ error: 'competitor_domain required' }, { status: 400 })

  const { data, error } = await db
    .from('keyword_gap_snapshots')
    .insert({
      owner_user_id: ownerId,
      competitor_domain,
      location_code,
      language_code,
      summary,
      gaps,
      behind,
      winning,
      excluded_count,
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ id: data.id })
}
