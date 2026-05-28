import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { importCatalogCsv } from '@/lib/g2g/catalog-import'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 120

/**
 * POST /api/admin/g2g-catalog/import
 *
 * Multipart form:
 *   file: <CSV>  — required
 *   label: text  — optional, free-form (e.g. "April release sync")
 *
 * Or JSON (for cron / programmatic imports):
 *   { csv: "service_id,brand_id,...", label?: string }
 *
 * Returns the delta report (inserted/updated/unchanged/deactivated).
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)   // Sprint OG.CATALOG
  const db = createServiceClient()

  // ── Resolve CSV text ───────────────────────────────────────────────────
  const contentType = req.headers.get('content-type') ?? ''
  let csvText: string  = ''
  let label:   string | null = null

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData()
      const file = form.get('file')
      if (!(file instanceof File)) {
        return NextResponse.json({ error: 'Missing "file" field in form-data' }, { status: 400 })
      }
      csvText = await file.text()
      const rawLabel = form.get('label')
      label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : (file.name || null)
    } else {
      const body = await req.json().catch(() => ({})) as { csv?: string; label?: string }
      if (!body.csv) return NextResponse.json({ error: 'JSON body must include "csv" field' }, { status: 400 })
      csvText = body.csv
      label   = body.label ?? null
    }
  } catch (e) {
    return NextResponse.json({ error: `Failed to parse request body: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 })
  }

  if (csvText.length > 25 * 1024 * 1024) {
    return NextResponse.json({ error: 'CSV exceeds 25MB limit' }, { status: 413 })
  }

  // ── Run import ─────────────────────────────────────────────────────────
  const result = await importCatalogCsv(db, csvText, ownerId, label, siteSlug)
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}

// ── GET /api/admin/g2g-catalog/import — last import history ─────────────
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const { data, error } = await db
    .from('g2g_catalog_imports')
    .select('*')
    .order('imported_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ imports: data ?? [] })
}
