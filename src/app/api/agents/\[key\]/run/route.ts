import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { runPakRT } from '@/lib/agents/pak-rt'
import { runMasGacor } from '@/lib/agents/mas-gacor'

export async function POST(
  request: Request,
  { params }: { params: { key: string } }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const key = params.key
  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await request.json()
  const siteSlug = body.site ?? 'g2g'

  try {
    // Create run record
    const { data: runRecord, error: runErr } = await db
      .from('agent_runs')
      .insert({
        owner_user_id: effectiveOwnerId,
        agent_key: key,
        site_slug: siteSlug,
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (runErr || !runRecord) {
      return NextResponse.json({ error: 'Failed to create run record' }, { status: 500 })
    }

    const runId = runRecord.id

    // Dispatch agent based on key
    let result: { summary: string; actionsQueued: number }

    if (key === 'pak-rt') {
      result = await runPakRT(effectiveOwnerId, siteSlug, runId)
    } else if (key === 'mas-gacor') {
      result = await runMasGacor(effectiveOwnerId, siteSlug, runId)
    } else {
      return NextResponse.json(
        { error: `Agent not yet implemented: ${key}` },
        { status: 400 }
      )
    }

    return NextResponse.json({
      runId,
      ...result,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
