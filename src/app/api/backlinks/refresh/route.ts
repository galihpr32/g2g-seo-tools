import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getSerpData } from '@/lib/dataforseo/client'
import { getCountryPreset, countryFromLanguageCode } from '@/lib/country-config'
import { detectPageLanguage } from '@/lib/language-detect'
import { checkLinkLive } from '../check/route'
import { logApiUsage } from '@/lib/api-logger'

export const maxDuration = 60

// ── POST /api/backlinks/refresh — monthly refresh ────────────────────────────
// Checks all active backlinks for:
//   1. Link still live (2-step fetch → Firecrawl)
//   2. Current SERP position for target_keyword on target_page
// Stores results in position_history JSONB and updates position_current.
// Body: { country?: string } — override SERP country (default: auto from target_page URL)
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await request.json().catch(() => ({})) as { country?: string }

  const { data: backlinks } = await db
    .from('paid_backlinks')
    .select('*')
    .eq('owner_user_id', ownerId)
    .in('link_status', ['active', 'pending'])

  if (!backlinks || backlinks.length === 0) {
    return NextResponse.json({ ok: true, checked: 0, message: 'No active backlinks to refresh' })
  }

  const now = new Date().toISOString()
  const monthKey = now.slice(0, 7) // "2026-04"

  const results: Array<{ id: string; status: string; position: number | null; error?: string }> = []

  for (const bl of backlinks) {
    try {
      // 1. Check if link is still live
      const { found, method } = await checkLinkLive(bl.external_url, bl.anchor_text, bl.target_page)
      const linkStatus = found ? 'active' : 'broken'

      // 2. Get SERP position for target_keyword on target_page
      let position: number | null = null
      if (bl.target_keyword && bl.target_page) {
        try {
          const lang = detectPageLanguage(bl.target_page)
          const country = body.country
            ? getCountryPreset(body.country)
            : countryFromLanguageCode(lang.code)

          const serpData = await getSerpData(
            bl.target_keyword,
            country.dfsLocationCode,
            country.dfsLanguageCode,
            20 // depth — check top 20 results
          )

          // Find our target_page in the SERP results
          const targetDomain = (() => {
            try { return new URL(bl.target_page).hostname } catch { return 'g2g.com' }
          })()

          const match = serpData.organicResults.find(r =>
            r.url.includes(targetDomain) ||
            r.url.includes(bl.target_page.replace(/^https?:\/\//, ''))
          )
          position = match?.rank_absolute ?? null
        } catch { /* SERP check failed — skip position update */ }
      }

      // 3. Update position_history (append this month's reading)
      const currentHistory: Array<{ date: string; position: number | null }> = bl.position_history ?? []
      const existingMonthIdx = currentHistory.findIndex(h => h.date === monthKey)
      if (existingMonthIdx >= 0) {
        currentHistory[existingMonthIdx] = { date: monthKey, position }
      } else {
        currentHistory.push({ date: monthKey, position })
      }
      // Keep last 24 months
      const trimmedHistory = currentHistory.slice(-24)

      // 4. Set position_at_creation if this is the first ever check
      const positionAtCreation = bl.position_at_creation ?? (currentHistory.length === 1 ? position : null)

      await db
        .from('paid_backlinks')
        .update({
          link_status: linkStatus,
          last_checked_at: now,
          check_method: method,
          position_current: position,
          position_history: trimmedHistory,
          position_at_creation: positionAtCreation,
        })
        .eq('id', bl.id)
        .eq('owner_user_id', ownerId)

      results.push({ id: bl.id, status: linkStatus, position })
    } catch (err) {
      results.push({ id: bl.id, status: 'error', position: null, error: String(err) })
    }
  }

  const active = results.filter(r => r.status === 'active').length
  const broken = results.filter(r => r.status === 'broken').length
  const errors = results.filter(r => r.status === 'error').length

  // Log API usage (fire-and-forget)
  const serpCount = backlinks.filter(bl => bl.target_keyword && bl.target_page).length
  logApiUsage(supabase, ownerId, {
    api: 'dataforseo', endpoint: 'serp/google/organic',
    triggeredBy: 'backlink_refresh', callCount: serpCount,
    metadata: { backlink_count: backlinks.length },
  })
  logApiUsage(supabase, ownerId, {
    api: 'firecrawl', endpoint: 'scrape',
    triggeredBy: 'backlink_refresh', callCount: backlinks.length,
    metadata: { backlink_count: backlinks.length },
  })

  return NextResponse.json({
    ok: true,
    checked: backlinks.length,
    active, broken, errors,
    results,
    refreshed_at: now,
  })
}
