import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 60

// ── POST /api/dmca/scan ───────────────────────────────────────────────────────
// Scans all published briefs' content_draft for active DMCA terms.
// Upserts hits into dmca_hits; marks existing hits as resolved if term no
// longer appears in the content.
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  // 1. Load all active DMCA terms for this owner
  const { data: terms, error: termsErr } = await supabase
    .from('dmca_terms')
    .select('id, original_term')
    .eq('owner_user_id', ownerId)
    .eq('active', true)

  if (termsErr) return NextResponse.json({ error: termsErr.message }, { status: 500 })
  if (!terms || terms.length === 0) {
    return NextResponse.json({ scanned: 0, hits: 0, resolved: 0 })
  }

  // 2. Load all published briefs with content
  const { data: briefs, error: briefsErr } = await supabase
    .from('seo_content_briefs')
    .select('id, content_draft')
    .eq('owner_user_id', ownerId)
    .eq('status', 'published')
    .not('content_draft', 'is', null)

  if (briefsErr) return NextResponse.json({ error: briefsErr.message }, { status: 500 })
  if (!briefs || briefs.length === 0) {
    return NextResponse.json({ scanned: 0, hits: 0, resolved: 0 })
  }

  let hitsCreated = 0
  let hitsResolved = 0

  // 3. For each brief, check each term
  for (const brief of briefs) {
    const content = (brief.content_draft ?? '').toLowerCase()

    for (const term of terms) {
      const termLower = term.original_term.toLowerCase()
      const found = content.includes(termLower)

      if (found) {
        // Upsert a hit (ignore if already exists)
        const { error: upsertErr } = await supabase
          .from('dmca_hits')
          .upsert({
            owner_user_id: ownerId,
            brief_id:      brief.id,
            dmca_term_id:  term.id,
            resolved:      false,
          }, {
            onConflict:        'brief_id,dmca_term_id',
            ignoreDuplicates:  true,
          })

        if (!upsertErr) hitsCreated++
      } else {
        // Term no longer present — mark existing hit as resolved if not already
        const { data: existing } = await supabase
          .from('dmca_hits')
          .select('id, resolved')
          .eq('brief_id', brief.id)
          .eq('dmca_term_id', term.id)
          .eq('resolved', false)
          .maybeSingle()

        if (existing) {
          await supabase
            .from('dmca_hits')
            .update({ resolved: true, resolved_at: new Date().toISOString() })
            .eq('id', existing.id)
          hitsResolved++
        }
      }
    }
  }

  return NextResponse.json({
    scanned:  briefs.length,
    terms:    terms.length,
    hits:     hitsCreated,
    resolved: hitsResolved,
  })
}

// ── GET /api/dmca/scan — fetch current unresolved hits ────────────────────────
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { data, error } = await supabase
    .from('dmca_hits')
    .select(`
      id,
      detected_at,
      resolved,
      resolved_at,
      dmca_terms!inner ( id, original_term, replacement_term ),
      seo_content_briefs!inner ( id, page_url, title )
    `)
    .eq('owner_user_id', ownerId)
    .eq('resolved', false)
    .order('detected_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ hits: data ?? [] })
}
