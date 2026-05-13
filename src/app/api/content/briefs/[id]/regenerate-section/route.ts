import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { regenerateSection, type RegenSection } from '@/lib/agents/section-regen'

export const maxDuration = 60

/**
 * POST /api/content/briefs/[id]/regenerate-section
 * Body: { section: 'outline' | 'faq' | 'meta' | 'keywords', notes?: string }
 *
 * Targeted regeneration of a single brief section. Cheaper + faster than
 * full regenerate. Triggered by the Tyr auto-suggest UI when only one
 * dimension is weak.
 *
 * On success: updates the brief field directly + clears Tyr score (so the
 * user must re-run Tyr after the partial change).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body   = await request.json().catch(() => ({}))
  const { section, notes } = body

  const allowed: RegenSection[] = ['outline', 'faq', 'meta', 'keywords']
  if (!allowed.includes(section)) {
    return NextResponse.json({ error: `section must be one of ${allowed.join(', ')}` }, { status: 400 })
  }

  const db = createServiceClient()
  const result = await regenerateSection({
    db,
    briefId:   id,
    section:   section as RegenSection,
    userNotes: typeof notes === 'string' ? notes.slice(0, 1000) : '',
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({
    ok:           true,
    section,
    updatedField: result.updatedField,
    newValue:     result.newValue,
  })
}
