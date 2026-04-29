import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getOnPagePagesWithCheck } from '@/lib/dataforseo/client'

const TARGET = 'g2g.com'

// Map of UI issue label slugs → DataForSEO check keys
const CHECK_KEY_MAP: Record<string, string> = {
  no_h1_tag:              'no_h1_tag',
  no_title:               'no_title',
  no_description:         'no_description',
  duplicate_title:        'duplicate_title',
  duplicate_description:  'duplicate_description',
  no_image_alt:           'no_image_alt',
  redirect_chain:         'redirect_chain',
  large_page_size:        'large_page_size',
  broken_links:           'broken_links',
  broken_resources:       'broken_resources',
}

/**
 * GET /api/site-audit/pages?check=no_h1_tag
 *
 * Returns the list of pages that fail a specific on-page check from
 * the most recent finished audit task for this owner.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { searchParams } = new URL(req.url)
  const check = searchParams.get('check') ?? ''

  if (!CHECK_KEY_MAP[check]) {
    return NextResponse.json(
      { error: `Unknown check key. Valid: ${Object.keys(CHECK_KEY_MAP).join(', ')}` },
      { status: 400 }
    )
  }

  const db = createServiceClient()

  // Get most recent finished task
  const { data: tasks } = await db
    .from('site_audit_tasks')
    .select('task_id')
    .eq('owner_user_id', ownerId)
    .eq('target', TARGET)
    .eq('status', 'finished')
    .order('finished_at', { ascending: false })
    .limit(1)

  const taskId = tasks?.[0]?.task_id
  if (!taskId) return NextResponse.json({ error: 'No finished audit found' }, { status: 404 })

  const pages = await getOnPagePagesWithCheck(taskId, CHECK_KEY_MAP[check])
  return NextResponse.json({ pages })
}
