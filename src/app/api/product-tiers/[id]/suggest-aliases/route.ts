// Sprint CKB.BRAND-ALIAS.3 — Hugin-mined alias suggestions.
//
// GET /api/product-tiers/[id]/suggest-aliases
//   → scans hugin_queries for short tokens (≤4 chars) that co-occur with
//     this tier's brand_canonical tokens at threshold ≥3x. Returns ranked
//     suggestions for Galih to review + approve.
//
// Pure local SQL + JS string ops — zero external API cost. Designed to
// surface candidates like "bns" for products named "Blade & Soul NEO"
// without manual entry.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

// Words we never suggest as aliases (would dilute the filter)
const STOPWORD_BLACKLIST = new Set([
  'cheap', 'best', 'top', 'fast', 'safe', 'free', 'low', 'high', 'pro',
  'buy', 'get', 'sell', 'sale', 'order', 'how', 'where', 'when', 'why',
  'what', 'who', 'price', 'deal', 'site', 'shop', 'the', 'and', 'for',
  'with', 'gold', 'silver', 'coin', 'coins', 'gem', 'gems', 'key', 'keys',
  'account', 'top', 'up', 'item', 'items', 'farm', 'boost', 'card', 'cards',
])

interface Suggestion {
  alias:          string
  cooccurrence:   number      // how many queries containing this token also contained a brand token
  total_seen:     number      // total times this token appeared in candidate queries
  brand_purity:   number      // cooccurrence / total_seen — 1.0 means token only appears with brand
  sample_queries: string[]    // up to 3 example queries
}

function tokenize(s: string): string[] {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s&]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  // 1. Load the tier row to know which brand we're mining for
  const { data: tier } = await db
    .from('product_tiers')
    .select('id, site_slug, product_name, brand_canonical, brand_aliases')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (!tier) return NextResponse.json({ error: 'Product not found' }, { status: 404 })

  // Brand identifier tokens: brand_canonical + product_name (fallback)
  // Aliases already saved are excluded so we don't re-suggest them.
  const existingAliases = new Set<string>((tier.brand_aliases as string[] | undefined) ?? [])
  const brandSource = String(tier.brand_canonical ?? tier.product_name ?? '')
  const brandTokens = new Set(tokenize(brandSource).filter(t => t.length >= 3 && !STOPWORD_BLACKLIST.has(t)))

  if (brandTokens.size === 0) {
    return NextResponse.json({
      ok:          true,
      suggestions: [],
      reason:      'no_brand_tokens',
      hint:        'Set brand_canonical or product_name to enable mining',
    })
  }

  // 2. Pull recent Hugin queries for this site (period_days=30 is the
  //    standard sliding window; status filter dropped so we mine the full
  //    pool including ALREADY-clustered queries, since aliases are about
  //    detecting brand identity, not opportunity discovery).
  const { data: rows } = await db
    .from('hugin_queries')
    .select('query, clicks')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     tier.site_slug)
    .eq('period_days',   30)
    .order('clicks', { ascending: false, nullsFirst: false })
    .limit(2000)   // cap so heavy GSC accounts don't OOM

  // 3. Build co-occurrence map: short candidate token → {seenWithBrand, seenTotal, samples[]}
  const cand = new Map<string, { withBrand: number; total: number; samples: string[] }>()

  for (const r of (rows ?? []) as Array<{ query: string }>) {
    const tokens = tokenize(r.query)
    if (tokens.length === 0) continue
    const tokenSet = new Set(tokens)

    // Does this query contain ANY known brand token?
    let hasBrand = false
    for (const t of tokenSet) if (brandTokens.has(t)) { hasBrand = true; break }

    // For every SHORT token (2-5 chars) in this query, log co-occurrence
    for (const tok of tokenSet) {
      if (tok.length < 2 || tok.length > 5)      continue
      if (STOPWORD_BLACKLIST.has(tok))           continue
      if (existingAliases.has(tok))              continue
      if (brandTokens.has(tok))                  continue   // already-known brand token
      if (/^\d+$/.test(tok))                     continue   // pure number

      const entry = cand.get(tok) ?? { withBrand: 0, total: 0, samples: [] }
      entry.total++
      if (hasBrand) {
        entry.withBrand++
        if (entry.samples.length < 3) entry.samples.push(r.query)
      }
      cand.set(tok, entry)
    }
  }

  // 4. Rank: require ≥3 cooccurrences AND ≥60% purity (most appearances
  //    must be with brand). High purity = confident this token is brand-
  //    specific, not a generic gaming term that snuck through.
  const out: Suggestion[] = []
  for (const [tok, s] of cand) {
    if (s.withBrand < 3) continue
    const purity = s.total > 0 ? s.withBrand / s.total : 0
    if (purity < 0.6)    continue
    out.push({
      alias:          tok,
      cooccurrence:   s.withBrand,
      total_seen:     s.total,
      brand_purity:   Math.round(purity * 100) / 100,
      sample_queries: s.samples,
    })
  }
  // Sort by cooccurrence × purity (strong signal first), then alphabetical
  out.sort((a, b) => {
    const sA = a.cooccurrence * a.brand_purity
    const sB = b.cooccurrence * b.brand_purity
    if (sB !== sA) return sB - sA
    return a.alias.localeCompare(b.alias)
  })

  return NextResponse.json({
    ok:           true,
    product_name: tier.product_name,
    brand_tokens: Array.from(brandTokens),
    scanned_rows: (rows ?? []).length,
    suggestions:  out.slice(0, 10),
  })
}
