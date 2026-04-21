import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { CATEGORY_TEMPLATES } from '@/lib/g2g-category-prompts'

function categoryKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

// GET /api/knowledge-base/prompts
// Returns DB prompts for owner, falling back to TS defaults for any missing category
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { data: dbPrompts } = await db
    .from('category_prompts')
    .select('*')
    .eq('owner_user_id', ownerId)
    .order('category_key')

  const dbMap = new Map((dbPrompts ?? []).map(p => [p.category_key, p]))

  // Merge DB overrides with TS defaults
  const prompts = CATEGORY_TEMPLATES.map(t => {
    const key = categoryKey(t.category)
    const db  = dbMap.get(key)
    return {
      id:                    db?.id ?? null,
      category_key:          key,
      category_name:         db?.category_name          ?? t.category,
      icon:                  db?.icon                   ?? t.icon,
      url_patterns:          db?.url_patterns           ?? t.urlPatterns,
      h1_template:           db?.h1_template            ?? t.h1Template,
      meta_title_template:   db?.meta_title_template    ?? t.metaTitleTemplate,
      meta_description_guide: db?.meta_description_guide ?? t.metaDescriptionGuide,
      keyword_rules:         db?.keyword_rules          ?? t.keywordRules,
      writing_rules:         db?.writing_rules          ?? t.writingRules,
      faq_focus:             db?.faq_focus              ?? t.faqFocus,
      sections:              db?.sections               ?? t.sections,
      is_active:             db?.is_active              ?? true,
      is_customized:         !!db,   // flag so UI can show "Customized" badge
    }
  })

  return NextResponse.json({ prompts })
}

// POST /api/knowledge-base/prompts — upsert a single category prompt
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    category_key:           string
    category_name:          string
    icon?:                  string
    url_patterns?:          string[]
    h1_template?:           string
    meta_title_template?:   string
    meta_description_guide?: string
    keyword_rules?:         string
    writing_rules?:         string
    faq_focus?:             string
    sections?:              { subheading: string; instructions: string }[]
    is_active?:             boolean
  }

  if (!body.category_key) return NextResponse.json({ error: 'category_key required' }, { status: 400 })

  const { data, error } = await db
    .from('category_prompts')
    .upsert({
      owner_user_id:         ownerId,
      category_key:          body.category_key,
      category_name:         body.category_name,
      icon:                  body.icon                   ?? null,
      url_patterns:          body.url_patterns           ?? null,
      h1_template:           body.h1_template            ?? null,
      meta_title_template:   body.meta_title_template    ?? null,
      meta_description_guide: body.meta_description_guide ?? null,
      keyword_rules:         body.keyword_rules          ?? null,
      writing_rules:         body.writing_rules          ?? null,
      faq_focus:             body.faq_focus              ?? null,
      sections:              body.sections               ?? null,
      is_active:             body.is_active              ?? true,
      updated_at:            new Date().toISOString(),
    }, { onConflict: 'owner_user_id,category_key' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ prompt: data })
}

// DELETE /api/knowledge-base/prompts?category_key=... — reset to default (delete DB override)
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const key = new URL(req.url).searchParams.get('category_key')
  if (!key) return NextResponse.json({ error: 'category_key required' }, { status: 400 })

  await db
    .from('category_prompts')
    .delete()
    .eq('owner_user_id', ownerId)
    .eq('category_key', key)

  return NextResponse.json({ ok: true })
}
