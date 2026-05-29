import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

/**
 * GET    /api/reports/monthly/comments?month=YYYY-MM&site=<slug>
 *   → returns comments grouped by section_key
 *
 * POST   /api/reports/monthly/comments
 *   body: { month: 'YYYY-MM', section_key: string, body: string, site?: string }
 *   → creates one comment
 *
 * DELETE /api/reports/monthly/comments?id=<uuid>
 */

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const url = new URL(req.url)
  const month = url.searchParams.get('month')
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: 'month=YYYY-MM required' }, { status: 400 })

  const db = createServiceClient()
  const { data, error } = await db
    .from('monthly_report_comments')
    .select('id, section_key, body, author_user_id, author_name, created_at, updated_at')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('report_month', month)
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Group by section
  const bySection: Record<string, typeof data> = {}
  for (const c of data ?? []) {
    const k = c.section_key
    if (!bySection[k]) bySection[k] = []
    bySection[k]!.push(c)
  }
  return NextResponse.json({ month, comments: bySection })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req, body)

  const month       = typeof body.month === 'string' ? body.month : ''
  const sectionKey  = typeof body.section_key === 'string' ? body.section_key.trim() : ''
  const commentBody = typeof body.body === 'string' ? body.body.trim() : ''

  if (!month || !/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: 'month=YYYY-MM required' }, { status: 400 })
  if (!sectionKey)  return NextResponse.json({ error: 'section_key required' }, { status: 400 })
  if (!commentBody) return NextResponse.json({ error: 'body required' }, { status: 400 })

  const db = createServiceClient()
  const { data, error } = await db
    .from('monthly_report_comments')
    .insert({
      owner_user_id:  ownerId,
      site_slug:      siteSlug,
      report_month:   month,
      section_key:    sectionKey,
      body:           commentBody,
      author_user_id: user.id,
      author_name:    user.email ?? null,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ comment: data })
}

export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  // Only the comment author OR the owner can delete
  const { error } = await db
    .from('monthly_report_comments')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
