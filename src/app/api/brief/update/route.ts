import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { captureReviewFeedback, computeChangedSections, type SectionedBrief } from '@/lib/learn/review-diff'

// PATCH /api/brief/update — update brief fields (published_url, status, etc.)
//
// Sprint LEARN.2: Whenever a content-bearing field changes, capture a
// brief_review_feedback row so the weekly aggregator can learn from human
// edits. First edit also snapshots the AI-original content into a dedicated
// ai_original_* column so subsequent diffs always compare back to the
// untouched Bragi version.
export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { id, ...updates } = body
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  // We need the AI-original snapshot + the brief's owner + site_slug for
  // the feedback capture step. Use service client so we read regardless of
  // RLS scope (the writer of the brief may not be its owner in workspace mode).
  const db = createServiceClient()
  const { data: pre } = await db
    .from('seo_content_briefs')
    .select('owner_user_id, site_slug, content_draft, meta_title, meta_description, ai_original_draft, ai_original_meta, ai_original_captured_at')
    .eq('id', id)
    .maybeSingle()

  // FIRST EDIT: capture AI-original snapshot before applying changes. Without
  // this, future diffs would compare human v2 against human v1 and lose the
  // original signal entirely.
  const isFirstContentEdit = pre && !pre.ai_original_captured_at && (
    typeof updates.content_draft === 'string' ||
    typeof updates.meta_title === 'string' ||
    typeof updates.meta_description === 'string'
  )
  if (isFirstContentEdit) {
    updates.ai_original_draft       = pre.content_draft ?? null
    updates.ai_original_meta        = { meta_title: pre.meta_title ?? null, meta_description: pre.meta_description ?? null }
    updates.ai_original_captured_at = new Date().toISOString()
  }

  // RLS ensures user can only update their own briefs
  const { error } = await supabase
    .from('seo_content_briefs')
    .update(updates)
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // ── Best-effort feedback capture ───────────────────────────────────────
  // Wrap in try/catch — capture should never block the human's save.
  try {
    if (pre && pre.ai_original_captured_at) {
      // Existing snapshot present — diff against it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const aiMeta = (pre.ai_original_meta ?? {}) as any
      const aiOriginal: SectionedBrief = {
        intro:            pre.ai_original_draft ?? '',
        meta_title:       aiMeta.meta_title ?? null,
        meta_description: aiMeta.meta_description ?? null,
      }
      const humanCurrent: SectionedBrief = {
        intro:            (typeof updates.content_draft === 'string'    ? updates.content_draft    : pre.content_draft) ?? '',
        meta_title:       (typeof updates.meta_title === 'string'       ? updates.meta_title       : pre.meta_title) ?? null,
        meta_description: (typeof updates.meta_description === 'string' ? updates.meta_description : pre.meta_description) ?? null,
      }
      const changes = computeChangedSections(aiOriginal, humanCurrent)
      if (changes.length > 0) {
        await captureReviewFeedback(db, {
          briefId:      String(id),
          ownerId:      String(pre.owner_user_id),
          siteSlug:     String(pre.site_slug ?? 'g2g'),
          reviewerId:   user.id,
          aiOriginal,
          humanCurrent,
        })
      }
    } else if (isFirstContentEdit && pre) {
      // First-edit case: we just stamped ai_original; on THIS save, diff
      // current updates vs that snapshot.
      const aiOriginal: SectionedBrief = {
        intro:            pre.content_draft ?? '',
        meta_title:       pre.meta_title ?? null,
        meta_description: pre.meta_description ?? null,
      }
      const humanCurrent: SectionedBrief = {
        intro:            (typeof updates.content_draft === 'string'    ? updates.content_draft    : pre.content_draft) ?? '',
        meta_title:       (typeof updates.meta_title === 'string'       ? updates.meta_title       : pre.meta_title) ?? null,
        meta_description: (typeof updates.meta_description === 'string' ? updates.meta_description : pre.meta_description) ?? null,
      }
      const changes = computeChangedSections(aiOriginal, humanCurrent)
      if (changes.length > 0) {
        await captureReviewFeedback(db, {
          briefId:      String(id),
          ownerId:      String(pre.owner_user_id),
          siteSlug:     String(pre.site_slug ?? 'g2g'),
          reviewerId:   user.id,
          aiOriginal,
          humanCurrent,
        })
      }
    }
  } catch (e) {
    // Non-blocking. Log but don't fail the save.
    console.warn('[brief-update] feedback capture failed:', e instanceof Error ? e.message : String(e))
  }

  return NextResponse.json({ ok: true })
}
