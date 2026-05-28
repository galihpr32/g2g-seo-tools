import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { buildActionPlan } from '@/lib/reports/action-plan-synthesizer'

export const maxDuration = 60

/**
 * Sprint FRIDAY.KPI.GRAPH.2 — fetch the 3-item action plan for a given
 * (week × brand). Reads from manual overrides first, fills empty slots
 * from Haiku synthesis of cross-agent signals (Mimir/Forseti/Hugin/Loki/SERP).
 *
 * GET /api/reports/friday-kpi/action-plan?week=2026-W21&brand=g2g
 */
function currentWeekIso(): string {
  const d = new Date()
  // ISO week calc
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNr = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const weekNum = 1 + Math.round(((target.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const url   = new URL(req.url)
  const week  = url.searchParams.get('week')  || currentWeekIso()
  const brand = (url.searchParams.get('brand') || 'g2g').toLowerCase()

  try {
    const plan = await buildActionPlan({
      db, ownerId,
      siteSlug: brand,
      weekIso:  week,
    })
    return NextResponse.json({ ok: true, week, brand, plan })
  } catch (err) {
    return NextResponse.json({
      ok:    false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 })
  }
}
