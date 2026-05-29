import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { fetchSerpForMarket, ourDomainsForSite, type TierMarket } from '@/lib/ranking-tracker'

export const maxDuration = 60

/**
 * POST /api/priority-products/run-baseline/tick
 *
 * Sprint SERP.CHUNKED — processes the next chunk of pairs from a run.
 *
 * Body: { run_id: string, chunk_size?: number (default 25, max 50) }
 * Returns: {
 *   run_id, status, total_pairs, processed_pairs, failed_pairs,
 *   remaining, just_processed, last_tick_at,
 * }
 *
 * Math: 25 parallel × ~2s/call = ~50s per tick — fits comfortably in 60s.
 * UI calls /tick repeatedly until remaining = 0.
 *
 * Auth: owner-scoped via auth.uid() + RLS. /tick can only mutate runs
 * created by the same user (RLS enforces this).
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as { run_id?: string; chunk_size?: number }
  if (!body.run_id) return NextResponse.json({ error: 'run_id required' }, { status: 400 })
  const chunkSize = Math.min(Math.max(Number(body.chunk_size ?? 25), 1), 50)

  // ── Load the run ──────────────────────────────────────────────────────
  const { data: run, error: loadErr } = await db
    .from('serp_baseline_runs')
    .select('id, owner_user_id, site_slug, scope, status, total_pairs, processed_pairs, failed_pairs, pending')
    .eq('id', body.run_id)
    .eq('owner_user_id', ownerId)
    .single()

  if (loadErr || !run) {
    return NextResponse.json({ error: loadErr?.message ?? 'Run not found' }, { status: 404 })
  }
  if (run.status === 'done' || run.status === 'cancelled' || run.status === 'failed') {
    return NextResponse.json({
      run_id:          run.id,
      status:          run.status,
      total_pairs:     run.total_pairs,
      processed_pairs: run.processed_pairs,
      failed_pairs:    run.failed_pairs,
      remaining:       0,
      just_processed:  0,
      message:         `Run is ${run.status} — no work to do`,
    })
  }

  type Pair = { product_id: string; keyword_id: string; keyword: string; market: string }
  const pending: Pair[] = Array.isArray(run.pending) ? run.pending : []
  const chunk:   Pair[] = pending.slice(0, chunkSize)
  const rest:    Pair[] = pending.slice(chunkSize)

  if (chunk.length === 0) {
    // Defensive: nothing left but status not flipped. Flip it now.
    await db
      .from('serp_baseline_runs')
      .update({ status: 'done', completed_at: new Date().toISOString() })
      .eq('id', run.id)
    return NextResponse.json({
      run_id:          run.id,
      status:          'done',
      total_pairs:     run.total_pairs,
      processed_pairs: run.processed_pairs,
      failed_pairs:    run.failed_pairs,
      remaining:       0,
      just_processed:  0,
    })
  }

  // Mark as running before doing the slow work
  if (run.status === 'pending') {
    await db.from('serp_baseline_runs').update({ status: 'running' }).eq('id', run.id)
  }

  const ourDomains = ourDomainsForSite(run.site_slug)
  if (ourDomains.length === 0) {
    await db
      .from('serp_baseline_runs')
      .update({ status: 'failed', completed_at: new Date().toISOString(), notes: `Unknown site_slug "${run.site_slug}" — no domain mapping` })
      .eq('id', run.id)
    return NextResponse.json({ error: `Unknown site_slug "${run.site_slug}"` }, { status: 400 })
  }

  const today = new Date().toISOString().slice(0, 10)

  // ── Run chunk in parallel ────────────────────────────────────────────
  // DataForSEO Live SERP doesn't rate-limit at this volume; running 25 in
  // parallel cuts wall-time from ~50s to ~3-5s per chunk.
  const results = await Promise.allSettled(chunk.map(async p => {
    const result = await fetchSerpForMarket(p.keyword, p.market as TierMarket, ourDomains, 50)
    const { error: upsertErr } = await db
      .from('tier_serp_snapshots')
      .upsert({
        owner_user_id:   run.owner_user_id,
        product_tier_id: p.product_id,
        tier_keyword_id: p.keyword_id,
        keyword:         p.keyword,
        market:          p.market,
        snapshot_date:   today,
        our_position:    result.ourPosition,
        our_url:         result.ourUrl,
        top_10:          result.top10,
        total_results:   result.totalResults,
        captured_at:     new Date().toISOString(),
      }, { onConflict: 'owner_user_id,product_tier_id,keyword,market,snapshot_date' })

    if (upsertErr) throw new Error(`upsert: ${upsertErr.message}`)
    return true
  }))

  const justProcessed = results.filter(r => r.status === 'fulfilled').length
  const justFailed    = results.filter(r => r.status === 'rejected').length

  // Log first-line failures into notes (truncated) — helps debug stuck runs
  const failureReasons = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .slice(0, 3)
    .map(r => r.reason instanceof Error ? r.reason.message : String(r.reason))

  // ── Update the run ────────────────────────────────────────────────────
  const newProcessed = run.processed_pairs + justProcessed
  const newFailed    = run.failed_pairs    + justFailed
  const isDone       = rest.length === 0

  const updatePayload: Record<string, unknown> = {
    pending:         rest,
    processed_pairs: newProcessed,
    failed_pairs:    newFailed,
    last_tick_at:    new Date().toISOString(),
    status:          isDone ? 'done' : 'running',
  }
  if (isDone) updatePayload.completed_at = new Date().toISOString()
  if (failureReasons.length > 0) {
    updatePayload.notes = `Last tick errors: ${failureReasons.join(' | ')}`.slice(0, 500)
  }

  await db.from('serp_baseline_runs').update(updatePayload).eq('id', run.id)

  // ── Cost log — once per tick (not once per call) so we don't spam ────
  if (justProcessed > 0) {
    await db.from('api_usage_logs').insert({
      api_name:   'dataforseo',
      endpoint:   'tier_serp_baseline_chunked',
      call_count: justProcessed,
      metadata:   { run_id: run.id, site_slug: run.site_slug, scope: run.scope },
      created_at: new Date().toISOString(),
    })
  }

  return NextResponse.json({
    run_id:          run.id,
    status:          isDone ? 'done' : 'running',
    total_pairs:     run.total_pairs,
    processed_pairs: newProcessed,
    failed_pairs:    newFailed,
    remaining:       rest.length,
    just_processed:  justProcessed,
    just_failed:     justFailed,
    last_tick_at:    updatePayload.last_tick_at,
  })
}
