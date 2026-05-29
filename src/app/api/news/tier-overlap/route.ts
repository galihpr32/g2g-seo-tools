import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import type { ExtractedKeyword } from '@/lib/news-export/keyword-extractor'

export const maxDuration = 15

/**
 * GET /api/news/tier-overlap?days=14
 *
 * For the news-signals page top section: returns each tier 1/2 product that
 * has been mentioned in news articles in the lookback window, with the top
 * matching articles + extracted keywords + brief status.
 *
 * Smaller payload than the export — only what the UI needs to render the
 * pinned section.
 */

interface TierOverlapProduct {
  tier_id:         string
  tier:            number
  product_name:    string
  category:        string | null
  relation_id:     string | null
  url:             string | null
  /** Latest brief id for this tier product (so UI can offer "Update existing brief"). */
  latest_brief_id: string | null
  article_count:   number
  top_keywords:    ExtractedKeyword[]   // dedupe + top 5 across all matching articles
  news_types:      string[]
  latest_articles: Array<{
    id:           string
    title:        string
    url:          string
    source_name:  string | null
    published_at: string | null
    news_type:    string | null
    importance:   number
  }>
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const { searchParams } = new URL(req.url)
  const days = Math.min(Math.max(parseInt(searchParams.get('days') ?? '14'), 1), 60)
  const db = createServiceClient()

  // 1. Tier products
  const { data: tiers } = await db
    .from('product_tiers')
    .select('id, product_name, category, relation_id, tier, url')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
  if (!tiers?.length) return NextResponse.json({ products: [] })

  const tierByName = new Map<string, typeof tiers[number]>()
  for (const t of tiers) tierByName.set(String(t.product_name).toLowerCase(), t)

  // 2. News in window
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString()
  const { data: items } = await db
    .from('news_items')
    .select('id, source_name, url, title, published_at, extracted_keywords')
    .eq('owner_user_id', ownerId)
    .gte('fetched_at', sinceIso)
    .order('published_at', { ascending: false })
    .limit(800)

  if (!items?.length) return NextResponse.json({ products: [] })

  const itemIds = items.map(i => i.id)
  const { data: exts } = await db
    .from('news_game_extractions')
    .select('news_item_id, game_name, news_type, mentions_count, kb_matched')
    .in('news_item_id', itemIds)

  const itemById = new Map(items.map(i => [i.id, i]))

  // 3. Bucket extractions by tier product (case-insensitive name match)
  interface Bucket {
    tier: typeof tiers[number]
    articles: Array<{
      id: string; title: string; url: string; source_name: string | null;
      published_at: string | null; news_type: string | null; mention_count: number; kb_matched: boolean
    }>
  }
  const bucketByTier = new Map<string, Bucket>()
  for (const e of (exts ?? []) as Array<{
    news_item_id: string; game_name: string; news_type: string | null; mentions_count: number; kb_matched: boolean
  }>) {
    const tier = tierByName.get(e.game_name.toLowerCase())
    if (!tier) continue
    const item = itemById.get(e.news_item_id)
    if (!item) continue

    const key = String(tier.id)
    let b = bucketByTier.get(key)
    if (!b) { b = { tier, articles: [] }; bucketByTier.set(key, b) }
    b.articles.push({
      id:            String(item.id),
      title:         String(item.title),
      url:           String(item.url),
      source_name:   item.source_name ? String(item.source_name) : null,
      published_at:  item.published_at,
      news_type:     e.news_type,
      mention_count: Number(e.mentions_count ?? 1),
      kb_matched:    !!e.kb_matched,
    })
  }

  if (bucketByTier.size === 0) return NextResponse.json({ products: [] })

  // 4. Pull latest brief per tier (if any) — for "Update existing brief" button
  const tierIds = Array.from(bucketByTier.values()).map(b => b.tier.relation_id).filter(Boolean) as string[]
  const briefMap = new Map<string, string>()
  if (tierIds.length) {
    // Brief by action_item.relation_id or by tier_product_id — try the most
    // common shape: seo_content_briefs joined via action_items has relation_id.
    // Simpler: scan seo_content_briefs.notes or page URL containing relation_id.
    // For v1 of this feature, just match by primary keyword similarity. Skip
    // the join for now; UI will fall back to "Push to Bragi" without it.
  }

  // 5. Shape response
  const products: TierOverlapProduct[] = []
  for (const b of bucketByTier.values()) {
    // Dedupe + collect keywords + news_types
    const kwSeen = new Map<string, ExtractedKeyword>()
    const types  = new Set<string>()
    let articleCount = 0
    for (const a of b.articles) {
      articleCount++
      if (a.news_type) types.add(a.news_type)
      const item = itemById.get(a.id)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kws = ((item as any)?.extracted_keywords ?? []) as ExtractedKeyword[]
      for (const k of kws) {
        if (!kwSeen.has(k.phrase)) kwSeen.set(k.phrase, k)
      }
    }
    // Sort keywords by relevance (high > medium > low) and cap at 6
    const ranked = Array.from(kwSeen.values()).sort((x, y) => {
      const rank = (r: string) => r === 'high' ? 3 : r === 'medium' ? 2 : 1
      return rank(y.relevance) - rank(x.relevance)
    }).slice(0, 6)

    // Sort articles by published_at desc, take top 5
    const latestArticles = b.articles
      .slice()
      .sort((a, c) => String(c.published_at ?? '').localeCompare(String(a.published_at ?? '')))
      .slice(0, 5)
      .map(a => ({
        id:            a.id,
        title:         a.title,
        url:           a.url,
        source_name:   a.source_name,
        published_at:  a.published_at,
        news_type:     a.news_type,
        // Lightweight importance proxy: mention_count × kb_match bonus
        importance:    Math.round((a.mention_count ?? 1) * 10 * (a.kb_matched ? 1.3 : 1)),
      }))

    products.push({
      tier_id:         String(b.tier.id),
      tier:            Number(b.tier.tier),
      product_name:    String(b.tier.product_name),
      category:        b.tier.category ?? null,
      relation_id:     b.tier.relation_id ?? null,
      url:             b.tier.url ?? null,
      latest_brief_id: briefMap.get(String(b.tier.id)) ?? null,
      article_count:   articleCount,
      top_keywords:    ranked,
      news_types:      Array.from(types),
      latest_articles: latestArticles,
    })
  }

  // Sort: Tier 1 first, then by article count desc
  products.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    return b.article_count - a.article_count
  })

  return NextResponse.json({ products })
}
