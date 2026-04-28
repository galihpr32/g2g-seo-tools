import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { redirect } from 'next/navigation'
import EditorialCalendarClient from './EditorialCalendarClient'

export const revalidate = 60

/**
 * /content/calendar
 *
 * Editorial calendar — visual month view of SEO content briefs.
 * Briefs are placed on the day they're scheduled to publish.
 * Unscheduled briefs appear in a sidebar pipeline column.
 *
 * Interactions:
 *   • Click a day to schedule/reschedule a brief via date picker
 *   • Click a brief card to open it
 *   • "Mark published" inline
 *   • Navigate months with prev/next buttons
 *   • Pipeline column shows unscheduled ready/in-progress briefs
 */
export default async function EditorialCalendarPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Fetch all non-archived briefs — calendar needs the full picture
  const { data: briefs, error } = await db
    .from('seo_content_briefs')
    .select(`
      id,
      page,
      primary_keyword,
      brief_type,
      status,
      tyr_score,
      content_outline,
      target_publish_date,
      created_at,
      updated_at
    `)
    .eq('owner_user_id', effectiveOwnerId)
    .not('status', 'eq', 'generating')
    .order('target_publish_date', { ascending: true, nullsFirst: false })
    .limit(500)

  if (error) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold text-white">📅 Editorial Calendar</h1>
        <p className="text-red-400 mt-3">Failed to load: {error.message}</p>
      </div>
    )
  }

  return <EditorialCalendarClient initialBriefs={briefs ?? []} />
}
