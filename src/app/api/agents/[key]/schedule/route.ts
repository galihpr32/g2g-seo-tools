import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export interface AgentSchedule {
  enabled: boolean
  frequency: 'daily' | 'weekly'
  day: number       // 0=Sun … 6=Sat (weekly only)
  hour: number      // 0–23
  timezone: string  // e.g. 'Asia/Jakarta'
}

function computeNextRun(schedule: AgentSchedule): Date {
  const now = new Date()
  const tz = schedule.timezone || 'UTC'

  // Get current time in target timezone
  const tzNow = new Date(now.toLocaleString('en-US', { timeZone: tz }))
  const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }))

  tzDate.setHours(schedule.hour, 0, 0, 0)

  if (schedule.frequency === 'weekly') {
    const currentDay = tzNow.getDay()
    let daysUntil = (schedule.day - currentDay + 7) % 7
    if (daysUntil === 0 && tzNow >= tzDate) daysUntil = 7
    tzDate.setDate(tzDate.getDate() + daysUntil)
  } else {
    // daily
    if (tzNow >= tzDate) tzDate.setDate(tzDate.getDate() + 1)
  }

  // Convert back to UTC — offset between tz local time and UTC
  const offsetMs = now.getTime() - tzNow.getTime()
  return new Date(tzDate.getTime() + offsetMs)
}

// GET /api/agents/[key]/schedule
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { key } = await params
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { data } = await db
    .from('agents')
    .select('config, schedule_next_run_at')
    .eq('owner_user_id', ownerId)
    .eq('agent_key', key)
    .maybeSingle()

  const config = (data?.config ?? {}) as Record<string, unknown>
  const schedule: AgentSchedule = {
    enabled:   (config.schedule_enabled  as boolean)  ?? false,
    frequency: (config.schedule_frequency as 'daily' | 'weekly') ?? 'daily',
    day:       (config.schedule_day      as number)   ?? 1,
    hour:      (config.schedule_hour     as number)   ?? 9,
    timezone:  (config.schedule_timezone as string)   ?? 'Asia/Jakarta',
  }

  return NextResponse.json({
    schedule,
    nextRunAt: (data as Record<string, unknown>)?.schedule_next_run_at ?? null,
  })
}

// PATCH /api/agents/[key]/schedule
// Body: { schedule: AgentSchedule }
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { key } = await params
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await request.json() as { schedule: AgentSchedule }
  const s = body.schedule
  if (!s) return NextResponse.json({ error: 'schedule required' }, { status: 400 })

  const nextRun = s.enabled ? computeNextRun(s) : null

  // Fetch existing config to merge
  const { data: existing } = await db
    .from('agents')
    .select('config')
    .eq('owner_user_id', ownerId)
    .eq('agent_key', key)
    .maybeSingle()

  const existingConfig = ((existing?.config ?? {}) as Record<string, unknown>)

  const newConfig = {
    ...existingConfig,
    schedule_enabled:   s.enabled,
    schedule_frequency: s.frequency,
    schedule_day:       s.day,
    schedule_hour:      s.hour,
    schedule_timezone:  s.timezone,
  }

  const { error } = await db
    .from('agents')
    .upsert({
      owner_user_id:       ownerId,
      agent_key:           key,
      config:              newConfig,
      schedule_next_run_at: nextRun?.toISOString() ?? null,
    }, { onConflict: 'owner_user_id,agent_key' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, nextRunAt: nextRun?.toISOString() ?? null })
}
