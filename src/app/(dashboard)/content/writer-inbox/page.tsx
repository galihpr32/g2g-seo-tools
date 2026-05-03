import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { redirect } from 'next/navigation'
import WriterInboxClient from './WriterInboxClient'

export const revalidate = 60

/**
 * /content/writer-inbox
 *
 * Writer-focused view of SEO briefs. Deliberately stripped of agent
 * terminology (no "Tyr", "Bragi", "agent_generated" labels). Writers
 * see a prioritised queue: what's ready to write, what's in progress,
 * and what was recently published.
 *
 * Only shows briefs that have actionable content — status IN
 * ('reviewed', 'draft', 'published'). Briefs still generating or
 * awaiting QA are hidden because the writer can't act on them yet.
 */
export default async function WriterInboxPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { data: rawBriefs, error } = await db
    .from('seo_content_briefs')
    .select(`
      id,
      page,
      primary_keyword,
      brief_type,
      status,
      tyr_score,
      content_outline,
      content_draft,
      faq_suggestions,
      new_keywords,
      notes,
      target_publish_date,
      created_at,
      updated_at,
      tyr_status,
      claude_review_status
    `)
    .eq('owner_user_id', effectiveOwnerId)
    .in('status', ['reviewed', 'draft', 'published'])
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(300)

  // Filter: hide 'reviewed' briefs that are still awaiting Claude independent
  // review. Writer should only see briefs that are truly actionable. Once
  // claude_review_status is 'passed' or 'skipped' (24h timeout fallback), the
  // brief becomes visible. 'failed' briefs go back to regen flow, not writers.
  const briefs = (rawBriefs ?? []).filter(b => {
    if (b.status === 'draft' || b.status === 'published') return true   // legacy / done — always show
    if (b.status === 'reviewed') {
      // Block if Tyr passed but Claude still pending or failed
      if (b.claude_review_status === 'pending') return false
      if (b.claude_review_status === 'failed')  return false
    }
    return true
  })

  if (error) {
    return (
      <div className="p-8 max-w-4xl">
        <h1 className="text-2xl font-bold text-white">✍️ Writer Inbox</h1>
        <p className="text-red-400 mt-3">Failed to load briefs: {error.message}</p>
      </div>
    )
  }

  return <WriterInboxClient initialBriefs={briefs} />
}
