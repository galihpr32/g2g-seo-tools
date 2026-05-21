import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { slugify, getSiteUrlForSlug } from '@/lib/agents/site-helpers'
import { logClaudeUsage } from '@/lib/api-logger'
import { resolveBrandNamesBulk } from '@/lib/clusters/resolve-brand-name'

/**
 * Saga — Cluster Builder (2-level brand → sub-product classifier)
 *
 * This is the AUTHORITATIVE source for keyword clustering across the app.
 * Where the legacy `cluster.ts` proposes incremental cluster moves from
 * agent_actions, this builder rebuilds the universe from scratch:
 *
 *   1. Pull keywords from every source we have for a site:
 *        - tracked_products.keywords[] (manually curated, high confidence)
 *        - keyword_tags                 (manually tagged)
 *        - keyword_gap_snapshots         (Loki finds, top by SV)
 *        - gsc_ranking_snapshots         (top GSC queries last N days)
 *        - keyword_map_clusters         (existing — re-classify under hierarchy)
 *
 *   2. Sonnet classifies each keyword into:
 *        { brand: "World of Warcraft", sub_product: "WoW Gold" }
 *      Brand is the umbrella game/franchise; sub_product is the
 *      market segment we sell (gold, accounts, items, boost, top-up …).
 *      `skip` is returned for competitor brand terms, generic spam, or
 *      navigational queries that don't represent a market.
 *
 *   3. Persist into the 2-level keyword_maps hierarchy:
 *        - level 0 (brand)        — one row per distinct brand
 *        - level 1 (sub_product)  — one row per (brand, sub_product),
 *                                   parent_map_id = brand row
 *        - keyword_map_clusters   — keyword link to LEAF (level-1) map
 *        - cluster_pages          — optional URL ↔ cluster mapping
 *                                   (carried in from tracked_products)
 *
 * Idempotent. Re-running adds new keywords/clusters without duplicating
 * existing ones thanks to the unique indexes in
 * `add_saga_cluster_hierarchy.sql`.
 *
 * Cost model: Sonnet ≈ $0.003 per 30-keyword batch. Default cap 500
 * keywords/run = ~17 batches = ~$0.05/run. Monthly cron = ~$0.60/site/year.
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = 'claude-sonnet-4-6'

export interface ClusterBuilderConfig {
  /** GSC lookback window in days (default 30) */
  windowDays: number
  /** Total keyword cap per run — protects token budget (default 500) */
  maxKeywordsPerRun: number
  /** GSC queries below this clicks threshold are dropped (default 3) */
  minGscClicks: number
  /** Sonnet batch size — bigger batch = cheaper but lower quality (default 30) */
  classifyBatchSize: number
  /** What triggered this run — only used for logging/audit */
  trigger: 'manual' | 'cron' | 'on_demand'
}

export const CLUSTER_BUILDER_DEFAULTS: ClusterBuilderConfig = {
  windowDays:        30,
  maxKeywordsPerRun: 500,
  minGscClicks:      3,
  classifyBatchSize: 30,
  trigger:           'manual',
}

export interface ClusterBuilderResult {
  brandsCreated:        number
  brandsExisting:       number
  subProductsCreated:   number
  subProductsExisting:  number
  keywordsLinked:       number
  keywordsSkipped:      number
  pagesLinked:          number
  classifyCalls:        number
  totalKeywordsLooked:  number
  warnings:             string[]
}

interface KeywordCandidate {
  keyword:       string
  source:        'tracked_product' | 'keyword_tag' | 'keyword_gap' | 'gsc' | 'existing_cluster'
  source_ref_id: string | null
  search_volume: number | null
  page_url:      string | null   // when source = tracked_product, optional carry-through
}

interface Classification {
  brand:       string | null
  sub_product: string | null
  skip:        boolean
  reason:      string
}

interface MapRowMin {
  id:             string
  topic:          string
  topic_slug:     string
  level:          number
  parent_map_id:  string | null
}

// ─── Public entry point ──────────────────────────────────────────────────────

export async function runClusterBuilder(
  ownerId:  string,
  siteSlug: string,
  config:   Partial<ClusterBuilderConfig> = {}
): Promise<ClusterBuilderResult> {
  const cfg = { ...CLUSTER_BUILDER_DEFAULTS, ...config }
  const db = createServiceClient()
  const result: ClusterBuilderResult = {
    brandsCreated:        0,
    brandsExisting:       0,
    subProductsCreated:   0,
    subProductsExisting:  0,
    keywordsLinked:       0,
    keywordsSkipped:      0,
    pagesLinked:          0,
    classifyCalls:        0,
    totalKeywordsLooked:  0,
    warnings:             [],
  }

  // ── 1. Gather candidate keywords ───────────────────────────────────────────
  const candidates = await gatherKeywords(db, ownerId, siteSlug, cfg, result.warnings)
  result.totalKeywordsLooked = candidates.length

  if (candidates.length === 0) return result

  // Dedup by lowercased keyword — keep highest-confidence source first
  const sourceWeight: Record<KeywordCandidate['source'], number> = {
    tracked_product:  5,
    keyword_tag:      4,
    keyword_gap:      3,
    gsc:              2,
    existing_cluster: 1,
  }
  const byKw = new Map<string, KeywordCandidate>()
  for (const c of candidates) {
    const k = c.keyword.toLowerCase().trim()
    if (!k) continue
    const existing = byKw.get(k)
    if (!existing || sourceWeight[c.source] > sourceWeight[existing.source]) {
      byKw.set(k, { ...c, keyword: k })
    } else if (existing && c.search_volume && (!existing.search_volume || c.search_volume > existing.search_volume)) {
      // Keep richer SV when source weights tie
      existing.search_volume = c.search_volume
    }
  }

  let unique = Array.from(byKw.values())
  // Sort by search_volume desc so high-value keywords get classified within the cap
  unique.sort((a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0))
  unique = unique.slice(0, cfg.maxKeywordsPerRun)

  // ── 2. Classify in batches via Sonnet ──────────────────────────────────────
  const classifications: Map<string, Classification> = new Map()
  for (let i = 0; i < unique.length; i += cfg.classifyBatchSize) {
    const batch = unique.slice(i, i + cfg.classifyBatchSize)
    try {
      const cls = await classifyBatch(batch.map(b => b.keyword), siteSlug, db, ownerId)
      result.classifyCalls += 1
      for (let j = 0; j < batch.length; j++) {
        classifications.set(batch[j].keyword, cls[j] ?? { brand: null, sub_product: null, skip: true, reason: 'no result returned' })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.warnings.push(`Sonnet batch ${i / cfg.classifyBatchSize + 1} failed: ${msg}`)
      // Skip the whole batch but keep going on the next
      for (const b of batch) classifications.set(b.keyword, { brand: null, sub_product: null, skip: true, reason: 'classify error' })
    }
  }

  // ── 3. Persist brand + sub-product maps ────────────────────────────────────
  // Cache maps as we create them so subsequent keywords find their parent.
  const brandCache = new Map<string, MapRowMin>()      // brand_slug → row
  const subCache   = new Map<string, MapRowMin>()      // brand_slug + '|' + sub_slug → row

  // Pre-load any existing brand+sub maps so re-runs don't re-create them.
  const { data: existingMaps } = await db
    .from('keyword_maps')
    .select('id, topic, topic_slug, level, parent_map_id')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  const idToMap = new Map<string, MapRowMin>()
  for (const m of (existingMaps ?? []) as MapRowMin[]) idToMap.set(m.id, m)

  for (const m of (existingMaps ?? []) as MapRowMin[]) {
    if (m.level === 0) brandCache.set(m.topic_slug, m)
  }
  for (const m of (existingMaps ?? []) as MapRowMin[]) {
    if (m.level === 1 && m.parent_map_id) {
      const brand = idToMap.get(m.parent_map_id)
      if (brand) subCache.set(`${brand.topic_slug}|${m.topic_slug}`, m)
    }
  }

  // ── 4. Walk classifications, upsert maps + link keywords ───────────────────
  // We collect cluster_pages writes for tracked_product sources so we can
  // batch-insert at the end (cheap, just one round-trip).
  const pageLinks: Array<{ cluster_id: string; page_url: string; role: 'category' }> = []

  // Sprint CLUSTER.RENAME.4 — build canonical brand name lookup so Sonnet's
  // free-form classification gets overridden by user/catalog canonical names.
  // Map<lowercased Sonnet brand string, canonical brand name>.
  const canonicalLookup = new Map<string, string>()
  try {
    const resolved = await resolveBrandNamesBulk(db, ownerId, siteSlug)
    for (const { resolved: name } of resolved.values()) {
      canonicalLookup.set(name.toLowerCase(), name)
      // Also accept first-word match (which is what the broken auto-seed produced)
      // → so e.g. Sonnet saying "World of Warcraft" still maps to canonical "WoW"
      // if user overrode tier.brand_canonical = "WoW".
      const firstWord = name.split(/\s+/)[0]
      if (firstWord && firstWord.length > 2) canonicalLookup.set(firstWord.toLowerCase(), name)
    }
  } catch (err) {
    result.warnings.push(`canonical brand lookup failed (using Sonnet output as-is): ${err instanceof Error ? err.message : String(err)}`)
  }

  /** Substitute Sonnet's brand with canonical if we have one. */
  function canonicalize(sonnetBrand: string): string {
    const hit = canonicalLookup.get(sonnetBrand.toLowerCase())
    if (hit) return hit
    // Fuzzy: try first word of Sonnet's brand
    const firstWord = sonnetBrand.split(/\s+/)[0]
    const fwHit = firstWord ? canonicalLookup.get(firstWord.toLowerCase()) : undefined
    if (fwHit) return fwHit
    return sonnetBrand
  }

  for (const cand of unique) {
    const cls = classifications.get(cand.keyword)
    if (!cls || cls.skip || !cls.brand || !cls.sub_product) {
      result.keywordsSkipped++
      continue
    }

    // Sprint CLUSTER.RENAME.4 — overlay Sonnet's brand string with canonical
    // (user override / catalog) when we have one. Keeps cluster names consistent
    // across the whole app regardless of how Sonnet phrased it on this run.
    const canonicalBrand = canonicalize(cls.brand)
    const brandSlug = slugify(canonicalBrand)
    const subSlug   = slugify(cls.sub_product)
    if (!brandSlug || !subSlug) {
      result.keywordsSkipped++
      continue
    }

    // 4a. Brand map (level 0)
    let brand = brandCache.get(brandSlug)
    if (!brand) {
      const { data: inserted, error: brandErr } = await db
        .from('keyword_maps')
        .insert({
          owner_user_id:  ownerId,
          site_slug:      siteSlug,
          topic:          canonicalBrand,
          topic_slug:     brandSlug,
          level:          0,
          parent_map_id:  null,
          auto_generated: true,
          source:         'saga',
          description:    `Brand cluster auto-generated by Saga from ${cand.source}.`,
        })
        .select('id, topic, topic_slug, level, parent_map_id')
        .maybeSingle()
      if (brandErr || !inserted) {
        // Race / duplicate — re-fetch
        const { data: refetch } = await db
          .from('keyword_maps')
          .select('id, topic, topic_slug, level, parent_map_id')
          .eq('owner_user_id', ownerId)
          .eq('site_slug', siteSlug)
          .eq('topic_slug', brandSlug)
          .is('parent_map_id', null)
          .maybeSingle()
        if (!refetch) {
          result.warnings.push(`Brand insert failed for "${canonicalBrand}": ${brandErr?.message ?? 'unknown'}`)
          result.keywordsSkipped++
          continue
        }
        brand = refetch as MapRowMin
        result.brandsExisting++
      } else {
        brand = inserted as MapRowMin
        result.brandsCreated++
      }
      brandCache.set(brandSlug, brand)
    } else {
      // Already known — no count bump (we counted it earlier on pre-load)
    }

    // 4b. Sub-product map (level 1)
    const subKey = `${brandSlug}|${subSlug}`
    let sub = subCache.get(subKey)
    if (!sub) {
      const { data: inserted, error: subErr } = await db
        .from('keyword_maps')
        .insert({
          owner_user_id:  ownerId,
          site_slug:      siteSlug,
          topic:          cls.sub_product,
          topic_slug:     subSlug,
          level:          1,
          parent_map_id:  brand.id,
          auto_generated: true,
          source:         'saga',
          description:    `Sub-product under "${canonicalBrand}". Auto-generated by Saga.`,
        })
        .select('id, topic, topic_slug, level, parent_map_id')
        .maybeSingle()
      if (subErr || !inserted) {
        const { data: refetch } = await db
          .from('keyword_maps')
          .select('id, topic, topic_slug, level, parent_map_id')
          .eq('owner_user_id', ownerId)
          .eq('site_slug', siteSlug)
          .eq('topic_slug', subSlug)
          .eq('parent_map_id', brand.id)
          .maybeSingle()
        if (!refetch) {
          result.warnings.push(`Sub-product insert failed for "${cls.sub_product}": ${subErr?.message ?? 'unknown'}`)
          result.keywordsSkipped++
          continue
        }
        sub = refetch as MapRowMin
        result.subProductsExisting++
      } else {
        sub = inserted as MapRowMin
        result.subProductsCreated++
      }
      subCache.set(subKey, sub)
    }

    // 4c. Keyword link
    const { error: kwErr } = await db
      .from('keyword_map_clusters')
      .upsert({
        map_id:         sub.id,
        owner_user_id:  ownerId,
        keyword:        cand.keyword,
        search_volume:  cand.search_volume,
        source:         cand.source === 'tracked_product' ? 'manual'
                       : cand.source === 'keyword_tag'    ? 'manual'
                       : cand.source === 'keyword_gap'    ? 'keyword_gap'
                       : cand.source === 'gsc'            ? 'loki'
                       : 'manual',
        source_ref_id:  cand.source_ref_id,
      }, { onConflict: 'map_id,keyword' })
    if (kwErr) {
      result.warnings.push(`Keyword link failed for "${cand.keyword}": ${kwErr.message}`)
    } else {
      result.keywordsLinked++
    }

    // 4d. Page link (carry through from tracked_products)
    if (cand.page_url && cand.source === 'tracked_product') {
      pageLinks.push({ cluster_id: sub.id, page_url: cand.page_url, role: 'category' })
    }
  }

  // ── 5. Insert cluster_pages in one batch (idempotent) ──────────────────────
  if (pageLinks.length > 0) {
    // Dedup before insert — same (cluster, url) twice in batch would error
    const seen = new Set<string>()
    const uniquePages = pageLinks.filter(p => {
      const k = `${p.cluster_id}::${p.page_url}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

    const { error: pageErr, count } = await db
      .from('cluster_pages')
      .upsert(
        uniquePages.map(p => ({
          cluster_id:    p.cluster_id,
          owner_user_id: ownerId,
          site_slug:     siteSlug,
          page_url:      p.page_url,
          role:          p.role,
        })),
        { onConflict: 'cluster_id,page_url', count: 'exact' }
      )

    if (pageErr) {
      result.warnings.push(`cluster_pages upsert failed: ${pageErr.message}`)
    } else {
      result.pagesLinked = count ?? uniquePages.length
    }
  }

  return result
}

// ─── Step 1: Gather keywords from all sources ────────────────────────────────

async function gatherKeywords(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
  cfg:      ClusterBuilderConfig,
  warnings: string[]
): Promise<KeywordCandidate[]> {
  const out: KeywordCandidate[] = []

  // 1a. tracked_products.keywords[] + page_url
  const { data: products, error: prodErr } = await db
    .from('tracked_products')
    .select('id, name, page_url, keywords')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('active', true)
  if (prodErr) warnings.push(`tracked_products query failed: ${prodErr.message}`)

  for (const p of (products ?? []) as Array<{ id: string; name: string; page_url: string; keywords: string[] }>) {
    // Include the product name itself + every keyword
    const all = [p.name, ...(p.keywords ?? [])].filter(Boolean)
    for (const kw of all) {
      out.push({
        keyword:       String(kw),
        source:        'tracked_product',
        source_ref_id: p.id,
        search_volume: null,
        page_url:      p.page_url,
      })
    }
  }

  // 1b. keyword_tags
  const { data: tags, error: tagsErr } = await db
    .from('keyword_tags')
    .select('keyword')
    .eq('owner_user_id', ownerId)
    .limit(2000)
  if (tagsErr) warnings.push(`keyword_tags query failed: ${tagsErr.message}`)

  for (const t of (tags ?? []) as Array<{ keyword: string }>) {
    out.push({
      keyword:       String(t.keyword),
      source:        'keyword_tag',
      source_ref_id: null,
      search_volume: null,
      page_url:      null,
    })
  }

  // 1c. keyword_gap_snapshots — top opportunities
  // Schema may evolve; tolerate failure silently.
  try {
    const { data: gaps } = await db
      .from('keyword_gap_snapshots')
      .select('keyword, search_volume')
      .eq('owner_user_id', ownerId)
      .order('search_volume', { ascending: false })
      .limit(500)
    for (const g of (gaps ?? []) as Array<{ keyword: string; search_volume: number | null }>) {
      out.push({
        keyword:       String(g.keyword),
        source:        'keyword_gap',
        source_ref_id: null,
        search_volume: g.search_volume,
        page_url:      null,
      })
    }
  } catch {
    // table may not exist on every env — non-fatal
  }

  // 1d. GSC top queries (last N days)
  try {
    const site = await getSiteUrlForSlug(db, siteSlug)
    const since = new Date(Date.now() - cfg.windowDays * 86_400_000).toISOString().slice(0, 10)
    const { data: gsc, error: gscErr } = await db
      .from('gsc_ranking_snapshots')
      .select('query, clicks, impressions, page')
      .eq('site_url', site.gscProperty)
      .gte('snapshot_date', since)
      .gte('clicks', cfg.minGscClicks)
      .order('clicks', { ascending: false })
      .limit(1000)

    if (gscErr) warnings.push(`gsc_ranking_snapshots query failed: ${gscErr.message}`)

    // Aggregate by query (sum clicks across days = better proxy for SV)
    const byQuery = new Map<string, { clicks: number; page: string | null }>()
    for (const g of (gsc ?? []) as Array<{ query: string | null; clicks: number; page: string | null }>) {
      const q = String(g.query ?? '').toLowerCase().trim()
      if (!q) continue
      const cur = byQuery.get(q) ?? { clicks: 0, page: null }
      cur.clicks += Number(g.clicks ?? 0)
      cur.page ||= g.page
      byQuery.set(q, cur)
    }
    for (const [q, v] of byQuery.entries()) {
      out.push({
        keyword:       q,
        source:        'gsc',
        source_ref_id: null,
        search_volume: v.clicks,   // proxy: total clicks in window
        page_url:      v.page,
      })
    }
  } catch (err) {
    warnings.push(`GSC gather failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 1e. existing keyword_map_clusters that aren't yet under a level-1 parent.
  // (Re-classify orphans inherited from legacy single-level taxonomy.)
  try {
    const { data: existing } = await db
      .from('keyword_map_clusters')
      .select('keyword, search_volume, map_id, source, source_ref_id, keyword_maps!inner(id, level, parent_map_id, site_slug)')
      .eq('owner_user_id', ownerId)
      .eq('keyword_maps.site_slug', siteSlug)
      .eq('keyword_maps.level', 0)   // sitting on a brand-level map = legacy/orphan
      .limit(2000)

    for (const c of (existing ?? []) as Array<{ keyword: string; search_volume: number | null; source: string; source_ref_id: string | null }>) {
      out.push({
        keyword:       String(c.keyword),
        source:        'existing_cluster',
        source_ref_id: c.source_ref_id,
        search_volume: c.search_volume,
        page_url:      null,
      })
    }
  } catch {
    // non-fatal
  }

  return out
}

// ─── Step 2: Sonnet batch classifier ─────────────────────────────────────────

const classifyTool: Anthropic.Tool = {
  name: 'submit_classifications',
  description: 'Classify each keyword into a brand + sub-product pair, or skip if irrelevant.',
  input_schema: {
    type: 'object',
    properties: {
      classifications: {
        type: 'array',
        description: 'One entry per input keyword, in the SAME ORDER as the input list. The array length MUST equal the input length.',
        items: {
          type: 'object',
          properties: {
            brand: {
              type: 'string',
              description: 'The umbrella game/franchise/platform the keyword belongs to (e.g. "World of Warcraft", "League of Legends", "Roblox", "Steam"). Use canonical full name; not abbreviation. Empty string if skip=true.',
            },
            sub_product: {
              type: 'string',
              description: 'The market segment the keyword targets within the brand (e.g. "WoW Gold", "WoW Boost", "LoL Accounts", "Roblox Robux", "Steam Gift Cards"). Should combine brand short-name + segment. Empty string if skip=true.',
            },
            skip: {
              type: 'boolean',
              description: 'Set true if the keyword is competitor-brand, generic spam, navigational-only, or doesn\'t represent a market we sell.',
            },
            reason: {
              type: 'string',
              description: 'One short sentence justifying the classification.',
            },
          },
          required: ['brand', 'sub_product', 'skip', 'reason'],
        },
      },
    },
    required: ['classifications'],
  },
}

async function classifyBatch(
  keywords: string[],
  siteSlug: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?:      SupabaseClient<any, any, any>,
  ownerId?: string
): Promise<Classification[]> {
  if (keywords.length === 0) return []

  const siteContext = siteSlug === 'offgamers'
    ? 'OffGamers (offgamers.com) — global digital goods marketplace selling game top-ups, gift cards, software keys, subscriptions.'
    : 'G2G (g2g.com) — global gaming marketplace for in-game gold, items, accounts, boosting services.'

  const list = keywords.map((k, i) => `${i + 1}. ${k}`).join('\n')

  const prompt = `You classify SEO keywords into a 2-level taxonomy for ${siteContext}

LEVEL 1 (brand): the game/franchise/platform.
   Examples: "World of Warcraft", "League of Legends", "Genshin Impact",
   "Roblox", "Final Fantasy XIV", "Diablo IV", "Steam", "PlayStation",
   "Apple App Store", "Spotify", "Xbox".

LEVEL 2 (sub_product): the market segment within that brand. Combine
   brand short-name with segment. Always start sub_product with the brand
   short-name (or its accepted abbreviation) so the sub-product reads
   standalone.
   Examples:
     - "WoW Gold", "WoW Boost", "WoW Items", "WoW Accounts", "WoW Power Leveling"
     - "LoL Accounts", "LoL Boost", "LoL Coaching"
     - "Genshin Impact Top-Up", "Genshin Impact Accounts"
     - "Roblox Robux", "Roblox Gift Cards"
     - "Steam Wallet", "Steam Gift Cards", "Steam Keys"
     - "Spotify Premium", "Spotify Gift Cards"

RULES:
- Use the canonical FULL name for brand, not abbreviation. ("World of Warcraft" not "WoW".)
- For sub_product, prefer the abbreviation if it's the more common search term ("WoW Gold" beats "World of Warcraft Gold").
- Skip the keyword (skip=true) if it is:
   * A competitor brand (e.g. "g2g.com", "playerauctions", "eldorado.gg" when classifying for OffGamers, or vice versa).
   * Pure navigational ("login", "support", "contact us").
   * Generic non-product ("how to play", "tier list", "wiki") UNLESS the
     keyword has commercial intent for a sub-product we sell.
   * Vague enough that you can't confidently pick a brand.
- When unsure between two brands, prefer the more specific brand. Don't invent brands you don't recognise.
- A keyword like "buy gold" with no brand context — skip (we cannot route it).

KEYWORDS TO CLASSIFY (${keywords.length} items, classify in order):
${list}

Call submit_classifications with EXACTLY ${keywords.length} entries.`

  const res = await anthropic.messages.create({
    model:       MODEL,
    max_tokens:  4096,
    tools:       [classifyTool],
    tool_choice: { type: 'tool', name: 'submit_classifications' },
    messages:    [{ role: 'user', content: prompt }],
  })

  if (db && ownerId) {
    logClaudeUsage(db, ownerId, {
      model:       MODEL,
      endpoint:    'cluster_builder_classify',
      triggeredBy: 'agent_saga',
      usage:       res.usage,
      extra:       { keyword_count: keywords.length, site: siteSlug },
    })
  }

  const tool = res.content.find(b => b.type === 'tool_use')
  if (!tool || tool.type !== 'tool_use') {
    throw new Error(`Sonnet did not call submit_classifications (stop_reason=${res.stop_reason})`)
  }

  const raw = (tool.input ?? {}) as { classifications?: unknown }
  const arr = Array.isArray(raw.classifications) ? raw.classifications : []

  return keywords.map((_, i) => {
    const item = arr[i] as Record<string, unknown> | undefined
    if (!item) return { brand: null, sub_product: null, skip: true, reason: 'missing from response' }
    const skip = Boolean(item.skip)
    const brand = typeof item.brand === 'string' ? item.brand.trim() : ''
    const sub_product = typeof item.sub_product === 'string' ? item.sub_product.trim() : ''
    if (skip || !brand || !sub_product) {
      return { brand: null, sub_product: null, skip: true, reason: typeof item.reason === 'string' ? item.reason : '' }
    }
    return {
      brand,
      sub_product,
      skip:   false,
      reason: typeof item.reason === 'string' ? item.reason : '',
    }
  })
}
