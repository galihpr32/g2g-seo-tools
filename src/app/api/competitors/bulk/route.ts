import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * POST /api/competitors/bulk
 *
 * Bulk-add multiple competitor domains in one call. Used by the SERP page's
 * "Add N selected as competitors" feature — user can multi-select rows then
 * push them to the workspace's competitor list with a single click.
 *
 * Body:
 *   {
 *     competitors: Array<{ domain: string; name?: string }>
 *   }
 *
 * Behaviour:
 *   - Normalises each domain (strips protocol, trailing slash, lowercases).
 *   - Existing domains in this workspace are silently SKIPPED (no error).
 *   - Missing `name` defaults to the cleaned domain (e.g. "kinguin.net").
 *   - Returns { added: [...], skipped: [...] } so the UI can show
 *     "3 added, 2 already in list" feedback.
 *
 * Returns 200 OK with summary even if all are duplicates.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    competitors?: Array<{ domain?: string; name?: string }>
  }

  if (!Array.isArray(body.competitors) || body.competitors.length === 0) {
    return NextResponse.json({ error: 'competitors array required' }, { status: 400 })
  }
  if (body.competitors.length > 50) {
    return NextResponse.json({ error: 'max 50 competitors per request' }, { status: 400 })
  }

  // ── Normalise + dedupe within request ───────────────────────────────────
  const normalized = new Map<string, { domain: string; name: string }>()
  for (const c of body.competitors) {
    const rawDomain = (c.domain ?? '').trim()
    if (!rawDomain) continue
    const domain = rawDomain
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/^www\./i, '')
      .toLowerCase()
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) continue   // basic validity

    const name = (c.name ?? '').trim() || domainToName(domain)
    if (!normalized.has(domain)) normalized.set(domain, { domain, name })
  }

  if (normalized.size === 0) {
    return NextResponse.json({ added: [], skipped: [], invalid: body.competitors.length })
  }

  // ── Look up existing domains for this workspace ─────────────────────────
  const { data: existing } = await db
    .from('competitors')
    .select('domain')
    .eq('owner_user_id', ownerId)
    .in('domain', Array.from(normalized.keys()))

  const existingDomains = new Set((existing ?? []).map(e => String(e.domain).toLowerCase()))

  // ── Split into to-insert vs already-in-list ─────────────────────────────
  const toInsert: Array<{ owner_user_id: string; domain: string; name: string }> = []
  const skipped: string[] = []

  for (const { domain, name } of normalized.values()) {
    if (existingDomains.has(domain)) {
      skipped.push(domain)
    } else {
      toInsert.push({ owner_user_id: ownerId, domain, name })
    }
  }

  // ── Bulk insert (single round-trip) ─────────────────────────────────────
  let added: Array<{ id: string; domain: string; name: string }> = []
  if (toInsert.length > 0) {
    const { data, error } = await db
      .from('competitors')
      .insert(toInsert)
      .select('id, domain, name')

    if (error) {
      // Best effort — partial may have succeeded. Surface the error but
      // still return what we know was attempted.
      console.error('[competitors/bulk] insert failed:', error)
      return NextResponse.json({
        error:   error.message,
        added:   [],
        skipped,
        attempted: toInsert.map(c => c.domain),
      }, { status: 500 })
    }
    added = data ?? []
  }

  return NextResponse.json({
    added,
    skipped,
    summary: {
      total_requested: body.competitors.length,
      added_count:     added.length,
      skipped_count:   skipped.length,
    },
  })
}

/**
 * Convert a domain into a sensible default display name.
 *   "kinguin.net"        → "Kinguin"
 *   "the-game-haus.com"  → "The Game Haus"
 *   "api.example.co.uk"  → "Api Example"
 */
function domainToName(domain: string): string {
  // Drop TLD
  const noTld = domain.replace(/\.[a-z.]+$/i, '')
  // Replace separators with spaces, title-case
  return noTld
    .split(/[.\-_]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}
