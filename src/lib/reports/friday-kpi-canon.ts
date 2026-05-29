// ── Friday KPI canon source resolver ───────────────────────────────────────
//
// Sprint FRIDAY.KPI.GRAPH.1 — single source of truth for "which data source
// should this owner's Friday KPI report use as authoritative". Defaults to
// 'gsc' since real impressions reflect actual business impact better than
// DFS-scraped intent rankings.
//
// Used by:
//   • src/lib/reports/friday-kpi.ts — buildBrandKpi branches on canon
//   • UI badge in /reports/friday-kpi page ("Source: GSC" tag)
//   • PNG renderer ("Source: GSC" subtitle in screenshot)

import type { SupabaseClient } from '@supabase/supabase-js'

export type CanonSource = 'dfs' | 'gsc'

const DEFAULT_CANON: CanonSource = 'gsc'

/**
 * Resolve canon source for the given workspace owner. Falls back to 'gsc' if
 * no config row exists (table empty or new workspace).
 */
export async function getFridayKpiCanon(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:      SupabaseClient<any>,
  ownerId: string,
): Promise<CanonSource> {
  try {
    const { data } = await db
      .from('friday_kpi_config')
      .select('canon_source')
      .eq('owner_user_id', ownerId)
      .maybeSingle()
    if (data?.canon_source === 'dfs' || data?.canon_source === 'gsc') return data.canon_source
  } catch {
    // table doesn't exist or query failed — use default
  }
  return DEFAULT_CANON
}

/** Update or insert the canon for an owner. */
export async function setFridayKpiCanon(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any>,
  ownerId:  string,
  canon:    CanonSource,
): Promise<{ ok: boolean; error?: string }> {
  if (canon !== 'dfs' && canon !== 'gsc') {
    return { ok: false, error: 'canon must be "dfs" or "gsc"' }
  }
  const { error } = await db
    .from('friday_kpi_config')
    .upsert({
      owner_user_id: ownerId,
      canon_source:  canon,
      updated_at:    new Date().toISOString(),
    }, { onConflict: 'owner_user_id' })
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
