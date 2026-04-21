import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getKeywordSuggestions } from '@/lib/dataforseo/client'

export const maxDuration = 30

// ── GET /api/brief/keywords?action_item_id=... ────────────────────────────────
// Fetches keyword candidates for an action item WITHOUT creating a brief.
// Returns: GSC queries + DataForSEO suggestions + SERP-related searches.
// Used by the pre-generation keyword selector in BriefViewer.
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const url = new URL(request.url)
  const actionItemId = url.searchParams.get('action_item_id')
  if (!actionItemId) return NextResponse.json({ error: 'Missing action_item_id' }, { status: 400 })

  // Load the action item
  const { data: item } = await db
    .from('seo_action_items')
    .select('page')
    .eq('id', actionItemId)
    .single()
  if (!item) return NextResponse.json({ error: 'Action item not found' }, { status: 404 })

  // Load GSC connection
  const { data: conn } = await db
    .from('gsc_connections')
    .select('site_url')
    .eq('user_id', ownerId)
    .single()

  // Load GSC queries for this page
  const { data: gscQueries } = conn?.site_url
    ? await db
        .from('gsc_ranking_drop_queries')
        .select('query, clicks, impressions, ctr, position')
        .eq('site_url', conn.site_url)
        .eq('page', item.page)
        .order('clicks', { ascending: false })
        .limit(15)
    : { data: [] }

  const topQueries = (gscQueries ?? []).map((q: { query: string }) => q.query)
  const primaryKeyword = topQueries[0] ?? deriveTopicFromUrl(item.page)

  // Fetch keyword suggestions from DataForSEO
  let suggestions: Array<{ keyword: string; search_volume: number | null; cpc: number | null }> = []
  try {
    suggestions = (await getKeywordSuggestions(primaryKeyword)).slice(0, 25)
  } catch { /* non-fatal — return what we have */ }

  return NextResponse.json({
    primary_keyword: primaryKeyword,
    gsc_queries: (gscQueries ?? []).map((q: {
      query: string; clicks: number; impressions: number; ctr: number; position: number
    }) => ({
      keyword: q.query,
      clicks: q.clicks,
      position: q.position,
      source: 'gsc' as const,
    })),
    suggestions: suggestions.map(s => ({
      keyword: s.keyword,
      search_volume: s.search_volume,
      cpc: s.cpc,
      source: 'dataforseo' as const,
    })),
  })
}

function deriveTopicFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    const slug = path.split('/').filter(Boolean).pop() ?? ''
    return slug.replace(/-/g, ' ').replace(/_/g, ' ')
  } catch { return '' }
}
