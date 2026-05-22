// ─── SERP-based intent classifier ──────────────────────────────────────────
//
// Sprint CKB.1 — Classify a keyword's user intent based on what kinds of
// pages Google actually ranks for it in the top 10.
//
// Strict thresholds (per Galih's design call):
//   ≥7 ecommerce/marketplace in top 10 → commercial-supportive (keep)
//   ≥7 wiki/blog/forum in top 10        → informational-pure  (skip or FAQ-only)
//   ≥4 tutorial/video/farming           → diy-competing       (skip unless counter-content)
//   anything else                       → commercial-investigation (include w/ CTA bridge)
//
// We classify by domain + URL path heuristics. Cheap, deterministic, no LLM
// call needed. Tuned for gaming-marketplace domain (G2G's universe).

import type { SerpOrganicResult, SerpPageData } from '@/lib/dataforseo/client'
import { getSerpData } from '@/lib/dataforseo/client'
import type { IntentClass, Market } from './types'

// ─── Domain classification ─────────────────────────────────────────────────

/**
 * Domains that are commercial-by-default (marketplaces, ecommerce, gift cards).
 * If ≥7 of top 10 are from this set, keyword is commercial-supportive.
 */
const COMMERCIAL_DOMAIN_KEYWORDS = [
  // G2G + OG ecosystem
  'g2g.com', 'offgamers.com',
  // Major gaming marketplaces
  'eldorado.gg', 'playerauctions.com', 'iggm.com', 'mmoga.com',
  'mmogah.com', 'mulefactory.com', 'odealo.com', 'cnctags.com',
  'gamertrend.com', 'gamerto.com', 'gamerall.com',
  // Gift card / digital goods marketplaces
  'kinguin.net', 'g2a.com', 'eneba.com', 'gamersgate.com', 'gamesplanet.com',
  'codashop.com', 'unipin.com', 'razergold.com',
  // App / platform stores
  'store.steampowered.com', 'epicgames.com', 'playstation.com',
  'xbox.com', 'nintendo.com', 'humblebundle.com',
]

const INFORMATIONAL_DOMAIN_KEYWORDS = [
  'wikipedia.org', 'fandom.com', 'wiki.gg', 'wikia.com',
  'reddit.com', 'quora.com', 'gamefaqs.com',
  'medium.com', 'wordpress.com', 'blogspot.com',
  'gamerant.com', 'kotaku.com', 'polygon.com', 'pcgamer.com',
  'ign.com', 'gamespot.com', 'eurogamer.net', 'rockpapershotgun.com',
  'screenrant.com', 'thegamer.com',
]

const VIDEO_DOMAIN_KEYWORDS = [
  'youtube.com', 'youtu.be', 'twitch.tv', 'tiktok.com', 'bilibili.com',
]

const DIY_TUTORIAL_PATH_PATTERNS = [
  /\/(guide|how-to|tutorial|farming|farm|grinding|build|tips?|strategy)\b/i,
  /\b(how-to|farming-guide|beginner-guide|leveling|walkthrough)\b/i,
]

type PageType =
  | 'ecommerce'
  | 'informational'
  | 'video'
  | 'diy-tutorial'
  | 'other'

function classifyResult(r: SerpOrganicResult): PageType {
  const domain = r.domain.toLowerCase()
  const url = r.url.toLowerCase()

  // 1) Commercial domains first (strongest signal)
  if (COMMERCIAL_DOMAIN_KEYWORDS.some(d => domain === d || domain.endsWith('.' + d))) {
    return 'ecommerce'
  }
  // 2) Video platforms
  if (VIDEO_DOMAIN_KEYWORDS.some(d => domain === d || domain.endsWith('.' + d))) {
    return 'video'
  }
  // 3) Informational publishers/wikis/forums
  if (INFORMATIONAL_DOMAIN_KEYWORDS.some(d => domain === d || domain.endsWith('.' + d))) {
    return 'informational'
  }
  // 4) DIY tutorial fallback — URL path heuristics catch standalone guide sites
  if (DIY_TUTORIAL_PATH_PATTERNS.some(p => p.test(url))) {
    return 'diy-tutorial'
  }
  // 5) Heuristic: presence of 'shop'/'buy'/'store'/'cart' in domain or path leans commercial
  const buyHint = /\b(shop|buy|store|cart|market|sale|sell|deals?|pricing)\b/i
  if (buyHint.test(domain) || buyHint.test(url)) return 'ecommerce'

  return 'other'
}

// ─── Verdict logic ─────────────────────────────────────────────────────────

interface ClassifyVerdict {
  intent_class:   IntentClass
  type_counts:    Record<PageType, number>
  total_analyzed: number
  rationale:      string                   // 1-line explanation for debugging/UI
}

export function verdictFromSerp(serp: SerpPageData): ClassifyVerdict {
  const counts: Record<PageType, number> = {
    'ecommerce': 0, 'informational': 0, 'video': 0, 'diy-tutorial': 0, 'other': 0,
  }
  for (const r of serp.organicResults.slice(0, 10)) {
    counts[classifyResult(r)]++
  }
  const total = Object.values(counts).reduce((s, v) => s + v, 0)

  // Strict thresholds first (per spec)
  if (counts.ecommerce >= 7) {
    return {
      intent_class: 'commercial-supportive',
      type_counts: counts,
      total_analyzed: total,
      rationale: `${counts.ecommerce}/${total} ecommerce — safe to target as H2 section.`,
    }
  }
  if (counts.informational >= 7) {
    return {
      intent_class: 'informational-pure',
      type_counts: counts,
      total_analyzed: total,
      rationale: `${counts.informational}/${total} informational — skip or FAQ-only.`,
    }
  }
  // DIY tutorial signal: video + tutorial sites dominating
  if ((counts['diy-tutorial'] + counts.video) >= 4 && counts.ecommerce < 4) {
    return {
      intent_class: 'diy-competing',
      type_counts: counts,
      total_analyzed: total,
      rationale: `${counts['diy-tutorial'] + counts.video}/${total} DIY/tutorial — counter-content only.`,
    }
  }
  // Mixed — investigation. Include with strong CTA bridge.
  return {
    intent_class: 'commercial-investigation',
    type_counts: counts,
    total_analyzed: total,
    rationale: `mixed (${counts.ecommerce} ecom · ${counts.informational} info · ${counts.video + counts['diy-tutorial']} DIY) — include w/ CTA bridge.`,
  }
}

// ─── Public entry ──────────────────────────────────────────────────────────

const LOCATION_BY_MARKET: Record<Market, { code: number; lang: string }> = {
  us: { code: 2840, lang: 'en' },
  id: { code: 2360, lang: 'id' },
}

export interface ClassifyOptions {
  /** Provide pre-fetched SERP to skip the API call. */
  serpOverride?: SerpPageData
  /** Default 'us' (Global). */
  market?: Market
}

/**
 * Classify a single keyword. Cheap: one SERP scrape (~$0.001) unless
 * serpOverride is supplied. Returns the intent class + diagnostic rationale.
 *
 * The orchestrator (Sprint CKB.2) calls this in parallel for ~15 candidates
 * per kit build.
 */
export async function classifyKeywordIntent(
  keyword: string,
  opts: ClassifyOptions = {},
): Promise<ClassifyVerdict> {
  const market = opts.market ?? 'us'
  const { code: locationCode, lang: languageCode } = LOCATION_BY_MARKET[market]

  let serp: SerpPageData
  if (opts.serpOverride) {
    serp = opts.serpOverride
  } else {
    serp = await getSerpData(keyword, locationCode, languageCode, 10)
  }
  return verdictFromSerp(serp)
}

/**
 * Classify many keywords with bounded concurrency. Used by Hugin auto-filter
 * (which runs nightly) and the kit builder (which classifies ~15 candidates).
 *
 * Returns a Map keyed by lowercased keyword.
 */
export async function classifyKeywordsBulk(
  keywords: string[],
  market: Market,
  concurrency = 5,
): Promise<Map<string, ClassifyVerdict>> {
  const out = new Map<string, ClassifyVerdict>()
  const queue = [...keywords]

  async function worker() {
    while (queue.length > 0) {
      const kw = queue.shift()
      if (!kw) return
      try {
        const v = await classifyKeywordIntent(kw, { market })
        out.set(kw.toLowerCase(), v)
      } catch (e) {
        console.warn('[intent-classifier]', kw, e instanceof Error ? e.message : String(e))
        out.set(kw.toLowerCase(), {
          intent_class:   'commercial-investigation',
          type_counts:    { ecommerce: 0, informational: 0, video: 0, 'diy-tutorial': 0, other: 0 },
          total_analyzed: 0,
          rationale:      'classification failed, defaulted to investigation',
        })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  return out
}
