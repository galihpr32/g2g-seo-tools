import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

export const maxDuration = 300

/**
 * GET /api/cron/backlinks-verify
 *
 * Daily — for every paid_backlink with status='pending' or 'active' (and
 * stale last_verified_at), cURL the external_url, parse HTML, check whether
 * the anchor text + target_page link still exists.
 *
 * State transitions:
 *   pending → active  : link found
 *   pending → broken  : URL 404/5xx OR anchor not found
 *   active  → broken  : link previously found is now missing or page errored
 *   broken  → active  : link reappeared (manual recovery / temporary outage)
 *
 * Auth: Bearer CRON_SECRET (GitHub Actions).
 *
 * Eliminates Specialist 2's manual click-each-pending-link daily ritual.
 * Conservative: 7 second timeout per fetch, max 50 backlinks per run, only
 * touches links with last_verified_at older than 48h.
 */
function isCronAuth(req: Request): boolean {
  const authHeader = req.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

function normalizeUrl(s: string): string {
  return s.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')
}

interface VerifyResult {
  status:    'active' | 'broken'
  httpStatus: number | null
  note:       string
}

async function verifyBacklink(externalUrl: string, anchorText: string, targetPage: string): Promise<VerifyResult> {
  const controller = new AbortController()
  const timeoutId  = setTimeout(() => controller.abort(), 7000)

  try {
    const res = await fetch(externalUrl, {
      method:  'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; G2G-LinkVerifier/1.0; +https://g2g-seo-tools.vercel.app)',
        'Accept':     'text/html,application/xhtml+xml',
      },
      signal:  controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timeoutId)

    if (res.status >= 500) return { status: 'broken', httpStatus: res.status, note: `Server error (${res.status})` }
    if (res.status === 404) return { status: 'broken', httpStatus: 404, note: '404 Not Found' }
    if (res.status >= 400)  return { status: 'broken', httpStatus: res.status, note: `HTTP ${res.status}` }

    const html = await res.text()
    if (!html) return { status: 'broken', httpStatus: res.status, note: 'Empty response body' }

    // Two checks:
    //  1. anchor text appears in body
    //  2. target page URL appears in href somewhere (normalized comparison)
    const lowerHtml   = html.toLowerCase()
    const anchorLower = anchorText.toLowerCase().trim()
    const targetNorm  = normalizeUrl(targetPage)

    const anchorPresent = lowerHtml.includes(anchorLower)
    const targetPresent = lowerHtml.includes(targetNorm) || lowerHtml.includes(targetNorm.replace(/-/g, '%2d'))

    if (!targetPresent) {
      return {
        status: 'broken',
        httpStatus: res.status,
        note:   anchorPresent
          ? 'Target URL link removed (anchor text remains, link gone)'
          : 'Anchor text + target URL both missing',
      }
    }
    if (!anchorPresent) {
      // Target URL present but anchor text changed — softer warning, still active
      return {
        status: 'active',
        httpStatus: res.status,
        note:   'Active — anchor text changed (target URL still linked)',
      }
    }
    return { status: 'active', httpStatus: res.status, note: 'Verified' }
  } catch (err) {
    clearTimeout(timeoutId)
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('aborted') || msg.includes('timeout')) {
      return { status: 'broken', httpStatus: null, note: 'Timeout (>7s)' }
    }
    return { status: 'broken', httpStatus: null, note: `Fetch error: ${msg.slice(0, 100)}` }
  }
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Stale = last_verified_at NULL or > 48h ago. Skip recently-verified links
  // so we don't hammer external sites unnecessarily.
  const stale = new Date(Date.now() - 48 * 3600_000).toISOString()

  const { data: backlinks } = await db
    .from('paid_backlinks')
    .select('id, external_url, anchor_text, target_page, link_status, last_verified_at')
    .in('link_status', ['pending', 'active'])
    .or(`last_verified_at.is.null,last_verified_at.lt.${stale}`)
    .order('last_verified_at', { ascending: true, nullsFirst: true })
    .limit(50)

  if (!backlinks || backlinks.length === 0) {
    return NextResponse.json({
      ok:        true,
      checked:   0,
      message:   'No stale backlinks to verify.',
    })
  }

  const stats = { checked: 0, flippedActive: 0, flippedBroken: 0, stillActive: 0, stillBroken: 0, errors: 0 }
  const transitions: Array<{ id: string; from: string; to: string; note: string }> = []

  for (const b of backlinks) {
    stats.checked++
    try {
      const result = await verifyBacklink(
        String(b.external_url),
        String(b.anchor_text ?? ''),
        String(b.target_page ?? ''),
      )

      const newStatus = result.status
      const oldStatus = String(b.link_status)

      const updates: Record<string, unknown> = {
        link_status:       newStatus,
        last_verified_at:  new Date().toISOString(),
        verification_note: result.note,
        http_status:       result.httpStatus,
      }

      if (oldStatus !== newStatus) {
        if (newStatus === 'active')  stats.flippedActive++
        if (newStatus === 'broken')  stats.flippedBroken++
        transitions.push({ id: String(b.id), from: oldStatus, to: newStatus, note: result.note })
      } else {
        if (newStatus === 'active')  stats.stillActive++
        if (newStatus === 'broken')  stats.stillBroken++
      }

      await db.from('paid_backlinks').update(updates).eq('id', b.id)
    } catch (err) {
      stats.errors++
      console.error('[backlinks-verify] failed for', b.id, err)
    }
  }

  return NextResponse.json({
    ok:          stats.errors === 0,
    stats,
    transitions: transitions.slice(0, 30),
    when:        new Date().toISOString(),
  })
}
