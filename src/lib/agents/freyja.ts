// Sprint FREYJA — AI Visibility aggregator.
//
// Reads ai_visibility_snapshots and produces:
//   1. Latest-state snapshot per (brand × llm × country)
//   2. WoW deltas (compare latest snapshot to ~7 days prior)
//   3. Trend series (last N weeks) for dashboard charts
//
// Source-agnostic: doesn't care if data came from Bing API, Semrush API, or
// manual CSV upload — all stored uniformly in the table.
//
// Public API:
//   • buildAiVisibilityOverview(db, ownerId, siteSlug) → dashboard payload
//   • buildAiVisibilityForKpi(db, ownerId, siteSlugs)  → Friday KPI integration
//   • upsertSnapshot(db, row) → import helper

import type { SupabaseClient } from '@supabase/supabase-js'

// ── Constants ────────────────────────────────────────────────────────────────

export const LLM_SOURCES = [
  'bing_ai',
  'semrush_overall',
  'chatgpt',
  'gemini',
  'ai_mode',
  'ai_overview',
  'perplexity',
  'claude',
] as const

export type LlmSource = typeof LLM_SOURCES[number]

export const LLM_LABELS: Record<string, { label: string; group: 'bing' | 'semrush' | 'other' }> = {
  bing_ai:         { label: 'Bing AI (Copilot)', group: 'bing' },
  semrush_overall: { label: 'Semrush — Overall', group: 'semrush' },
  chatgpt:         { label: 'ChatGPT',           group: 'semrush' },
  gemini:          { label: 'Gemini',            group: 'semrush' },
  ai_mode:         { label: 'Google AI Mode',    group: 'semrush' },
  ai_overview:     { label: 'Google AI Overview', group: 'semrush' },
  perplexity:      { label: 'Perplexity',         group: 'other' },
  claude:          { label: 'Claude',             group: 'other' },
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface SnapshotRow {
  snapshot_date:  string
  llm_source:     string
  country:        string
  mentions:       number
  citations:      number
  cited_pages:    number
  source:         string
  metadata?:      Record<string, unknown> | null
}

export interface UpsertInput {
  owner_user_id:  string
  site_slug:      string
  snapshot_date:  string  // 'YYYY-MM-DD'
  llm_source:     string
  country?:       string
  mentions?:      number
  citations?:     number
  cited_pages?:   number
  source?:        'manual' | 'csv' | 'bing_api' | 'semrush_api'
  metadata?:      Record<string, unknown>
}

export interface PerLlmSummary {
  llm_source:        string
  label:             string
  group:             'bing' | 'semrush' | 'other'
  latest_date:       string | null
  latest_mentions:   number
  latest_citations:  number
  latest_cited:      number
  // WoW deltas: latest vs ~7 days prior. Null when no prior snapshot.
  mentions_wow_pct:  number | null
  citations_wow_pct: number | null
  cited_wow_pct:     number | null
}

export interface AiVisibilityOverview {
  site_slug:  string
  totals: {
    mentions:    number
    citations:   number
    cited_pages: number
  }
  per_llm:    PerLlmSummary[]
  /** Trend series for chart — last N dates, summed across all llm_sources */
  trend:      Array<{ date: string; mentions: number; citations: number; cited_pages: number }>
  /** When was the most recent data point across all sources */
  data_freshness: { latest: string | null; oldest_in_window: string | null }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build dashboard payload for /reports/ai-visibility.
 * Includes per-LLM summary, totals, and trend series for the last 12 weeks.
 */
export async function buildAiVisibilityOverview(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>,
  ownerId:   string,
  siteSlug:  string,
  windowDays = 84,   // 12 weeks
): Promise<AiVisibilityOverview> {
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10)

  const { data: rows } = await db
    .from('ai_visibility_snapshots')
    .select('snapshot_date, llm_source, country, mentions, citations, cited_pages')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .gte('snapshot_date', sinceIso)
    .order('snapshot_date', { ascending: false })

  const snapshots = (rows ?? []) as Array<{
    snapshot_date: string
    llm_source:    string
    country:       string
    mentions:      number
    citations:     number
    cited_pages:   number
  }>

  // Per-LLM bucketing — pick latest + ~7d-prior per source
  const byLlm = new Map<string, typeof snapshots>()
  for (const s of snapshots) {
    const arr = byLlm.get(s.llm_source) ?? []
    arr.push(s)
    byLlm.set(s.llm_source, arr)
  }

  const perLlm: PerLlmSummary[] = []
  for (const [llm, arr] of byLlm.entries()) {
    // arr is already sorted DESC by date because of outer query order.
    // We may have multiple country rows per date; aggregate them.
    const byDate = new Map<string, { mentions: number; citations: number; cited_pages: number }>()
    for (const r of arr) {
      const cur = byDate.get(r.snapshot_date) ?? { mentions: 0, citations: 0, cited_pages: 0 }
      cur.mentions    += r.mentions
      cur.citations   += r.citations
      cur.cited_pages += r.cited_pages
      byDate.set(r.snapshot_date, cur)
    }
    const dates = Array.from(byDate.keys()).sort().reverse()
    const latestDate = dates[0] ?? null
    const latest = latestDate ? byDate.get(latestDate)! : null

    // WoW: find a date ≥ 5 days before latest
    let priorDate: string | null = null
    if (latestDate) {
      const latestMs = new Date(latestDate).getTime()
      const cutoff   = latestMs - 5 * 86_400_000
      priorDate = dates.find(d => new Date(d).getTime() < cutoff) ?? null
    }
    const prior = priorDate ? byDate.get(priorDate)! : null

    const pct = (cur: number, prev: number | undefined): number | null => {
      if (prev == null || prev <= 0) return cur > 0 ? 100 : null
      return +(((cur - prev) / prev) * 100).toFixed(1)
    }

    const meta = LLM_LABELS[llm] ?? { label: llm, group: 'other' as const }
    perLlm.push({
      llm_source:        llm,
      label:             meta.label,
      group:             meta.group,
      latest_date:       latestDate,
      latest_mentions:   latest?.mentions    ?? 0,
      latest_citations:  latest?.citations   ?? 0,
      latest_cited:      latest?.cited_pages ?? 0,
      mentions_wow_pct:  pct(latest?.mentions    ?? 0, prior?.mentions),
      citations_wow_pct: pct(latest?.citations   ?? 0, prior?.citations),
      cited_wow_pct:     pct(latest?.cited_pages ?? 0, prior?.cited_pages),
    })
  }
  perLlm.sort((a, b) => b.latest_citations - a.latest_citations)

  // Totals: latest snapshot per llm × country, summed
  const seenLatestKey = new Set<string>()
  let totalMentions = 0, totalCitations = 0, totalCited = 0
  for (const s of snapshots) {
    const key = `${s.llm_source}|${s.country}`
    if (seenLatestKey.has(key)) continue
    seenLatestKey.add(key)
    totalMentions  += s.mentions
    totalCitations += s.citations
    totalCited     += s.cited_pages
  }

  // Trend series — sum across all llm × country per date
  const trendMap = new Map<string, { mentions: number; citations: number; cited_pages: number }>()
  for (const s of snapshots) {
    const cur = trendMap.get(s.snapshot_date) ?? { mentions: 0, citations: 0, cited_pages: 0 }
    cur.mentions    += s.mentions
    cur.citations   += s.citations
    cur.cited_pages += s.cited_pages
    trendMap.set(s.snapshot_date, cur)
  }
  const trend = Array.from(trendMap.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const sortedDates = trend.map(t => t.date)

  return {
    site_slug:  siteSlug,
    totals:     { mentions: totalMentions, citations: totalCitations, cited_pages: totalCited },
    per_llm:    perLlm,
    trend,
    data_freshness: {
      latest:           sortedDates[sortedDates.length - 1] ?? null,
      oldest_in_window: sortedDates[0] ?? null,
    },
  }
}

/**
 * Build a compact summary for Friday KPI digest. One row per brand with the
 * 3 most-important numbers + brand-level total WoW deltas.
 */
export interface FridayKpiAiSlice {
  site_slug:        string
  total_mentions:   number
  total_citations:  number
  total_cited:      number
  // Brand-level WoW % (sum of all sources, latest week vs prior week)
  mentions_wow_pct: number | null
  citations_wow_pct: number | null
  cited_wow_pct:    number | null
  // Per-LLM short rows for the message (top 4 by citations)
  top_sources: Array<{ label: string; citations: number; wow_pct: number | null }>
}

export async function buildAiVisibilityForKpi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>,
  ownerId:   string,
  siteSlugs: string[],
): Promise<FridayKpiAiSlice[]> {
  const out: FridayKpiAiSlice[] = []
  for (const slug of siteSlugs) {
    // eslint-disable-next-line no-await-in-loop
    const ov = await buildAiVisibilityOverview(db, ownerId, slug, 28)

    // Brand-level WoW: avg of all LLMs' WoW that exist (skip nulls)
    const avgPct = (arr: Array<number | null>): number | null => {
      const valid = arr.filter((x): x is number => x != null)
      if (valid.length === 0) return null
      return +(valid.reduce((s, x) => s + x, 0) / valid.length).toFixed(1)
    }

    const mentionsWow  = avgPct(ov.per_llm.map(x => x.mentions_wow_pct))
    const citationsWow = avgPct(ov.per_llm.map(x => x.citations_wow_pct))
    const citedWow     = avgPct(ov.per_llm.map(x => x.cited_wow_pct))

    out.push({
      site_slug:        slug,
      total_mentions:   ov.totals.mentions,
      total_citations:  ov.totals.citations,
      total_cited:      ov.totals.cited_pages,
      mentions_wow_pct: mentionsWow,
      citations_wow_pct: citationsWow,
      cited_wow_pct:    citedWow,
      top_sources: ov.per_llm.slice(0, 4).map(s => ({
        label:     s.label,
        citations: s.latest_citations,
        wow_pct:   s.citations_wow_pct,
      })),
    })
  }
  return out
}

/**
 * Upsert a snapshot row. Used by both manual import endpoint and (future)
 * automated API pull crons.
 */
export async function upsertSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:    SupabaseClient<any>,
  input: UpsertInput,
): Promise<{ ok: boolean; error?: string }> {
  if (!input.owner_user_id || !input.site_slug) {
    return { ok: false, error: 'owner_user_id + site_slug required' }
  }
  if (!input.snapshot_date || !/^\d{4}-\d{2}-\d{2}$/.test(input.snapshot_date)) {
    return { ok: false, error: 'snapshot_date must be YYYY-MM-DD' }
  }
  if (!input.llm_source?.trim()) {
    return { ok: false, error: 'llm_source required' }
  }

  const { error } = await db
    .from('ai_visibility_snapshots')
    .upsert({
      owner_user_id: input.owner_user_id,
      site_slug:     input.site_slug,
      snapshot_date: input.snapshot_date,
      llm_source:    input.llm_source.trim().toLowerCase(),
      country:       input.country?.trim().toLowerCase() || 'global',
      mentions:      Math.max(0, Math.round(input.mentions    ?? 0)),
      citations:     Math.max(0, Math.round(input.citations   ?? 0)),
      cited_pages:   Math.max(0, Math.round(input.cited_pages ?? 0)),
      source:        input.source ?? 'manual',
      metadata:      input.metadata ?? null,
    }, { onConflict: 'owner_user_id,site_slug,snapshot_date,llm_source,country' })

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
