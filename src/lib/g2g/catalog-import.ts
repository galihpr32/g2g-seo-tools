// ─── G2G canonical catalog CSV importer ─────────────────────────────────────
// Expected CSV header (exact column order from the admin export):
//   service_id,brand_id,relation_id,service_name,brand_name,created_at
//
// Behaviour:
//   1. Parse all rows in-memory (13k rows × ~80 bytes ≈ 1MB, fine for Node).
//   2. Stamp every row with a single `importedAt` timestamp.
//   3. Bulk-upsert in chunks (Supabase REST tops out around ~1000 rows/call).
//   4. After all chunks land, mark every row whose last_imported_at is older
//      than `importedAt` as is_active = false.
//   5. Compute the delta (inserted / updated / unchanged / deactivated) for
//      the audit log.
//
// Why this shape (not streaming SAX-style):
//   13k rows is small enough that loading + sorting + chunking in memory
//   stays well under Vercel's 300s function ceiling and the 1GB RAM cap.
//   Streaming would add complexity for no measurable gain at this scale.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface CatalogRow {
  service_id:    string
  brand_id:      string
  relation_id:   string
  service_name:  string
  brand_name:    string
  cms_created_at: string | null
}

export interface ImportResult {
  ok:               boolean
  rows_total:       number
  rows_inserted:    number
  rows_updated:     number
  rows_unchanged:   number
  rows_deactivated: number
  errors:           string[]
  imported_at:      string
  import_id?:       string
}

const REQUIRED_HEADERS = ['service_id', 'brand_id', 'relation_id', 'service_name', 'brand_name', 'created_at'] as const
const CHUNK_SIZE = 500   // Supabase REST happy zone; gives ~28 round-trips for 14k rows

// ─── Public entry point ────────────────────────────────────────────────────

export async function importCatalogCsv(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:           SupabaseClient<any, any, any>,
  csvText:      string,
  ownerUserId:  string,
  sourceLabel:  string | null = null,
  siteSlug:     string = 'g2g',     // Sprint OG.CATALOG — scope import per brand
): Promise<ImportResult> {
  const importedAt = new Date().toISOString()
  const errors:     string[] = []

  // ── 1. Parse ─────────────────────────────────────────────────────────────
  const parsed = parseCatalogCsv(csvText)
  if (!parsed.ok) {
    return baseResult(importedAt, parsed.errors)
  }
  const rows = parsed.rows

  if (rows.length === 0) {
    return baseResult(importedAt, ['CSV contained no data rows'])
  }

  // ── 2. Snapshot prior state so we can compute insert/update deltas ──────
  // Single SELECT — chunked IN can't bring back 14k rows cleanly. We grab
  // every active relation_id once and bucket in memory.
  const { data: priorRows, error: priorErr } = await db
    .from('g2g_products')
    .select('relation_id, service_id, brand_id, service_name, brand_name, is_active')
    .eq('site_slug', siteSlug)
  if (priorErr) {
    return baseResult(importedAt, [`Failed to snapshot prior catalog: ${priorErr.message}`])
  }
  const priorMap = new Map<string, {
    service_id: string; brand_id: string; service_name: string; brand_name: string; is_active: boolean
  }>()
  for (const r of priorRows ?? []) priorMap.set(r.relation_id, r as unknown as typeof priorMap extends Map<string, infer V> ? V : never)

  // ── 3. Bulk upsert in chunks ─────────────────────────────────────────────
  let inserted = 0, updated = 0, unchanged = 0
  for (const row of rows) {
    const prior = priorMap.get(row.relation_id)
    if (!prior) {
      inserted++
    } else if (
      prior.service_id !== row.service_id ||
      prior.brand_id   !== row.brand_id   ||
      prior.service_name !== row.service_name ||
      prior.brand_name   !== row.brand_name ||
      !prior.is_active
    ) {
      updated++
    } else {
      unchanged++
    }
  }

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE).map(r => ({
      relation_id:      r.relation_id,
      service_id:       r.service_id,
      brand_id:         r.brand_id,
      service_name:     r.service_name,
      brand_name:       r.brand_name,
      cms_created_at:   r.cms_created_at,
      is_active:        true,                // anything in the CSV is live
      site_slug:        siteSlug,            // Sprint OG.CATALOG — brand scope
      last_imported_at: importedAt,
      updated_at:       importedAt,
    }))
    const { error: upErr } = await db
      .from('g2g_products')
      .upsert(chunk, { onConflict: 'relation_id' })
    if (upErr) {
      errors.push(`Chunk ${i}-${i + chunk.length} failed: ${upErr.message}`)
    }
  }

  // ── 4. Mark anything missing from this run as inactive ─────────────────
  // We compare last_imported_at — any active row still bearing an older
  // import stamp wasn't touched by the upsert pass.
  let deactivated = 0
  if (errors.length === 0) {
    const { data: deactivatedRows, error: deErr } = await db
      .from('g2g_products')
      .update({ is_active: false, updated_at: importedAt })
      .lt('last_imported_at', importedAt)
      .eq('is_active', true)
      .eq('site_slug', siteSlug)   // Sprint OG.CATALOG — scope to current brand
      .select('relation_id')
    if (deErr) {
      errors.push(`Deactivation pass failed: ${deErr.message}`)
    } else {
      deactivated = deactivatedRows?.length ?? 0
    }
  }

  // ── 5. Audit-log row ─────────────────────────────────────────────────────
  const { data: auditRow } = await db
    .from('g2g_catalog_imports')
    .insert({
      owner_user_id:    ownerUserId,
      imported_at:      importedAt,
      source_label:     sourceLabel,
      rows_total:       rows.length,
      rows_inserted:    inserted,
      rows_updated:     updated,
      rows_unchanged:   unchanged,
      rows_deactivated: deactivated,
      notes:            errors.length ? errors.join('\n').slice(0, 4000) : null,
    })
    .select('id')
    .single()

  return {
    ok:               errors.length === 0,
    rows_total:       rows.length,
    rows_inserted:    inserted,
    rows_updated:     updated,
    rows_unchanged:   unchanged,
    rows_deactivated: deactivated,
    errors,
    imported_at:      importedAt,
    import_id:        auditRow?.id ?? undefined,
  }
}

// ─── CSV parsing ────────────────────────────────────────────────────────────

interface ParseOk  { ok: true;  rows: CatalogRow[]; errors: string[] }
interface ParseErr { ok: false; rows: never;        errors: string[] }

export function parseCatalogCsv(csvText: string): ParseOk | ParseErr {
  // Strip BOM if Excel-exported.
  const text = csvText.replace(/^﻿/, '')
  const lines = text.split(/\r?\n/).filter(l => l.length > 0)

  if (lines.length < 2) {
    return { ok: false, rows: undefined as never, errors: ['CSV has fewer than 2 lines (need header + at least 1 row)'] }
  }

  const header = splitCsvLine(lines[0]).map(s => s.toLowerCase().trim())
  const missingHeaders = REQUIRED_HEADERS.filter(h => !header.includes(h))
  if (missingHeaders.length) {
    return { ok: false, rows: undefined as never, errors: [`Missing required headers: ${missingHeaders.join(', ')}. Found: ${header.join(', ')}`] }
  }

  const idx = {
    service_id:    header.indexOf('service_id'),
    brand_id:      header.indexOf('brand_id'),
    relation_id:   header.indexOf('relation_id'),
    service_name:  header.indexOf('service_name'),
    brand_name:    header.indexOf('brand_name'),
    created_at:    header.indexOf('created_at'),
  }

  const rows: CatalogRow[]  = []
  const errors: string[]    = []
  const seenRel = new Set<string>()

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i])
    if (cols.length < REQUIRED_HEADERS.length) {
      errors.push(`Line ${i + 1}: only ${cols.length} columns (skipped)`)
      continue
    }

    const service_id   = cols[idx.service_id]?.trim()
    const brand_id     = cols[idx.brand_id]?.trim()
    const relation_id  = cols[idx.relation_id]?.trim()
    const service_name = cols[idx.service_name]?.trim()
    const brand_name   = cols[idx.brand_name]?.trim()
    const created_raw  = cols[idx.created_at]?.trim()

    if (!service_id || !brand_id || !relation_id || !service_name || !brand_name) {
      errors.push(`Line ${i + 1}: missing required field(s) (skipped)`)
      continue
    }
    if (!isUuid(service_id)) {
      errors.push(`Line ${i + 1}: service_id "${service_id}" not a UUID (skipped)`)
      continue
    }
    if (!isUuid(relation_id)) {
      errors.push(`Line ${i + 1}: relation_id "${relation_id}" not a UUID (skipped)`)
      continue
    }
    if (seenRel.has(relation_id)) {
      // Duplicate within the same CSV — keep first, skip rest.
      continue
    }
    seenRel.add(relation_id)

    rows.push({
      service_id,
      brand_id,
      relation_id,
      service_name,
      brand_name,
      cms_created_at: parseCmsDate(created_raw),
    })
  }

  return { ok: true, rows, errors }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Minimal CSV line splitter: handles double-quoted fields containing commas
 *  + escaped double-quotes (""). Good enough for the G2G admin export, which
 *  is a clean RFC-4180-ish dump. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else inQuotes = false
      } else {
        cur += c
      }
    } else {
      if (c === ',')      { out.push(cur); cur = '' }
      else if (c === '"') inQuotes = true
      else                cur += c
    }
  }
  out.push(cur)
  return out
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

/** Source CSV uses 'YYYY-MM-DD HH:MM:SS' (no timezone). Treat as UTC. */
function parseCmsDate(raw: string | undefined): string | null {
  if (!raw) return null
  const d = new Date(raw.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function baseResult(importedAt: string, errors: string[]): ImportResult {
  return {
    ok: false,
    rows_total: 0,
    rows_inserted: 0,
    rows_updated: 0,
    rows_unchanged: 0,
    rows_deactivated: 0,
    errors,
    imported_at: importedAt,
  }
}
