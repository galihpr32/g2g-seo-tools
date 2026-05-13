import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { fuzzyScore } from '@/lib/g2g/fuzzy-match'

export const maxDuration = 30

/**
 * POST /api/product-tiers/match-names
 *
 * Resolves a list of product names against the canonical g2g_products
 * catalog. For each input name returns:
 *   - status: 'exact' | 'multiple' | 'fuzzy' | 'none'
 *   - matches: array of candidate catalog rows
 *
 * The UI then lets the user pick/confirm each match (or skip), and ships the
 * accepted relation_ids to /api/product-tiers/bulk-from-catalog for insert.
 *
 * Body:
 *   {
 *     names: string[],         // one product per element
 *     category?: string,        // optional pre-filter: 'Top Up', 'Accounts', etc.
 *     fuzzyThreshold?: number   // default 0.55
 *   }
 */

interface CatalogRow {
  relation_id:    string
  service_id:     string
  brand_id:       string
  service_name:   string
  brand_name:     string
  is_active:      boolean
}

interface MatchResult {
  name_input:  string
  /**
   * - exact:    1 case-insensitive brand_name match (highest confidence)
   * - multiple: brand_name matched but to MULTIPLE rows (e.g. game has Top Up + Accounts)
   *             → user picks which service category to use
   * - fuzzy:    no exact match, but ≥1 fuzzy match above threshold (user confirms)
   * - none:     no plausible match
   */
  status:      'exact' | 'multiple' | 'fuzzy' | 'none'
  matches:     Array<CatalogRow & { score?: number }>
  /** Highest fuzzy score among matches (set when status='fuzzy'). */
  best_score?: number
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await getEffectiveOwnerId(supabase, user.id)   // ensures session valid, owner not used in catalog query
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    names?:           string[]
    category?:        string
    fuzzyThreshold?:  number
  }

  const names = Array.isArray(body.names)
    ? body.names.map(n => String(n ?? '').trim()).filter(n => n.length > 0).slice(0, 500)
    : []
  if (names.length === 0) {
    return NextResponse.json({ error: 'names array required (non-empty)' }, { status: 400 })
  }

  const threshold      = typeof body.fuzzyThreshold === 'number' ? body.fuzzyThreshold : 0.55
  const categoryFilter = (body.category ?? '').trim() || null

  // 1. Pre-pull entire active catalog (≤14k rows, ~1MB) for in-memory matching.
  //    Doing one big query + JS match is faster than N queries with ILIKE.
  let catQ = db
    .from('g2g_products')
    .select('relation_id, service_id, brand_id, service_name, brand_name, is_active')
    .eq('is_active', true)
  if (categoryFilter) catQ = catQ.eq('service_name', categoryFilter)
  const { data: catalogRaw, error: catErr } = await catQ
  if (catErr) return NextResponse.json({ error: catErr.message }, { status: 500 })

  const catalog = (catalogRaw ?? []) as CatalogRow[]
  if (catalog.length === 0) {
    return NextResponse.json({
      error: categoryFilter
        ? `Catalog empty for category="${categoryFilter}". Upload CSV at /settings/g2g-products or pick a different category.`
        : 'Catalog empty. Upload CSV at /settings/g2g-products first.',
    }, { status: 400 })
  }

  // Build lowercase brand_name index. Same brand may have multiple rows
  // (different service categories) — keep all in an array.
  const byBrand = new Map<string, CatalogRow[]>()
  for (const row of catalog) {
    const k = row.brand_name.toLowerCase().trim()
    const arr = byBrand.get(k) ?? []
    arr.push(row)
    byBrand.set(k, arr)
  }

  // 2. Match each input name
  const results: MatchResult[] = []
  for (const raw of names) {
    const lc = raw.toLowerCase().trim()

    // Exact match first (case-insensitive)
    const exact = byBrand.get(lc)
    if (exact && exact.length === 1) {
      results.push({ name_input: raw, status: 'exact',    matches: exact })
      continue
    }
    if (exact && exact.length > 1) {
      results.push({ name_input: raw, status: 'multiple', matches: exact })
      continue
    }

    // Fuzzy match across catalog (token Jaccard via fuzzy-match lib).
    // Score every row, take top 5 above threshold.
    const scored = catalog
      .map(row => ({ row, score: fuzzyScore(row.brand_name, raw) }))
      .filter(s => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)

    if (scored.length === 0) {
      results.push({ name_input: raw, status: 'none', matches: [] })
      continue
    }

    results.push({
      name_input: raw,
      status:     'fuzzy',
      matches:    scored.map(s => ({ ...s.row, score: Number(s.score.toFixed(2)) })),
      best_score: Number(scored[0].score.toFixed(2)),
    })
  }

  // Aggregate stats
  const stats = {
    total:    results.length,
    exact:    results.filter(r => r.status === 'exact').length,
    multiple: results.filter(r => r.status === 'multiple').length,
    fuzzy:    results.filter(r => r.status === 'fuzzy').length,
    none:     results.filter(r => r.status === 'none').length,
  }

  return NextResponse.json({
    results,
    stats,
    catalog_size:    catalog.length,
    fuzzy_threshold: threshold,
  })
}
