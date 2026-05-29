import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getKeywordSuggestions } from '@/lib/dataforseo/client'
import { classifyIntent, blendScore } from '@/lib/competitive/scorer'

export const maxDuration = 60

/**
 * Sprint COMPETITIVE.SCORER.5 — Discover competitive keyword candidates for a
 * cluster that has no winner tracked yet.
 *
 * POST /api/competitive/discover
 *   Body: { product_tier_id: string, market: 'us' | 'id', limit?: number }
 *
 * Flow:
 *   1. Load the product (name, category, url)
 *   2. Seed DataForSEO keyword_suggestions with product name (+ variants)
 *   3. For each candidate: classify intent + compute preliminary score
 *      (density default 50 per methodology — SERP density only computable
 *      once we've snapshot the kw)
 *   4. Filter: SV >= 100, intent >= 50
 *   5. Dedupe against existing tier_keywords for this product
 *   6. Top N (default 5) → create seo_opportunities with source='competitive_discovery'
 *
 * Returns: list of candidates created + skipped reasons.
 */

interface PostBody {
  product_tier_id: string
  market:          'us' | 'id'
  limit?:          number
}

const LOCATION_BY_MARKET: Record<string, number> = { us: 2840, id: 2360 }
const LANG_BY_MARKET:     Record<string, string> = { us: 'en',  id: 'id'   }

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as Partial<PostBody>
  const productTierId = String(body.product_tier_id ?? '').trim()
  const market        = (body.market === 'id' ? 'id' : body.market === 'us' ? 'us' : null)
  if (!productTierId)  return NextResponse.json({ error: 'product_tier_id required' }, { status: 400 })
  if (!market)         return NextResponse.json({ error: 'market must be us|id' },   { status: 400 })

  const limit = Math.max(1, Math.min(10, Number(body.limit ?? 5)))

  // ── 1. Load product context ──────────────────────────────────────────────
  const { data: product, error: prodErr } = await db
    .from('product_tiers')
    .select('id, tier, site_slug, product_name, category, url')
    .eq('id', productTierId)
    .eq('owner_user_id', ownerId)
    .single()

  if (prodErr || !product) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }

  // ── 2. Get existing kws for dedup ────────────────────────────────────────
  const { data: existingKws } = await db
    .from('tier_keywords')
    .select('keyword, cluster_market')
    .eq('owner_user_id', ownerId)
    .eq('product_tier_id', productTierId)
  const existingSet = new Set(
    (existingKws ?? []).map(k => `${String(k.keyword).toLowerCase().trim()}|${k.cluster_market ?? market}`),
  )

  // Also dedupe against opportunities already discovered for this product
  const { data: existingOpps } = await db
    .from('seo_opportunities')
    .select('topic')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', product.site_slug)
    .like('topic_slug', 'competitive-discovery%')
  const existingOppTopics = new Set(
    (existingOpps ?? []).map(o => String(o.topic ?? '').toLowerCase().trim()),
  )

  // ── 3. Seed DataForSEO with product name ────────────────────────────────
  const seed = product.product_name.trim()
  const locationCode = LOCATION_BY_MARKET[market]
  const langCode     = LANG_BY_MARKET[market]
  let suggestions: Awaited<ReturnType<typeof getKeywordSuggestions>> = []
  try {
    suggestions = await getKeywordSuggestions(seed, locationCode, langCode, 50)
  } catch (e) {
    return NextResponse.json({
      ok:    false,
      error: `DataForSEO suggestion fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    }, { status: 502 })
  }

  if (suggestions.length === 0) {
    return NextResponse.json({
      ok:        true,
      product:   product.product_name,
      market,
      created:   [],
      skipped:   [],
      message:   `DataForSEO returned 0 suggestions for seed "${seed}". Try a more specific product name or seed manually.`,
    })
  }

  // ── 4. Score each candidate ──────────────────────────────────────────────
  // SV normalization: max within this batch = 100 (consistent with cluster rule).
  const maxSv = Math.max(...suggestions.map(s => s.search_volume ?? 0), 1)

  type Candidate = {
    keyword:           string
    sv_volume:         number | null
    sv_volume_norm:    number
    intent_score:      number
    serp_density:      number   // default 50 per methodology
    preliminary_score: number
  }

  const scored: Candidate[] = suggestions
    .filter(s => (s.search_volume ?? 0) >= 100)   // demand floor
    .map(s => {
      const sv_volume_norm = Math.round(((s.search_volume ?? 0) / maxSv) * 100)
      const intent_score   = classifyIntent(s.keyword)
      const serp_density   = 50    // default until we snapshot
      return {
        keyword:           s.keyword,
        sv_volume:         s.search_volume ?? null,
        sv_volume_norm,
        intent_score,
        serp_density,
        preliminary_score: blendScore({ sv_volume_norm, serp_density, intent_score }),
      }
    })
    .filter(c => c.intent_score >= 50)            // skip pure nav / very weak
    .sort((a, b) => b.preliminary_score - a.preliminary_score)

  // ── 5. Filter dedups + take top N ────────────────────────────────────────
  const created: Array<{ keyword: string; score: number; opportunity_id: string }> = []
  const skipped: Array<{ keyword: string; reason: string }> = []

  for (const c of scored) {
    const lowerKw = c.keyword.toLowerCase().trim()
    if (existingSet.has(`${lowerKw}|${market}`)) {
      skipped.push({ keyword: c.keyword, reason: 'already tracked in tier_keywords' })
      continue
    }
    if (existingOppTopics.has(lowerKw)) {
      skipped.push({ keyword: c.keyword, reason: 'already in opportunity pipeline' })
      continue
    }
    if (created.length >= limit) break

    const topicSlug = `competitive-discovery-${lowerKw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)}`

    // eslint-disable-next-line no-await-in-loop
    const { data: opp, error: oppErr } = await db
      .from('seo_opportunities')
      .upsert({
        owner_user_id:  ownerId,
        site_slug:      product.site_slug,
        topic:          c.keyword,
        topic_slug:     topicSlug,
        target_url:     product.url ?? null,
        status:         'new',
        heimdall_signals: [{
          action_id:  `competitive_discovery_${Date.now()}_${created.length}`,
          source:     'competitive_discovery',
          summary:    `Competitive kw candidate for T${product.tier} ${product.product_name} (${market.toUpperCase()})`,
          tier:       product.tier,
          tier_id:    product.id,
          market,
          sv_volume:        c.sv_volume,
          sv_volume_norm:   c.sv_volume_norm,
          intent_score:     c.intent_score,
          serp_density:     c.serp_density,
          preliminary_score: c.preliminary_score,
          created_at: new Date().toISOString(),
        }],
        signal_count:    1,
        total_sv:        c.sv_volume ?? 0,
        last_signal_at:  new Date().toISOString(),
      }, { onConflict: 'owner_user_id,site_slug,topic_slug' })
      .select('id')
      .single()

    if (oppErr || !opp) {
      skipped.push({ keyword: c.keyword, reason: `insert failed: ${oppErr?.message ?? 'unknown'}` })
      continue
    }
    created.push({ keyword: c.keyword, score: c.preliminary_score, opportunity_id: opp.id })
  }

  return NextResponse.json({
    ok:        true,
    product:   product.product_name,
    market,
    seed,
    suggestions_returned: suggestions.length,
    scored_candidates:    scored.length,
    created,
    skipped: skipped.slice(0, 20),
  })
}
