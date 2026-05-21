import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getFridayKpiCanon, setFridayKpiCanon, type CanonSource } from '@/lib/reports/friday-kpi-canon'

/**
 * Sprint FRIDAY.KPI.GRAPH.1 — small CRUD for the Friday KPI canon source.
 *
 * GET  /api/reports/friday-kpi/canon  → { canon: 'dfs' | 'gsc' }
 * PATCH /api/reports/friday-kpi/canon { canon: 'dfs' | 'gsc' } → { ok, canon }
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const canon = await getFridayKpiCanon(db, ownerId)
  return NextResponse.json({ canon })
}

export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as { canon?: string }
  const canon = (body.canon ?? '').toLowerCase() as CanonSource
  if (canon !== 'dfs' && canon !== 'gsc') {
    return NextResponse.json({ error: 'canon must be "dfs" or "gsc"' }, { status: 400 })
  }
  const result = await setFridayKpiCanon(db, ownerId, canon)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
  return NextResponse.json({ ok: true, canon })
}
