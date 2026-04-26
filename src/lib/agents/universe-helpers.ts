import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Soft-enforcement helpers for the keyword universe.
 *
 * Existing agents (Heimdall / Loki / Odin / Bragi / Hermod) call
 * `lookupKeywordInUniverse` before queueing actions. Result is attached as
 * action.data fields:
 *   keyword_map_cluster_id (uuid | null)  — direct match
 *   keyword_map_id         (uuid | null)  — topic match (cluster maybe missing)
 *   outside_universe       (boolean)      — true when no match at all
 *
 * Behaviour stays unchanged when there's no match — agents still queue the
 * action, but the tag lets the queue UI / Saga / Mimir downstream filter
 * "out-of-universe" findings without blocking the flow.
 */

export interface UniverseMatch {
  keyword_map_cluster_id: string | null
  keyword_map_id:         string | null
  topic:                  string | null
  cluster_status:         string | null
  outside_universe:       boolean
}

const NO_MATCH: UniverseMatch = {
  keyword_map_cluster_id: null,
  keyword_map_id:         null,
  topic:                  null,
  cluster_status:         null,
  outside_universe:       true,
}

/**
 * Cheap lookup: exact-match (case-insensitive) keyword against
 * keyword_map_clusters. Falls back to topic-name token match if no exact hit.
 *
 * Returns NO_MATCH on any error — soft enforcement means "don't block, just
 * record what we found".
 */
export async function lookupKeywordInUniverse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  ownerId: string,
  keyword: string
): Promise<UniverseMatch> {
  if (!keyword || !keyword.trim()) return NO_MATCH

  const kw = keyword.toLowerCase().trim()

  // 1. exact cluster match
  try {
    const { data: clusterMatch } = await db
      .from('keyword_map_clusters')
      .select('id, map_id, status')
      .eq('owner_user_id', ownerId)
      .ilike('keyword', kw)
      .limit(1)
      .maybeSingle()

    if (clusterMatch) {
      // Look up the topic name for context
      const { data: mapRow } = await db
        .from('keyword_maps')
        .select('topic')
        .eq('id', clusterMatch.map_id)
        .maybeSingle()
      return {
        keyword_map_cluster_id: clusterMatch.id as string,
        keyword_map_id:         clusterMatch.map_id as string,
        topic:                  (mapRow?.topic as string) ?? null,
        cluster_status:         (clusterMatch.status as string) ?? null,
        outside_universe:       false,
      }
    }
  } catch {
    // fall through to topic match
  }

  // 2. topic match by token overlap (matches "wow gold" → "World of Warcraft" topic)
  // Cheap heuristic: if any word in the keyword appears in the topic or any
  // alias, count as topic match (cluster doesn't exist yet — Saga will propose).
  try {
    const tokens = kw.split(/\s+/).filter(t => t.length >= 3)
    if (tokens.length === 0) return NO_MATCH

    const { data: maps } = await db
      .from('keyword_maps')
      .select('id, topic, topic_slug, aliases')
      .eq('owner_user_id', ownerId)
      .neq('status', 'archived')

    if (!maps?.length) return NO_MATCH

    for (const m of maps as Array<{ id: string; topic: string; topic_slug: string; aliases: string[] | null }>) {
      const candidates = [m.topic.toLowerCase(), m.topic_slug.toLowerCase(), ...((m.aliases ?? []).map(a => a.toLowerCase()))]
      const hit = tokens.some(t => candidates.some(c => c.includes(t)))
      if (hit) {
        return {
          keyword_map_cluster_id: null,
          keyword_map_id:         m.id,
          topic:                  m.topic,
          cluster_status:         null,
          outside_universe:       false,
        }
      }
    }
  } catch {
    // ignore
  }

  return NO_MATCH
}
