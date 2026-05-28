// Sprint WEEKLY.SLACK.PUBLIC-PNG — `/public/weekly/png/latest` redirects to
// the most-recently-generated PNG token URL. Lets Slack message + bookmarks
// hold a stable URL that always serves the freshest weekly visual.

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic    = 'force-dynamic'
export const fetchCache = 'force-no-store'

export async function GET(req: Request) {
  const db = createServiceClient()
  const { data, error } = await db
    .from('weekly_reports')
    .select('public_token, png_generated_at')
    .not('png_data', 'is', null)
    .not('public_token', 'is', null)
    .order('png_generated_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data?.public_token) {
    return NextResponse.json({ error: 'No PNG has been generated yet' }, { status: 404 })
  }

  const url = new URL(`/public/weekly/png/${data.public_token}`, req.url)
  return NextResponse.redirect(url, 307)
}
