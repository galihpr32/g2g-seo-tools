// Sprint WEEKLY.SLACK.PUBLIC-PNG — login-free PNG viewer for the Weekly
// Report. Looks up the row by public_token, returns the stored PNG bytes
// with Content-Type: image/png. No auth, no sidebar, no shell.
//
// URL pattern: /public/weekly/png/[token]
//   → image bytes inline (browser previews, Slack unfurls, etc.)

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic    = 'force-dynamic'
export const fetchCache = 'force-no-store'

export async function GET(
  _req:   Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params
  if (!token || token.length < 8) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
  }

  const db = createServiceClient()
  const { data, error } = await db
    .from('weekly_reports')
    .select('png_data, png_generated_at')
    .eq('public_token', token)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || !data.png_data) {
    return NextResponse.json({ error: 'PNG not available for this report yet' }, { status: 404 })
  }

  // Supabase returns bytea as a hex-prefixed string (\x...) when SELECT-ed
  // through the JS client. Convert back to Buffer for streaming. If for any
  // reason the client returns a base64 string or raw Uint8Array, handle both.
  let buf: Buffer
  if (typeof data.png_data === 'string') {
    const s = data.png_data as string
    if (s.startsWith('\\x')) buf = Buffer.from(s.slice(2), 'hex')
    else                     buf = Buffer.from(s,           'base64')
  } else if (data.png_data instanceof Uint8Array) {
    buf = Buffer.from(data.png_data)
  } else {
    return NextResponse.json({ error: 'Unsupported png_data encoding' }, { status: 500 })
  }

  return new NextResponse(new Uint8Array(buf), {
    status:  200,
    headers: {
      'Content-Type':   'image/png',
      'Content-Length': String(buf.length),
      // Cache 1h on browser, but revalidate so a fresh PNG is picked up
      'Cache-Control':  'public, max-age=3600, stale-while-revalidate=86400',
      'Content-Disposition': `inline; filename="weekly-report-${(data.png_generated_at ?? '').toString().slice(0, 10)}.png"`,
    },
  })
}
