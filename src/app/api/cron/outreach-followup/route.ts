import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

export const maxDuration = 60

/**
 * GET /api/cron/outreach-followup
 *
 * Daily cron — flags outreach_prospects.needs_followup=true when:
 *   - last_sent_at <= NOW - 5 days, AND
 *   - last_replied_at is null, AND
 *   - status NOT IN ('published', 'rejected')   (terminal states)
 *   - needs_followup is currently false (idempotent — won't re-flag)
 *
 * UI's Hermod outreach view filters by needs_followup=true to show the
 * "needs follow-up" queue. Specialist 2 clears the flag manually after
 * sending the follow-up email.
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

  const cutoff = new Date(Date.now() - 5 * 86400_000).toISOString()

  const { data, error } = await db
    .from('outreach_prospects')
    .update({ needs_followup: true, followup_flagged_at: new Date().toISOString() })
    .lte('last_sent_at', cutoff)
    .is('last_replied_at', null)
    .eq('needs_followup', false)
    .not('status', 'in', '("published","rejected")')
    .select('id, domain, owner_user_id, last_sent_at')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    flagged: data?.length ?? 0,
    when: new Date().toISOString(),
    sample: (data ?? []).slice(0, 5).map(d => ({ domain: d.domain, last_sent_at: d.last_sent_at })),
  })
}
