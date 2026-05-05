import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { runBifrost } from '@/lib/agents/bifrost'

export const maxDuration = 60

/**
 * GET /api/cron/bifrost
 *
 * Triggered every 6h by GitHub Actions (.github/workflows/bifrost-news.yml).
 * Iterates every workspace owner that has at least one active news_source
 * (or no news_sources rows yet — Bifrost auto-seeds Tier 1 on first run)
 * and runs `runBifrost(ownerId)` per owner.
 *
 * Auth: Bearer ${CRON_SECRET}
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServiceClient()

  // Discover all owners — anyone who has ever opened the app (i.e. exists in
  // workspace_members as an owner OR has a knowledge_base_items row).
  // Simpler: pull distinct owner_user_id from agents table (every owner has it).
  const { data: agentOwners } = await db
    .from('agents')
    .select('owner_user_id')

  const owners = Array.from(new Set((agentOwners ?? []).map(r => r.owner_user_id as string).filter(Boolean)))

  if (owners.length === 0) {
    return NextResponse.json({ ok: true, summary: 'No workspaces to process', owners: 0 })
  }

  const results: Array<{ ownerId: string; summary: string; queued: number; warnings: number }> = []

  for (const ownerId of owners) {
    try {
      const r = await runBifrost(ownerId)
      results.push({
        ownerId,
        summary:  r.summary,
        queued:   r.actionsQueued,
        warnings: r.warnings.length,
      })
    } catch (err) {
      console.error(`[bifrost-cron] owner ${ownerId} failed:`, err)
      results.push({
        ownerId,
        summary:  `error: ${err instanceof Error ? err.message : String(err)}`,
        queued:   0,
        warnings: 1,
      })
    }
  }

  const totalQueued = results.reduce((s, r) => s + r.queued, 0)
  return NextResponse.json({
    ok:           true,
    owners:       owners.length,
    total_queued: totalQueued,
    results,
  })
}
