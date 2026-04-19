import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { smartScrape } from '@/lib/firecrawl/client'

export const maxDuration = 30

// ── POST /api/backlinks/check — check if a backlink is still live ─────────────
// 2-step: tries fetch() first, falls back to Firecrawl if blocked/failed.
// Body: { id: string }
// Checks if the external_url still contains a link to target_page with anchor_text.
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { id } = await request.json() as { id: string }
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const { data: bl } = await supabase
    .from('paid_backlinks')
    .select('external_url, anchor_text, target_page')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .single()

  if (!bl) return NextResponse.json({ error: 'Backlink not found' }, { status: 404 })

  const { found, method, error: checkErr } = await checkLinkLive(
    bl.external_url, bl.anchor_text, bl.target_page
  )

  const status = found ? 'active' : 'broken'
  const now = new Date().toISOString()

  await supabase
    .from('paid_backlinks')
    .update({ link_status: status, last_checked_at: now, check_method: method })
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  return NextResponse.json({ ok: true, link_status: status, method, error: checkErr ?? null })
}

// ── Helper: check if external_url contains a link to target_page ──────────────
async function checkLinkLive(
  externalUrl: string,
  anchorText: string,
  targetPage: string
): Promise<{ found: boolean; method: 'fetch' | 'firecrawl'; error?: string }> {
  const anchorLower = anchorText.toLowerCase()
  const targetDomain = (() => {
    try { return new URL(targetPage).hostname } catch { return 'g2g.com' }
  })()

  function htmlContainsLink(html: string): boolean {
    const lower = html.toLowerCase()
    return lower.includes(anchorLower) && lower.includes(targetDomain)
  }

  // Step 1: try plain fetch()
  try {
    const res = await fetch(externalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; G2GSEOBot/1.0)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(8000),
    })

    if (res.ok) {
      const html = await res.text()
      return { found: htmlContainsLink(html), method: 'fetch' }
    }

    // 4xx/5xx but response received — try Firecrawl
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      throw new Error(`HTTP ${res.status} — trying Firecrawl`)
    }

    // Other HTTP errors (404, etc.) — link is likely dead
    if (res.status === 404) {
      return { found: false, method: 'fetch' }
    }

    throw new Error(`HTTP ${res.status}`)
  } catch (fetchErr) {
    // Step 2: fallback to Firecrawl
    try {
      const scraped = await smartScrape(externalUrl)
      if (!scraped) return { found: false, method: 'firecrawl', error: 'Firecrawl returned no content' }

      const combined = [scraped.markdown ?? '', scraped.title ?? ''].join(' ').toLowerCase()
      return { found: combined.includes(anchorLower) && combined.includes(targetDomain), method: 'firecrawl' }
    } catch (fcErr) {
      return {
        found: false,
        method: 'firecrawl',
        error: `fetch: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}; firecrawl: ${fcErr instanceof Error ? fcErr.message : String(fcErr)}`,
      }
    }
  }
}

// Exported for the /check/all route
export { checkLinkLive }
