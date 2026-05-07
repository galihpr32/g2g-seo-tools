import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

export const maxDuration = 300

/**
 * GET /api/cron/psi-monthly?site=<slug>
 *
 * Monthly cron — for ONE site (specified via `?site=` param) or all active
 * sites if no param, calls Google PSI API for top traffic pages,
 * persists Lighthouse scores + CWV.
 *
 * IMPORTANT: Per-site invocation (`?site=g2g` or `?site=offgamers`) keeps
 * each function call under Vercel's 300s timeout. The GitHub Action loops
 * over sites and calls this route once per site. Without per-site split:
 *   2 sites × 12 pages × 20s/call = 480s → 504 Gateway Timeout.
 *
 * Page cap reduced 20→12 to give headroom: 12 × 20s = 240s, fits in 300s.
 *
 * Auth: Bearer CRON_SECRET via GitHub Actions.
 * Requires env: PSI_API_KEY
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

interface PsiAudit {
  performance:    number | null
  accessibility:  number | null
  best_practices: number | null
  seo:            number | null
  lcp_ms:         number | null
  inp_ms:         number | null
  cls:            number | null
  ttfb_ms:        number | null
  fcp_ms:         number | null
  cwv_passed:     boolean | null
  top_issues:     Array<{ title: string; savings_ms?: number }>
  error?:         string
}

async function callPsi(url: string, strategy: 'mobile' | 'desktop' = 'mobile'): Promise<PsiAudit | null> {
  const apiKey = process.env.PSI_API_KEY
  if (!apiKey) return { ...emptyAudit(), error: 'PSI_API_KEY not configured' }

  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance&category=accessibility&category=best-practices&category=seo&key=${apiKey}`

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 60_000)
  try {
    const res = await fetch(apiUrl, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return { ...emptyAudit(), error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
    const data = await res.json() as Record<string, unknown>

    const lhr = (data.lighthouseResult ?? {}) as Record<string, unknown>
    const categories = (lhr.categories ?? {}) as Record<string, { score: number | null }>
    const audits = (lhr.audits ?? {}) as Record<string, { displayValue?: string; numericValue?: number; details?: { type?: string; overallSavingsMs?: number }; title?: string }>

    // CWV — prefer field data (loadingExperience), fallback to lab
    const fieldExp = (data.loadingExperience ?? {}) as Record<string, unknown>
    const fieldMetrics = (fieldExp.metrics ?? {}) as Record<string, { percentile?: number; category?: string }>

    const lcpField = fieldMetrics['LARGEST_CONTENTFUL_PAINT_MS']?.percentile
    const inpField = fieldMetrics['INTERACTION_TO_NEXT_PAINT']?.percentile
    const clsField = fieldMetrics['CUMULATIVE_LAYOUT_SHIFT_SCORE']?.percentile

    const lcp_ms = (lcpField != null ? lcpField : audits['largest-contentful-paint']?.numericValue) ?? null
    const inp_ms = (inpField != null ? inpField : audits['interaction-to-next-paint']?.numericValue) ?? null
    const cls    = clsField != null ? clsField / 100 : audits['cumulative-layout-shift']?.numericValue ?? null  // CrUX returns *100

    const cwv_passed = (lcp_ms != null && inp_ms != null && cls != null)
      ? (Number(lcp_ms) <= 2500 && Number(inp_ms) <= 200 && Number(cls) <= 0.1)
      : null

    // Top opportunities (sorted by savings_ms desc)
    const opportunities = Object.values(audits)
      .filter(a => a.details?.type === 'opportunity' && (a.details?.overallSavingsMs ?? 0) > 100)
      .map(a => ({ title: String(a.title ?? ''), savings_ms: Math.round(a.details?.overallSavingsMs ?? 0) }))
      .sort((a, b) => (b.savings_ms ?? 0) - (a.savings_ms ?? 0))
      .slice(0, 5)

    return {
      performance:    score100(categories.performance?.score),
      accessibility:  score100(categories.accessibility?.score),
      best_practices: score100(categories['best-practices']?.score),
      seo:            score100(categories.seo?.score),
      lcp_ms:         lcp_ms != null ? Math.round(Number(lcp_ms)) : null,
      inp_ms:         inp_ms != null ? Math.round(Number(inp_ms)) : null,
      cls:            cls != null ? Math.round(Number(cls) * 1000) / 1000 : null,
      ttfb_ms:        audits['server-response-time']?.numericValue ? Math.round(audits['server-response-time']!.numericValue!) : null,
      fcp_ms:         audits['first-contentful-paint']?.numericValue ? Math.round(audits['first-contentful-paint']!.numericValue!) : null,
      cwv_passed,
      top_issues:     opportunities,
    }
  } catch (err) {
    clearTimeout(t)
    return { ...emptyAudit(), error: err instanceof Error ? err.message : String(err) }
  }
}

function emptyAudit(): PsiAudit {
  return {
    performance: null, accessibility: null, best_practices: null, seo: null,
    lcp_ms: null, inp_ms: null, cls: null, ttfb_ms: null, fcp_ms: null,
    cwv_passed: null, top_issues: [],
  }
}

function score100(s: number | null | undefined): number | null {
  return s == null ? null : Math.round(s * 100)
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const today = new Date().toISOString().split('T')[0]
  const stats = { sites: 0, pagesChecked: 0, written: 0, failed: 0 }

  // Per-site invocation cap: when ?site= is passed we only process THAT site.
  // Without it (manual trigger / legacy GH workflows) we process all — but
  // that risks 504. The current workflow ALWAYS passes ?site=...
  const reqUrl = new URL(req.url)
  const siteFilter = reqUrl.searchParams.get('site')

  let sitesQuery = db
    .from('site_configs')
    .select('slug, gsc_property')
    .eq('is_active', true)
  if (siteFilter) sitesQuery = sitesQuery.eq('slug', siteFilter)

  const { data: sites } = await sitesQuery

  if (!sites?.length) return NextResponse.json({ error: `No active sites${siteFilter ? ` matching slug=${siteFilter}` : ''}` }, { status: 500 })

  // Page cap reduced to 12 per site — fits comfortably within 300s ceiling
  // (12 pages × ~20s each = ~240s, leaves headroom for cold start + db).
  const MAX_PAGES_PER_SITE = 12

  for (const site of sites) {
    stats.sites++
    const siteSlug = String(site.slug)

    // Top URLs to test: tracked_products + GSC top-clicks
    const { data: products } = await db
      .from('tracked_products')
      .select('page_url, owner_user_id')
      .eq('site_slug', siteSlug)
      .eq('active', true)
      .limit(20)

    const ownerToUrls = new Map<string, Set<string>>()
    for (const p of products ?? []) {
      const o = String(p.owner_user_id)
      if (!ownerToUrls.has(o)) ownerToUrls.set(o, new Set())
      ownerToUrls.get(o)!.add(String(p.page_url))
    }

    const firstOwner = Array.from(ownerToUrls.keys())[0]
    if (firstOwner && site.gsc_property) {
      const { data: gscTop } = await db
        .from('gsc_ranking_snapshots')
        .select('page, clicks')
        .eq('site_url', site.gsc_property)
        .gte('snapshot_date', new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10))
        .order('clicks', { ascending: false })
        .limit(20)
      for (const g of (gscTop ?? [])) {
        ownerToUrls.get(firstOwner)!.add(String(g.page))
      }
    }

    for (const [ownerId, urlSet] of ownerToUrls.entries()) {
      const urls = Array.from(urlSet).slice(0, MAX_PAGES_PER_SITE)
      for (const url of urls) {
        stats.pagesChecked++
        const audit = await callPsi(url, 'mobile')
        if (!audit || audit.error) {
          stats.failed++
          continue
        }

        const { error } = await db
          .from('psi_snapshots')
          .upsert({
            owner_user_id:   ownerId,
            site_slug:       siteSlug,
            page_url:        url,
            snapshot_date:   today,
            strategy:        'mobile',
            performance:     audit.performance,
            accessibility:   audit.accessibility,
            best_practices:  audit.best_practices,
            seo:             audit.seo,
            lcp_ms:          audit.lcp_ms,
            inp_ms:          audit.inp_ms,
            cls:             audit.cls,
            ttfb_ms:         audit.ttfb_ms,
            fcp_ms:          audit.fcp_ms,
            cwv_passed:      audit.cwv_passed,
            top_issues:      audit.top_issues,
            error:           audit.error ?? null,
          }, { onConflict: 'owner_user_id,site_slug,page_url,strategy,snapshot_date' })

        if (!error) stats.written++
      }
    }
  }

  return NextResponse.json({ ok: true, when: new Date().toISOString(), stats })
}
