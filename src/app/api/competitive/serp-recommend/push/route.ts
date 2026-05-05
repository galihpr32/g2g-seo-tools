import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 30

/**
 * POST /api/competitive/serp-recommend/push
 *
 * Promotes a single idea from a serp_recommendations run into the brief
 * pipeline. Creates a seo_opportunity (so it shows in Pipeline Journey ready
 * for triage) plus an agent_action stamped with `agent_key='loki'` and
 * `data.source='serp_recommend_manual'` so reports can attribute it back.
 *
 * Body:
 *   {
 *     recommendation_id: string,    // serp_recommendations.id
 *     idea_id:           string,    // ContentIdea.id (from the response)
 *     primary_keyword:   string,    // user-confirmed keyword
 *     target_url?:       string,    // optional URL override
 *     suggested_brief_type: string, // optimize_existing | new_page | category_page | blog_post
 *   }
 *
 * Returns: { ok, opp_id, idea_id }
 */

interface IdeaRecord {
  id:                   string
  type:                 string
  title:                string
  body:                 string
  target_keyword:       string
  target_url:           string | null
  suggested_brief_type: string
  evidence:             string
}

const VALID_BRIEF_TYPES = new Set(['optimize_existing', 'new_page', 'category_page', 'blog_post'])

function briefTypeForOutput(outputType: string): string {
  if (outputType === 'optimize_existing') return 'on_page'
  if (outputType === 'new_page')          return 'category_page'
  if (outputType === 'category_page')     return 'category_page'
  if (outputType === 'blog_post')         return 'blog_post'
  return 'on_page'
}

function topicSlug(keyword: string): string {
  return keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await request.json().catch(() => ({})) as {
    recommendation_id?:    string
    idea_id?:              string
    primary_keyword?:      string
    target_url?:           string | null
    suggested_brief_type?: string
  }

  const {
    recommendation_id, idea_id,
    primary_keyword, target_url, suggested_brief_type,
  } = body

  if (!recommendation_id || !idea_id) {
    return NextResponse.json({ error: 'recommendation_id + idea_id required' }, { status: 400 })
  }
  if (!primary_keyword?.trim()) {
    return NextResponse.json({ error: 'primary_keyword required' }, { status: 400 })
  }
  if (!suggested_brief_type || !VALID_BRIEF_TYPES.has(suggested_brief_type)) {
    return NextResponse.json({
      error: `suggested_brief_type must be one of: ${[...VALID_BRIEF_TYPES].join(', ')}`,
    }, { status: 400 })
  }

  // ── Load the recommendation row to verify ownership + grab the idea ──────
  const { data: recRow } = await db
    .from('serp_recommendations')
    .select('id, owner_user_id, snapshot_date, ideas, pushed_links, model')
    .eq('id', recommendation_id)
    .maybeSingle()

  if (!recRow) {
    return NextResponse.json({ error: 'Recommendation run not found' }, { status: 404 })
  }
  if (recRow.owner_user_id !== ownerId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const ideas = (recRow.ideas ?? []) as IdeaRecord[]
  const idea  = ideas.find(i => i.id === idea_id)
  if (!idea) {
    return NextResponse.json({ error: `Idea ${idea_id} not found in recommendation ${recommendation_id}` }, { status: 404 })
  }

  // Refuse to push the same idea twice — keeps Pipeline Journey clean.
  const pushedLinks = (recRow.pushed_links ?? []) as Array<{ idea_id: string; opp_id: string; pushed_at: string }>
  if (pushedLinks.some(l => l.idea_id === idea_id)) {
    return NextResponse.json({
      error: 'This idea has already been pushed to the pipeline. Look it up in Pipeline Journey.',
      already_pushed: true,
    }, { status: 409 })
  }

  // ── Create the seo_opportunity row ────────────────────────────────────────
  // Pipeline Journey treats it as an aggregated opp ready for triage.
  // The `notes` carries the idea body + evidence so writers see WHY this opp
  // exists when they expand the card.
  const topic     = primary_keyword.trim()
  const slug      = topicSlug(topic)
  // Future-use: append richer notes onto seo_opportunities once that column
  // exists. For now the Loki signals JSON below carries the rationale.

  const { data: opp, error: oppErr } = await db
    .from('seo_opportunities')
    .insert({
      owner_user_id:    ownerId,
      site_slug:        'g2g',                      // single-site for now
      topic,
      topic_slug:       slug,
      target_url:       target_url ?? idea.target_url ?? null,
      status:           'new',
      output_type:      suggested_brief_type,
      total_sv:         null,                        // SV unknown at idea-stage
      signal_count:     1,
      // Stamp loki signals[] with one synthetic entry so the Pipeline Journey
      // "Why this opp" section renders the source nicely.
      heimdall_signals: [],
      loki_signals:     [{
        action_id:         null,
        agent_key:         'loki',
        created_at:        new Date().toISOString(),
        keyword:           topic,
        search_volume:     null,
        competitor_domain: 'serp_recommend',
        competitor_position: null,
        our_position:        null,
        source:            'serp_recommend_manual',
        idea_type:         idea.type,
        recommendation_id: recRow.id,
        idea_evidence:     idea.evidence.slice(0, 200),
      }],
      odin_signals: [],
      created_at:   new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
    .select('id')
    .single()

  if (oppErr || !opp) {
    return NextResponse.json({
      error: `Failed to create opportunity: ${oppErr?.message ?? 'unknown'}`,
    }, { status: 500 })
  }

  // ── Optional: create an agent_action row so the action_items / notifications
  // counter increments (consistent with how Loki cron creates these). ──────
  await db.from('agent_actions').insert({
    owner_user_id: ownerId,
    agent_key:     'loki',
    site_slug:     'g2g',
    action_type:   'add_action_item',
    title:         `[SERP idea] ${idea.title.slice(0, 100)}`,
    description:   `${idea.body}\n\nEvidence: ${idea.evidence}\n\n(via SERP recommend, manual push)`,
    priority:      'medium',
    data: {
      source:            'serp_recommend_manual',
      recommendation_id: recRow.id,
      idea_id,
      idea_type:         idea.type,
      keyword:           topic,
      page_url:          target_url ?? idea.target_url ?? null,
      brief_type:        briefTypeForOutput(suggested_brief_type),
      opp_id:            opp.id,
    },
  })

  // ── Update pushed_links so we don't push the same idea twice ─────────────
  const newPushedLinks = [
    ...pushedLinks,
    { idea_id, opp_id: opp.id, pushed_at: new Date().toISOString() },
  ]
  await db
    .from('serp_recommendations')
    .update({ pushed_links: newPushedLinks })
    .eq('id', recRow.id)

  return NextResponse.json({
    ok:      true,
    opp_id:  opp.id,
    idea_id,
    pipeline_url: `/command-center/pipeline?focus=${opp.id}`,
  })
}
