import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { buildCsv } from '@/lib/csv'

export const maxDuration = 30

/**
 * GET /api/products/auto-content/csv-export?mode=template|data
 *
 * mode=template — empty CSV with headers + one example row, for users to
 *                 fill in and re-import.
 * mode=data     — current product_content_queue contents as CSV (default),
 *                 useful as backup or to round-trip through Excel.
 *
 * Both share the same header schema so a template-filled CSV can be imported
 * back via /api/products/auto-content/csv-import without translation.
 */

// Sheet column layout mirrors the Google Sheet exactly so CSV-imported rows
// land in the same column positions when round-tripped through Excel.
//   A · Brand Name    · F · EN File URL    · H · ID File URL
//   B · Category      · G · EN Status      · I · ID Status
//   C · Relation ID   · D · Main Keyword
//   E · Secondary Keywords
const HEADERS = [
  'Brand Name',
  'Category',
  'Relation ID',
  'Main Keyword',
  'Secondary Keywords',
  'EN File URL',
  'EN Status',
  'ID File URL',
  'ID Status',
  'Generated At',
  'Uploaded At',
  'Created At',
] as const

function fmt(d: string | Date | null | undefined): string {
  if (!d) return ''
  const date = typeof d === 'string' ? new Date(d) : d
  if (isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const mode = new URL(req.url).searchParams.get('mode') ?? 'data'
  const today = new Date().toISOString().slice(0, 10)

  if (mode === 'template') {
    const exampleRow: Record<string, string> = {
      'Brand Name':         'Example Brand',
      'Category':           'Gift Cards',
      'Relation ID':        '00000000-0000-0000-0000-000000000000',
      'Main Keyword':       'buy example brand gift card',
      'Secondary Keywords': 'example brand voucher, example brand code',
      'EN File URL':        '',
      'EN Status':          'To Do',
      'ID File URL':        '',
      'ID Status':          'To Do',
      'Generated At':       '',
      'Uploaded At':        '',
      'Created At':         '',
    }
    const csv = buildCsv(HEADERS as unknown as string[], [exampleRow])
    return new NextResponse(csv, {
      headers: {
        'Content-Type':         'text/csv; charset=utf-8',
        'Content-Disposition':  `attachment; filename="product-content-template-${today}.csv"`,
      },
    })
  }

  // mode === 'data' — dump current queue (both EN + ID artefacts)
  const { data: rows, error } = await db
    .from('product_content_queue')
    .select('relation_id, product_name, category, main_keyword, secondary_keywords, google_doc_url, status, id_google_doc_url, id_status, generated_at, uploaded_at, created_at')
    .eq('owner_user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(5000)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const objs = (rows ?? []).map(r => ({
    'Brand Name':         r.product_name ?? '',
    'Category':           r.category ?? '',
    'Relation ID':        r.relation_id ?? '',
    'Main Keyword':       r.main_keyword ?? '',
    'Secondary Keywords': r.secondary_keywords ?? '',
    'EN File URL':        r.google_doc_url ?? '',
    'EN Status':          r.status ?? '',
    'ID File URL':        r.id_google_doc_url ?? '',
    'ID Status':          r.id_status ?? '',
    'Generated At':       fmt(r.generated_at),
    'Uploaded At':        fmt(r.uploaded_at),
    'Created At':         fmt(r.created_at),
  }))

  const csv = buildCsv(HEADERS as unknown as string[], objs)
  return new NextResponse(csv, {
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="product-content-${today}.csv"`,
    },
  })
}
