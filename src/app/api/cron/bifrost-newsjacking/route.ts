import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { runBifrostNewsjacker } from '@/lib/agents/bifrost-newsjacking'

export const maxDuration = 180

/**
 * GET /api/cron/bifrost-newsjacking
 *
 * Daily cron — runs the Bifrost newsjacking classifier per (owner, site).
 * Tags outreach_prospects with `fresh_hook` JSONB so Specialist 2 sees
 * which prospects have a hot angle ready to send.
 *
 * Auth: Bearer CRON_SECRET.
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: sites } = await db.from('site_configs').select('slug').eq('is_active', true)
  if (!sites?.length) return NextResponse.json({ error: 'No active sites' }, { status: 500 })

  const runs: Array<{ site: string; owner: string; ok: boolean; result?: unknown; error?: string }> = []

  for (const site of sites) {
    const siteSlug = String(site.slug)
    // Each owner with active outreach_prospects on this site
    const { data: prospects } = await db
      .from('outreach_prospects')
      .select('owner_user_id')
      .in('status', ['prospecting', 'contacted', 'negotiating', 'accepted'])
      .limit(500)
    const owners = Array.from(new Set((prospects ?? []).map(p => String(p.owner_user_id))))

    for (const ownerId of owners) {
      try {
        const result = await runBifrostNewsjacker(db, ownerId, siteSlug)
        runs.push({ site: siteSlug, owner: ownerId, ok: result.warnings.length === 0, result })
      } catch (err) {
        runs.push({ site: siteSlug, owner: ownerId, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  return NextResponse.json({ ok: runs.every(r => r.ok), when: new Date().toISOString(), runs })
}
