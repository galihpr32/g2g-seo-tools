// ── Sprint #380 BOSS.VIEW.PDF — server-side Puppeteer PDF export ──────────
//
// GET /api/reports/friday-kpi/boss-view/pdf
//   With ?slug=<slug>  → loads a previously-PUBLISHED snapshot from
//                        `friday_kpi_boss_view_published` (no auth — same
//                        guarantee the public page makes). Commentary is
//                        already baked into the payload at publish time.
//   Without slug       → auth-gated; loads the caller's current cached
//                        payload + commentary from
//                        `friday_kpi_boss_view_cache` so admins can preview
//                        a PDF of the working snapshot before publishing.
//
// Response: application/pdf binary with a Content-Disposition attachment
// header so browsers trigger a save dialog instead of inlining.
//
// Heavy puppeteer launch path — `maxDuration = 60` (same cap the
// per-brand boss-view build uses on Hobby).

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { buildBossViewPdfHtml, type BossViewCommentary } from '@/lib/reports/boss-view-pdf-html'
import { htmlToPdf } from '@/lib/reports/puppeteer-launcher'
import type { BossViewPayload } from '@/lib/reports/boss-view'

export const runtime     = 'nodejs'
export const maxDuration = 60
export const dynamic     = 'force-dynamic'

interface PublishedRow {
  payload:      BossViewPayload & { commentary?: BossViewCommentary | null }
  generated_at: string
  published_at: string
}
interface CacheRow {
  payload:      BossViewPayload
  commentary:   BossViewCommentary | null
  generated_at: string
}

export async function GET(req: Request) {
  const url  = new URL(req.url)
  const slug = url.searchParams.get('slug')?.trim() || null

  // Resolve payload + commentary depending on mode.
  let payload:    BossViewPayload | null            = null
  let commentary: BossViewCommentary | null         = null
  let downloadSlug: string                          = 'preview'

  try {
    if (slug) {
      // Sprint #384 — slug mode is no-longer-anonymous: gate on @g2g.com /
      // @offgamers.com email so PDF download can't bypass the same domain
      // gate now enforced on the public /reports/[slug] page.
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return NextResponse.json({
        error: 'unauthenticated',
        message: 'Please sign in with your G2G or OffGamers account.',
      }, { status: 401 })
      const lower = (user.email ?? '').toLowerCase().trim()
      const allowed = lower.endsWith('@g2g.com') || lower.endsWith('@offgamers.com')
      if (!allowed) return NextResponse.json({
        error: 'forbidden_domain',
        message: 'Only @g2g.com & @offgamers.com domains can open this file. ' +
                 'Please use your account profile to open this file.',
      }, { status: 403 })

      const db = createServiceClient()
      const { data, error } = await db
        .from('friday_kpi_boss_view_published')
        .select('payload, generated_at, published_at')
        .eq('slug', slug)
        .order('published_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!data)  return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 })
      const row = data as PublishedRow
      // Commentary lives INSIDE the published payload (publish/route.ts
      // injects it at publish time).
      const { commentary: c, ...rest } = row.payload
      payload      = rest as BossViewPayload
      commentary   = c ?? null
      downloadSlug = slug
    } else {
      // Admin mode — requires auth, reads the caller's cache row.
      const supabase = await createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      const ownerId = await getEffectiveOwnerId(supabase, user.id)
      const db      = createServiceClient()
      const { data, error } = await db
        .from('friday_kpi_boss_view_cache')
        .select('payload, commentary, generated_at')
        .eq('owner_user_id', ownerId)
        .order('generated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!data)  return NextResponse.json({
        error: 'No cached payload. Open the dashboard + click Refresh first.',
      }, { status: 400 })
      const row = data as CacheRow
      payload      = row.payload
      commentary   = (row.commentary as BossViewCommentary | null) ?? null
      // Derive a slug-like filename suffix from the payload's curStart so
      // multiple downloads don't collide on filename. Falls back to date.
      const cur = row.payload?.curStart ?? ''
      downloadSlug = cur ? cur.replace(/-/g, '') : 'preview'
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to load payload'
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  if (!payload) return NextResponse.json({ error: 'No payload to render' }, { status: 500 })

  // Build HTML + render via Puppeteer.
  try {
    const html = buildBossViewPdfHtml(payload, { commentary })
    const pdf  = await htmlToPdf(html)

    // Convert Node Buffer to a Uint8Array for the standard Response body.
    // (Buffer is a Uint8Array under the hood but TS Response typings
    // don't accept Buffer directly anymore.)
    const body = new Uint8Array(pdf)
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="weekly-snapshot-${downloadSlug}.pdf"`,
        'Content-Length':      String(pdf.length),
        'Cache-Control':       'no-store, max-age=0',
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'PDF render failed'
    console.error('[boss-view/pdf] render failed:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
