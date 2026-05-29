import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { autoTuneMimirMemories } from '@/lib/agents/mimir-memory'

export const maxDuration = 60

/**
 * GET /api/cron/mimir-tune
 *
 * Sprint MIMIR.POLISH.3 — Weekly importance auto-tuner.
 *
 * Rules per memory (defined in autoTuneMimirMemories):
 *   • last_applied_at null OR >60d  → importance -10 (floor 30)
 *   • last_applied_at within 7d     → importance +5  (cap 100, +15 for lessons)
 *   • otherwise unchanged
 * Sets last_tuned_at to make re-runs in same week idempotent.
 *
 * Suggested schedule: Monday 02:00 UTC. Plays nice with Friday KPI digest
 * since Friday's report can include "X memories decayed, Y boosted" stats.
 *
 * Auth: Bearer CRON_SECRET.
 */
function isCronAuth(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(request: Request) {
  if (!isCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Tune across all configured workspace owners. Today we only have G2G;
  // when OffGamers shares the same DB this picks up automatically.
  const owners = [process.env.G2G_OWNER_USER_ID, process.env.OG_OWNER_USER_ID]
    .filter((o): o is string => typeof o === 'string' && o.length > 0)
    .filter((o, i, arr) => arr.indexOf(o) === i)   // dedupe

  if (owners.length === 0) {
    return NextResponse.json({ error: 'No owners configured (set G2G_OWNER_USER_ID)' }, { status: 500 })
  }

  const db = createServiceClient()
  const results = []
  for (const ownerId of owners) {
    const result = await autoTuneMimirMemories(db, ownerId)
    results.push({ ownerId, ...result })
  }

  return NextResponse.json({
    ok:        results.every(r => r.errors.length === 0),
    tuned_at:  new Date().toISOString(),
    per_owner: results,
    summary: {
      total_seen: results.reduce((s, r) => s + r.total_seen, 0),
      decayed:    results.reduce((s, r) => s + r.decayed,    0),
      boosted:    results.reduce((s, r) => s + r.boosted,    0),
      unchanged:  results.reduce((s, r) => s + r.unchanged,  0),
    },
  })
}
