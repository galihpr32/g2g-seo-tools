import { NextResponse } from 'next/server'
import { getDomainRankedKeywords, getDomainOverviewDFS } from '@/lib/dataforseo/client'
import { createClient } from '@/lib/supabase/server'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { getCountryPreset } from '@/lib/country-config'
import { getSiteUrlForSlug } from '@/lib/agents/site-helpers'

export const maxDuration = 30

// GET /api/semrush/keywords?country=us&limit=200
//
// Returns { keywords: Keyword[], overview: Overview | null, error?: string }.
//
// Since the SEMrush deprecation, this route is fully DataForSEO-backed.
// `?country` (ISO2) drives the SERP location_code via SERP_COUNTRIES preset
// — defaults to US so behaviour matches what the rankings page used to show.
// Site is resolved from cookie/query so OG users see offgamers.com data.
export async function GET(req: Request) {
  const hasCredentials = !!(
    process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD
  )

  if (!hasCredentials) {
    return NextResponse.json({
      keywords: [],
      overview: null,
      error: 'DataForSEO credentials not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.',
    })
  }

  const url     = new URL(req.url)
  const country = url.searchParams.get('country')?.toLowerCase() ?? 'us'
  const limit   = Math.max(50, Math.min(1000, Number(url.searchParams.get('limit') ?? '200')))
  const preset  = getCountryPreset(country)

  // Resolve site → domain via site_configs so OffGamers picks up offgamers.com
  // automatically. Falls back to g2g.com if the lookup blows up (e.g. in dev
  // without an OG row seeded).
  let domain = 'g2g.com'
  try {
    const supabase = await createClient()
    const siteSlug = resolveSiteSlugFromRequest(req)
    const site = await getSiteUrlForSlug(supabase, siteSlug)
    domain = site.domain
  } catch {
    // Keep default — surface this as soft-fail so the page still renders
    // with G2G data instead of erroring out.
  }

  try {
    const [dfsKeywords, overview] = await Promise.all([
      getDomainRankedKeywords(domain, preset.dfsLocationCode, preset.dfsLanguageCode, limit),
      getDomainOverviewDFS(domain, preset.dfsLocationCode, preset.dfsLanguageCode),
    ])

    // Map DataForSEO ranked keywords to the Keyword shape the UI expects
    const keywords = dfsKeywords.map(k => ({
      keyword: k.keyword,
      position: k.position ?? 0,
      previousPosition: 0,  // not available from DFS ranked_keywords endpoint
      positionDiff: 0,       // not available — would need historical data
      searchVolume: k.volume ?? 0,
      cpc: 0,                // not returned by ranked_keywords
      url: k.url ?? '',
      trafficPercent: 0,     // not returned by ranked_keywords
    }))

    return NextResponse.json({
      keywords,
      overview,
      country: preset.code,
      domain,
    })
  } catch (e) {
    console.error('[semrush/keywords] error:', e)
    return NextResponse.json(
      { keywords: [], overview: null, error: String(e) },
      { status: 200 }
    )
  }
}
