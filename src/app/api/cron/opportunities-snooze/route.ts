import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

export const maxDuration = 60

/**
 * GET /api/cron/opportunities-snooze
 *
 * Daily cron — auto-snoozes seo_opportunities where:
 *   - status = 'new' (untouched, never moved out of triage)
 *   - last_signal_at <= NOW - 21 days (or created_at if last_signal_at is null)
 *
 * This keeps the Specialist 1 triage list from growing unbounded with
 * stale opportunities. Snoozed rows are still visible via the
 * "show snoozed" toggle on /command-center/opportunities.
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

  const cutoff = new Date(Date.now() - 21 * 86400_000).toISOString()

  // Two-pass update: rows with last_signal_at, and rows without (use created_at).
  const { data: snoozedWithSignal, error: e1 } = await db
    .from('seo_opportunities')
    .update({ status: 'snoozed', snoozed_at: new Date().toISOString() })
    .eq('status', 'new')
    .lte('last_signal_at', cutoff)
    .select('id')
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 })

  const { data: snoozedNoSignal, error: e2 } = await db
    .from('seo_opportunities')
    .update({ status: 'snoozed', snoozed_at: new Date().toISOString() })
    .eq('status', 'new')
    .is('last_signal_at', null)
    .lte('created_at', cutoff)
    .select('id')
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 })

  const total = (snoozedWithSignal?.length ?? 0) + (snoozedNoSignal?.length ?? 0)
  return NextResponse.json({ ok: true, snoozed: total, when: new Date().toISOString() })
}
