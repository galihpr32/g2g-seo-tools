import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

export const maxDuration = 120

/**
 * GET /api/cron/experiment-metric-update
 *
 * Weekly cron — for every active experiment with linked_keywords, pull the
 * latest avg position from keyword_ranking_history (last 7 days) and write
 * to current_value. This eliminates the manual Head step from the PIC
 * roadmap (Workflow #4 step 4.2): "buka tiap experiment, lihat
 * linked_keywords, manually pull latest position…"
 *
 * Logic:
 *   - Active experiment = status IN ('start','continue')
 *   - For each: collect linked_keywords. Pull all keyword_ranking_history
 *     rows in last 7 days that match those keywords AND the same site_slug.
 *   - current_value = mean of last-week positions (rounded to 1 decimal)
 *   - If experiment also has linked_pages, optionally fold in GSC data
 *     (future enhancement — for now: keywords only)
 *
 * Auth: Bearer CRON_SECRET via GitHub Actions.
 */
function isCronAuth(req: Request): boolean {
  const auth = req.headers.get('authorization')
  return auth === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Pull all active experiments across all owners + sites that have linked
  // keywords (we only update those — experiments with empty linked_keywords
  // have no data source and stay manual).
  const { data: experiments, error: expErr } = await db
    .from('experiments')
    .select('id, owner_user_id, site_slug, linked_keywords, current_value, baseline_value, target_value')
    .in('status', ['start', 'continue'])
    .not('linked_keywords', 'is', null)

  if (expErr) {
    return NextResponse.json({ error: expErr.message }, { status: 500 })
  }

  // Filter to experiments with at least one linked keyword
  const candidates = (experiments ?? []).filter(e =>
    Array.isArray(e.linked_keywords) && e.linked_keywords.length > 0
  )

  if (candidates.length === 0) {
    return NextResponse.json({
      ok:        true,
      processed: 0,
      updated:   0,
      message:   'No active experiments with linked_keywords. Nothing to update.',
    })
  }

  // Pull last-7-day position snapshots for all (site, keyword) pairs in scope.
  // Done in one query batched by site_slug to keep round-trips low.
  const since = new Date(Date.now() - 7 * 86400_000).toISOString().split('T')[0]
  const sites = Array.from(new Set(candidates.map(c => String(c.site_slug))))

  const positionsBySiteKw = new Map<string, number[]>()  // key = `${site}|${kw_lower}`
  for (const site of sites) {
    const kwsForSite = Array.from(new Set(
      candidates
        .filter(c => c.site_slug === site)
        .flatMap(c => (c.linked_keywords as string[]) ?? [])
        .map(kw => String(kw).trim())
        .filter(Boolean)
    ))
    if (kwsForSite.length === 0) continue

    const { data: snapshots } = await db
      .from('keyword_ranking_history')
      .select('keyword, position, snapshot_date')
      .eq('site_slug', site)
      .in('keyword', kwsForSite)
      .gte('snapshot_date', since)

    for (const snap of snapshots ?? []) {
      if (snap.position == null) continue
      const key = `${site}|${String(snap.keyword).toLowerCase()}`
      const arr = positionsBySiteKw.get(key) ?? []
      arr.push(Number(snap.position))
      positionsBySiteKw.set(key, arr)
    }
  }

  // For each experiment, compute mean position across linked keywords
  let updated = 0
  const stats: Array<{ id: string; oldVal: number | null; newVal: number | null; sampleCount: number }> = []
  const errors: Array<{ id: string; error: string }> = []

  for (const exp of candidates) {
    const positions: number[] = []
    for (const kw of exp.linked_keywords as string[]) {
      const key = `${exp.site_slug}|${String(kw).toLowerCase()}`
      const arr = positionsBySiteKw.get(key) ?? []
      positions.push(...arr)
    }
    if (positions.length === 0) {
      // No data yet — leave current_value alone, don't overwrite with null
      continue
    }
    const avg = positions.reduce((s, n) => s + n, 0) / positions.length
    const newVal = +avg.toFixed(1)

    // Skip if value unchanged (avoid useless writes / updated_at churn)
    if (exp.current_value != null && Math.abs(Number(exp.current_value) - newVal) < 0.05) {
      continue
    }

    const { error: updErr } = await db
      .from('experiments')
      .update({ current_value: newVal })
      .eq('id', exp.id)

    if (updErr) {
      errors.push({ id: String(exp.id), error: updErr.message })
    } else {
      updated++
      stats.push({
        id:          String(exp.id),
        oldVal:      exp.current_value as number | null,
        newVal,
        sampleCount: positions.length,
      })
    }
  }

  return NextResponse.json({
    ok:         errors.length === 0,
    processed:  candidates.length,
    updated,
    skipped:    candidates.length - updated,
    stats:      stats.slice(0, 30),    // cap response payload
    errors,
    when:       new Date().toISOString(),
  })
}
