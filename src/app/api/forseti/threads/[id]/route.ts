import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * GET /api/forseti/threads/[id]
 *
 * Returns one thread + its full activity log (responses + status changes,
 * chronologically). Used by /forseti/[id] detail page.
 */
export async function GET(
  _req: Request,
  ctx:  { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()
  const { id }  = await ctx.params

  const { data: thread, error: tErr } = await db
    .from('forseti_threads')
    .select('*')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()

  if (tErr)    return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  const { data: responses } = await db
    .from('forseti_thread_responses')
    .select('*')
    .eq('thread_id', id)
    .order('created_at', { ascending: true })

  return NextResponse.json({
    thread: {
      ...thread,
      effective_category: thread.manual_category_override ?? thread.auto_category,
      effective_severity: thread.manual_severity_override ?? thread.auto_severity,
    },
    responses: responses ?? [],
  })
}

// ─── POST /api/forseti/threads/[id]/responses (via separate route) ─────────
// Defined in /api/forseti/threads/[id]/responses/route.ts
