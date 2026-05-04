/**
 * Frey — AI Visibility Tracking Agent
 *
 * Norse god of fertility/prosperity (visibility/growth fits the metaphor).
 *
 * Weekly run:
 *   1. Pull active prompts from ai_visibility_prompts
 *   2. For each prompt × LLM platform (Claude + GPT-4o-mini for MVP):
 *        - Query the LLM with the prompt as user message
 *        - Parse the response with a Haiku-based extractor:
 *            * G2G mentioned? where (position 1, 2, ...)?
 *            * Sentiment for G2G mention?
 *            * Which competitors mentioned + their positions
 *   3. Persist findings to ai_visibility_findings
 *   4. Compute weekly snapshots (per-topic + overall) → ai_visibility_snapshots
 *   5. Emit pipeline-relevant signals:
 *        Flow 1 — high-SV topic with low/zero AI mention → agent_actions
 *                 (loki-style so existing Saga aggregator picks it up)
 *        Flow 2 — sentiment drop > 0.3 in 7d → Slack alert
 */

import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/service'
import { chatCompletion } from '@/lib/llm-clients/openai'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const QUERY_MODEL_CLAUDE  = 'claude-haiku-4-5-20251001'   // Claude lookup
const QUERY_MODEL_OPENAI  = 'gpt-4o-mini'                 // OpenAI lookup
const PARSER_MODEL        = 'claude-haiku-4-5-20251001'   // Cheap parser

type LlmPlatform = 'claude' | 'gpt-4o-mini'

interface PromptRow {
  id:              string
  prompt_text:     string
  category:        string
  topic_slug:      string | null
  auto_topic_slug: string | null
}

interface ParsedFinding {
  brand_mentioned: boolean
  brand_position:  number | null
  sentiment:       number          // -1..+1
  competitors:     Array<{ domain: string; position: number; mentions: number }>
  parser_notes:    string
}

interface FreyRunResult {
  runId:            string
  prompts_queried:  number
  llm_calls:        number
  findings_written: number
  pipeline_actions: number
  alerts_triggered: number
  errors:           string[]
  summary:          string
}

const BRAND = {
  name:    'G2G',
  domain:  'g2g.com',
  aliases: ['g2g.com', 'g2g'],
}

// Curated competitor list — kept in code (could be moved to DB if needed).
// Frey looks for these in LLM responses.
const KNOWN_COMPETITORS = [
  'playerauctions.com',
  'eneba.com',
  'kinguin.net',
  'mmoga.com',
  'iggm.com',
  'igvault.com',
  'gameflip.com',
  'chicksgold.com',
  'mmoauctions.com',
  'bonusxp.com',
]

// ─── Public entrypoint ────────────────────────────────────────────────────────

export async function runFrey(
  ownerId: string,
  siteSlug: string = 'g2g',
): Promise<FreyRunResult> {
  const db     = createServiceClient()
  const runId  = crypto.randomUUID()
  const errors: string[] = []

  // 1. Fetch active prompts
  const { data: promptRows, error: promptErr } = await db
    .from('ai_visibility_prompts')
    .select('id, prompt_text, category, topic_slug, auto_topic_slug')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(60)   // safety cap

  if (promptErr) {
    return { runId, prompts_queried: 0, llm_calls: 0, findings_written: 0, pipeline_actions: 0, alerts_triggered: 0, errors: [promptErr.message], summary: 'Failed to fetch prompts' }
  }

  const prompts = (promptRows ?? []) as PromptRow[]
  if (prompts.length === 0) {
    return { runId, prompts_queried: 0, llm_calls: 0, findings_written: 0, pipeline_actions: 0, alerts_triggered: 0, errors: [], summary: 'No active prompts to query' }
  }

  // 2. For each prompt × LLM, query + parse
  let llmCalls = 0
  const findings: Array<Record<string, unknown>> = []

  for (const prompt of prompts) {
    for (const platform of ['claude', 'gpt-4o-mini'] as LlmPlatform[]) {
      llmCalls++
      const response = await queryLlm(platform, prompt.prompt_text)
      if (!response) {
        errors.push(`${platform}: ${prompt.prompt_text.slice(0, 40)}…`)
        continue
      }

      const parsed = await parseResponse(response, prompt.prompt_text)

      findings.push({
        owner_user_id:   ownerId,
        site_slug:       siteSlug,
        run_id:          runId,
        prompt_id:       prompt.id,
        llm_platform:    platform,
        brand_mentioned: parsed.brand_mentioned,
        brand_position:  parsed.brand_position,
        sentiment:       parsed.sentiment,
        competitors:     parsed.competitors,
        raw_response:    response.slice(0, 4000),
        parser_notes:    parsed.parser_notes,
      })
    }
  }

  // 3. Persist findings
  let findingsWritten = 0
  if (findings.length > 0) {
    const { error: insErr } = await db.from('ai_visibility_findings').insert(findings)
    if (insErr) {
      errors.push(`Findings insert: ${insErr.message}`)
    } else {
      findingsWritten = findings.length
    }
  }

  // 4. Compute + write weekly snapshot
  await writeSnapshots(db, ownerId, siteSlug, runId, prompts, findings)

  // 5. Emit pipeline signals (Flow 1) + alerts (Flow 2)
  const pipelineActions = await emitPipelineSignals(db, ownerId, siteSlug, runId, prompts, findings, errors)
  const alertsTriggered = await emitSentimentAlerts(db, ownerId, siteSlug, findings, errors)

  return {
    runId,
    prompts_queried:  prompts.length,
    llm_calls:        llmCalls,
    findings_written: findingsWritten,
    pipeline_actions: pipelineActions,
    alerts_triggered: alertsTriggered,
    errors,
    summary: `Frey scan: ${prompts.length} prompts × 2 LLMs · ${findingsWritten} findings · ${pipelineActions} pipeline · ${alertsTriggered} alerts`,
  }
}

// ─── LLM querying ────────────────────────────────────────────────────────────

async function queryLlm(platform: LlmPlatform, prompt: string): Promise<string | null> {
  if (platform === 'claude') {
    try {
      const res = await anthropic.messages.create({
        model:      QUERY_MODEL_CLAUDE,
        max_tokens: 1024,
        messages:   [{ role: 'user', content: prompt }],
      })
      const block = res.content[0]
      return block.type === 'text' ? block.text : null
    } catch (err) {
      console.error('[frey/claude] error:', err instanceof Error ? err.message : err)
      return null
    }
  }

  if (platform === 'gpt-4o-mini') {
    const res = await chatCompletion({
      model:       QUERY_MODEL_OPENAI,
      prompt,
      maxTokens:   1024,
      temperature: 0.3,
    })
    return res?.text ?? null
  }

  return null
}

// ─── Response parsing (Haiku extractor) ──────────────────────────────────────

const PARSER_SYSTEM_PROMPT = `You are an AI visibility analyzer. Given an LLM response and the original user query, extract structured data about brand mentions.

Return ONLY a JSON object with this exact shape — no markdown, no explanation:

{
  "brand_mentioned": boolean,
  "brand_position": number | null,
  "sentiment": number,
  "competitors": [{"domain": string, "position": number, "mentions": number}],
  "parser_notes": string
}

Rules:
- "brand" = G2G or g2g.com (case-insensitive, treat aliases as same)
- brand_mentioned: true if G2G is named/recommended/cited in any way
- brand_position: 1-based position among recommendations (1 = first/top recommendation, 2 = second, etc.). Null if not mentioned or not in a list.
- sentiment: number from -1.0 (very negative) to +1.0 (very positive). 0 = neutral.
- competitors: array of competitor domains mentioned. Position is their order in the response. mentions = how many times they're named.
- Only include competitors from this list: playerauctions.com, eneba.com, kinguin.net, mmoga.com, iggm.com, igvault.com, gameflip.com, chicksgold.com, mmoauctions.com, bonusxp.com
- parser_notes: 1-2 sentence summary of how G2G is portrayed (or absent)`

interface ParserOutput {
  brand_mentioned: boolean
  brand_position: number | null
  sentiment: number
  competitors: Array<{ domain: string; position: number; mentions: number }>
  parser_notes: string
}

async function parseResponse(llmResponse: string, prompt: string): Promise<ParsedFinding> {
  try {
    const res = await anthropic.messages.create({
      model:      PARSER_MODEL,
      max_tokens: 600,
      system:     PARSER_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Original user query:\n"""${prompt}"""\n\nLLM response to analyze:\n"""${llmResponse}"""\n\nReturn the JSON now.`,
      }],
    })

    const block = res.content[0]
    if (block.type !== 'text') throw new Error('parser returned non-text')

    // Strip any markdown code fences just in case
    const cleaned = block.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim()
    const parsed = JSON.parse(cleaned) as ParserOutput

    return {
      brand_mentioned: !!parsed.brand_mentioned,
      brand_position:  typeof parsed.brand_position === 'number' ? parsed.brand_position : null,
      sentiment:       Math.max(-1, Math.min(1, Number(parsed.sentiment) || 0)),
      competitors:     Array.isArray(parsed.competitors) ? parsed.competitors.slice(0, 10) : [],
      parser_notes:    String(parsed.parser_notes ?? '').slice(0, 500),
    }
  } catch (err) {
    // Fallback: simple regex-based detection
    const lower = llmResponse.toLowerCase()
    const mentioned = BRAND.aliases.some(a => lower.includes(a))
    const competitorMentions = KNOWN_COMPETITORS
      .map((domain, i) => ({ domain, position: i + 1, mentions: lower.split(domain).length - 1 }))
      .filter(c => c.mentions > 0)

    return {
      brand_mentioned: mentioned,
      brand_position:  null,
      sentiment:       0,
      competitors:     competitorMentions,
      parser_notes:    `Parser fallback (Haiku failed: ${err instanceof Error ? err.message : 'unknown'})`,
    }
  }
}

// ─── Snapshot computation ────────────────────────────────────────────────────

async function writeSnapshots(
  db:        ReturnType<typeof createServiceClient>,
  ownerId:   string,
  siteSlug:  string,
  runId:     string,
  prompts:   PromptRow[],
  findings:  Array<Record<string, unknown>>,
): Promise<void> {
  if (findings.length === 0) return

  // Compute Monday of this week (UTC)
  const now = new Date()
  const dayOfWeek = now.getUTCDay()  // 0 = Sunday
  const daysToMonday = (dayOfWeek + 6) % 7
  const weekStart = new Date(now)
  weekStart.setUTCDate(now.getUTCDate() - daysToMonday)
  weekStart.setUTCHours(0, 0, 0, 0)
  const weekStarting = weekStart.toISOString().split('T')[0]

  // Group findings by topic
  const promptIdToTopic = new Map<string, string | null>()
  for (const p of prompts) {
    promptIdToTopic.set(p.id, p.topic_slug ?? p.auto_topic_slug ?? null)
  }

  const byTopic = new Map<string, Array<typeof findings[0]>>()
  for (const f of findings) {
    const topic = promptIdToTopic.get(f.prompt_id as string) ?? '__overall__'
    if (!byTopic.has(topic)) byTopic.set(topic, [])
    byTopic.get(topic)!.push(f)
  }

  // Always also write a site-overall snapshot
  byTopic.set('__overall__', findings)

  const snapshots: Array<Record<string, unknown>> = []
  for (const [topic, entries] of byTopic.entries()) {
    const total       = entries.length
    const mentioned   = entries.filter(e => e.brand_mentioned).length
    const mentionRate = total > 0 ? mentioned / total : 0

    const positions = entries.filter(e => typeof e.brand_position === 'number').map(e => e.brand_position as number)
    const avgPosition = positions.length > 0 ? positions.reduce((a, b) => a + b, 0) / positions.length : null

    const sentiments = entries.filter(e => e.brand_mentioned).map(e => Number(e.sentiment) || 0)
    const avgSentiment = sentiments.length > 0 ? sentiments.reduce((a, b) => a + b, 0) / sentiments.length : 0

    // Composite visibility score (0-100):
    //   mention rate weighted 50%, position weighted 30% (lower is better), sentiment weighted 20%
    const positionScore  = avgPosition !== null ? Math.max(0, 1 - (avgPosition - 1) / 9) : 0   // pos 1 = 1.0, pos 10 = 0.0
    const sentimentScore = (avgSentiment + 1) / 2                                              // -1..1 → 0..1
    const visibilityScore = (mentionRate * 50) + (positionScore * 30) + (sentimentScore * 20)

    // Top competitor: most-mentioned across all entries
    const compCounts = new Map<string, number>()
    for (const e of entries) {
      const comps = (e.competitors as Array<{ domain: string; mentions: number }>) ?? []
      for (const c of comps) {
        compCounts.set(c.domain, (compCounts.get(c.domain) ?? 0) + (c.mentions ?? 1))
      }
    }
    const topCompetitor = Array.from(compCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

    // Per-LLM breakdown
    const byLlm: Record<string, { mentioned: number; total: number }> = {}
    for (const e of entries) {
      const platform = String(e.llm_platform)
      if (!byLlm[platform]) byLlm[platform] = { mentioned: 0, total: 0 }
      byLlm[platform].total++
      if (e.brand_mentioned) byLlm[platform].mentioned++
    }

    snapshots.push({
      owner_user_id:    ownerId,
      site_slug:        siteSlug,
      topic_slug:       topic === '__overall__' ? null : topic,
      week_starting:    weekStarting,
      visibility_score: Number(visibilityScore.toFixed(2)),
      mention_rate:     Number(mentionRate.toFixed(4)),
      avg_position:     avgPosition !== null ? Number(avgPosition.toFixed(2)) : null,
      avg_sentiment:    Number(avgSentiment.toFixed(2)),
      prompt_coverage:  total,
      llm_breakdown:    byLlm,
      top_competitor:   topCompetitor,
    })
  }

  if (snapshots.length > 0) {
    await db.from('ai_visibility_snapshots').upsert(snapshots, {
      onConflict: 'owner_user_id,site_slug,topic_slug,week_starting',
      ignoreDuplicates: false,
    })
  }

  // runId is referenced but not stored on snapshots intentionally — snapshots are
  // weekly aggregates, not per-run. Future: link via metadata column if needed.
  void runId
}

// ─── Flow 1: emit pipeline signals for high-impact gaps ──────────────────────

async function emitPipelineSignals(
  db:        ReturnType<typeof createServiceClient>,
  ownerId:   string,
  siteSlug:  string,
  runId:     string,
  prompts:   PromptRow[],
  findings:  Array<Record<string, unknown>>,
  errors:    string[],
): Promise<number> {
  // Group findings by prompt to compute "is G2G mentioned in this prompt at all?"
  const byPrompt = new Map<string, Array<typeof findings[0]>>()
  for (const f of findings) {
    const pid = f.prompt_id as string
    if (!byPrompt.has(pid)) byPrompt.set(pid, [])
    byPrompt.get(pid)!.push(f)
  }

  const actionsToInsert: Array<Record<string, unknown>> = []
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

  // Skip-list: don't double-emit if there's a recent Frey action for the same prompt
  const { data: recentFreyActions } = await db
    .from('agent_actions')
    .select('data')
    .eq('owner_user_id', ownerId)
    .eq('agent_key', 'frey')
    .gte('created_at', fourteenDaysAgo)
    .limit(200)

  const recentPromptIds = new Set<string>()
  for (const a of recentFreyActions ?? []) {
    const d = a.data as { prompt_id?: string } | null
    if (d?.prompt_id) recentPromptIds.add(d.prompt_id)
  }

  for (const prompt of prompts) {
    const entries = byPrompt.get(prompt.id) ?? []
    if (entries.length === 0) continue

    const mentionedCount = entries.filter(e => e.brand_mentioned).length
    const totalCount     = entries.length
    const mentionRate    = totalCount > 0 ? mentionedCount / totalCount : 0

    // Trigger condition: G2G mentioned in <50% of LLMs for this prompt = visibility gap
    if (mentionRate >= 0.5) continue
    if (recentPromptIds.has(prompt.id)) continue

    // Find which competitor dominated this prompt
    const compCounts = new Map<string, number>()
    for (const e of entries) {
      const comps = (e.competitors as Array<{ domain: string; mentions: number }>) ?? []
      for (const c of comps) {
        compCounts.set(c.domain, (compCounts.get(c.domain) ?? 0) + (c.mentions ?? 1))
      }
    }
    const topComp = Array.from(compCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const topicSlug = prompt.topic_slug ?? prompt.auto_topic_slug ?? null

    actionsToInsert.push({
      owner_user_id: ownerId,
      agent_key:     'frey',
      run_id:        runId,
      site_slug:     siteSlug,
      action_type:   'add_action_item',
      title:         `AI visibility gap: "${prompt.prompt_text.slice(0, 60)}${prompt.prompt_text.length > 60 ? '…' : ''}"`,
      description:   `G2G mentioned in only ${mentionedCount}/${totalCount} LLM responses for this prompt. ${topComp ? `${topComp} dominated.` : 'No clear competitor dominance.'} Content gap to address.`,
      priority:      mentionRate === 0 ? 'high' : 'medium',
      data: {
        prompt_id:       prompt.id,
        prompt_text:     prompt.prompt_text,
        category:        prompt.category,
        topic_slug:      topicSlug,
        mention_rate:    mentionRate,
        top_competitor:  topComp,
        source:          'frey_ai_visibility',
        llm_results: entries.map(e => ({
          platform:       e.llm_platform,
          mentioned:      e.brand_mentioned,
          position:       e.brand_position,
          sentiment:      e.sentiment,
        })),
      },
    })
  }

  if (actionsToInsert.length === 0) return 0

  const { error } = await db.from('agent_actions').insert(actionsToInsert)
  if (error) {
    errors.push(`pipeline signals: ${error.message}`)
    return 0
  }
  return actionsToInsert.length
}

// ─── Flow 2: Slack alert on sentiment drops ──────────────────────────────────

async function emitSentimentAlerts(
  db:        ReturnType<typeof createServiceClient>,
  ownerId:   string,
  siteSlug:  string,
  findings:  Array<Record<string, unknown>>,
  errors:    string[],
): Promise<number> {
  // Compute current week's avg sentiment for prompts where G2G IS mentioned
  const mentionedFindings = findings.filter(f => f.brand_mentioned)
  if (mentionedFindings.length < 5) return 0   // not enough signal

  const currentSentiment = mentionedFindings.reduce((sum, f) => sum + (Number(f.sentiment) || 0), 0) / mentionedFindings.length

  // Compare to previous week's snapshot
  const lastWeek = new Date()
  lastWeek.setUTCDate(lastWeek.getUTCDate() - 7)
  const lastWeekStr = lastWeek.toISOString().split('T')[0]

  const { data: prevSnapshot } = await db
    .from('ai_visibility_snapshots')
    .select('avg_sentiment')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .is('topic_slug', null)              // overall snapshot
    .lte('week_starting', lastWeekStr)
    .order('week_starting', { ascending: false })
    .limit(1)
    .maybeSingle()

  const prevSentiment = prevSnapshot?.avg_sentiment != null ? Number(prevSnapshot.avg_sentiment) : null
  if (prevSentiment === null) return 0    // no baseline to compare

  const delta = currentSentiment - prevSentiment
  if (delta > -0.3) return 0               // not a significant drop

  // Drop ≥0.3: alert Slack
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_CHANNEL_ID) return 0

  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: process.env.SLACK_CHANNEL_ID,
        text: `⚠️ *Frey alert* — AI sentiment dropped ${(delta * 100).toFixed(0)}% week-over-week\n` +
              `Current: ${currentSentiment.toFixed(2)} · Previous: ${prevSentiment.toFixed(2)}\n` +
              `Investigate which prompts shifted negative. Check /ai-visibility for breakdown.`,
        mrkdwn: true,
      }),
    })
    return 1
  } catch (err) {
    errors.push(`Slack alert: ${err instanceof Error ? err.message : String(err)}`)
    return 0
  }
}
