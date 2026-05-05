import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { DEFAULT_HTML_FORMAT, type BrandHtmlFormat } from '@/lib/agents/markdown-to-html'

/**
 * GET /api/knowledge-base/brand-format
 *
 * Returns the brand-level HTML output template stored on the brand KB row
 * (knowledge_base_items where category='brand'). Used by FinalContentPanel
 * to render the "HTML" / "Preview" view of a brief's final_content.
 *
 * Falls back to the project default (G2G Quasar classes) when the brand
 * KB row is missing or doesn't have an html_format key. That way new
 * workspaces still get sensible HTML output without configuring anything.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { data: brand } = await db
    .from('knowledge_base_items')
    .select('data')
    .eq('owner_user_id', ownerId)
    .eq('category', 'brand')
    .maybeSingle()

  const brandFormat = (brand?.data as { html_format?: BrandHtmlFormat })?.html_format ?? null

  return NextResponse.json({
    format:   { ...DEFAULT_HTML_FORMAT, ...(brandFormat ?? {}) },
    isCustom: !!brandFormat && Object.keys(brandFormat).length > 0,
  })
}
