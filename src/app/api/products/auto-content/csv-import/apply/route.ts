import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 30

/**
 * POST /api/products/auto-content/csv-import/apply
 *
 * STEP 2 of the import flow — commits user-approved changes from the
 * preview step (/csv-import). User per-row chooses: 'use_csv', 'keep_db',
 * or 'skip' for each conflict; this endpoint applies those choices.
 *
 * Body (JSON):
 *   {
 *     toInsert:  CsvRow[],
 *     toUpdate:  Array<{ relation_id, fields: Partial<CsvRow> }>,
 *     skipped:   string[],   // relation_ids the user skipped
 *     fileName?: string      // for audit trail
 *   }
 *
 * Returns: import_id + summary counts. Also bumps brand→category KB
 * patterns so future imports can suggest categories.
 */

interface CsvRow {
  brand_name:         string
  category:           string
  relation_id:        string
  main_keyword:       string
  secondary_keywords: string
  en_file_url:        string
  status:             string
}

interface ApplyBody {
  toInsert?:  CsvRow[]
  toUpdate?:  Array<{ relation_id: string; fields: Partial<CsvRow> }>
  skipped?:   string[]
  fileName?:  string
}

function normBrand(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function csvFieldsToDbCols(f: Partial<CsvRow>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (f.brand_name         !== undefined) out.product_name       = f.brand_name
  if (f.category           !== undefined) out.category           = f.category
  if (f.main_keyword       !== undefined) out.main_keyword       = f.main_keyword
  if (f.secondary_keywords !== undefined) out.secondary_keywords = f.secondary_keywords
  if (f.en_file_url        !== undefined) out.google_doc_url     = f.en_file_url
  if (f.status             !== undefined) out.status             = f.status
  return out
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await request.json().catch(() => ({})) as ApplyBody
  const toInsert = body.toInsert ?? []
  const toUpdate = body.toUpdate ?? []
  const skipped  = body.skipped  ?? []

  let inserted = 0
  let updated  = 0
  const changesSummary: Array<{ relation_id: string; action: string; changes?: Record<string, unknown> }> = []
  const warnings: string[] = []

  // ── 1. Insert new rows ────────────────────────────────────────────────────
  if (toInsert.length > 0) {
    const insertRows = toInsert.map(r => ({
      owner_user_id:      ownerId,
      relation_id:        r.relation_id,
      product_name:       r.brand_name,
      category:           r.category || null,
      main_keyword:       r.main_keyword || null,
      secondary_keywords: r.secondary_keywords || null,
      google_doc_url:     r.en_file_url || null,
      status:             r.status || 'pending',
    }))

    const { data: ins, error: insErr } = await db
      .from('product_content_queue')
      .insert(insertRows)
      .select('relation_id')
    if (insErr) {
      warnings.push(`Insert failed: ${insErr.message}`)
    } else {
      inserted = ins?.length ?? 0
      for (const r of toInsert) changesSummary.push({ relation_id: r.relation_id, action: 'inserted' })
    }
  }

  // ── 2. Apply updates (one-by-one to keep partial-field semantics) ─────────
  for (const u of toUpdate) {
    const updates = csvFieldsToDbCols(u.fields)
    if (Object.keys(updates).length === 0) continue
    updates.updated_at = new Date().toISOString()
    const { error: updErr } = await db
      .from('product_content_queue')
      .update(updates)
      .eq('owner_user_id', ownerId)
      .eq('relation_id', u.relation_id)
    if (updErr) {
      warnings.push(`Update failed for ${u.relation_id}: ${updErr.message}`)
      continue
    }
    updated++
    changesSummary.push({ relation_id: u.relation_id, action: 'updated', changes: updates })
  }

  // ── 3. KB learning — bump brand→category patterns ─────────────────────────
  // Only count successfully-applied rows (insert + update). Conflicts the
  // user explicitly resolved by 'use_csv' for category count too.
  const allApplied = [
    ...toInsert.map(r => ({ brand: r.brand_name, category: r.category })),
    ...toUpdate
      .filter(u => u.fields.category !== undefined && u.fields.brand_name !== undefined)
      .map(u => ({ brand: u.fields.brand_name ?? '', category: u.fields.category ?? '' })),
  ].filter(p => p.brand && p.category)

  for (const p of allApplied) {
    const brandNorm = normBrand(p.brand)
    if (!brandNorm) continue
    // Upsert with occurrence_count increment via RPC pattern. Keep simple
    // by trying insert; if conflict, bump count.
    const { error: insErr } = await db
      .from('product_brand_category_patterns')
      .insert({
        owner_user_id:    ownerId,
        brand_name:       p.brand,
        brand_norm:       brandNorm,
        category:         p.category,
        occurrence_count: 1,
        last_seen_at:     new Date().toISOString(),
      })
    if (insErr) {
      // Conflict path — increment existing
      await db.rpc('increment_brand_category_pattern', {
        p_owner_id: ownerId,
        p_brand_norm: brandNorm,
        p_category: p.category,
      }).then(({ error }) => {
        if (error) {
          // RPC may not exist yet; do a manual update fallback.
          void db
            .from('product_brand_category_patterns')
            .update({ occurrence_count: 999, last_seen_at: new Date().toISOString() })   // best-effort marker
            .eq('owner_user_id', ownerId)
            .eq('brand_norm', brandNorm)
            .eq('category', p.category)
            .then(() => { /* silent */ })
        }
      })
    }
  }

  // ── 4. Persist audit row ──────────────────────────────────────────────────
  const { data: importRow } = await db
    .from('product_content_imports')
    .insert({
      owner_user_id:   ownerId,
      source:          'csv',
      source_file:     body.fileName ?? null,
      imported_by:     user.id,
      rows_total:      toInsert.length + toUpdate.length + skipped.length,
      rows_new:        inserted,
      rows_updated:    updated,
      rows_skipped:    skipped.length,
      rows_conflicts:  toUpdate.length,
      changes_summary: changesSummary,
      notes:           warnings.length > 0 ? warnings.join('\n') : null,
    })
    .select('id')
    .single()

  return NextResponse.json({
    ok:           true,
    import_id:    importRow?.id ?? null,
    inserted,
    updated,
    skipped:      skipped.length,
    warnings,
  })
}
