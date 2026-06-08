// Sprint #378 SNAPSHOT.RENAME — list of previously-published snapshots.
// GET /api/reports/friday-kpi/boss-view/published
// Returns up to 50 most-recently-published rows for the caller, sorted
// newest first. UI on the admin page renders this as a quick-access list
// so the user can re-open / re-share past report pages without hunting URLs.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PublishedRowDb {
  id:           string
  slug:         string
  generated_at: string
  published_at: string
  // payload is JSONB; we narrow the keys we actually read.
  payload:      { weekLabel?: string; curStart?: string; curEnd?: string } | null
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { data, error } = await db
    .from('friday_kpi_boss_view_published')
    .select('id, slug, generated_at, published_at, payload')
    .eq('owner_user_id', ownerId)
    .order('published_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (data ?? []) as PublishedRowDb[]
  return NextResponse.json({
    snapshots: rows.map(r => ({
      slug:        r.slug,
      weekLabel:   r.payload?.weekLabel ?? r.slug,
      curStart:    r.payload?.curStart ?? null,
      curEnd:      r.payload?.curEnd   ?? null,
      generatedAt: r.generated_at,
      publishedAt: r.published_at,
      url:         `/reports/${r.slug}`,
    })),
  })
}
