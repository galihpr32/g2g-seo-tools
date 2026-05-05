import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { canAccessOwnerData } from '@/lib/workspace'

/**
 * GET /api/content/briefs/[id]
 *
 * Fetch a single brief's full content. Used by the Pipeline Journey inline
 * viewer so the user doesn't need to navigate away to read the brief.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const db = createServiceClient()

  const { data: brief, error } = await db
    .from('seo_content_briefs')
    .select(`
      id, owner_user_id, page, brief_type, primary_keyword, status,
      tyr_score, tyr_status,
      content_outline, content_draft, faq_suggestions, new_keywords,
      final_content, final_content_generated_at, final_content_edited_at,
      final_content_translations,
      published_at, published_by, target_publish_date,
      notes, created_at, updated_at
    `)
    .eq('id', id)
    .maybeSingle()

  if (error || !brief) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const allowed = await canAccessOwnerData(supabase, user.id, String(brief.owner_user_id))
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  return NextResponse.json({ brief })
}

/**
 * PATCH /api/content/briefs/[id]
 *
 * Lightweight brief update endpoint — currently used by the Brief Library
 * page to flip status to 'published' (the only field exposed for now).
 * Restricted to whitelisted fields to avoid accidental writes; expand the
 * `ALLOWED` set as needed.
 */

const ALLOWED_STATUSES = new Set(['draft', 'agent_generated', 'reviewed', 'published'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null) as {
    status?: string
    target_publish_date?: string | null
    notes?: string
    assigned_to?: string | null
    final_content?: string             // inline-edit the assembled article body
    final_content_translations?: Record<string, string>  // inline-edit a specific lang translation
    // For outreach briefs, new_keywords[] stores anchor text variations.
    // Writers tweak this list directly from the brief detail page.
    new_keywords?: Array<{ keyword: string; volume?: number | null }>
  } | null
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  // Resolve effective owner via the brief itself (handles legacy ownership rows)
  const dbAuth = createServiceClient()
  const { data: briefMeta } = await dbAuth
    .from('seo_content_briefs')
    .select('owner_user_id')
    .eq('id', id)
    .maybeSingle()
  if (!briefMeta) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const ownerId = String(briefMeta.owner_user_id)
  const allowed = await canAccessOwnerData(supabase, user.id, ownerId)
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const nowIso = new Date().toISOString()
  const update: Record<string, unknown> = {}

  if (body.status) {
    if (!ALLOWED_STATUSES.has(body.status)) {
      return NextResponse.json({ error: `status must be one of ${[...ALLOWED_STATUSES].join(', ')}` }, { status: 400 })
    }
    update.status = body.status

    // When the user transitions a brief to 'published', capture WHO did it.
    // published_at + published_by feed /team-performance reporting.
    if (body.status === 'published') {
      update.published_by = user.id
      update.published_at = nowIso
    }

    // When un-publishing (writer pressed "Mark unpublished" on a published brief),
    // clear the published_* attribution so /team-performance and /reports/ranking-impact
    // don't keep counting it as a live publication.
    if (body.status === 'reviewed' || body.status === 'draft') {
      update.published_by = null
      update.published_at = null
    }
  }

  // Allow setting or clearing target_publish_date (null clears it)
  if ('target_publish_date' in body) {
    if (body.target_publish_date !== null && !DATE_RE.test(body.target_publish_date ?? '')) {
      return NextResponse.json({ error: 'target_publish_date must be YYYY-MM-DD or null' }, { status: 400 })
    }
    update.target_publish_date = body.target_publish_date ?? null
  }

  // Inline-edit the assembled article body (writer's manual revision).
  // Capping at 100k chars guards against accidental paste-of-an-entire-PDF.
  if (typeof body.final_content === 'string') {
    update.final_content          = body.final_content.slice(0, 100_000)
    update.final_content_edited_at = nowIso
  }

  // Outreach: update the anchor-text list. Sanitise to enforce shape +
  // dedupe + cap at 20 entries to prevent abuse.
  if (Array.isArray(body.new_keywords)) {
    const cleaned: Array<{ keyword: string; volume: number | null }> = []
    const seen = new Set<string>()
    for (const item of body.new_keywords.slice(0, 20)) {
      const kw = String(item?.keyword ?? '').trim().slice(0, 200)
      if (!kw) continue
      const norm = kw.toLowerCase()
      if (seen.has(norm)) continue
      seen.add(norm)
      cleaned.push({ keyword: kw, volume: typeof item?.volume === 'number' ? item.volume : null })
    }
    update.new_keywords = cleaned
  }

  // Inline-edit a specific translation. Body shape: { final_content_translations: { id: '...' } }
  // Merges with existing translations (doesn't blow away other languages).
  if (body.final_content_translations && typeof body.final_content_translations === 'object') {
    const dbCur = createServiceClient()
    const { data: row } = await dbCur
      .from('seo_content_briefs')
      .select('final_content_translations')
      .eq('id', id)
      .maybeSingle()
    const existing = (row?.final_content_translations ?? {}) as Record<string, string>
    const incoming = Object.fromEntries(
      Object.entries(body.final_content_translations).map(([k, v]) => [k, String(v ?? '').slice(0, 100_000)]),
    )
    update.final_content_translations = { ...existing, ...incoming }
  }

  // Writer assignment — pass null to unassign, uuid to assign.
  if ('assigned_to' in body) {
    update.assigned_to = body.assigned_to ?? null
    update.assigned_at = body.assigned_to ? nowIso : null
  }

  if (typeof body.notes === 'string') {
    update.notes = body.notes.slice(0, 2000)
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const db = createServiceClient()
  const { error } = await db
    .from('seo_content_briefs')
    .update(update)
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })


  // When a brief is published, automatically seed a brief_outcomes row so
  // the ranking impact tracker can start capturing GSC snapshots.
  // Fire-and-forget — don't let this block the response.
  if (update.status === 'published') {
    fetch(`${req.headers.get('origin') ?? ''}/api/brief-outcomes`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', cookie: req.headers.get('cookie') ?? '' },
      body:    JSON.stringify({ brief_id: id }),
    }).catch(() => { /* silent — outcome seeding is best-effort */ })
  }

  return NextResponse.json({ ok: true })
}

/**
 * DELETE /api/content/briefs/[id]
 *
 * Hard-deletes a brief. Also cleans up brief_outcomes rows to avoid
 * orphaned ranking tracker entries.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const db = createServiceClient()

  // Resolve ownership via the brief itself (legacy briefs sometimes carry the
  // writer's user_id in owner_user_id rather than the workspace owner's).
  const { data: briefMeta } = await db
    .from('seo_content_briefs')
    .select('owner_user_id')
    .eq('id', id)
    .maybeSingle()
  if (!briefMeta) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const ownerId = String(briefMeta.owner_user_id)
  const allowed = await canAccessOwnerData(supabase, user.id, ownerId)
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Clean up brief_outcomes first (FK)
  await db.from('brief_outcomes').delete().eq('brief_id', id).eq('owner_user_id', ownerId)

  // Also unlink from any seo_opportunities
  await db
    .from('seo_opportunities')
    .update({ brief_id: null, status: 'new', updated_at: new Date().toISOString() })
    .eq('brief_id', id)
    .eq('owner_user_id', ownerId)

  const { error } = await db
    .from('seo_content_briefs')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
