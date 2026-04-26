import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/service'
import { slugify } from '@/lib/agents/site-helpers'

/**
 * Saga — Keyword Universe Curator (Norse goddess of history & chronicling)
 *
 * Daily agent that maintains the keyword_maps + keyword_map_clusters
 * universe. Doesn't generate content — only curates the taxonomy.
 *
 * Run cycle (in order):
 *  1. CLUSTER PROPOSER
 *     Scan agent_actions last 30d for keywords proposed by Loki/Heimdall/Odin
 *     that aren't yet in any cluster. Group by topic via Claude classification
 *     against existing keyword_maps (topic + aliases). For each candidate:
 *       - keyword fits an existing topic  → queue add_to_cluster action
 *       - keyword doesn't fit any topic   → queue create_topic_map action
 *         (only if ≥3 keywords share a new topic — avoids fragmentation)
 *
 *  2. ARCHIVE PROPOSER
 *     Find clusters with status IN ('not_started', 'tracking') that have:
 *       - last_action_at older than 90 days, AND
 *       - gsc_clicks_30d = 0 (or NULL — fall back to last_action_at only)
 *     Queue archive_cluster actions so the user can confirm.
 *
 *  3. COVERAGE GAP DETECTOR
 *     For each active topic, count published vs total clusters. Surface
 *     topics with low completion (<50%) or stale planning (>60d at 'planning').
 *     Queue coverage_review actions for the worst offenders (max 3 per run).
 *
 *  4. LIFECYCLE PROMOTER
 *     For clusters with brief_id linked to a published brief, auto-update
 *     cluster status to 'published'. No approval needed — this is mechanical.
 *
 * All proposals go through the approval queue (action_types):
 *   - add_to_cluster      → executor inserts into keyword_map_clusters
 *   - create_topic_map    → executor inserts a new keyword_maps + initial clusters
 *   - archive_cluster     → executor sets cluster.status='archived'
 *   - coverage_review     → informational, opens insights page (no DB mutation)
 *
 * Failure model: same as other agents. partial = some sub-step warned;
 * error = whole run threw.
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = 'claude-haiku-4-5-20251001'

export interface SagaConfig {
  windowDays:          number   // default 30 — lookback for cluster candidates
  minKeywordsForTopic: number   // default 3 — min keywords needed to propose a brand-new topic
  archiveAgeDays:      number   // default 90 — cluster must be inactive this long to be archive candidate
  maxProposalsPerRun:  number   // default 15 — total cap (cluster + archive + coverage combined)
  coverageThresholdPct: number  // default 50 — topics below this completion get coverage_review
}

export const SAGA_DEFAULTS: SagaConfig = {
  windowDays:           30,
  minKeywordsForTopic:  3,
  archiveAgeDays:       90,
  maxProposalsPerRun:   15,
  coverageThresholdPct: 50,
}

interface AgentActionRow {
  id:          string
  agent_key:   string
  action_type: string
  data:        Record<string, unknown> | null
  created_at:  string
}

interface ClusterRow {
  id:           string
  map_id:       string
  keyword:      string
  status:       string
  last_action_at: string | null
  gsc_clicks_30d: number | null
  is_pillar:    boolean
  source:       string
}

interface MapRow {
  id:                       string
  topic:                    string
  topic_slug:               string
  aliases:                  string[] | null
  status:                   string
  last_cluster_activity_at: string | null
}

export async function runSaga(
  ownerId: string,
  siteSlug: string,
  runId: string,
  config: Partial<SagaConfig> = {}
): Promise<{ summary: string; actionsQueued: number }> {
  const cfg = { ...SAGA_DEFAULTS, ...config }
  const db = createServiceClient()
  const warnings: string[] = []
  let actionsQueued = 0
  const findings: string[] = []
  let promotedCount = 0

  try {
    // 0. Load existing universe (topics + their cluster keywords for matching)
    const { data: maps, error: mapsErr } = await db
      .from('keyword_maps')
      .select('id, topic, topic_slug, aliases, status, last_cluster_activity_at')
      .eq('owner_user_id', ownerId)
      .neq('status', 'archived')

    if (mapsErr) throw new Error(`keyword_maps query failed: ${mapsErr.message}`)

    const { data: existingClusters, error: clustersErr } = await db
      .from('keyword_map_clusters')
      .select('id, map_id, keyword, status, last_action_at, gsc_clicks_30d, is_pillar, source')
      .eq('owner_user_id', ownerId)

    if (clustersErr) throw new Error(`keyword_map_clusters query failed: ${clustersErr.message}`)

    const existingKeywords = new Set(
      (existingClusters ?? []).map(c => (c.keyword as string).toLowerCase().trim())
    )
    const mapsList = (maps ?? []) as MapRow[]
    const clustersList = (existingClusters ?? []) as ClusterRow[]

    // ── Step 1: cluster proposer ────────────────────────────────────────────
    if (actionsQueued < cfg.maxProposalsPerRun) {
      const proposed = await proposeClusters(db, ownerId, runId, siteSlug, cfg, mapsList, existingKeywords, cfg.maxProposalsPerRun - actionsQueued)
      actionsQueued += proposed.actionsQueued
      findings.push(...proposed.findings)
      warnings.push(...proposed.warnings)
    }

    // ── Step 2: archive proposer ────────────────────────────────────────────
    if (actionsQueued < cfg.maxProposalsPerRun) {
      const archived = await proposeArchives(db, ownerId, runId, siteSlug, cfg, clustersList, mapsList, cfg.maxProposalsPerRun - actionsQueued)
      actionsQueued += archived.actionsQueued
      findings.push(...archived.findings)
    }

    // ── Step 3: coverage gap detector ────────────────────────────────────---
    if (actionsQueued < cfg.maxProposalsPerRun) {
      const coverage = await proposeCoverageReviews(db, ownerId, runId, siteSlug, cfg, clustersList, mapsList, cfg.maxProposalsPerRun - actionsQueued)
      actionsQueued += coverage.actionsQueued
      findings.push(...coverage.findings)
    }

    // ── Step 4: lifecycle promoter (mechanical — no approval) ──────────────-
    promotedCount = await promoteFromBriefStatus(db, ownerId)
    if (promotedCount > 0) findings.push(`auto-promoted ${promotedCount} cluster(s) to 'published'`)

    const summaryBase = findings.length
      ? `Queued ${actionsQueued} proposals · ${findings.slice(0, 4).join(', ')}${findings.length > 4 ? '…' : ''}.`
      : `No new proposals — universe looks stable.`
    const summary = warnings.length ? `${summaryBase} ⚠ ${warnings.join('; ')}` : summaryBase
    const status = warnings.length ? 'partial' : 'success'

    await _finishRun(db, runId, ownerId, status, summary, findings.length, actionsQueued, warnings)
    return { summary, actionsQueued }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    await _finishRun(db, runId, ownerId, 'error', msg, 0, actionsQueued, warnings, msg)
    throw err
  }
}

// ── Step 1: Cluster proposer ────────────────────────────────────────────────

async function proposeClusters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  ownerId: string,
  runId: string,
  siteSlug: string,
  cfg: SagaConfig,
  maps: MapRow[],
  existingKeywords: Set<string>,
  budget: number
): Promise<{ actionsQueued: number; findings: string[]; warnings: string[] }> {
  const findings: string[] = []
  const warnings: string[] = []
  let actionsQueued = 0

  const sinceIso = new Date(Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000).toISOString()
  const { data: actions, error } = await db
    .from('agent_actions')
    .select('id, agent_key, action_type, data, created_at')
    .eq('owner_user_id', ownerId)
    .in('agent_key', ['loki', 'heimdall', 'odin'])
    .gte('created_at', sinceIso)

  if (error) {
    warnings.push(`agent_actions query failed: ${error.message}`)
    return { actionsQueued, findings, warnings }
  }

  // Extract distinct keywords + their occurrence count + sample SV
  interface KeywordCandidate {
    keyword:       string
    occurrences:   number
    search_volume: number
    sources:       Set<string>
    sample_action_id: string
  }
  const candidates = new Map<string, KeywordCandidate>()
  for (const a of (actions ?? []) as AgentActionRow[]) {
    const data = a.data ?? {}
    const kwRaw = (data.keyword ?? data.game_name) as string | undefined
    if (!kwRaw) continue
    const kw = String(kwRaw).toLowerCase().trim()
    if (!kw || existingKeywords.has(kw)) continue
    const sv = Number(data.search_volume ?? 0)
    const c = candidates.get(kw) ?? { keyword: kw, occurrences: 0, search_volume: 0, sources: new Set(), sample_action_id: a.id }
    c.occurrences += 1
    c.search_volume = Math.max(c.search_volume, sv)
    c.sources.add(a.agent_key)
    candidates.set(kw, c)
  }

  if (candidates.size === 0) return { actionsQueued, findings, warnings }

  // Classify each candidate against existing topics via Claude
  // (batch in one call for efficiency; cap to 50 candidates per run)
  const candidateList = Array.from(candidates.values())
    .sort((a, b) => b.search_volume - a.search_volume)
    .slice(0, 50)

  let classifications: ClassificationResult[]
  try {
    classifications = await classifyKeywords(candidateList.map(c => c.keyword), maps)
  } catch (err) {
    warnings.push(`Claude classification failed: ${err instanceof Error ? err.message : String(err)}`)
    return { actionsQueued, findings, warnings }
  }

  // Bucket: keyword → existing topic OR keyword → "new topic" (with proposed slug)
  const addToTopic = new Map<string, KeywordCandidate[]>()   // map_id → candidates
  const newTopicGroups = new Map<string, KeywordCandidate[]>()  // proposed_slug → candidates

  for (let i = 0; i < candidateList.length; i++) {
    const cand = candidateList[i]
    const cls = classifications[i]
    if (!cls) continue
    if (cls.match === 'existing' && cls.map_id) {
      const arr = addToTopic.get(cls.map_id) ?? []
      arr.push(cand)
      addToTopic.set(cls.map_id, arr)
    } else if (cls.match === 'new' && cls.proposed_topic_slug) {
      const arr = newTopicGroups.get(cls.proposed_topic_slug) ?? []
      arr.push(cand)
      newTopicGroups.set(cls.proposed_topic_slug, arr)
    }
  }

  // Queue add_to_cluster proposals (one action per candidate)
  for (const [mapId, cands] of addToTopic.entries()) {
    if (actionsQueued >= budget) break
    const topic = maps.find(m => m.id === mapId)
    if (!topic) continue
    for (const cand of cands) {
      if (actionsQueued >= budget) break
      const { error: insertErr } = await db
        .from('agent_actions')
        .insert({
          owner_user_id: ownerId,
          agent_key:     'saga',
          run_id:        runId,
          site_slug:     siteSlug,
          action_type:   'add_to_cluster',
          title:         `Add "${cand.keyword}" to "${topic.topic}" topic`,
          description:   `Proposed by Saga: keyword appeared in ${cand.occurrences} action${cand.occurrences > 1 ? 's' : ''} from ${Array.from(cand.sources).join(', ')}. Search volume ${cand.search_volume.toLocaleString()}. Approve to add as cluster under topic "${topic.topic}".`,
          priority:      cand.search_volume > 5000 ? 'high' : cand.search_volume > 1000 ? 'medium' : 'low',
          data: {
            keyword:           cand.keyword,
            map_id:            mapId,
            topic:             topic.topic,
            search_volume:     cand.search_volume,
            sources:           Array.from(cand.sources),
            sample_action_id:  cand.sample_action_id,
            occurrences:       cand.occurrences,
          },
        })
      if (insertErr) {
        warnings.push(`add_to_cluster insert failed: ${insertErr.message}`)
      } else {
        actionsQueued++
        findings.push(`+cluster "${cand.keyword}" → ${topic.topic}`)
      }
    }
  }

  // Queue create_topic_map proposals (only for groups with >= minKeywordsForTopic)
  for (const [slug, cands] of newTopicGroups.entries()) {
    if (actionsQueued >= budget) break
    if (cands.length < cfg.minKeywordsForTopic) continue
    const topicGuess = cands[0].keyword.split(/\s+/).slice(0, 3).join(' ')
    const { error: insertErr } = await db
      .from('agent_actions')
      .insert({
        owner_user_id: ownerId,
        agent_key:     'saga',
        run_id:        runId,
        site_slug:     siteSlug,
        action_type:   'create_topic_map',
        title:         `Create new topic "${topicGuess}" — ${cands.length} candidate keywords`,
        description:   `Saga detected ${cands.length} keywords that don't fit any existing topic but cluster together. Proposed pillar keyword: "${cands[0].keyword}". Sample keywords: ${cands.slice(0, 5).map(c => `"${c.keyword}"`).join(', ')}. Approve to create the topic map.`,
        priority:      cands.length >= 5 ? 'high' : 'medium',
        data: {
          proposed_topic:       topicGuess,
          proposed_topic_slug:  slug,
          pillar_keyword:       cands[0].keyword,
          candidate_keywords:   cands.map(c => ({ keyword: c.keyword, search_volume: c.search_volume })),
        },
      })
    if (insertErr) {
      warnings.push(`create_topic_map insert failed: ${insertErr.message}`)
    } else {
      actionsQueued++
      findings.push(`+topic "${topicGuess}" (${cands.length} kw)`)
    }
  }

  return { actionsQueued, findings, warnings }
}

// ── Step 2: Archive proposer ────────────────────────────────────────────────

async function proposeArchives(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  ownerId: string,
  runId: string,
  siteSlug: string,
  cfg: SagaConfig,
  clusters: ClusterRow[],
  maps: MapRow[],
  budget: number
): Promise<{ actionsQueued: number; findings: string[] }> {
  const findings: string[] = []
  let actionsQueued = 0

  const cutoffMs = Date.now() - cfg.archiveAgeDays * 24 * 60 * 60 * 1000

  const candidates = clusters.filter(c => {
    if (c.is_pillar) return false   // never auto-archive pillar
    if (!['not_started', 'tracking'].includes(c.status)) return false
    const lastAction = c.last_action_at ? new Date(c.last_action_at).getTime() : 0
    if (lastAction > cutoffMs) return false   // recent activity
    // If we have GSC data, require zero clicks too. If null, age alone is sufficient.
    if (c.gsc_clicks_30d !== null && c.gsc_clicks_30d > 0) return false
    return true
  })

  const mapById = new Map(maps.map(m => [m.id, m]))

  for (const cand of candidates.slice(0, budget)) {
    if (actionsQueued >= budget) break
    const topic = mapById.get(cand.map_id)
    const { error: insertErr } = await db
      .from('agent_actions')
      .insert({
        owner_user_id: ownerId,
        agent_key:     'saga',
        run_id:        runId,
        site_slug:     siteSlug,
        action_type:   'archive_cluster',
        title:         `Archive "${cand.keyword}" — inactive ${cfg.archiveAgeDays}+ days, no clicks`,
        description:   `Cluster has been ${cand.status} for over ${cfg.archiveAgeDays} days with no agent activity${cand.gsc_clicks_30d === 0 ? ' and zero GSC clicks last 30d' : ''}. Approve to archive (preserves audit trail; status only).`,
        priority:      'low',
        data: {
          cluster_id:      cand.id,
          map_id:          cand.map_id,
          keyword:         cand.keyword,
          topic:           topic?.topic ?? null,
          status_before:   cand.status,
          last_action_at:  cand.last_action_at,
          gsc_clicks_30d:  cand.gsc_clicks_30d,
        },
      })
    if (!insertErr) {
      actionsQueued++
      findings.push(`archive "${cand.keyword}"`)
    }
  }

  return { actionsQueued, findings }
}

// ── Step 3: Coverage gap detector ───────────────────────────────────────────

async function proposeCoverageReviews(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  ownerId: string,
  runId: string,
  siteSlug: string,
  cfg: SagaConfig,
  clusters: ClusterRow[],
  maps: MapRow[],
  budget: number
): Promise<{ actionsQueued: number; findings: string[] }> {
  const findings: string[] = []
  let actionsQueued = 0

  // Group clusters by map
  const byMap = new Map<string, ClusterRow[]>()
  for (const c of clusters) {
    if (c.status === 'archived') continue
    const arr = byMap.get(c.map_id) ?? []
    arr.push(c)
    byMap.set(c.map_id, arr)
  }

  const issues: Array<{ map: MapRow; total: number; published: number; pct: number; reason: string }> = []
  for (const map of maps) {
    if (map.status !== 'in_progress') continue   // 'planning' = too early; 'published' = done
    const cs = byMap.get(map.id) ?? []
    if (cs.length < 3) continue   // skip tiny topics
    const published = cs.filter(c => c.status === 'published' || c.status === 'tracking').length
    const pct = (published / cs.length) * 100
    if (pct < cfg.coverageThresholdPct) {
      issues.push({ map, total: cs.length, published, pct, reason: `${pct.toFixed(0)}% coverage (${published}/${cs.length})` })
    }
  }

  // Take worst 3
  issues.sort((a, b) => a.pct - b.pct)
  for (const issue of issues.slice(0, Math.min(3, budget))) {
    if (actionsQueued >= budget) break
    const { error: insertErr } = await db
      .from('agent_actions')
      .insert({
        owner_user_id: ownerId,
        agent_key:     'saga',
        run_id:        runId,
        site_slug:     siteSlug,
        action_type:   'coverage_review',
        title:         `Topic "${issue.map.topic}" coverage low — ${issue.reason}`,
        description:   `Topic has ${issue.total} clusters but only ${issue.published} published. Consider prioritising the unpublished clusters or archiving the topic if no longer strategic. Open Insights page to drill in.`,
        priority:      issue.pct < 25 ? 'high' : 'medium',
        data: {
          map_id:        issue.map.id,
          topic:         issue.map.topic,
          total:         issue.total,
          published:     issue.published,
          coverage_pct:  issue.pct,
        },
      })
    if (!insertErr) {
      actionsQueued++
      findings.push(`coverage "${issue.map.topic}" ${issue.pct.toFixed(0)}%`)
    }
  }

  return { actionsQueued, findings }
}

// ── Step 4: Lifecycle promoter ──────────────────────────────────────────────

async function promoteFromBriefStatus(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  ownerId: string
): Promise<number> {
  // Find clusters whose linked brief is now 'published' but cluster status isn't.
  const { data: candidates } = await db
    .from('keyword_map_clusters')
    .select('id, brief_id, status')
    .eq('owner_user_id', ownerId)
    .not('brief_id', 'is', null)
    .neq('status', 'published')

  if (!candidates?.length) return 0

  const briefIds = (candidates as { brief_id: string }[]).map(c => c.brief_id)
  const { data: briefs } = await db
    .from('seo_content_briefs')
    .select('id, status')
    .in('id', briefIds)
    .eq('status', 'published')

  if (!briefs?.length) return 0

  const publishedBriefIds = new Set((briefs as { id: string }[]).map(b => b.id))
  const toPromote = (candidates as { id: string; brief_id: string }[]).filter(c => publishedBriefIds.has(c.brief_id))

  if (!toPromote.length) return 0

  const ids = toPromote.map(c => c.id)
  await db
    .from('keyword_map_clusters')
    .update({ status: 'published' })
    .in('id', ids)

  return toPromote.length
}

// ── Claude classifier ───────────────────────────────────────────────────────

interface ClassificationResult {
  match:                'existing' | 'new' | 'skip'
  map_id?:              string                  // when match='existing'
  proposed_topic_slug?: string                  // when match='new'
  reason:               string
}

const classifyTool: Anthropic.Tool = {
  name: 'submit_classifications',
  description: 'Submit topic classification for each candidate keyword.',
  input_schema: {
    type: 'object',
    properties: {
      classifications: {
        type: 'array',
        description: 'One result per input keyword, in the same order.',
        items: {
          type: 'object',
          properties: {
            match: {
              type: 'string',
              enum: ['existing', 'new', 'skip'],
              description: 'existing = matches one of the provided topics; new = doesn\'t fit but is a viable new topic; skip = irrelevant/spam.',
            },
            map_id: {
              type: 'string',
              description: 'When match=existing: the topic_id (UUID) it belongs to.',
            },
            proposed_topic_slug: {
              type: 'string',
              description: 'When match=new: a kebab-case slug for the proposed new topic, e.g. "honkai-star-rail".',
            },
            reason: {
              type: 'string',
              description: 'One short sentence justifying the classification.',
            },
          },
          required: ['match', 'reason'],
        },
      },
    },
    required: ['classifications'],
  },
}

async function classifyKeywords(keywords: string[], maps: MapRow[]): Promise<ClassificationResult[]> {
  if (keywords.length === 0) return []

  const topicList = maps.map(m =>
    `- ${m.id} | "${m.topic}" (slug: ${m.topic_slug}${m.aliases && m.aliases.length ? `, aliases: ${m.aliases.join(', ')}` : ''})`
  ).join('\n')

  const kwList = keywords.map((k, i) => `${i + 1}. "${k}"`).join('\n')

  const prompt = `You are classifying keyword candidates against an existing keyword universe for G2G.com (gaming marketplace).

EXISTING TOPICS:
${topicList || '(none — universe is empty, all keywords are candidates for new topics)'}

CANDIDATE KEYWORDS (classify each, in order):
${kwList}

For each keyword, decide:
- "existing" if it clearly belongs to one of the topics above (use topic_id as map_id)
- "new" if it represents a topic not yet in the universe (provide a kebab-case proposed_topic_slug)
- "skip" if it's branded competitor terms, spam, or irrelevant to a gaming marketplace

Be strict: when in doubt between existing and new, prefer existing (consolidation > fragmentation). Only mark "new" if the keyword clearly represents a distinct topic.

Call submit_classifications with exactly ${keywords.length} results, in the same order as the input.`

  const res = await anthropic.messages.create({
    model:       MODEL,
    max_tokens:  2048,
    tools:       [classifyTool],
    tool_choice: { type: 'tool', name: 'submit_classifications' },
    messages:    [{ role: 'user', content: prompt }],
  })

  const toolUse = res.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error(`Claude did not call submit_classifications (stop_reason=${res.stop_reason})`)
  }

  const raw = toolUse.input as { classifications?: unknown }
  const results = Array.isArray(raw.classifications) ? raw.classifications : []
  return results.map(r => {
    const obj = r as Record<string, unknown>
    return {
      match: (obj.match === 'existing' || obj.match === 'new' || obj.match === 'skip') ? obj.match : 'skip',
      map_id: typeof obj.map_id === 'string' ? obj.map_id : undefined,
      proposed_topic_slug: typeof obj.proposed_topic_slug === 'string' ? slugify(obj.proposed_topic_slug) : undefined,
      reason: typeof obj.reason === 'string' ? obj.reason : '',
    }
  })
}

// ── Run finaliser ───────────────────────────────────────────────────────────

async function _finishRun(
  db: ReturnType<typeof createServiceClient>,
  runId: string,
  ownerId: string,
  status: 'success' | 'error' | 'partial',
  summary: string,
  findingsCount: number,
  actionsQueued: number,
  warnings: string[],
  errorMessage?: string
) {
  await db
    .from('agent_runs')
    .update({
      status,
      summary,
      findings_count: findingsCount,
      actions_queued: actionsQueued,
      error_message:  errorMessage ?? (warnings.length ? warnings.join('; ') : null),
      finished_at:    new Date().toISOString(),
    })
    .eq('id', runId)

  await db
    .from('agents')
    .update({
      last_run_at:      new Date().toISOString(),
      last_run_status:  status,
      last_run_summary: summary,
    })
    .eq('owner_user_id', ownerId)
    .eq('agent_key', 'saga')
}
