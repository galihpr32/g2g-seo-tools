import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { runPakRT, PAK_RT_DEFAULTS, type PakRTConfig } from '@/lib/agents/pak-rt'
import { runMasGacor } from '@/lib/agents/mas-gacor'
import { runIntelBakso } from '@/lib/agents/intel-bakso'
import { runAnakIntern } from '@/lib/agents/anak-intern'

export const maxDuration = 300

// Which agents to run on which schedule
// schedule: 'daily' | 'weekly'
// This single endpoint is called by multiple cron entries in vercel.json.
// The `agent` query param picks which agent to run.
//
// vercel.json crons:
//   0 1 * * *     /api/cron/agents?agent=pak-rt      (pak-rt — daily 01:00 UTC)
//   0 2 * * *     /api/cron/agents?agent=mas-gacor   (mas-gacor — daily 02:00 UTC)
//   0 3 * * 1     /api/cron/agents?agent=intel-bakso  (intel-bakso — weekly Mon 03:00 UTC)
//   0 4 * * 1     /api/cron/agents?agent=anak-intern  (anak-intern — weekly Mon 04:00 UTC)

function verifyAuth(request: Request) {
  const authHeader = request.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(request: Request) {
  if (!verifyAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const agentKey = searchParams.get('agent') ?? 'pak-rt'
  const siteSlug = searchParams.get('site') ?? 'g2g'

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Run agent for every distinct owner_user_id that has agent config or runs
  // Use distinct owners from agent_runs or a fallback from agents table
  const { data: ownerRows } = await db
    .from('agents')
    .select('owner_user_id, config')
    .eq('agent_key', agentKey)

  // Also include owners who have no agent row yet — get from site_configs
  const { data: siteRows } = await db
    .from('site_configs')
    .select('owner_user_id')
    .eq('slug', siteSlug)

  const ownerSet = new Set<string>()
  for (const r of ownerRows ?? []) ownerSet.add(r.owner_user_id)
  for (const r of siteRows ?? []) ownerSet.add(r.owner_user_id)

  if (ownerSet.size === 0) {
    return NextResponse.json({ message: `No owners found for agent ${agentKey}`, ran: 0 })
  }

  const ownerConfigMap = new Map<string, Record<string, unknown>>()
  for (const r of ownerRows ?? []) {
    ownerConfigMap.set(r.owner_user_id, (r.config ?? {}) as Record<string, unknown>)
  }

  const results: Record<string, unknown> = {}
  let succeeded = 0
  let failed = 0

  for (const ownerId of ownerSet) {
    try {
      // Create run record
      const { data: runRecord, error: runErr } = await db
        .from('agent_runs')
        .insert({
          owner_user_id: ownerId,
          agent_key:     agentKey,
          site_slug:     siteSlug,
          status:        'running',
          started_at:    new Date().toISOString(),
        })
        .select('id')
        .single()

      if (runErr || !runRecord) {
        results[ownerId] = { status: 'error', error: 'Failed to create run record' }
        failed++
        continue
      }

      const runId = runRecord.id
      const savedConfig = ownerConfigMap.get(ownerId) ?? {}
      let result: { summary: string; actionsQueued: number }

      if (agentKey === 'pak-rt') {
        const config: Partial<PakRTConfig> = {
          maxDropsPerDay: typeof savedConfig.maxDropsPerDay === 'number' ? savedConfig.maxDropsPerDay : PAK_RT_DEFAULTS.maxDropsPerDay,
          minClicksDrop:  typeof savedConfig.minClicksDrop  === 'number' ? savedConfig.minClicksDrop  : PAK_RT_DEFAULTS.minClicksDrop,
          minPctDrop:     typeof savedConfig.minPctDrop     === 'number' ? savedConfig.minPctDrop     : PAK_RT_DEFAULTS.minPctDrop,
        }
        result = await runPakRT(ownerId, siteSlug, runId, config)
      } else if (agentKey === 'mas-gacor') {
        result = await runMasGacor(ownerId, siteSlug, runId)
      } else if (agentKey === 'intel-bakso') {
        result = await runIntelBakso(ownerId, siteSlug, runId)
      } else if (agentKey === 'anak-intern') {
        result = await runAnakIntern(ownerId, siteSlug, runId)
      } else {
        results[ownerId] = { status: 'skipped', reason: `Agent ${agentKey} not in cron` }
        continue
      }

      results[ownerId] = { status: 'ok', ...result }
      succeeded++
    } catch (err) {
      results[ownerId] = { status: 'error', error: String(err) }
      failed++
    }
  }

  return NextResponse.json({
    agent: agentKey,
    site: siteSlug,
    owners: ownerSet.size,
    succeeded,
    failed,
    results,
  })
}
