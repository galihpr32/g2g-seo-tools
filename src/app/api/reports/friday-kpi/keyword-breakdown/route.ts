// Sprint FRIDAY.KPI.KW-BREAKDOWN.1 (337) —
// API for the Friday KPI Keyword Breakdown sub-page.
//
// GET /api/reports/friday-kpi/keyword-breakdown?site=g2g&week=YYYY-MM-DD
//   Returns the cached payload for that (site, week) tuple, or
//   { ok: true, cached: false } if nothing has been generated yet.
//   `?week=` defaults to the most-recently-completed Thu→Wed start.
//
// POST /api/reports/friday-kpi/keyword-breakdown
//   Body: { site_slug: string, week_start?: string }
//   Builds a fresh payload (GA4 + GSC live fetch) and upserts to cache.
//   Returns the freshly built payload.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { buildKeywordBreakdown, type KeywordBreakdownPayload } from '@/lib/reports/friday-kpi-keyword-breakdown'

export const runtime     = 'nodejs'
// GA4 + GSC live calls can take 15-30s. Set generous ceiling so manual
// "Refresh" doesn't 504 on slow Google-side responses.
export const maxDuration = 90
export const dynamic     = 'force-dynamic'

function getDefaultWeekStart(now: Date = new Date()): string {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = today.getDay()
  const daysSinceCompletedWed = day === 3 ? 7 : (day + 4) % 7 || 7
  const end = new Date(today)
  end.setDate(today.getDate() - daysSinceCompletedWed)
  const start = new Date(end)
  start.setDate(end.getDate() - 6)
  return start.toISOString().slice(0, 10)
}

export async function GET(req: Request) {
  const db = createServiceClient()
  const url = new URL(req.url)

  // Sprint KW.BREAKDOWN.PUBLIC (350) — token-based read path. When a `token`
  // query param is present, we skip auth entirely and look up the row by
  // public_token. The token is a UUID generated at insert time; anyone who
  // has it can view that single snapshot. No owner/site/week needed —
  // they're all derivable from the row.
  const token = url.searchParams.get('token')
  if (token) {
    const { data, error } = await db
      .from('friday_kpi_keyword_breakdown')
      .select('payload, generated_at, site_slug, week_start, public_token')
      .eq('public_token', token)
      .maybeSingle()
    if (error)  return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data)  return NextResponse.json({ error: 'Token not found' }, { status: 404 })
    return NextResponse.json({
      ok:           true,
      cached:       true,
      public:       true,
      site_slug:    data.site_slug,
      week_start:   data.week_start,
      generated_at: data.generated_at,
      public_token: data.public_token,
      payload:      data.payload as KeywordBreakdownPayload,
    })
  }

  // Authenticated read path (existing behaviour for the internal page).
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const siteSlug = (url.searchParams.get('site') ?? 'g2g').toLowerCase()
  const week     = url.searchParams.get('week') ?? getDefaultWeekStart()

  const { data, error } = await db
    .from('friday_kpi_keyword_breakdown')
    .select('payload, generated_at, public_token')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('week_start', week)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (!data) {
    return NextResponse.json({
      ok:           true,
      cached:       false,
      site_slug:    siteSlug,
      week_start:   week,
      hint:         'No snapshot yet for this week. POST to /api/reports/friday-kpi/keyword-breakdown with { site_slug, week_start } to build one.',
    })
  }

  return NextResponse.json({
    ok:           true,
    cached:       true,
    site_slug:    siteSlug,
    week_start:   week,
    generated_at: data.generated_at,
    public_token: data.public_token,
    payload:      data.payload as KeywordBreakdownPayload,
  })
}

interface PostBody {
  site_slug?:  string
  week_start?: string
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as PostBody
  const siteSlug = (body.site_slug ?? 'g2g').toLowerCase()
  const weekStart = body.week_start ?? getDefaultWeekStart()

  try {
    const payload = await buildKeywordBreakdown({ db, ownerId, siteSlug, weekStart })

    // Upsert: one row per (owner × site × week_start). Refresh replaces in
    // place so the UI sees a single canonical snapshot per week.
    // Sprint KW.BREAKDOWN.PUBLIC (350) — chain .select() so we get the
    // public_token back (auto-generated on insert; preserved on update).
    const { data: row, error: upsertError } = await db
      .from('friday_kpi_keyword_breakdown')
      .upsert({
        owner_user_id: ownerId,
        site_slug:     siteSlug,
        week_start:    weekStart,
        payload,
        generated_at:  new Date().toISOString(),
      }, { onConflict: 'owner_user_id,site_slug,week_start' })
      .select('public_token')
      .single()

    if (upsertError) {
      // Still return the freshly built payload even if cache write failed
      // — user wanted "see the latest" more than "persist it".
      return NextResponse.json({
        ok:           true,
        cached:       false,
        site_slug:    siteSlug,
        week_start:   weekStart,
        payload,
        warning:      `Cache write failed: ${upsertError.message}`,
      })
    }

    return NextResponse.json({
      ok:           true,
      cached:       true,
      site_slug:    siteSlug,
      week_start:   weekStart,
      generated_at: payload.generated_at,
      public_token: row?.public_token,
      payload,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
