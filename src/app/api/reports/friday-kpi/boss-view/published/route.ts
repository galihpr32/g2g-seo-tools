// Sprint #378 SNAPSHOT.RENAME / Sprint #379 PUBLISHED.UNIFIED.PDF —
// Returns ALL published reports for the caller across both sources:
//   1. Boss view snapshots  (friday_kpi_boss_view_published)
//   2. Keyword Breakdown    (friday_kpi_keyword_breakdown, public_token column)
//
// Each row carries a `type` discriminator so the UI can show a badge.
// Sorted newest first across both types. Up to 50 total.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface BossViewRowDb {
  slug:         string
  generated_at: string
  published_at: string
  payload:      { weekLabel?: string; curStart?: string; curEnd?: string } | null
}
interface KwBreakdownRowDb {
  public_token: string
  site_slug:    string
  week_start:   string
  generated_at: string
}

export interface PublishedReportItem {
  type:        'snapshot' | 'kw_breakdown'
  url:         string
  label:       string
  sub:         string | null    // secondary info (site / dates)
  publishedAt: string
  generatedAt: string
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  // Parallel fetch from both sources.
  const [bossRes, kwRes] = await Promise.all([
    db
      .from('friday_kpi_boss_view_published')
      .select('slug, generated_at, published_at, payload')
      .eq('owner_user_id', ownerId)
      .order('published_at', { ascending: false })
      .limit(30),
    db
      .from('friday_kpi_keyword_breakdown')
      .select('public_token, site_slug, week_start, generated_at')
      .eq('owner_user_id', ownerId)
      .order('generated_at', { ascending: false })
      .limit(30),
  ])

  if (bossRes.error) return NextResponse.json({ error: bossRes.error.message }, { status: 500 })
  if (kwRes.error)   return NextResponse.json({ error: kwRes.error.message },   { status: 500 })

  const items: PublishedReportItem[] = []

  for (const r of (bossRes.data ?? []) as BossViewRowDb[]) {
    items.push({
      type:        'snapshot',
      url:         `/reports/${r.slug}`,
      label:       r.payload?.weekLabel ?? r.slug,
      sub:         r.payload?.curStart && r.payload?.curEnd
                   ? `${r.payload.curStart} → ${r.payload.curEnd}` : null,
      publishedAt: r.published_at,
      generatedAt: r.generated_at,
    })
  }

  for (const r of (kwRes.data ?? []) as KwBreakdownRowDb[]) {
    // KW breakdown rows don't have a separate "published" timestamp — they
    // get a public_token at creation, so generated_at doubles as publishedAt.
    items.push({
      type:        'kw_breakdown',
      url:         `/public/friday-kpi/keywords/${r.public_token}`,
      label:       `KW Breakdown · ${r.site_slug.toUpperCase()} · week ${r.week_start}`,
      sub:         r.site_slug,
      publishedAt: r.generated_at,
      generatedAt: r.generated_at,
    })
  }

  // Combined sort newest first, cap to 50
  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  return NextResponse.json({ snapshots: items.slice(0, 50) })
}
