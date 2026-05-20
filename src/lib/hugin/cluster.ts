// ─── Hugin clustering ───────────────────────────────────────────────────────
//
// User selects N queries in /hugin UI → backend groups them into (brand,
// sub_product) clusters using Haiku semantic classification. Returns groups
// the user can claim wholesale.
//
// Why slim implementation vs reusing Saga's runClusterBuilder:
//   • Saga is end-to-end: scans agent_actions, persists clusters, manages
//     lifecycle. Overkill for an ad-hoc "group these 20 queries" request.
//   • We just need: given a list of strings, return list of groups with a
//     suggested representative + product label.
//   • Same Haiku prompt pattern as Saga, just stateless.

import Anthropic from '@anthropic-ai/sdk'
import { logClaudeUsage } from '@/lib/api-logger'
import type { SupabaseClient } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = 'claude-haiku-4-5-20251001'

export interface ClusterInput {
  query:                     string
  total_impressions:         number
  auto_matched_product_name?: string | null
}

export interface ClusterGroup {
  cluster_id:           string       // synthetic, e.g. 'cluster_1'
  brand:                string       // e.g. "Genshin Impact"
  sub_product:          string       // e.g. "Account" or "Top-up"
  representative_query: string       // the query best capturing the cluster intent
  members:              string[]     // queries in this cluster
  total_impressions:    number       // sum across members
}

export interface ClusterResult {
  ok:          boolean
  groups:      ClusterGroup[]
  unclustered: string[]              // queries that didn't fit any group
  duration_ms: number
  error?:      string
}

const CLUSTER_TOOL = {
  name: 'submit_clusters',
  description: 'Submit semantic clusters of the input queries. Group by (brand, sub_product).',
  input_schema: {
    type: 'object' as const,
    required: ['clusters'],
    properties: {
      clusters: {
        type:        'array',
        description: 'Each cluster groups queries with shared brand + sub-product intent.',
        items: {
          type:     'object',
          required: ['brand', 'sub_product', 'representative_query', 'members'],
          properties: {
            brand: {
              type:        'string',
              description: 'Product/brand the queries are about (e.g. "Genshin Impact", "Valorant"). Use "Unknown" if unclear.',
            },
            sub_product: {
              type:        'string',
              description: 'Sub-product category: "Account", "Top-up", "Items", "Gold/Currency", "Boosting", "Skins/Cosmetics", "Battle Pass", or "Other".',
            },
            representative_query: {
              type:        'string',
              description: 'The single query in the cluster that best captures the shared intent.',
            },
            members: {
              type:        'array',
              description: 'All queries belonging to this cluster, including the representative.',
              items:       { type: 'string' },
            },
          },
        },
      },
    },
  },
}

export async function clusterQueries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  inputs:   ClusterInput[],
): Promise<ClusterResult> {
  const start = Date.now()

  if (inputs.length === 0) {
    return { ok: true, groups: [], unclustered: [], duration_ms: 0 }
  }
  if (inputs.length > 100) {
    return { ok: false, groups: [], unclustered: [], duration_ms: 0, error: 'Max 100 queries per cluster call' }
  }

  const corpus = inputs.map((c, i) => {
    const hint = c.auto_matched_product_name ? `  [auto-match: ${c.auto_matched_product_name}]` : ''
    return `${i + 1}. ${c.query}${hint}`
  }).join('\n')

  const prompt = `Group these ${inputs.length} long-tail search queries into clusters by shared (brand × sub_product) intent.

Rules:
- Each cluster groups queries that share the SAME brand (e.g. "Genshin Impact") AND SAME sub-product (e.g. "Account" or "Top-up").
- "where to buy genshin impact account" and "cheap genshin impact account safe" → same cluster (Genshin Impact / Account).
- "best valorant skins" and "cheap valorant points" → DIFFERENT clusters (sub_product differs).
- If a query stands alone with no semantic peer, give it its own single-member cluster.
- Pick a representative_query — the one query that best captures the shared intent.
- Use "Unknown" for brand when query is too vague to assign.

Sub-product categories (pick the closest fit):
- Account · Top-up · Items · Gold/Currency · Boosting · Skins/Cosmetics · Battle Pass · Other

QUERIES:
${corpus}

Call submit_clusters with your groupings. Every input query must appear in exactly one cluster's members[].`

  try {
    const res = await anthropic.messages.create({
      model:       MODEL,
      max_tokens:  3000,
      tools:       [CLUSTER_TOOL],
      tool_choice: { type: 'tool', name: CLUSTER_TOOL.name },
      messages:    [{ role: 'user', content: prompt }],
    })

    logClaudeUsage(db, ownerId, {
      model:       MODEL,
      endpoint:    'hugin_cluster',
      triggeredBy: 'other',
      usage:       res.usage,
      extra:       { input_count: inputs.length },
    })

    const toolUse = res.content.find(c => c.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      return { ok: false, groups: [], unclustered: inputs.map(i => i.query), duration_ms: Date.now() - start, error: 'No tool_use in response' }
    }

    const payload = toolUse.input as { clusters?: Array<{ brand?: string; sub_product?: string; representative_query?: string; members?: string[] }> }
    const clusters = payload.clusters ?? []

    // Build impression totals from inputs
    const impByQuery = new Map(inputs.map(i => [i.query.toLowerCase().trim(), i.total_impressions ?? 0]))

    const groups: ClusterGroup[] = clusters.map((c, idx) => {
      const members = (c.members ?? []).map(m => String(m).trim()).filter(Boolean)
      const totalImp = members.reduce((s, m) => s + (impByQuery.get(m.toLowerCase()) ?? 0), 0)
      return {
        cluster_id:           `cluster_${idx + 1}`,
        brand:                String(c.brand ?? 'Unknown').slice(0, 100),
        sub_product:          String(c.sub_product ?? 'Other').slice(0, 50),
        representative_query: String(c.representative_query ?? members[0] ?? '').slice(0, 250),
        members,
        total_impressions:    totalImp,
      }
    })

    // Detect any input that didn't make it into a cluster (model omission)
    const clustered = new Set<string>()
    for (const g of groups) for (const m of g.members) clustered.add(m.toLowerCase().trim())
    const unclustered = inputs
      .map(i => i.query)
      .filter(q => !clustered.has(q.toLowerCase().trim()))

    // Sort groups by total impressions desc (most impactful clusters first)
    groups.sort((a, b) => b.total_impressions - a.total_impressions)

    return { ok: true, groups, unclustered, duration_ms: Date.now() - start }
  } catch (err) {
    return { ok: false, groups: [], unclustered: inputs.map(i => i.query), duration_ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
}
