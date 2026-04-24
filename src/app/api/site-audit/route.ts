import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { startOnPageCrawl, pollOnPageTask, getOnPageSummary } from '@/lib/dataforseo/client'

export const maxDuration = 60

const TARGET = 'g2g.com'

// ── GET — return latest cached audit ─────────────────────────────────────────
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const { searchParams } = new URL(req.url)
  const poll = searchParams.get('poll') // task row ID to poll status for

  // Poll a specific task
  if (poll) {
    const { data: row } = await db
      .from('site_audit_tasks')
      .select('*')
      .eq('id', poll)
      .eq('owner_user_id', ownerId)
      .single()

    if (!row) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

    // If still in-progress, check DFS
    if (row.status === 'in_progress' || row.status === 'pending') {
      const summary = await getOnPageSummary(row.task_id)
      if (summary?.crawlProgress === 'finished') {
        await db
          .from('site_audit_tasks')
          .update({ status: 'finished', summary, finished_at: new Date().toISOString() })
          .eq('id', poll)
        return NextResponse.json({ task: { ...row, status: 'finished', summary } })
      }
    }

    return NextResponse.json({ task: row })
  }

  // Return latest task
  const { data } = await db
    .from('site_audit_tasks')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('target', TARGET)
    .order('created_at', { ascending: false })
    .limit(1)

  return NextResponse.json({ task: data?.[0] ?? null })
}

// ── POST — start a new on-page audit ─────────────────────────────────────────
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Start the DFS crawl task
  const dfsTaskId = await startOnPageCrawl(TARGET, 100)
  if (!dfsTaskId) {
    return NextResponse.json({ error: 'Failed to start DataForSEO on-page crawl. Check API credentials.' }, { status: 500 })
  }

  // Save task row (pending)
  const { data: row, error: insertErr } = await db
    .from('site_audit_tasks')
    .insert({
      owner_user_id: ownerId,
      task_id: dfsTaskId,
      target: TARGET,
      status: 'in_progress',
    })
    .select()
    .single()

  if (insertErr || !row) {
    return NextResponse.json({ error: 'Failed to save audit task' }, { status: 500 })
  }

  // Try to wait for completion (up to 45s)
  const summary = await pollOnPageTask(dfsTaskId, 44_000)

  if (summary?.crawlProgress === 'finished') {
    await db
      .from('site_audit_tasks')
      .update({ status: 'finished', summary, finished_at: new Date().toISOString() })
      .eq('id', row.id)
    return NextResponse.json({ task: { ...row, status: 'finished', summary } })
  }

  // Returned before completion — client should poll
  return NextResponse.json({ task: row })
}
