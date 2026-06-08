// Sprint #373 BOSS.VIEW.PUBLISH —
// POST /api/reports/friday-kpi/boss-view/publish
//   Body: { } (no params; uses the caller's current cached payload)
//
// Snapshots the user's currently-cached BossViewPayload into the
// `friday_kpi_boss_view_published` table with a slug derived from the
// payload's curStart date. The slug format is `{weekNumber}-{monthLower}`
// e.g. `22-may` for the week beginning May 21 (ISO week 22 of May).
//
// Returns: { ok, slug, url, publishedAt }
//
// Used by the "Create Report Page" button on /reports/friday-kpi/boss-view.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import type { BossViewPayload } from '@/lib/reports/boss-view'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface CachedRow {
  payload:      BossViewPayload
  generated_at: string
}

// Compute slug from the payload's curStart date.
// Example: curStart=2026-05-28 → ISO week 22, month "may" → "22-may"
function slugFor(payload: BossViewPayload): string {
  const d = new Date(payload.curStart + 'T00:00:00Z')
  // ISO week number — Thursday-based (matches the Thu→Wed weekly windows
  // already used everywhere in this app). See friday-kpi.ts for the exact
  // formula; replicating here so we don't need a cross-module import.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNr  = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const weekNum  = 1 + Math.round(((target.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)
  const monthName = d.toLocaleDateString('en-US', { month: 'long' }).toLowerCase()
  return `${weekNum}-${monthName}`
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  // 1. Read the user's cached boss-view payload + commentary.
  // Sprint #374 — commentary is stored in a separate column on the cache
  // row so AI-suggested + user-edited text persists between refreshes. We
  // inject it INTO the published payload here so /reports/[slug] can render
  // it without a separate fetch.
  const { data: cached, error: cacheErr } = await db
    .from('friday_kpi_boss_view_cache')
    .select('payload, commentary, generated_at')
    .eq('owner_user_id', ownerId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (cacheErr) return NextResponse.json({ error: cacheErr.message }, { status: 500 })
  if (!cached)  return NextResponse.json({
    error: 'No cached boss-view payload. Open /reports/friday-kpi/boss-view and click Refresh first.',
  }, { status: 400 })

  const row = cached as CachedRow & { commentary: unknown }

  // 2. Inject commentary into payload, compute slug, upsert.
  const payloadWithCommentary = {
    ...row.payload,
    commentary: row.commentary ?? null,
  }
  const slug = slugFor(row.payload)

  const { error: upsertErr } = await db
    .from('friday_kpi_boss_view_published')
    .upsert({
      owner_user_id: ownerId,
      slug,
      payload:      payloadWithCommentary,
      generated_at: row.generated_at,
      published_at: new Date().toISOString(),
    }, { onConflict: 'owner_user_id,slug' })

  if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 })

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')
  const url    = appUrl ? `${appUrl}/reports/${slug}` : `/reports/${slug}`

  return NextResponse.json({
    ok:           true,
    slug,
    url,
    publishedAt:  new Date().toISOString(),
  })
}
