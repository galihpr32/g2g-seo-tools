import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

export const maxDuration = 120

/**
 * GET /api/cron/brief-outcomes-classify
 *
 * Daily cron — classifies every brief_outcomes row that has reached the
 * +30 day mark but doesn't yet have a category_30d. Pure deterministic
 * scoring (no LLM) — reads pos_0 / pos_30 / clicks_0 / clicks_30 and
 * writes one of:
 *   winner  — pos improved ≥3 OR clicks ≥1.5× baseline
 *   loser   — pos worsened ≥3 OR clicks ≤0.7× baseline
 *   flat    — neither
 *   no_data — pos_30 missing (page not indexed / no impressions yet)
 *
 * This closes the OTHER feedback loop besides KB: it answers "did the
 * brief actually work?" 30 days after publish, deterministically. The
 * Heimdall→KB loop already learned what features predict success; this
 * loop tells us per-brief whether the prediction held.
 *
 * Output is consumed by /team-performance + the monthly report's
 * winners/losers extraction (Sprint 1.1 cron).
 *
 * Auth: Bearer CRON_SECRET.
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

interface OutcomeRow {
  id:            string
  brief_id:      string
  owner_user_id: string
  pos_0:         number | null
  pos_30:        number | null
  clicks_0:      number | null
  clicks_30:     number | null
  snapshot_30_at: string | null
}

function classify(row: OutcomeRow): { category: string; reason: string } {
  const { pos_0, pos_30, clicks_0, clicks_30 } = row

  if (pos_30 == null) {
    return { category: 'no_data', reason: 'No GSC position at +30d — page may not be indexed yet.' }
  }

  // Position delta — lower is better
  const posDelta    = pos_0 != null ? pos_0 - pos_30 : null     // +ve = improved
  const clicksRatio = (clicks_0 != null && clicks_0 > 0)
    ? (clicks_30 ?? 0) / clicks_0
    : null

  // Winner gates
  if (posDelta != null && posDelta >= 3) {
    return { category: 'winner', reason: `Position improved ${posDelta.toFixed(1)} ranks (${pos_0?.toFixed(1)} → ${pos_30.toFixed(1)}).` }
  }
  if (clicksRatio != null && clicksRatio >= 1.5) {
    return { category: 'winner', reason: `Clicks ${clicksRatio.toFixed(2)}× baseline (${clicks_0} → ${clicks_30}).` }
  }
  // First-time-ranking case: pos_0 was null (didn't rank), now ranks in top 20
  if (pos_0 == null && pos_30 <= 20) {
    return { category: 'winner', reason: `New page entered SERP at position ${pos_30.toFixed(1)}.` }
  }

  // Loser gates
  if (posDelta != null && posDelta <= -3) {
    return { category: 'loser', reason: `Position dropped ${Math.abs(posDelta).toFixed(1)} ranks (${pos_0?.toFixed(1)} → ${pos_30.toFixed(1)}).` }
  }
  if (clicksRatio != null && clicksRatio <= 0.7 && (clicks_0 ?? 0) >= 5) {
    return { category: 'loser', reason: `Clicks fell to ${clicksRatio.toFixed(2)}× baseline (${clicks_0} → ${clicks_30}).` }
  }

  return { category: 'flat', reason: 'Position and clicks unchanged within thresholds.' }
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Only classify rows that:
  //   1. Have snapshot_30_at populated (the +30d snapshot ran)
  //   2. Don't yet have category_30d (idempotent — won't re-classify)
  const { data: rows, error } = await db
    .from('brief_outcomes')
    .select('id, brief_id, owner_user_id, pos_0, pos_30, clicks_0, clicks_30, snapshot_30_at')
    .not('snapshot_30_at', 'is', null)
    .is('category_30d', null)
    .limit(500)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const stats = { examined: rows?.length ?? 0, winners: 0, losers: 0, flat: 0, no_data: 0, errors: 0 }

  for (const row of (rows ?? []) as OutcomeRow[]) {
    const { category, reason } = classify(row)
    stats[category as 'winners' | 'losers' | 'flat' | 'no_data'] = (stats as Record<string, number>)[category === 'winner' ? 'winners' : category === 'loser' ? 'losers' : category] + 0  // typing nudge
    // Counter increments
    if (category === 'winner') stats.winners++
    else if (category === 'loser') stats.losers++
    else if (category === 'flat') stats.flat++
    else stats.no_data++

    const { error: upErr } = await db
      .from('brief_outcomes')
      .update({
        category_30d:     category,
        category_30d_at:  new Date().toISOString(),
        category_reason:  reason,
      })
      .eq('id', row.id)
    if (upErr) stats.errors++
  }

  return NextResponse.json({ ok: stats.errors === 0, when: new Date().toISOString(), stats })
}
