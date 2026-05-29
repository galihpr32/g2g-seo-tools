import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { getSiteUrlForSlug } from '@/lib/agents/site-helpers'
import { isSkipDomain } from '@/lib/agents/hermod-domain-eval'

export const maxDuration = 60

/**
 * GET/POST /api/competitive/backlink-gap?competitor=overgear.com
 *
 * Pulls referring domains for a competitor (or all tracked competitors)
 * via DataForSEO backlinks API, then INTERSECTS with our domain's referring
 * domains to find ones that link to them but NOT us.
 *
 * Result: ranked list of "outreach gold" — domains already linking to a
 * competitor in your space, plausible to pitch.
 *
 * Skips competitors-of-competitors via HERMOD_SKIP_DOMAINS so we don't
 * surface other gaming marketplaces as outreach targets.
 *
 * Cost: ~$0.01-0.05 per competitor depending on backlink volume.
 */

interface DfsRefDomain {
  domain:           string
  rank:             number
  backlinks:        number
  first_seen:       string
  lost_date:        string | null
  is_lost:          boolean
}

/** Diagnostic class so the route handler can surface WHY a call returned
 *  empty data (credentials missing, network error, DFS rejected request). */
class DfsCallError extends Error {
  constructor(message: string, public reason: 'no_credentials' | 'http_error' | 'network_error' | 'malformed_response', public detail?: string) {
    super(message)
  }
}

async function dfsCall<T = unknown>(path: string, body: unknown): Promise<T> {
  if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) {
    throw new DfsCallError('DataForSEO credentials missing in env', 'no_credentials')
  }
  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64')
  try {
    const res = await fetch(`https://api.dataforseo.com/v3${path}`, {
      method:  'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('[backlink-gap] DFS error:', res.status, text)
      throw new DfsCallError(`DataForSEO HTTP ${res.status}`, 'http_error', text.slice(0, 300))
    }
    return await res.json() as T
  } catch (err) {
    if (err instanceof DfsCallError) throw err
    console.error('[backlink-gap] DFS fetch failed:', err)
    throw new DfsCallError('DataForSEO fetch threw', 'network_error', err instanceof Error ? err.message : String(err))
  }
}

async function getReferringDomains(target: string, limit = 100): Promise<DfsRefDomain[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await dfsCall<any>('/backlinks/referring_domains/live', [{
    target,
    limit,
    order_by: ['rank,desc'],
    filters:  [['is_lost', '=', false]],
  }])
  const items = data?.tasks?.[0]?.result?.[0]?.items ?? []
  if (!items.length && data?.tasks?.[0]?.status_message) {
    console.warn(`[backlink-gap] DFS returned empty for ${target}: ${data.tasks[0].status_message}`)
  }
  return items as DfsRefDomain[]
}

export async function GET(req: Request) {
  return handle(req)
}

export async function POST(req: Request) {
  return handle(req)
}

async function handle(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const url      = new URL(req.url)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const competitorParam = url.searchParams.get('competitor')

  const db = createServiceClient()

  // Resolve our domain
  let ourDomain = 'g2g.com'
  try {
    const site = await getSiteUrlForSlug(db, siteSlug)
    ourDomain = site.domain
  } catch { /* fallback */ }

  // Determine competitors to compare
  let competitors: string[] = []
  if (competitorParam) {
    competitors = [competitorParam.toLowerCase().replace(/^www\./, '')]
  } else {
    const { data: comps } = await db
      .from('competitors')
      .select('domain')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .eq('active', true)
      .limit(5)
    competitors = (comps ?? []).map(c => String(c.domain).toLowerCase().replace(/^www\./, ''))
  }

  if (competitors.length === 0) {
    return NextResponse.json({
      ok:    false,
      error: 'No competitor specified or tracked. Add tracked competitors at /competitive/competitors first, or pass ?competitor=domain.com.',
    }, { status: 400 })
  }

  // Pull our referring domains once (used as the "we have these already" set)
  let ourRefs: DfsRefDomain[] = []
  try {
    ourRefs = await getReferringDomains(ourDomain, 1000)
  } catch (e) {
    if (e instanceof DfsCallError) {
      // BDT (May 2026) flagged backlink-gap was silent-empty. Surface the
      // real reason so admin can fix credentials / network issue.
      return NextResponse.json({
        error:      `DataForSEO call failed for our domain (${ourDomain}): ${e.message}`,
        reason:     e.reason,
        detail:     e.detail,
        action:     e.reason === 'no_credentials' ? 'Add DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD env vars in Vercel.' : 'Check DataForSEO billing / quota.',
      }, { status: 502 })
    }
    throw e
  }
  const ourRefSet = new Set<string>(
    ourRefs.map(r => r.domain.toLowerCase().replace(/^www\./, ''))
  )

  // Pull each competitor's referring domains
  const competitorResults: Array<{ competitor: string; gaps: Array<{ domain: string; rank: number; backlinks: number }>; total: number; gapsCount: number; note?: string }> = []
  for (const comp of competitors) {
    let refs: DfsRefDomain[] = []
    try {
      refs = await getReferringDomains(comp, 200)
    } catch (e) {
      const note = e instanceof DfsCallError ? `${e.reason}: ${e.message}` : (e instanceof Error ? e.message : 'unknown')
      competitorResults.push({ competitor: comp, gaps: [], total: 0, gapsCount: 0, note })
      continue
    }
    if (refs.length === 0) {
      competitorResults.push({ competitor: comp, gaps: [], total: 0, gapsCount: 0, note: 'DataForSEO returned 0 referring domains for this competitor.' })
      continue
    }

    // Filter to ones that:
    //   - we don't already have
    //   - aren't auto-skipped (other marketplaces, social, walled gardens, etc.)
    //   - aren't ourselves
    const gaps = refs
      .filter(r => {
        const dom = r.domain.toLowerCase().replace(/^www\./, '')
        if (dom === ourDomain) return false
        if (ourRefSet.has(dom)) return false
        if (isSkipDomain(dom)) return false
        return true
      })
      .map(r => ({
        domain:    r.domain.replace(/^www\./, ''),
        rank:      r.rank,
        backlinks: r.backlinks,
      }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 50)

    competitorResults.push({
      competitor: comp,
      gaps,
      total:      refs.length,
      gapsCount:  gaps.length,
    })
  }

  return NextResponse.json({
    ok:               true,
    ourDomain,
    competitors:      competitorResults,
    when:             new Date().toISOString(),
  })
}
