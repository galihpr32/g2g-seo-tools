import { NextResponse, after } from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { canAccessOwnerData }  from '@/lib/workspace'
import { assembleFullArticle } from '@/lib/agents/brief-generator'

export const maxDuration = 60

/**
 * POST /api/content/briefs/[id]/assemble
 *
 * Manually triggers the Bragi assembly step that turns the structured brief
 * (outline + FAQ + target keywords) into a full publish-ready markdown article
 * body, written to seo_content_briefs.final_content.
 *
 * This is auto-triggered after Tyr passes a brief; this endpoint exists for
 * (a) manual re-runs from the brief detail page, and (b) recovery for briefs
 * generated before the assembly feature shipped (no final_content yet).
 *
 * Returns immediately with `{ ok: true }` and runs assembly in after() so
 * Vercel doesn't time out on a 30-45s Claude call.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const db     = createServiceClient()

  // Two valid auth paths:
  //   (1) CRON_SECRET bearer — used by the internal fire-and-forget call from
  //       generateAgentBrief after Tyr passes. Skips user-session lookup so
  //       it works from a child lambda that has no cookie.
  //   (2) Logged-in user with workspace access — the manual "Generate Final
  //       Content" button on the brief detail page.
  const authHeader = request.headers.get('authorization') ?? ''
  const isInternal = authHeader.startsWith('Bearer ')
                  && process.env.CRON_SECRET
                  && authHeader.slice(7) === process.env.CRON_SECRET

  let ownerId: string

  if (isInternal) {
    const { data: briefMeta } = await db
      .from('seo_content_briefs')
      .select('owner_user_id')
      .eq('id', id)
      .maybeSingle()
    if (!briefMeta) return NextResponse.json({ error: 'Brief not found' }, { status: 404 })
    ownerId = String(briefMeta.owner_user_id)
  } else {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: briefMeta } = await db
      .from('seo_content_briefs')
      .select('owner_user_id, final_content')
      .eq('id', id)
      .maybeSingle()
    if (!briefMeta) return NextResponse.json({ error: 'Brief not found' }, { status: 404 })

    ownerId = String(briefMeta.owner_user_id)
    const allowed = await canAccessOwnerData(supabase, user.id, ownerId)
    if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Mark assembly in flight so the UI can show a "generating final content" state.
  // We set final_content_generated_at to NULL → updated_at = now to indicate work is starting.
  await db
    .from('seo_content_briefs')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id)

  after(async () => {
    try {
      const result = await assembleFullArticle(id, ownerId)
      if (!result.ok) {
        console.error(`[assemble] brief ${id} assembly failed:`, result.reason)
      }
    } catch (err) {
      console.error(`[assemble] brief ${id} unexpected error:`, err)
    }
  })

  return NextResponse.json({ ok: true, briefId: id, queued: true })
}
