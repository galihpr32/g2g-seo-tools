import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { parseCsv, csvRowsToObjects } from '@/lib/csv'

export const maxDuration = 30

/**
 * POST /api/products/auto-content/csv-import
 *
 * STEP 1 of the import flow — preview only. Parses the uploaded CSV, runs
 * STRICT schema validation (rejects unrecognised columns), classifies each
 * row as new / unchanged / conflict, and returns the diff for the user to
 * approve in a per-row modal.
 *
 * Body (JSON): { csv: string }   — file content
 * Returns:
 *   {
 *     headers, rowCount,
 *     new:        [{ csv: {...} }],
 *     unchanged:  [{ csv: {...}, db: {...} }],
 *     conflicts:  [{ csv: {...}, db: {...}, fieldDiffs: { field: { csv, db } } }],
 *     warnings:   string[],
 *   }
 *
 * No DB writes happen here — committing changes is /csv-import/apply.
 */

// Strict schema — any column outside this set rejects the import.
const ALLOWED_HEADERS = new Set([
  'Brand Name',
  'Category',
  'Relation ID',
  'Main Keyword',
  'Secondary Keywords',
  'EN File URL',
  'Status',
  'Generated At',
  'Uploaded At',
  'Created At',
])
const REQUIRED_HEADERS = ['Brand Name', 'Category', 'Relation ID']

interface CsvRow {
  brand_name:         string
  category:           string
  relation_id:        string
  main_keyword:       string
  secondary_keywords: string
  en_file_url:        string
  status:             string
}

function csvObjToRow(obj: Record<string, string>): CsvRow {
  return {
    brand_name:         (obj['Brand Name'] ?? '').trim(),
    category:           (obj['Category'] ?? '').trim(),
    relation_id:        (obj['Relation ID'] ?? '').trim(),
    main_keyword:       (obj['Main Keyword'] ?? '').trim(),
    secondary_keywords: (obj['Secondary Keywords'] ?? '').trim(),
    en_file_url:        (obj['EN File URL'] ?? '').trim(),
    status:             (obj['Status'] ?? '').trim(),
  }
}

interface DbRow {
  relation_id:        string
  product_name:       string
  category:           string | null
  main_keyword:       string | null
  secondary_keywords: string | null
  google_doc_url:     string | null
  status:             string
  generated_at:       string | null
  uploaded_at:        string | null
  created_at:         string
}

function dbToCsvShape(db: DbRow): CsvRow {
  return {
    brand_name:         db.product_name ?? '',
    category:           db.category ?? '',
    relation_id:        db.relation_id,
    main_keyword:       db.main_keyword ?? '',
    secondary_keywords: db.secondary_keywords ?? '',
    en_file_url:        db.google_doc_url ?? '',
    status:             db.status,
  }
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await request.json().catch(() => ({})) as { csv?: string }
  const csvText = (body.csv ?? '').trim()
  if (!csvText) return NextResponse.json({ error: 'csv body is empty' }, { status: 400 })

  // ── 1. Parse + strict header validation ───────────────────────────────────
  let parsed: string[][]
  try { parsed = parseCsv(csvText) }
  catch (err) {
    return NextResponse.json({ error: `CSV parse failed: ${err instanceof Error ? err.message : err}` }, { status: 400 })
  }

  if (parsed.length < 2) {
    return NextResponse.json({ error: 'CSV needs at least header row + 1 data row' }, { status: 400 })
  }

  const headers = parsed[0].map(h => h.trim())
  const unknownHeaders = headers.filter(h => h && !ALLOWED_HEADERS.has(h))
  if (unknownHeaders.length > 0) {
    return NextResponse.json({
      error: `Unrecognised columns: ${unknownHeaders.join(', ')}. Allowed: ${[...ALLOWED_HEADERS].join(', ')}.`,
    }, { status: 400 })
  }

  let csvObjs: Array<Record<string, string>>
  try { csvObjs = csvRowsToObjects(parsed, REQUIRED_HEADERS) }
  catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }

  const csvRows = csvObjs.map(csvObjToRow)

  // ── 2. Field-level validation ─────────────────────────────────────────────
  const warnings: string[] = []
  const validRows: CsvRow[] = []
  const seenIds = new Set<string>()
  for (const [idx, row] of csvRows.entries()) {
    const lineNo = idx + 2   // +2 because row 1 is header, rows are 1-indexed in user UX
    if (!row.relation_id) {
      warnings.push(`Line ${lineNo}: missing Relation ID — skipped`)
      continue
    }
    if (!row.brand_name) {
      warnings.push(`Line ${lineNo}: missing Brand Name — skipped`)
      continue
    }
    if (seenIds.has(row.relation_id)) {
      warnings.push(`Line ${lineNo}: duplicate Relation ID "${row.relation_id}" within CSV — skipped`)
      continue
    }
    seenIds.add(row.relation_id)
    validRows.push(row)
  }

  // ── 3. Pull existing DB rows for these relation_ids ───────────────────────
  const relationIds = validRows.map(r => r.relation_id)
  const { data: existingRows } = await db
    .from('product_content_queue')
    .select('relation_id, product_name, category, main_keyword, secondary_keywords, google_doc_url, status, generated_at, uploaded_at, created_at')
    .eq('owner_user_id', ownerId)
    .in('relation_id', relationIds)

  const dbMap = new Map<string, DbRow>()
  for (const r of (existingRows ?? []) as DbRow[]) dbMap.set(r.relation_id, r)

  // ── 4. Classify each row ──────────────────────────────────────────────────
  const COMPARED_FIELDS: Array<keyof CsvRow> = [
    'brand_name', 'category', 'main_keyword', 'secondary_keywords', 'en_file_url', 'status',
  ]

  const newRows:        Array<{ csv: CsvRow }> = []
  const unchanged:      Array<{ csv: CsvRow; db: CsvRow }> = []
  const conflicts:      Array<{ csv: CsvRow; db: CsvRow; fieldDiffs: Record<string, { csv: string; db: string }> }> = []

  for (const csvRow of validRows) {
    const dbRow = dbMap.get(csvRow.relation_id)
    if (!dbRow) {
      newRows.push({ csv: csvRow })
      continue
    }

    const dbShape = dbToCsvShape(dbRow)
    const fieldDiffs: Record<string, { csv: string; db: string }> = {}

    for (const f of COMPARED_FIELDS) {
      const a = csvRow[f] ?? ''
      const b = dbShape[f] ?? ''
      if (a !== b) fieldDiffs[f] = { csv: a, db: b }
    }

    if (Object.keys(fieldDiffs).length === 0) {
      unchanged.push({ csv: csvRow, db: dbShape })
    } else {
      conflicts.push({ csv: csvRow, db: dbShape, fieldDiffs })
    }
  }

  return NextResponse.json({
    headers,
    rowCount:  csvRows.length,
    new:       newRows,
    unchanged,
    conflicts,
    warnings,
  })
}
