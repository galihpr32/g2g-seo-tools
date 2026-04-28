import { NextResponse }        from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { generateAgentBrief }  from '@/lib/agents/brief-generator'

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

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()
  const { id }  = await params

  // Optional user notes
  let userNotes = ''
  try {
    const body = await request.json() as { notes?: string }
    userNotes  = String(body.notes ?? '').slice(0, 1000).trim()
  } catch { /* no body */ }

  // ── Load brief ───────────────────────────────────────────────────────────
  const { data: brief, error: briefErr } = await db
    .from('seo_content_briefs')
    .select('id, owner_user_id, primary_keyword, page, brief_type, notes, tyr_score, tyr_status, tyr_breakdown, search_volume')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .single()

  if (briefErr || !brief) {
    return NextResponse.json({ error: 'Brief not found' }, { status: 404 })
  }

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

  // ── Fire regeneration in background ─────────────────────────────────────
  generateAgentBrief({
    briefId:        id,
    ownerId,
    keyword,
    pageUrl,
    briefType,
    searchVolume:   typeof brief.search_volume === 'number' ? brief.search_volume : undefined,
    notes:          userNotes || null,
    previousReview: previousReview as Parameters<typeof generateAgentBrief>[0]['previousReview'],
  }).catch(err => {
    console.error('[regenerate] generateAgentBrief failed:', err)
    // Brief stays in 'draft' — user can retry
  })

  return NextResponse.json({ ok: true, briefId: id })
}
