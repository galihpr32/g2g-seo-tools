// Sprint #373 BOSS.VIEW.PUBLISH —
// GET /api/public/reports/friday-kpi/boss-view/[slug]
//
// PUBLIC (no auth) endpoint that serves a previously-published boss-view
// payload by slug. Reads from `friday_kpi_boss_view_published` via the
// service-role client to bypass RLS. Returns the most-recently-published
// row for that slug (whoever published last wins — fine for single-org
// use; revisit if multi-tenant becomes relevant).
//
// The dedicated `/api/public/...` prefix ensures it's clear this endpoint
// is shareable + does no auth checking. Don't add owner-scoped data here.

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import type { BossViewPayload } from '@/lib/reports/boss-view'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 })

  const db = createServiceClient()
  const { data, error } = await db
    .from('friday_kpi_boss_view_published')
    .select('payload, generated_at, published_at')
    .eq('slug', slug)
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'Not found' },  { status: 404 })

  return NextResponse.json({
    slug,
    payload:      data.payload as BossViewPayload,
    generatedAt:  data.generated_at,
    publishedAt:  data.published_at,
  })
}
