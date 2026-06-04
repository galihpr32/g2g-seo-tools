// Sprint #361 WEEKLY.BOSS.VIEW — API for the boss-view preview page.
//
// GET  /api/reports/friday-kpi/boss-view?site=g2g&site=offgamers
//      Returns the latest cached payload (or freshly built if no cache).
//
// POST /api/reports/friday-kpi/boss-view
//      Body: { sites?: string[] }  (defaults to ['g2g', 'offgamers'])
//      Force-rebuild and cache. Use for the "Refresh" button on the preview
//      page.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { buildBossView, type BossViewPayload } from '@/lib/reports/boss-view'

export const runtime     = 'nodejs'
// Heavier workload (multiple GSC + GA4 calls per brand). 60s is the Hobby
// cap — should be enough for 2 brands; if we add more, we'll need to split.
export const maxDuration = 60
export const dynamic     = 'force-dynamic'

const TABLE = 'friday_kpi_boss_view_cache'

interface CachedRow {
  id:           string
  owner_user_id: string
  payload:      BossViewPayload
  generated_at: string
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  // Try the cache first — single row per owner (we overwrite each refresh
  // since the boss view is a "latest snapshot" not a history).
  const { data: cached } = await db
    .from(TABLE)
    .select('id, owner_user_id, payload, generated_at')
    .eq('owner_user_id', ownerId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (cached) {
    const row = cached as CachedRow
    return NextResponse.json({
      cached:  true,
      payload: row.payload,
      generatedAt: row.generated_at,
    })
  }

  // No cache — build fresh.
  return await buildAndCache(db, ownerId, ['g2g', 'offgamers'])
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.clone().json().catch(() => ({})) as { sites?: string[] }
  const sites = Array.isArray(body.sites) && body.sites.length > 0
    ? body.sites.filter(s => typeof s === 'string')
    : ['g2g', 'offgamers']

  return await buildAndCache(db, ownerId, sites)
}

async function buildAndCache(
  db:      ReturnType<typeof createServiceClient>,
  ownerId: string,
  sites:   string[],
) {
  try {
    const payload = await buildBossView({ db, ownerId, siteSlugs: sites })

    // Upsert single cache row per owner.
    const { error: deleteErr } = await db.from(TABLE).delete().eq('owner_user_id', ownerId)
    if (deleteErr) {
      console.warn('[boss-view] cache delete failed (continuing anyway):', deleteErr.message)
    }
    const { error: insertErr } = await db.from(TABLE).insert({
      owner_user_id: ownerId,
      payload,
      generated_at: new Date().toISOString(),
    })
    if (insertErr) {
      console.warn('[boss-view] cache insert failed (returning payload anyway):', insertErr.message)
    }

    return NextResponse.json({
      cached:  false,
      payload,
      generatedAt: payload.generatedAt,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Boss view build failed'
    console.error('[boss-view] build failed:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
