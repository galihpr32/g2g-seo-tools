// Sprint WEEKLY.SLACK.PUBLIC-PNG — `/public/weekly/latest` redirects to the
// most-recently published weekly report. Default picks G2G (primary brand)
// when both brands have a row for the current week; the public page itself
// then offers brand-switcher pills so the viewer can jump to OffGamers.
//
// Why a page (not a route)? Next App Router prefers `redirect()` from a
// server component for SEO-friendly 308 redirects. /public/weekly/png/latest
// uses a route.ts because it serves binary, not HTML.

import { redirect } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic    = 'force-dynamic'
export const fetchCache = 'force-no-store'

export default async function PublicWeeklyLatestRedirect() {
  const db = createServiceClient()

  // Prefer G2G; fall back to whichever brand has the freshest published row.
  const { data: rows } = await db
    .from('weekly_reports')
    .select('public_token, site_slug, week_start, published_at')
    .eq('publish_status', 'published')
    .not('public_token', 'is', null)
    .order('week_start',   { ascending: false })
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(10)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = (rows ?? []) as any[]
  const g2g  = list.find(r => r.site_slug === 'g2g')        ?? null
  const any  = list[0]                                       ?? null
  const pick = g2g ?? any
  if (!pick?.public_token) {
    // No published rows yet — render a friendly empty state instead of 404.
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-950 text-gray-300 px-6">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-xl font-bold text-white">Weekly Report not ready yet</h1>
          <p className="text-sm text-gray-400">
            No published weekly report has been generated. The first weekly
            digest will be available after the next Friday delivery fires.
          </p>
        </div>
      </main>
    )
  }

  redirect(`/public/weekly/${pick.public_token}`)
}
