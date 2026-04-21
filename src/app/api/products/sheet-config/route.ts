import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { extractSpreadsheetId } from '@/lib/google/sheets'

// GET /api/products/sheet-config — return current config
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { data } = await supabase
    .from('product_sheet_config')
    .select('*')
    .eq('owner_user_id', ownerId)
    .single()

  return NextResponse.json({ config: data ?? null })
}

// POST /api/products/sheet-config — save / update config
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const body = await req.json().catch(() => ({})) as {
    sheet_url?:  string
    sheet_name?: string
  }

  if (!body.sheet_url) {
    return NextResponse.json({ error: 'sheet_url is required' }, { status: 400 })
  }

  const spreadsheetId = extractSpreadsheetId(body.sheet_url)
  if (!spreadsheetId) {
    return NextResponse.json({ error: 'Invalid Google Sheets URL. Make sure it contains /spreadsheets/d/{id}' }, { status: 400 })
  }

  const { error } = await supabase
    .from('product_sheet_config')
    .upsert({
      owner_user_id:  ownerId,
      spreadsheet_id: spreadsheetId,
      sheet_name:     body.sheet_name ?? 'Sheet1',
      updated_at:     new Date().toISOString(),
    }, { onConflict: 'owner_user_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, spreadsheetId })
}
