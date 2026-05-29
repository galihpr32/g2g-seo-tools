import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { checkLinkLive } from '@/app/api/backlinks/check/route'

export const maxDuration = 300

/**
 * GET /api/cron/backlinks-verify
 *
 * Daily — for every paid_backlink with status='pending' or 'active' (and
 * stale last_verified_at), runs the SAME verification helper as the manual
 * "Check" button (/api/backlinks/check). That helper:
 *   1. Tries plain fetch first (cheap)
 *   2. Falls back to Firecrawl (headless browser) on 403/429/503/timeout
 *   3. Matches by anchorText AND targetDomain (hostname only)
 *
 * State transitions:
 *   pending → active  : link found
 *   pending → broken  : URL truly dead (both fetch + Firecrawl failed) OR
 *                       anchor/domain missing from rendered HTML
 *   active  → broken  : link previously found is now missing or page errored
 *   broken  → active  : link reappeared (manual recovery / temporary outage)
 *
 * Auth: Bearer CRON_SECRET (GitHub Actions).
 *
 * Eliminates Specialist 2's manual click-each-pending-link daily ritual.
 *
 * SPRINT BL.VERIFY.FIX (2026-05-19): Previously this cron used a more brittle
 * verification path that diverged from the manual check — no Firecrawl
 * fallback, strict full-URL match. Result: Cloudflare-protected publishers
 * returned 403 → marked broken; URL-path mismatch (UTM/redirect/format) →
 * also marked broken. Galih reported 18/19 "broken" rows were false
 * positives that flipped to active on manual "Check" click. Fixed by routing
 * cron through the same checkLinkLive helper used by the UI.
 */
function isCronAuth(req: Request): boolean {
  const authHeader = req.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
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
      const result = await checkLinkLive(
        String(b.external_url),
        String(b.anchor_text ?? ''),
        String(b.target_page ?? ''),
      )

      const newStatus = result.found ? 'active' : 'broken'
      const oldStatus = String(b.link_status)
      const note = result.found
        ? `Verified via ${result.method}`
        : (result.error ?? `Anchor or domain missing (via ${result.method})`)

      const updates: Record<string, unknown> = {
        link_status:       newStatus,
        last_verified_at:  new Date().toISOString(),
        verification_note: note,
        // Keep http_status null — checkLinkLive doesn't expose it; verification
        // note captures the failure mode.
        http_status:       null,
      }

      if (oldStatus !== newStatus) {
        if (newStatus === 'active')  stats.flippedActive++
        if (newStatus === 'broken')  stats.flippedBroken++
        transitions.push({ id: String(b.id), from: oldStatus, to: newStatus, note })
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
