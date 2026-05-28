import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 10

// ─── GET /api/settings/tyr-autopublish ────────────────────────────────────
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const { data, error } = await db
    .from('tyr_autopublish_config')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('tier_level', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Ensure all 3 tier_level rows exist in response (return defaults if missing)
  const byTier: Record<number, unknown> = {}
  for (const r of data ?? []) byTier[Number((r as Record<string, unknown>).tier_level)] = r

  const ensureRow = (tier: 0 | 1 | 2) => byTier[tier] ?? {
    tier_level:               tier,
    auto_publish_enabled:     tier !== 1,  // tier 0+2 default on, tier 1 default off
    min_tyr_score:            tier === 1 ? 85 : tier === 2 ? 80 : 70,
    min_dimension_threshold:  tier === 1 ? 8  : tier === 2 ? 7  : 6,
    forbidden_violations_max: 0,
    notes:                    null,
  }

  return NextResponse.json({
    configs: [ensureRow(0), ensureRow(1), ensureRow(2)],
  })
}

// ─── PUT /api/settings/tyr-autopublish ────────────────────────────────────
// Body: { tier_level, auto_publish_enabled, min_tyr_score, min_dimension_threshold, forbidden_violations_max, notes? }
export async function PUT(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    tier_level?:               number
    auto_publish_enabled?:     boolean
    min_tyr_score?:            number
    min_dimension_threshold?:  number
    forbidden_violations_max?: number
    notes?:                    string
  }

  const tier = body.tier_level
  if (![0, 1, 2].includes(Number(tier))) {
    return NextResponse.json({ error: 'tier_level must be 0, 1, or 2' }, { status: 400 })
  }

  const payload = {
    owner_user_id:            ownerId,
    site_slug:                siteSlug,
    tier_level:               Number(tier),
    auto_publish_enabled:     !!body.auto_publish_enabled,
    min_tyr_score:            Math.min(100, Math.max(0,  Number(body.min_tyr_score          ?? 75))),
    min_dimension_threshold:  Math.min(10,  Math.max(0,  Number(body.min_dimension_threshold ?? 6))),
    forbidden_violations_max: Math.max(0,  Number(body.forbidden_violations_max ?? 0)),
    notes:                    body.notes ?? null,
    updated_at:               new Date().toISOString(),
  }

  const { data, error } = await db
    .from('tyr_autopublish_config')
    .upsert(payload, { onConflict: 'owner_user_id,site_slug,tier_level' })
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ config: data })
}
