// Sprint #387 BACKLINKS.SHEET.SYNC ─────────────────────────────────────────
//
// GET  /api/backlinks/sync?site=g2g
//      → { config: { sheet_url, last_synced_at, last_sync_rows_added, ... } | null }
//
// PUT  /api/backlinks/sync
//      Body: { site_slug, sheet_url }
//      → Upsert (owner_user_id, site_slug) row in `backlinks_sync_config`.
//
// POST /api/backlinks/sync
//      Body: { site_slug }
//      → Fetch the configured sheet_url server-side, parse CSV, append new
//        rows to `paid_backlinks` (skip if external_url already exists for
//        the same owner+site — APPEND-ONLY by user spec). Returns counts.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const runtime     = 'nodejs'
export const maxDuration = 60          // sheet fetch + parse + N inserts
export const dynamic     = 'force-dynamic'

const TABLE_CFG     = 'backlinks_sync_config'
const TABLE_TARGET  = 'paid_backlinks'

// ─── GET — return current config (or null) ────────────────────────────────
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const { data, error } = await db
    .from(TABLE_CFG)
    .select('sheet_url, last_synced_at, last_sync_rows_added, last_sync_rows_skipped, last_sync_rows_errored, last_sync_error')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ config: data ?? null, siteSlug })
}

// ─── PUT — save (upsert) config ───────────────────────────────────────────
export async function PUT(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { site_slug?: string; sheet_url?: string }
  const sheetUrl = String(body.sheet_url ?? '').trim()
  if (!sheetUrl) return NextResponse.json({ error: 'sheet_url required' }, { status: 400 })
  if (!/^https:\/\/docs\.google\.com\/spreadsheets\//.test(sheetUrl)) {
    return NextResponse.json({
      error: 'sheet_url must be a Google Sheets "Publish to web → CSV" URL ' +
             '(starts with https://docs.google.com/spreadsheets/)',
    }, { status: 400 })
  }

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req, body)
  const db       = createServiceClient()

  const { data, error } = await db
    .from(TABLE_CFG)
    .upsert({
      owner_user_id: ownerId,
      site_slug:     siteSlug,
      sheet_url:     sheetUrl,
    }, { onConflict: 'owner_user_id,site_slug' })
    .select('sheet_url, last_synced_at, last_sync_rows_added, last_sync_rows_skipped, last_sync_rows_errored, last_sync_error')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ config: data, siteSlug })
}

// ─── POST — run the sync ──────────────────────────────────────────────────
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body     = await req.clone().json().catch(() => ({})) as { site_slug?: string }
  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req, body)
  const db       = createServiceClient()

  // 1. Load saved sheet_url
  const { data: cfgRow, error: cfgErr } = await db
    .from(TABLE_CFG)
    .select('sheet_url')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
    .maybeSingle()
  if (cfgErr) return NextResponse.json({ error: cfgErr.message }, { status: 500 })
  if (!cfgRow?.sheet_url) return NextResponse.json({
    error: 'No sheet URL configured. Save a sheet URL first.',
  }, { status: 400 })

  // 2. Fetch CSV
  let csvText: string
  try {
    const resp = await fetch(cfgRow.sheet_url, { redirect: 'follow', cache: 'no-store' })
    if (!resp.ok) {
      await markFailure(db, ownerId, siteSlug, `HTTP ${resp.status} fetching sheet`)
      return NextResponse.json({
        error: `Failed to fetch sheet (HTTP ${resp.status}). Make sure the sheet is published via File → Share → Publish to web → CSV, and the link is accessible.`,
      }, { status: 502 })
    }
    csvText = await resp.text()
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'fetch failed'
    await markFailure(db, ownerId, siteSlug, msg)
    return NextResponse.json({ error: `Failed to fetch sheet: ${msg}` }, { status: 502 })
  }

  // 3. Parse CSV
  const rows = parseCsv(csvText)
  if (rows.length < 2) {
    await markFailure(db, ownerId, siteSlug, 'CSV had no data rows')
    return NextResponse.json({
      error: 'CSV had no data rows. Make sure the sheet has a header row + at least one data row.',
    }, { status: 400 })
  }

  // 4. Map header columns (case-insensitive, any order)
  const header = rows[0].map(s => s.trim().toLowerCase())
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n)
      if (i >= 0) return i
    }
    return -1
  }
  const cSite    = col('site_name', 'site')
  const cUrl     = col('external_url', 'url')
  const cAnchor  = col('anchor_text', 'anchor')
  const cTarget  = col('target_page', 'target')
  const cKw      = col('target_keyword', 'keyword')
  const cCountry = col('target_country', 'country')
  const cStatus  = col('link_status', 'status')
  const cCost    = col('cost_amount', 'cost')
  const cCurr    = col('cost_currency', 'currency')
  const cDate    = col('live_date', 'date')
  const cUtmS    = col('utm_source')
  const cUtmM    = col('utm_medium')
  const cUtmC    = col('utm_campaign')
  const cUtmT    = col('utm_term')
  const cUtmCt   = col('utm_content')
  const cNotes   = col('notes')

  // Required columns
  if (cSite < 0 || cUrl < 0 || cAnchor < 0 || cTarget < 0) {
    const errMsg = 'CSV must include columns: site_name, external_url, anchor_text, target_page'
    await markFailure(db, ownerId, siteSlug, errMsg)
    return NextResponse.json({ error: errMsg }, { status: 400 })
  }

  // 5. Load existing external_urls for dedup (append-only mode)
  const { data: existingRows, error: existErr } = await db
    .from(TABLE_TARGET)
    .select('external_url')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
  if (existErr) {
    await markFailure(db, ownerId, siteSlug, existErr.message)
    return NextResponse.json({ error: existErr.message }, { status: 500 })
  }
  const existingUrls = new Set(
    ((existingRows ?? []) as Array<{ external_url: string }>).map(r => r.external_url.trim().toLowerCase()),
  )

  // 6. Walk data rows → build inserts
  const allowedStatus = new Set(['active', 'broken', 'pending'])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toInsert: any[] = []
  let skipped = 0
  let errored = 0
  const errorSamples: Array<{ row: number; reason: string }> = []

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const rowNum = i + 1
    const url = (row[cUrl] ?? '').trim()
    if (!url) { errored++; if (errorSamples.length < 5) errorSamples.push({ row: rowNum, reason: 'external_url empty' }); continue }
    if (!/^https?:\/\//i.test(url)) { errored++; if (errorSamples.length < 5) errorSamples.push({ row: rowNum, reason: 'external_url must start with http(s)://' }); continue }

    if (existingUrls.has(url.toLowerCase())) { skipped++; continue }

    const siteName = (row[cSite]   ?? '').trim()
    const anchor   = (row[cAnchor] ?? '').trim()
    const target   = (row[cTarget] ?? '').trim()
    if (!siteName || !anchor || !target) {
      errored++
      if (errorSamples.length < 5) errorSamples.push({ row: rowNum, reason: 'missing required field (site_name/anchor_text/target_page)' })
      continue
    }

    const statusRaw = cStatus >= 0 ? (row[cStatus] ?? '').trim().toLowerCase() : 'active'
    const status    = allowedStatus.has(statusRaw) ? statusRaw : 'active'

    const costStr = cCost >= 0 ? (row[cCost] ?? '').trim().replace(/[^0-9.\-]/g, '') : ''
    const costNum = costStr ? Number(costStr) : null

    const liveStr = cDate >= 0 ? (row[cDate] ?? '').trim() : ''
    const liveOk  = /^\d{4}-\d{2}-\d{2}$/.test(liveStr) ? liveStr : null

    toInsert.push({
      owner_user_id:  ownerId,
      site_slug:      siteSlug,
      site_name:      siteName,
      external_url:   url,
      anchor_text:    anchor,
      target_page:    target,
      target_keyword: cKw      >= 0 ? (row[cKw]      ?? '').trim() || null : null,
      target_country: cCountry >= 0 ? ((row[cCountry] ?? '').trim().toLowerCase() || 'global') : 'global',
      link_status:    status,
      cost_amount:    Number.isFinite(costNum as number) ? costNum : null,
      cost_currency:  (cCurr >= 0 ? (row[cCurr] ?? '').trim().toUpperCase() : '') || 'USD',
      live_date:      liveOk,
      utm_source:     cUtmS  >= 0 ? (row[cUtmS]  ?? '').trim() || null : null,
      utm_medium:     cUtmM  >= 0 ? (row[cUtmM]  ?? '').trim() || 'referral' : 'referral',
      utm_campaign:   cUtmC  >= 0 ? (row[cUtmC]  ?? '').trim() || null : null,
      utm_term:       cUtmT  >= 0 ? (row[cUtmT]  ?? '').trim() || null : null,
      utm_content:    cUtmCt >= 0 ? (row[cUtmCt] ?? '').trim() || null : null,
      notes:          cNotes >= 0 ? (row[cNotes] ?? '').trim() || null : null,
    })
    existingUrls.add(url.toLowerCase())   // dedup within the same import batch
  }

  // 7. Bulk insert
  let added = 0
  if (toInsert.length > 0) {
    const { error: insErr } = await db.from(TABLE_TARGET).insert(toInsert)
    if (insErr) {
      await markFailure(db, ownerId, siteSlug, insErr.message)
      return NextResponse.json({ error: `Insert failed: ${insErr.message}` }, { status: 500 })
    }
    added = toInsert.length
  }

  // 8. Update sync metadata
  await db.from(TABLE_CFG).update({
    last_synced_at:         new Date().toISOString(),
    last_sync_rows_added:   added,
    last_sync_rows_skipped: skipped,
    last_sync_rows_errored: errored,
    last_sync_error:        null,
  })
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)

  return NextResponse.json({
    ok:           true,
    added,
    skipped,
    errored,
    totalRows:    rows.length - 1,
    errorSamples,
    siteSlug,
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function markFailure(
  db:       ReturnType<typeof createServiceClient>,
  ownerId:  string,
  siteSlug: string,
  msg:      string,
) {
  await db.from(TABLE_CFG).update({
    last_synced_at:  new Date().toISOString(),
    last_sync_error: msg.slice(0, 500),
  })
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
}

// RFC4180-ish CSV parser (mirrors product-tiers/csv-import). Handles
// quoted values, escaped "", CRLF, blank lines.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let cur:    string[] = []
  let cell:   string   = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ }
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
        if (ch === '\r' && text[i + 1] === '\n') i++
        cur.push(cell); cell = ''
        if (cur.some(c => c.trim() !== '')) rows.push(cur)
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
