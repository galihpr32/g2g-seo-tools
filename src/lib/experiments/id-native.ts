// Sprint BRAGI.ID.NATIVE — A/B variant assignment for ID-native experiment.
//
// Strategy: Random 50/50 across T1+T2 briefs (Galih confirmed). T0 + non-
// tier briefs aren't enrolled — too low volume to add statistical noise.
//
// Deterministic randomness: we hash brief_id into [0,1) instead of calling
// Math.random(). Two reasons:
//   1. Idempotency — re-running variant assignment yields the same answer,
//      so the experiment can't flip mid-flight if a brief is regenerated.
//   2. Reproducibility — if Galih wants to inspect "which 50% would have
//      been id_native", he can hash brief_ids offline and check.
//
// Locked flag: once assigned + persisted, we never reassign. The "locked"
// column is the safety net against bugs that try to flip variants on
// regenerate.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { TierLevel } from '@/lib/anthropic/model-tier'

export type IdVariant = 'en_translate' | 'id_native'

/** Tiers that get enrolled in the experiment. Editing this list = changing the cohort. */
export const ENROLLED_TIERS: ReadonlyArray<TierLevel> = [1, 2]

/** Override the experiment via env. Useful for "freeze cohort to en_translate" rollback. */
const FORCE_VARIANT = (process.env.ID_EXPERIMENT_FORCE ?? '').toLowerCase() as IdVariant | ''

/**
 * Deterministically map a string id to a Uint32 hash. Simple FNV-1a — good
 * enough for cohort splitting; not cryptographic.
 */
function hash32(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Decide which variant a (brief_id, tier) pair should run. Returns null
 * when the brief isn't enrolled (not in T1/T2). Caller persists the result.
 */
export function pickIdVariant(briefId: string, tier: TierLevel): IdVariant | null {
  if (!ENROLLED_TIERS.includes(tier)) return null
  if (FORCE_VARIANT === 'en_translate' || FORCE_VARIANT === 'id_native') {
    return FORCE_VARIANT
  }
  // 50/50 split: even hash → en_translate, odd → id_native.
  return hash32(briefId) % 2 === 0 ? 'en_translate' : 'id_native'
}

interface AssignResult {
  ok:        boolean
  variant:   IdVariant | null
  source:    'existing' | 'newly_assigned' | 'not_enrolled' | 'forced'
  error?:    string
}

/**
 * Ensure a brief has a variant assigned. Idempotent — repeat calls return
 * the existing variant. Honours the `id_experiment_locked` flag.
 *
 * @returns the variant in use, or null when the brief is not enrolled
 *          (e.g. T0 / non-tier).
 */
export async function ensureIdVariantForBrief(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:      SupabaseClient<any>,
  briefId: string,
  tier:    TierLevel,
): Promise<AssignResult> {
  // 1. Read current state — never overwrite a locked variant.
  const { data: row, error: readErr } = await db
    .from('seo_content_briefs')
    .select('id_experiment_variant, id_experiment_locked')
    .eq('id', briefId)
    .maybeSingle()
  if (readErr) return { ok: false, variant: null, source: 'not_enrolled', error: readErr.message }

  const existing = (row?.id_experiment_variant ?? null) as IdVariant | null
  const locked   = Boolean(row?.id_experiment_locked)
  if (existing && locked) return { ok: true, variant: existing, source: 'existing' }

  // 2. Compute the variant.
  const variant = pickIdVariant(briefId, tier)
  if (!variant) {
    return { ok: true, variant: null, source: 'not_enrolled' }
  }

  // 3. Persist (and lock so future calls don't flip).
  const { error: upErr } = await db
    .from('seo_content_briefs')
    .update({
      id_experiment_variant:     variant,
      id_experiment_assigned_at: new Date().toISOString(),
      id_experiment_locked:      true,
      updated_at:                new Date().toISOString(),
    })
    .eq('id', briefId)
  if (upErr) return { ok: false, variant, source: 'newly_assigned', error: upErr.message }

  return {
    ok:      true,
    variant,
    source:  FORCE_VARIANT ? 'forced' : 'newly_assigned',
  }
}
