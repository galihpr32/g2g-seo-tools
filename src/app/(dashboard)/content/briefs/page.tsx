import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { redirect } from 'next/navigation'
import BriefLibraryClient from './BriefLibraryClient'

export const revalidate = 30

/**
 * /content/briefs
 *
 * Brief library — single index of every SEO content brief in
 * `seo_content_briefs`, with filters by status, Tyr score, keyword search,
 * and date range.
 *
 * Why this page exists:
 * Until now, briefs were only reachable via:
 *   • the GSC action-items detail page (only briefs linked to action items)
 *   • a direct URL `/content/briefs/[id]` (you had to know the id)
 *   • the Approval Queue (only pending review)
 *
 * Tyr-approved briefs (status='reviewed') were effectively orphaned — no
 * way to browse them, hand off to writers, or batch-export.
 *
 * This page closes that gap. From here the user can:
 *   • Filter briefs by status / Tyr verdict / score / keyword / date
 *   • Open the editor (/gsc/action-items/[id] when linked) or read-only
 *     view (/content/briefs/[id]) for unlinked briefs
 *   • Copy brief content to clipboard for quick handoff to writers
 *   • Mark a brief as published (status='published')
 */
export default async function BriefLibraryPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Pull all briefs for this owner. Lightweight initial fetch — full
  // detail is loaded on demand by the detail page.
  const { data: briefs, error } = await db
    .from('seo_content_briefs')
    .select(`
      id,
      page,
      primary_keyword,
      brief_type,
      status,
      tyr_score,
      tyr_status,
      tyr_reviewed_at,
      action_item_id,
      content_outline,
      content_draft,
      faq_suggestions,
      new_keywords,
      notes,
      created_at,
      updated_at
    `)
    .eq('owner_user_id', effectiveOwnerId)
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(500)

  if (error) {
    return (
      <div className="p-8 max-w-4xl">
        <h1 className="text-2xl font-bold text-white">Brief Library</h1>
        <p className="text-red-400 mt-3">Failed to load briefs: {error.message}</p>
      </div>
    )
  }

  return <BriefLibraryClient initialBriefs={briefs ?? []} />
}
