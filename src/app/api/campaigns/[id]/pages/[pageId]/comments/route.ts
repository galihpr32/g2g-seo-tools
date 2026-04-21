import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

type Params = { params: Promise<{ id: string; pageId: string }> }

// ── GET /api/campaigns/[id]/pages/[pageId]/comments ───────────────────────────
export async function GET(_request: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const { pageId } = await params

  const { data, error } = await db
    .from('campaign_page_comments')
    .select('id, author_email, content, created_at')
    .eq('campaign_page_id', pageId)
    .eq('owner_user_id', ownerId)
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ comments: data ?? [] })
}

// ── POST /api/campaigns/[id]/pages/[pageId]/comments ─────────────────────────
// Body: { content: string }
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const { id: campaignId, pageId } = await params

  const { content } = await request.json() as { content: string }
  if (!content?.trim()) {
    return NextResponse.json({ error: 'Comment cannot be empty' }, { status: 400 })
  }

  // Verify page belongs to this campaign + owner
  const { data: page } = await db
    .from('campaign_pages')
    .select('id')
    .eq('id', pageId)
    .eq('campaign_id', campaignId)
    .eq('owner_user_id', ownerId)
    .single()

  if (!page) return NextResponse.json({ error: 'Page not found' }, { status: 404 })

  const { data: comment, error } = await db
    .from('campaign_page_comments')
    .insert({
      campaign_page_id: pageId,
      owner_user_id:    ownerId,
      author_email:     user.email ?? 'unknown',
      content:          content.trim(),
    })
    .select('id, author_email, content, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ comment })
}
