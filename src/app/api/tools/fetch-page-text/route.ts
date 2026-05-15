import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const maxDuration = 15

/**
 * GET /api/tools/fetch-page-text?url=https://...
 *
 * Sprint MIMIR.ONPAGE — Lightweight helper for the on-page learner UI.
 * Fetches a page and returns plain text/markdown derived from its HTML.
 *
 * We strip scripts/styles, normalize whitespace, and cap output at 30 KB
 * per fetch — enough for the learner to read structure without bloating
 * the request payload that gets POSTed to /api/mimir/onpage/learn.
 *
 * Auth: any logged-in user (no owner scoping required — we don't store
 * the result, just relay).
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url).searchParams.get('url')
  if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400 })

  let parsed: URL
  try { parsed = new URL(url) } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return NextResponse.json({ error: 'Only http(s) supported' }, { status: 400 })
  }

  try {
    const res = await fetch(parsed.toString(), {
      headers: {
        // Identify as a normal browser so anti-bot middleware doesn't return a stub
        'User-Agent':      'Mozilla/5.0 (compatible; G2G-SEO-Tools/1.0; +https://g2g.com)',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      },
      // No redirect chase beyond default; 30s outer cap from maxDuration
    })

    if (!res.ok) {
      return NextResponse.json({ error: `Upstream ${res.status}`, url: parsed.toString() }, { status: 502 })
    }

    const html = await res.text()
    const text = htmlToCleanText(html)

    return NextResponse.json({
      url:     parsed.toString(),
      bytes:   html.length,
      text:    text.slice(0, 30_000),   // cap
      truncated: text.length > 30_000,
    })
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : String(err),
      url:   parsed.toString(),
    }, { status: 502 })
  }
}

/**
 * Minimal HTML → text reducer. Preserves heading/paragraph structure with
 * line breaks so the on-page learner can recognize H1/H2/H3 cues. Not a
 * full DOM parser — regex is enough for our use case (we just need
 * Haiku-readable structure, not pixel-perfect output).
 */
function htmlToCleanText(html: string): string {
  return html
    // Strip script + style blocks entirely
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    // Mark headings so the learner can spot them
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n')
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n')
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n')
    // Paragraphs + list items → line breaks
    .replace(/<(p|li|br|div|tr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|li|div|tr|h[1-6])>/gi, '\n')
    // Drop all remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode the handful of named entities we care about
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
