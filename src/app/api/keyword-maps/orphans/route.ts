import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * GET /api/keyword-maps/orphans?site=g2g
 *
 * Returns "orphan" keywords — keywords surfaced by detection agents
 * (Heimdall, Loki, Odin) and aggregated into seo_opportunities, but NOT
 * yet assigned to any keyword_map cluster.
 *
 * Used by the Gaps tab on /content/keyword-map to show what's missing.
 *
 * Response:
 *   {
 *     orphans: Array<{
 *       opp_id, topic, topic_slug, total_sv, signal_count,
 *       updated_at, output_type, status,
 *       suggested_map_id, suggested_map_topic    // closest existing cluster, if any
 *     }>
 *   }
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const siteSlug = searchParams.get('site') ?? 'g2g'

  // 1. All opportunities for this site (excluding dismissed/published — those
  //    are either rejected or done, not "orphan" anymore).
  const { data: opps, error: oppErr } = await db
    .from('seo_opportunities')
    .select('id, topic, topic_slug, total_sv, signal_count, status, output_type, updated_at')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .in('status', ['new', 'in_review', 'brief_queued', 'brief_ready'])
    .order('total_sv', { ascending: false, nullsFirst: false })
    .limit(200)

  if (oppErr) return NextResponse.json({ error: oppErr.message }, { status: 500 })
  if (!opps?.length) return NextResponse.json({ orphans: [] })

  // 2. All keywords already in clusters for this owner. Lowercase for matching.
  const { data: clusterRows } = await db
    .from('keyword_map_clusters')
    .select('keyword, map_id')
    .eq('owner_user_id', ownerId)

  const claimedKeywords = new Set(
    ((clusterRows ?? []) as Array<{ keyword: string }>).map(r => r.keyword.toLowerCase().trim()),
  )

  // 3. All keyword maps for the suggested-cluster lookup
  const { data: maps } = await db
    .from('keyword_maps')
    .select('id, topic, topic_slug, aliases, market')
    .eq('owner_user_id', ownerId)
    .eq('market', siteSlug === 'g2g' ? 'us' : siteSlug)

  // 4. Diff opps against claimed keywords
  type MapRow = { id: string; topic: string; topic_slug: string; aliases: string[] | null }
  const mapsTyped = (maps ?? []) as MapRow[]

  const orphans = opps
    .filter(o => o.topic && !claimedKeywords.has(o.topic.toLowerCase().trim()))
    .map(o => {
      // Find closest existing cluster by topic_slug overlap or alias match
      const oppTopicLower = (o.topic_slug ?? o.topic ?? '').toLowerCase()
      let suggestedMap: MapRow | null = null
      for (const m of mapsTyped) {
        const mapTopicLower = (m.topic_slug ?? m.topic ?? '').toLowerCase()
        if (mapTopicLower && oppTopicLower.includes(mapTopicLower)) {
          suggestedMap = m
          break
        }
        // Alias match
        const aliases = (m.aliases ?? []).map(a => String(a).toLowerCase())
        if (aliases.some(a => oppTopicLower.includes(a))) {
          suggestedMap = m
          break
        }
      }

      return {
        opp_id:              o.id,
        topic:               o.topic,
        topic_slug:          o.topic_slug,
        total_sv:            o.total_sv,
        signal_count:        o.signal_count,
        status:              o.status,
        output_type:         o.output_type,
        updated_at:          o.updated_at,
        suggested_map_id:    suggestedMap?.id    ?? null,
        suggested_map_topic: suggestedMap?.topic ?? null,
      }
    })

  return NextResponse.json({
    orphans,
    summary: {
      total_opportunities: opps.length,
      claimed_count:       opps.length - orphans.length,
      orphan_count:        orphans.length,
    },
  })
}
