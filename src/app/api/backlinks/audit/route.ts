import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getBacklinkOverview, getReferringDomains, getBacklinks } from '@/lib/semrush/client'
import { getSiteConfig } from '@/lib/sites'

export const maxDuration = 30

// GET /api/backlinks/audit?site=g2g&limit=100&view=domains|backlinks
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const apiKey = process.env.SEMRUSH_API_KEY
  if (!apiKey || apiKey === 'placeholder') {
    return NextResponse.json({ error: 'SEMrush API key not configured.' }, { status: 400 })
  }

  const { searchParams } = new URL(req.url)
  const siteSlug = searchParams.get('site')  ?? 'g2g'
  const limit    = Math.min(parseInt(searchParams.get('limit') ?? '100'), 500)
  const view     = searchParams.get('view')  ?? 'domains' // 'domains' | 'backlinks'

  try {
    const siteConfig = await getSiteConfig(supabase, siteSlug)
    const domain = siteConfig?.semrush_domain ?? 'g2g.com'

    const [overview, domains, backlinks] = await Promise.all([
      getBacklinkOverview(domain),
      view !== 'backlinks' ? getReferringDomains(domain, limit) : Promise.resolve([]),
      view === 'backlinks' ? getBacklinks(domain, limit)        : Promise.resolve([]),
    ])

    // Compute anchor text distribution from backlinks (if fetched)
    const anchorMap = new Map<string, number>()
    for (const b of backlinks) {
      const anchor = b.anchorText.toLowerCase().trim() || '(empty)'
      anchorMap.set(anchor, (anchorMap.get(anchor) ?? 0) + 1)
    }
    const topAnchors = [...anchorMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([anchor, count]) => ({ anchor, count }))

    return NextResponse.json({ domain, overview, domains, backlinks, topAnchors })
  } catch (e) {
    console.error('[backlinks/audit] error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
