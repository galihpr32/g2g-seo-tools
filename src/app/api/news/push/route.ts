import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * POST /api/news/push
 * Body:
 *   {
 *     game_name: string,
 *     game_name_norm: string,
 *     article_count: number,
 *     dominant_news_type?: string,
 *     suggested_brief_type?: 'optimize_existing' | 'new_page' | 'category_page' | 'blog_post',
 *     latest_titles?: string[],
 *   }
 *
 * Manually pushes a "news buzz" signal into the brief pipeline. Same pattern
 * as the SERP-recommend push: creates a seo_opportunity (so it shows in
 * Pipeline Journey for triage) plus an agent_action stamped with
 * `agent_key='odin'` and `data.source='bifrost_manual'`.
 */

const VALID_BRIEF_TYPES = new Set(['optimize_existing', 'new_page', 'category_page', 'blog_post'])

function topicSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await request.json().catch(() => ({})) as {
    game_name?: string; game_name_norm?: string; article_count?: number
    dominant_news_type?: string; suggested_brief_type?: string; latest_titles?: string[]
  }

  const game_name = body.game_name?.trim()
  if (!game_name) return NextResponse.json({ error: 'game_name required' }, { status: 400 })

  const briefType = body.suggested_brief_type ?? 'category_page'
  if (!VALID_BRIEF_TYPES.has(briefType)) {
    return NextResponse.json({ error: `suggested_brief_type must be one of: ${[...VALID_BRIEF_TYPES].join(', ')}` }, { status: 400 })
  }

  const slug          = topicSlug(game_name)
  const articleCount  = Math.max(1, Math.floor(body.article_count ?? 1))
  const dominantType  = body.dominant_news_type ?? 'other'
  const latestTitles  = (body.latest_titles ?? []).slice(0, 3)

  // Refuse duplicate: if there's an active (non-dismissed) opp with same slug
  // queued via Bifrost in last 7 days, don't double-create.
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString()
  const { data: existing } = await db
    .from('seo_opportunities')
    .select('id, status, updated_at')
    .eq('owner_user_id', ownerId)
    .eq('topic_slug', slug)
    .neq('status', 'dismissed')
    .gte('updated_at', cutoff)
    .limit(1)
  if (existing && existing.length > 0) {
    return NextResponse.json({
      error:           'A recent opportunity for this game already exists (within last 7 days). Open Pipeline Journey to find it.',
      existing_opp_id: existing[0].id,
    }, { status: 409 })
  }

  // Create opportunity
  const { data: opp, error: oppErr } = await db
    .from('seo_opportunities')
    .insert({
      owner_user_id:   ownerId,
      site_slug:       'g2g',
      topic:           game_name,
      topic_slug:      slug,
      target_url:      null,
      status:          'new',
      output_type:     briefType,
      total_sv:        null,
      signal_count:    articleCount,
      heimdall_signals: [],
      loki_signals:     [],
      // Stamp odin signal with bifrost source + news type breakdown
      odin_signals: [{
        action_id:     null,
        agent_key:     'odin',
        created_at:    new Date().toISOString(),
        game_name,
        search_volume: null,
        trend_basis:   `bifrost_news (${articleCount} articles in 7d)`,
        trend_score:   articleCount * 10,
        source:        'bifrost_manual',
        news_type:     dominantType,
        latest_titles: latestTitles,
      }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (oppErr || !opp) {
    return NextResponse.json({ error: `Failed to create opportunity: ${oppErr?.message ?? 'unknown'}` }, { status: 500 })
  }

  // Companion agent_action (so notifications + action_items pick it up)
  await db.from('agent_actions').insert({
    owner_user_id: ownerId,
    agent_key:     'odin',
    site_slug:     'g2g',
    action_type:   'add_action_item',
    title:         `📰 News buzz: ${game_name} — ${articleCount} articles in 7d`,
    description:   `Bifrost detected ${articleCount} articles about ${game_name} (dominant type: ${dominantType}). ${latestTitles.length > 0 ? `Recent: ${latestTitles.slice(0, 2).join(' · ')}` : ''}`,
    priority:      articleCount >= 5 ? 'high' : 'medium',
    data: {
      source:         'bifrost_manual',
      game_name,
      game_name_norm: body.game_name_norm ?? slug,
      article_count:  articleCount,
      news_type:      dominantType,
      brief_type:     briefType,
      opp_id:         opp.id,
      handoff_to:     'bragi',
      payload: {
        keyword:       game_name.toLowerCase(),
        page_url:      null,
        search_volume: null,
        source_agent:  'bifrost',
        brief_type:    briefType === 'optimize_existing' ? 'on_page' : briefType,
        context:       `Bifrost manual push: ${articleCount} articles in 7d, dominant news type: ${dominantType}`,
      },
    },
  })

  return NextResponse.json({
    ok:           true,
    opp_id:       opp.id,
    pipeline_url: `/command-center/pipeline?focus=${opp.id}`,
  })
}
