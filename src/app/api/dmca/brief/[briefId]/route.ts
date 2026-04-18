import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

type Params = { params: Promise<{ briefId: string }> }

// ── GET /api/dmca/brief/[briefId] ─────────────────────────────────────────────
// Returns unresolved DMCA hits for a specific brief (used in BriefViewer badge)
export async function GET(_req: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { briefId } = await params

  const { data, error } = await supabase
    .from('dmca_hits')
    .select(`
      id,
      detected_at,
      dmca_terms!inner ( id, original_term, replacement_term )
    `)
    .eq('brief_id', briefId)
    .eq('owner_user_id', ownerId)
    .eq('resolved', false)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ hits: data ?? [] })
}

// ── POST /api/dmca/brief/[briefId]/resolve ─────────────────────────────────────
// (handled as a separate route for clarity — see /dmca/brief/[briefId]/resolve)

// ── DELETE — resolve all hits for a brief (mark as resolved) ──────────────────
export async function DELETE(_req: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { briefId } = await params

  const { error } = await supabase
    .from('dmca_hits')
    .update({ resolved: true, resolved_at: new Date().toISOString() })
    .eq('brief_id', briefId)
    .eq('owner_user_id', ownerId)
    .eq('resolved', false)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
