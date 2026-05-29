// ─── Tracked-product ranking analysis ────────────────────────────────────────
//
// Takes the keyword_ranking_history written by /api/cron/keyword-rankings and
// turns it into:
//   1. Bucket counts (top 3 / 5 / 10 / 20 / 100) for the period
//   2. Movement: how many improved/declined/stayed
//   3. Per-keyword last-period vs current-period delta
//   4. AI-generated action plan (Sonnet) for poorly-ranked keywords
//
// Site-isolated via site_slug (G2G and OffGamers data never mixes).
//
// Used by both the weekly and monthly report routes — pass `periodDays=7` for
// weekly, `periodDays=30` for monthly. The AI action plan only fires for the
// monthly report (cost-control: weekly = quick stats, monthly = strategic).

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface KeywordRankingMovement {
  keyword:        string
  productName:    string
  productPath:    string
  countryCode:    string
  curPosition:    number | null         // average over the report period (last entry)
  prevPosition:   number | null         // value at the start of the period
  movement:       number | null         // prev - cur (positive = improved, negative = dropped)
  bestPosition:   number | null         // best (lowest) seen during period
  worstPosition:  number | null
  searchVolume:   number | null
  url:            string | null
  snapshotsCount: number
}

export interface RankingBuckets {
  top3:   number
  top5:   number
  top10:  number
  top20:  number
  top100: number
  total:  number                        // total keyword count tracked (any position OR null)
  ranked: number                        // count where curPosition != null
}

export interface RankingActionItem {
  keyword:      string
  productName:  string
  curPosition:  number | null
  movement:     number | null
  recommendation: string                // 1-2 sentence concrete action
  priority:     'P0' | 'P1' | 'P2'
  category:     'quick-win' | 'recovery' | 'long-tail' | 'content-gap' | 'technical'
}

export interface RankingAnalysis {
  /** Site this analysis was scoped to */
  siteSlug:       string
  /** Period reported on */
  periodStart:    string                // 'YYYY-MM-DD'
  periodEnd:      string
  /** Aggregate bucket counts for the END of the period */
  bucketsCur:     RankingBuckets
  /** Same buckets at the START — for "we had 12 in top 10, now 18" framing */
  bucketsPrev:    RankingBuckets
  /** Per-keyword movement, sorted by abs(movement) desc */
  movements:      KeywordRankingMovement[]
  /** Top 5 improvers + top 5 droppers — quick-glance lists */
  topImprovers:   KeywordRankingMovement[]
  topDroppers:    KeywordRankingMovement[]
  /** AI action plan — null when periodDays<14 (weekly) to save cost */
  actionPlan:     RankingActionItem[] | null
  generatedAt:    string
}

// ─── Build keyword movements from raw history rows ───────────────────────────

interface HistoryRow {
  tracked_product_id: string
  keyword:            string
  country_code:       string
  snapshot_date:      string
  position:           number | null
  url:                string | null
  search_volume:      number | null
}

function buildBuckets(movements: KeywordRankingMovement[], which: 'cur' | 'prev'): RankingBuckets {
  let top3 = 0, top5 = 0, top10 = 0, top20 = 0, top100 = 0, ranked = 0
  for (const m of movements) {
    const pos = which === 'cur' ? m.curPosition : m.prevPosition
    if (pos == null) continue
    ranked++
    if (pos <= 3)   top3++
    if (pos <= 5)   top5++
    if (pos <= 10)  top10++
    if (pos <= 20)  top20++
    if (pos <= 100) top100++
  }
  return { top3, top5, top10, top20, top100, total: movements.length, ranked }
}

// ─── AI action plan (Sonnet — concise, actionable) ──────────────────────────

async function generateActionPlan(opts: {
  siteName:     string
  domain:       string
  movements:    KeywordRankingMovement[]
  buckets:      RankingBuckets
  periodLabel:  string
}): Promise<RankingActionItem[]> {
  const { siteName, domain, movements, buckets, periodLabel } = opts

  // Surface the 12 keywords MOST in need of attention. Heuristic:
  //   - Big drops (movement < -5) = recovery priority
  //   - Pos 11-30 with volume = quick-win priority
  //   - Pos 30+ = long-tail / content-gap
  const droppers = movements.filter(m => (m.movement ?? 0) < -5).slice(0, 6)
  const quickWins = movements
    .filter(m => m.curPosition != null && m.curPosition >= 11 && m.curPosition <= 30 && (m.searchVolume ?? 0) >= 100)
    .slice(0, 6)

  const focus = [...droppers, ...quickWins].slice(0, 12)
  if (focus.length === 0) return []

  const focusBlock = focus.map(m =>
    `- "${m.keyword}" on ${m.productName} (${m.productPath}) — ${m.curPosition != null ? `pos ${m.curPosition}` : 'unranked'}${m.movement != null ? `, movement ${m.movement > 0 ? '+' : ''}${m.movement} positions` : ''}${m.searchVolume ? `, volume ${m.searchVolume}` : ''}`
  ).join('\n')

  const prompt = `You are an SEO strategist for ${siteName} (${domain}). Given the tracked-keyword performance below for ${periodLabel}, produce a concrete action plan as a JSON array.

CONTEXT (keyword bucket snapshot at end of period):
- Top 3:   ${buckets.top3}
- Top 5:   ${buckets.top5}
- Top 10:  ${buckets.top10}
- Top 20:  ${buckets.top20}
- Tracked: ${buckets.total}

KEYWORDS NEEDING ATTENTION:
${focusBlock}

For EACH keyword, output ONE action item. Output STRICT JSON — an array of objects, no prose, no fences:
[
  {
    "keyword": "<exact keyword from list>",
    "productName": "<exact product name>",
    "curPosition": <number or null>,
    "movement": <number or null>,
    "recommendation": "<1-2 sentences, specific. e.g. 'Add a comparison block targeting [phrase]; the SERP for this keyword now features 3 listicles in top 5.'>",
    "priority": "P0" | "P1" | "P2",
    "category": "quick-win" | "recovery" | "long-tail" | "content-gap" | "technical"
  }
]

Priority rules:
- P0 = movement < -5 OR curPosition was top-3 and now isn't
- P1 = curPosition 11-20 with high volume (quick-win) OR movement -5..-2
- P2 = everything else

Recommendations must reference the keyword + product page concretely. NEVER write generic advice. Output ONLY the JSON array.`

  try {
    const res = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2000,
      messages:   [{ role: 'user', content: prompt }],
    })
    const text = res.content[0]?.type === 'text' ? res.content[0].text.trim() : ''
    // Strip optional code-fence
    const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    const parsed = JSON.parse(cleaned)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((p: unknown) => typeof p === 'object' && p !== null && 'keyword' in p && 'recommendation' in p)
      .map((p: Record<string, unknown>) => ({
        keyword:        String(p.keyword),
        productName:    String(p.productName ?? ''),
        curPosition:    typeof p.curPosition === 'number' ? p.curPosition : null,
        movement:       typeof p.movement    === 'number' ? p.movement    : null,
        recommendation: String(p.recommendation),
        priority:       (['P0','P1','P2'].includes(p.priority as string) ? p.priority : 'P2') as RankingActionItem['priority'],
        category:       (['quick-win','recovery','long-tail','content-gap','technical'].includes(p.category as string) ? p.category : 'quick-win') as RankingActionItem['category'],
      }))
  } catch (err) {
    console.warn('[ranking-analysis] AI action plan failed:', err)
    return []
  }
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export async function analyzeTrackedRankings(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:           SupabaseClient<any, any, any>
  ownerId:      string
  siteSlug:     string
  siteName:     string
  domain:       string
  periodStart:  string                  // 'YYYY-MM-DD'
  periodEnd:    string
  /** Days of history to aggregate. 7=weekly, 30=monthly. */
  periodDays:   number
  /** Whether to spend $$ on AI action plan. Default true for monthly, false for weekly. */
  withActionPlan?: boolean
}): Promise<RankingAnalysis> {
  const { db, ownerId, siteSlug, siteName, domain, periodStart, periodEnd, periodDays } = opts
  const withActionPlan = opts.withActionPlan ?? (periodDays >= 14)

  // Fetch all snapshots in period for this site
  const { data: rows } = await db
    .from('keyword_ranking_history')
    .select('tracked_product_id, keyword, country_code, snapshot_date, position, url, search_volume')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .gte('snapshot_date', periodStart)
    .lte('snapshot_date', periodEnd)
    .order('snapshot_date', { ascending: true })

  // Need product names for context — fetch separately
  const { data: prodRows } = await db
    .from('tracked_products')
    .select('id, name, page_url')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  const prodById = new Map<string, { name: string; pageUrl: string }>(
    (prodRows ?? []).map(p => [String(p.id), { name: String(p.name), pageUrl: String(p.page_url) }])
  )

  // Group history per (product_id, keyword, country_code) → array of snapshots
  const grouped = new Map<string, HistoryRow[]>()
  for (const r of (rows ?? []) as HistoryRow[]) {
    const key = `${r.tracked_product_id}|${r.keyword}|${r.country_code}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(r)
  }

  // Collapse each group into a single movement record
  const movements: KeywordRankingMovement[] = []
  for (const [key, snapshots] of grouped.entries()) {
    const [tracked_product_id, keyword, country_code] = key.split('|')
    const product = prodById.get(tracked_product_id)
    const productName = product?.name ?? '?'
    const productPath = product?.pageUrl ?? '?'

    const ranked = snapshots.filter(s => s.position != null)
    if (ranked.length === 0) {
      movements.push({
        keyword,
        productName,
        productPath,
        countryCode:    country_code,
        curPosition:    null,
        prevPosition:   null,
        movement:       null,
        bestPosition:   null,
        worstPosition:  null,
        searchVolume:   snapshots[snapshots.length - 1]?.search_volume ?? null,
        url:            null,
        snapshotsCount: snapshots.length,
      })
      continue
    }

    const firstRanked = ranked[0]
    const lastRanked  = ranked[ranked.length - 1]
    const bestPos     = Math.min(...ranked.map(s => s.position as number))
    const worstPos    = Math.max(...ranked.map(s => s.position as number))

    movements.push({
      keyword,
      productName,
      productPath,
      countryCode:    country_code,
      curPosition:    lastRanked.position,
      prevPosition:   firstRanked.position,
      movement:       firstRanked.position != null && lastRanked.position != null
                       ? firstRanked.position - lastRanked.position           // positive = improved
                       : null,
      bestPosition:   bestPos,
      worstPosition:  worstPos,
      searchVolume:   lastRanked.search_volume,
      url:            lastRanked.url,
      snapshotsCount: snapshots.length,
    })
  }

  const bucketsCur  = buildBuckets(movements, 'cur')
  const bucketsPrev = buildBuckets(movements, 'prev')

  const topImprovers = [...movements]
    .filter(m => (m.movement ?? 0) > 0)
    .sort((a, b) => (b.movement ?? 0) - (a.movement ?? 0))
    .slice(0, 8)

  const topDroppers = [...movements]
    .filter(m => (m.movement ?? 0) < 0)
    .sort((a, b) => (a.movement ?? 0) - (b.movement ?? 0))
    .slice(0, 8)

  const periodLabel = `${periodStart} → ${periodEnd}`
  const actionPlan = withActionPlan
    ? await generateActionPlan({ siteName, domain, movements, buckets: bucketsCur, periodLabel })
    : null

  return {
    siteSlug,
    periodStart,
    periodEnd,
    bucketsCur,
    bucketsPrev,
    movements: movements
      .sort((a, b) => Math.abs(b.movement ?? 0) - Math.abs(a.movement ?? 0))
      .slice(0, 100),    // cap stored payload — UI/PPTX only show top movements anyway
    topImprovers,
    topDroppers,
    actionPlan,
    generatedAt: new Date().toISOString(),
  }
}
