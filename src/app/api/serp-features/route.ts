import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDomainKeywordsWithFeatures, SERP_FEATURE_LABELS } from '@/lib/semrush/client'
import { getSiteConfig, resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 30

// GET /api/serp-features?database=us&limit=1000&site=g2g
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const database  = searchParams.get('database') ?? 'us'
  const limit     = Math.min(parseInt(searchParams.get('limit') ?? '1000'), 2000)
  const siteSlug  = resolveSiteSlugFromRequest(req)

  const apiKey = process.env.SEMRUSH_API_KEY
  if (!apiKey || apiKey === 'placeholder') {
    return NextResponse.json({ error: 'SEMrush API key not configured.' }, { status: 400 })
  }

  try {
    const siteConfig = await getSiteConfig(supabase, siteSlug)
    const domain = siteConfig?.semrush_domain ?? 'g2g.com'

    const rows = await getDomainKeywordsWithFeatures(domain, database, limit)

    // Build summary: count per feature code
    const featureSummary: Record<number, { captured: number; available: number; volume: number }> = {}

    for (const row of rows) {
      // Count available features
      for (const code of row.available) {
        if (!featureSummary[code]) featureSummary[code] = { captured: 0, available: 0, volume: 0 }
        featureSummary[code].available++
        featureSummary[code].volume += row.searchVolume
      }
      // Count captured features
      for (const code of row.captured) {
        if (!featureSummary[code]) featureSummary[code] = { captured: 0, available: 0, volume: 0 }
        featureSummary[code].captured++
      }
    }

    // Only return known feature codes, sorted by captured desc
    const summary = Object.entries(featureSummary)
      .filter(([code]) => SERP_FEATURE_LABELS[Number(code)])
      .map(([code, stats]) => ({
        code:      Number(code),
        label:     SERP_FEATURE_LABELS[Number(code)],
        captured:  stats.captured,
        available: stats.available,
        volume:    stats.volume,
        captureRate: stats.available > 0 ? Math.round((stats.captured / stats.available) * 100) : 0,
      }))
      .sort((a, b) => b.captured - a.captured)

    // Only include rows that have at least one feature (captured OR available)
    const filteredRows = rows.filter(r => r.captured.length > 0 || r.available.length > 0)

    return NextResponse.json({
      domain,
      database,
      totalKeywords: rows.length,
      keywordsWithFeatures: filteredRows.length,
      summary,
      rows: filteredRows,
    })
  } catch (e) {
    console.error('[serp-features] error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
