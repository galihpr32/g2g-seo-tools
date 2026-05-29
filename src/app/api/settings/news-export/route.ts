import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { extractSpreadsheetId } from '@/lib/news-export/sheet-writer'

export const maxDuration = 10

// ─── GET /api/settings/news-export ─────────────────────────────────────────
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const { data } = await db
    .from('news_export_config')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .maybeSingle()

  return NextResponse.json({ config: data ?? null })
}

// ─── PUT /api/settings/news-export ─────────────────────────────────────────
// Body: { spreadsheet_url, weekly_cron_enabled? }
export async function PUT(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as { spreadsheet_url?: string; weekly_cron_enabled?: boolean }
  const url = String(body.spreadsheet_url ?? '').trim()
  if (!url) return NextResponse.json({ error: 'spreadsheet_url required' }, { status: 400 })

  const sheetId = extractSpreadsheetId(url)
  if (!sheetId) {
    return NextResponse.json({
      error: 'Could not extract spreadsheet ID. Paste either the full URL (https://docs.google.com/spreadsheets/d/.../edit) or the bare ID.',
    }, { status: 400 })
  }

  const { data, error } = await db
    .from('news_export_config')
    .upsert({
      owner_user_id:       ownerId,
      site_slug:           siteSlug,
      spreadsheet_url:     url,
      spreadsheet_id:      sheetId,
      weekly_cron_enabled: body.weekly_cron_enabled !== false,
      updated_at:          new Date().toISOString(),
    }, { onConflict: 'owner_user_id,site_slug' })
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ config: data })
}

// ─── DELETE /api/settings/news-export ──────────────────────────────────────
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const { error } = await db
    .from('news_export_config')
    .delete()
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
