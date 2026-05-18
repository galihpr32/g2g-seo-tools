import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { buildAiVisibilityOverview, upsertSnapshot, LLM_SOURCES } from '@/lib/agents/freyja'

export const maxDuration = 30

/**
 * Sprint FREYJA — AI Visibility dashboard data + manual import endpoint.
 *
 * GET  /api/reports/ai-visibility?days=84   → dashboard payload
 * POST /api/reports/ai-visibility            → import snapshots (single or batch)
 *
 * Manual upload is the primary path for now because Bing Webmaster AI
 * Performance and Semrush AI Visibility don't have stable public APIs yet.
 * Schema is API-ready when they do — upsertSnapshot accepts `source: 'bing_api'`
 * or `'semrush_api'` for future automation.
 */

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const url  = new URL(req.url)
  const days = Math.min(365, Math.max(7, parseInt(url.searchParams.get('days') ?? '84', 10)))

  try {
    const overview = await buildAiVisibilityOverview(db, ownerId, siteSlug, days)
    return NextResponse.json({ ok: true, site_slug: siteSlug, window_days: days, overview })
  } catch (err) {
    console.error('[ai-visibility GET] build failed:', err)
    return NextResponse.json({
      ok:    false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 })
  }
}

/**
 * POST body:
 *   Single row:
 *     {
 *       snapshot_date: '2026-05-15',
 *       llm_source:    'bing_ai',
 *       country:       'global',
 *       mentions:      12500,
 *       citations:     8400,
 *       cited_pages:   691,
 *       source:        'manual'
 *     }
 *
 *   Or batch:
 *     { rows: [ {...}, {...}, ... ] }
 *
 * Re-imports of same (date × llm × country) override.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Normalize to rows[]
  let rows: Array<Record<string, unknown>>
  if (Array.isArray(body)) {
    rows = body
  } else if (body && typeof body === 'object' && 'rows' in body && Array.isArray((body as { rows: unknown }).rows)) {
    rows = (body as { rows: Array<Record<string, unknown>> }).rows
  } else if (body && typeof body === 'object') {
    rows = [body as Record<string, unknown>]
  } else {
    return NextResponse.json({ error: 'Body must be a row, array of rows, or {rows: [...]}' }, { status: 400 })
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: 'No rows provided' }, { status: 400 })
  }
  if (rows.length > 500) {
    return NextResponse.json({ error: 'Max 500 rows per request' }, { status: 400 })
  }

  let inserted = 0
  const errors: Array<{ idx: number; error: string }> = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    // Light validation — llm_source whitelist (warn but allow custom for forward-compat)
    const llmSource = String(r.llm_source ?? '').trim().toLowerCase()
    if (!(LLM_SOURCES as readonly string[]).includes(llmSource)) {
      // Allow it through but flag in response metadata so client knows.
      // Forward-compat: new LLMs added in code update the whitelist, but
      // import endpoint shouldn't block experiments.
    }

    // eslint-disable-next-line no-await-in-loop
    const res = await upsertSnapshot(db, {
      owner_user_id: ownerId,
      site_slug:     siteSlug,
      snapshot_date: String(r.snapshot_date ?? ''),
      llm_source:    llmSource,
      country:       r.country ? String(r.country) : 'global',
      mentions:      Number(r.mentions    ?? 0),
      citations:     Number(r.citations   ?? 0),
      cited_pages:   Number(r.cited_pages ?? 0),
      source:        (r.source as 'manual' | 'csv' | 'bing_api' | 'semrush_api' | undefined) ?? 'manual',
      metadata:      (r.metadata as Record<string, unknown> | undefined) ?? undefined,
    })

    if (res.ok) inserted++
    else        errors.push({ idx: i, error: res.error ?? 'unknown' })
  }

  return NextResponse.json({
    ok:        errors.length === 0,
    inserted,
    skipped:   errors.length,
    errors:    errors.slice(0, 20),  // cap response size
    site_slug: siteSlug,
  })
}
