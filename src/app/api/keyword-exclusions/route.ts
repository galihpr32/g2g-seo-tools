import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Given a competitor domain like "playerauctions.com", generate brand exclusion patterns.
 * e.g. "playerauctions.com" → ["playerauctions", "player auction", "player auctions", "playerauction"]
 */
function generateBrandPatterns(domain: string): string[] {
  // Strip TLD and common subdomains
  const base = domain
    .replace(/^www\./, '')
    .replace(/\.(com|gg|io|net|org|co|id|my|sg|ph|tv|shop|store|game|games)(\.[a-z]{2})?$/, '')
    .toLowerCase()

  const patterns = new Set<string>()
  patterns.add(base)  // exact base: "playerauctions"

  // Split on hyphens, underscores or dots: "g2g" stays, "player-auction" → "player auction"
  const spaced = base.replace(/[-_.]/g, ' ').trim()
  if (spaced !== base) patterns.add(spaced)

  // Try to split CamelCase / run-together words heuristically
  // e.g. "playerauction" → "player auction"
  const split = base.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  if (split !== base) patterns.add(split)

  // Common suffix/plural variants
  for (const p of [...patterns]) {
    if (p.endsWith('s')) patterns.add(p.slice(0, -1))       // "playerauctions" → "playerauction"
    else patterns.add(p + 's')                               // "playerauction" → "playerauctions"
  }

  return [...patterns].filter(p => p.length > 2)
}

// ─── GET /api/keyword-exclusions ─────────────────────────────────────────────
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { data, error } = await db
    .from('keyword_exclusions')
    .select('*')
    .eq('owner_user_id', ownerId)
    .order('source', { ascending: true })
    .order('pattern', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ exclusions: data ?? [] })
}

// ─── POST /api/keyword-exclusions ────────────────────────────────────────────
// Body: { pattern: string } for manual add
//       { auto_from_domain: string, source_domain: string } for auto-generate
//       { auto_from_competitors: true } to generate from all tracked competitors
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => ({}))

  // ── Auto-generate from all tracked competitors ────────────────────────────
  if (body.auto_from_competitors) {
    const { data: competitors } = await db
      .from('competitors')
      .select('domain')
      .eq('owner_user_id', ownerId)
      .eq('active', true)

    if (!competitors?.length) {
      return NextResponse.json({ added: 0, message: 'No active competitors found' })
    }

    const rows: { owner_user_id: string; pattern: string; match_type: string; source: string; source_domain: string }[] = []
    for (const comp of competitors) {
      for (const pattern of generateBrandPatterns(comp.domain)) {
        rows.push({
          owner_user_id: ownerId,
          pattern,
          match_type: 'contains',
          source: 'auto',
          source_domain: comp.domain,
        })
      }
    }

    const { data: inserted, error } = await db
      .from('keyword_exclusions')
      .upsert(rows, { onConflict: 'owner_user_id,pattern', ignoreDuplicates: true })
      .select()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ added: inserted?.length ?? 0, patterns: rows.map(r => r.pattern) })
  }

  // ── Auto-generate from a specific domain ─────────────────────────────────
  if (body.auto_from_domain) {
    const patterns = generateBrandPatterns(body.auto_from_domain)
    const rows = patterns.map(p => ({
      owner_user_id: ownerId,
      pattern: p,
      match_type: 'contains',
      source: 'auto',
      source_domain: body.auto_from_domain,
    }))

    const { data: inserted, error } = await db
      .from('keyword_exclusions')
      .upsert(rows, { onConflict: 'owner_user_id,pattern', ignoreDuplicates: true })
      .select()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ added: inserted?.length ?? 0, patterns })
  }

  // ── Manual single pattern ─────────────────────────────────────────────────
  const { pattern, match_type = 'contains' } = body
  if (!pattern?.trim()) {
    return NextResponse.json({ error: 'pattern is required' }, { status: 400 })
  }

  const { data, error } = await db
    .from('keyword_exclusions')
    .insert({ owner_user_id: ownerId, pattern: pattern.trim().toLowerCase(), match_type, source: 'manual' })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'Pattern already exists' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ exclusion: data })
}

// ─── DELETE /api/keyword-exclusions ──────────────────────────────────────────
// Body: { id: string } or { source_domain: string } to bulk-delete auto patterns for a domain
//       { clear_auto: true } to remove all auto-generated patterns
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => ({}))

  if (body.clear_auto) {
    await db.from('keyword_exclusions').delete()
      .eq('owner_user_id', ownerId).eq('source', 'auto')
    return NextResponse.json({ ok: true })
  }

  if (body.source_domain) {
    await db.from('keyword_exclusions').delete()
      .eq('owner_user_id', ownerId).eq('source_domain', body.source_domain)
    return NextResponse.json({ ok: true })
  }

  if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  await db.from('keyword_exclusions').delete()
    .eq('owner_user_id', ownerId).eq('id', body.id)
  return NextResponse.json({ ok: true })
}
