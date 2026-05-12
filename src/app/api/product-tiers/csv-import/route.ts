import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

/**
 * POST /api/product-tiers/csv-import
 * Body: { csv: string, replace?: boolean }
 *
 * Parses a CSV with the following header row (case-insensitive, any order):
 *   Tier, Product Name, Category, Relation ID, URL, Notes
 *
 * Required columns: Tier + Product Name. Others optional.
 * If `replace=true`, deletes ALL existing tier entries for this owner+site
 * before importing. Otherwise upserts on (relation_id) when present, inserts
 * otherwise.
 *
 * Returns: { inserted, updated, errors: [{ row, reason }] }
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const { csv, replace } = await req.json().catch(() => ({})) as { csv?: string; replace?: boolean }
  if (!csv?.trim()) return NextResponse.json({ error: 'csv body is required' }, { status: 400 })

  const rows = parseCsv(csv)
  if (rows.length === 0) return NextResponse.json({ error: 'No data rows found' }, { status: 400 })

  const header = rows[0].map(s => s.trim().toLowerCase())
  const colTier     = header.findIndex(h => h === 'tier')
  const colName     = header.findIndex(h => h === 'product name' || h === 'product_name' || h === 'name')
  const colCategory = header.findIndex(h => h === 'category')
  const colRelId    = header.findIndex(h => h === 'relation id' || h === 'relation_id')
  const colUrl      = header.findIndex(h => h === 'url')
  const colNotes    = header.findIndex(h => h === 'notes')

  if (colTier < 0 || colName < 0) {
    return NextResponse.json({
      error: 'CSV must include "Tier" and "Product Name" columns',
    }, { status: 400 })
  }

  // ── Optional clean-slate: wipe existing entries for this owner+site ──
  if (replace) {
    await db
      .from('product_tiers')
      .delete()
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
  }

  let inserted = 0
  let updated  = 0
  const errors: Array<{ row: number; reason: string }> = []

  // Walk data rows (skip header at index 0)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const rowNum = i + 1   // human-friendly (1-indexed including header)

    const tierRaw  = (row[colTier] ?? '').trim()
    const tier     = tierRaw === '1' ? 1 : tierRaw === '2' ? 2 : null
    const name     = (row[colName] ?? '').trim()
    const category = colCategory >= 0 ? (row[colCategory] ?? '').trim() : ''
    const relId    = colRelId    >= 0 ? (row[colRelId]    ?? '').trim() : ''
    const url      = colUrl      >= 0 ? (row[colUrl]      ?? '').trim() : ''
    const notes    = colNotes    >= 0 ? (row[colNotes]    ?? '').trim() : ''

    if (!tier)         { errors.push({ row: rowNum, reason: 'Tier must be 1 or 2' }); continue }
    if (!name)         { errors.push({ row: rowNum, reason: 'Product Name is required' }); continue }

    const payload = {
      owner_user_id: ownerId,
      site_slug:     siteSlug,
      tier,
      product_name:  name,
      category:      category || null,
      relation_id:   relId    || null,
      url:           url      || null,
      notes:         notes    || null,
      updated_at:    new Date().toISOString(),
    }

    if (relId && !replace) {
      // Upsert on the unique (owner, site, relation_id) index
      const { error, data } = await db
        .from('product_tiers')
        .upsert(payload, { onConflict: 'owner_user_id,site_slug,relation_id' })
        .select('id, created_at, updated_at')
        .single()

      if (error) { errors.push({ row: rowNum, reason: error.message }); continue }
      // Heuristic: if created_at == updated_at it was just inserted
      if (data && data.created_at === data.updated_at) inserted++
      else                                              updated++
    } else {
      const { error } = await db.from('product_tiers').insert(payload)
      if (error) { errors.push({ row: rowNum, reason: error.message }); continue }
      inserted++
    }
  }

  return NextResponse.json({ ok: true, inserted, updated, errors })
}

/**
 * Minimal CSV parser — handles quoted cells, escaped quotes, commas inside
 * quotes, and CRLF/LF line endings. Doesn't try to be a full RFC-4180 parser
 * because the input is hand-typed by humans, not machine-generated, and we
 * tolerate small deviations.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let cur:    string[] = []
  let cell:   string   = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ }   // escaped ""
        else inQuotes = false
      } else {
        cell += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        cur.push(cell); cell = ''
      } else if (ch === '\n' || ch === '\r') {
        // commit row at LF; tolerate CRLF by skipping the next \n
        if (ch === '\r' && text[i + 1] === '\n') i++
        cur.push(cell); cell = ''
        if (cur.some(c => c.trim() !== '')) rows.push(cur)   // drop blank lines
        cur = []
      } else {
        cell += ch
      }
    }
  }
  if (cell.length > 0 || cur.length > 0) {
    cur.push(cell)
    if (cur.some(c => c.trim() !== '')) rows.push(cur)
  }
  return rows
}
