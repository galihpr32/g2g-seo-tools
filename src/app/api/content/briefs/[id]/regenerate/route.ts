import { NextResponse, after } from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { canAccessOwnerData }  from '@/lib/workspace'
import { generateAgentBrief }  from '@/lib/agents/brief-generator'

export const maxDuration = 60

/**
 * POST /api/content/briefs/[id]/regenerate
 *
 * Regenerates an existing brief in-place with Tyr's feedback as context.
 * Called from the BriefActionBar when user clicks "Regenerate".
 *
 * Body (optional): { notes: string }  — user's own instructions to Bragi
 *
 * Flow:
 *  1. Load brief + existing tyr_breakdown
 *  2. Reset brief to 'draft' status immediately (fast write, unblocks UI)
 *  3. Fire generateAgentBrief in background with previous_review = tyr_breakdown
 *  4. Return immediately — generation takes ~15-30s and updates the brief async
 *
 * The user sees the brief status flip to 'generating' and can reload when
 * BriefActionBar polls or they navigate back to the brief.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db      = createServiceClient()
  const { id }  = await params

  // Optional user notes
  let userNotes = ''
  try {
    const body = await request.json() as { notes?: string }
    userNotes  = String(body.notes ?? '').slice(0, 1000).trim()
  } catch { /* no body */ }

  // ── Load brief by ID (no owner filter — verify access separately so legacy
  // briefs stamped with writer's user_id still work for the workspace owner) ──
  const { data: brief, error: briefErr } = await db
    .from('seo_content_briefs')
    .select('id, owner_user_id, primary_keyword, page, brief_type, notes, tyr_score, tyr_status, tyr_breakdown, search_volume')
    .eq('id', id)
    .maybeSingle()

  if (briefErr || !brief) {
    return NextResponse.json({ error: 'Brief not found' }, { status: 404 })
  }

  const recordOwnerId = String(brief.owner_user_id)
  const allowed       = await canAccessOwnerData(supabase, user.id, recordOwnerId)
  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const ownerId = recordOwnerId   // generation continues under record's owner

  const keyword   = String(brief.primary_keyword ?? '')
  const pageUrl   = String(brief.page            ?? '')
  const briefType = String(brief.brief_type       ?? 'on_page')

  if (!keyword || !pageUrl) {
    return NextResponse.json({ error: 'Brief is missing keyword or page URL' }, { status: 400 })
  }

  // ── Build previous_review context ────────────────────────────────────────
  // Include Tyr's full breakdown so generateAgentBrief can address weaknesses.
  const previousReview = brief.tyr_breakdown
    ? {
        score:       brief.tyr_score ?? null,
        tyrStatus:   brief.tyr_status ?? null,
        ...(brief.tyr_breakdown as Record<string, unknown>),
      }
    : null

  // Append user notes to brief notes for audit trail
  const newNotes = [
    brief.notes ?? null,
    `[regen ${new Date().toISOString().slice(0, 10)}] User-requested regeneration.`,
    userNotes ? `User notes: ${userNotes}` : null,
    previousReview
      ? `Previous Tyr score: ${previousReview.score ?? '?'}/100 (${brief.tyr_status ?? 'unreviewed'}).`
      : null,
  ].filter(Boolean).join('\n')

  // ── Reset brief to draft so UI shows it's being regenerated ─────────────
  await db
    .from('seo_content_briefs')
    .update({
      status:     'draft',
      notes:      newNotes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)

  // ── Fire regeneration in background (after() keeps lambda alive on Vercel) ──
  after(async () => {
    try {
      await generateAgentBrief({
        briefId:        id,
        ownerId,
        keyword,
        pageUrl,
        briefType,
        searchVolume:   typeof brief.search_volume === 'number' ? brief.search_volume : undefined,
        notes:          userNotes || null,
        previousReview: previousReview as Parameters<typeof generateAgentBrief>[0]['previousReview'],
      })

      // If brief is linked to an opportunity, mark it brief_ready
      const { data: opps } = await db
        .from('seo_opportunities')
        .select('id, status')
        .eq('brief_id', id)
        .eq('owner_user_id', ownerId)
        .limit(1)

      if (opps?.[0] && opps[0].status !== 'brief_ready') {
        await db
          .from('seo_opportunities')
          .update({ status: 'brief_ready', updated_at: new Date().toISOString() })
          .eq('id', opps[0].id)
      }
    } catch (err) {
      console.error('[regenerate] generateAgentBrief failed:', err)
      // Brief stays in 'draft' — user can retry again
    }
  })

  return NextResponse.json({ ok: true, briefId: id })
}
