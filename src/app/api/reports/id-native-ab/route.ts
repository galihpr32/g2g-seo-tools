import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 30

/**
 * GET /api/reports/id-native-ab?days=30
 *
 * Sprint BRAGI.ID.NATIVE — A/B summary for ID-native vs EN-translate.
 *
 * Joins seo_content_briefs (variant) × gsc_ranking_snapshots (clicks/imps)
 * × brief_review_feedback (acceptance) and returns per-variant aggregates
 * plus a combined score per Galih's spec.
 *
 * The "combined metric" is:
 *   normalized_clicks (0-1)   weight 0.40
 * + normalized_ctr    (0-1)   weight 0.30
 * + acceptance_rate   (0-1)   weight 0.30
 *
 * Normalization is min-max across the two variants so the score is a
 * relative comparison rather than absolute. Whichever variant is higher
 * wins.
 *
 * Note: this report is most meaningful AFTER ~4 weeks of data so each
 * variant has settled in the SERP. Reading it on Day 3 is just noise.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { searchParams } = new URL(req.url)
  const days = Math.min(180, Math.max(1, parseInt(searchParams.get('days') ?? '30', 10)))
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString()

  // 1. Enrolled briefs in the window, with variant assignment.
  const { data: briefs } = await db
    .from('seo_content_briefs')
    .select('id, page, primary_keyword, id_experiment_variant, id_experiment_assigned_at')
    .eq('owner_user_id', ownerId)
    .not('id_experiment_variant', 'is', null)
    .gte('id_experiment_assigned_at', sinceIso)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const briefRows = (briefs ?? []) as any[]

  if (briefRows.length === 0) {
    return NextResponse.json({
      ok: true,
      window_days: days,
      message: 'No enrolled briefs in this window. Variants are assigned at brief generation; run /api/brief/generate on a T1/T2 page to enroll one.',
      variants: emptyVariantSummary(),
    })
  }

  // 2. Aggregate per variant — clicks/impressions (most-recent GSC snapshot per page).
  // We use snapshot_date >= 14 days ago so we don't compare brand-new variants to
  // long-running ones; effectively the latest 2 weeks of traffic.
  const pages = Array.from(new Set(briefRows.map(b => String(b.page)).filter(Boolean)))
  const gscSince = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)
  const { data: snaps } = pages.length > 0
    ? await db
        .from('gsc_ranking_snapshots')
        .select('page, clicks, impressions, ctr, snapshot_date')
        .in('page', pages)
        .gte('snapshot_date', gscSince)
    : { data: [] }

  // Latest snapshot per page (assumes daily writes)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latestByPage = new Map<string, { clicks: number; impressions: number; ctr: number }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const s of (snaps ?? []) as any[]) {
    const page = String(s.page)
    const cur = latestByPage.get(page)
    if (!cur) latestByPage.set(page, {
      clicks:      Number(s.clicks ?? 0),
      impressions: Number(s.impressions ?? 0),
      ctr:         Number(s.ctr ?? 0),
    })
  }

  // 3. Brief reviewer feedback — acceptance rate per variant.
  const briefIds = briefRows.map(b => String(b.id))
  const { data: feedback } = briefIds.length > 0
    ? await db
        .from('brief_review_feedback')
        .select('brief_id, accepted')
        .in('brief_id', briefIds)
    : { data: [] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feedbackByBrief = new Map<string, boolean[]>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const f of (feedback ?? []) as any[]) {
    const k = String(f.brief_id)
    const list = feedbackByBrief.get(k) ?? []
    list.push(Boolean(f.accepted))
    feedbackByBrief.set(k, list)
  }

  // 4. Aggregate per variant
  type Bucket = {
    briefs:          number
    pages_with_gsc:  number
    total_clicks:    number
    total_imps:      number
    accepted:        number
    feedback_count:  number
  }
  const variants: Record<'en_translate' | 'id_native', Bucket> = {
    en_translate: { briefs: 0, pages_with_gsc: 0, total_clicks: 0, total_imps: 0, accepted: 0, feedback_count: 0 },
    id_native:    { briefs: 0, pages_with_gsc: 0, total_clicks: 0, total_imps: 0, accepted: 0, feedback_count: 0 },
  }

  for (const b of briefRows) {
    const v = b.id_experiment_variant as 'en_translate' | 'id_native'
    const bucket = variants[v]
    if (!bucket) continue
    bucket.briefs++

    const gsc = latestByPage.get(String(b.page))
    if (gsc) {
      bucket.pages_with_gsc++
      bucket.total_clicks += gsc.clicks
      bucket.total_imps   += gsc.impressions
    }

    const fb = feedbackByBrief.get(String(b.id))
    if (fb && fb.length) {
      bucket.accepted       += fb.filter(Boolean).length
      bucket.feedback_count += fb.length
    }
  }

  // 5. Compute summary metrics + combined score
  const en = summarize(variants.en_translate)
  const id = summarize(variants.id_native)
  const combined = computeCombinedScores(en, id)

  return NextResponse.json({
    ok:           true,
    window_days:  days,
    cohort_size:  briefRows.length,
    variants: {
      en_translate: { ...en, combined_score: combined.en },
      id_native:    { ...id, combined_score: combined.id },
    },
    winner: combined.winner,
    note:   briefRows.length < 30
      ? 'Cohort < 30 briefs — results are directional, not significant. Wait for more data.'
      : 'Cohort size sufficient for directional read; statistical significance requires ≥100 briefs/variant.',
  })
}

function emptyVariantSummary() {
  const empty = summarize({ briefs: 0, pages_with_gsc: 0, total_clicks: 0, total_imps: 0, accepted: 0, feedback_count: 0 })
  return {
    en_translate: { ...empty, combined_score: 0 },
    id_native:    { ...empty, combined_score: 0 },
  }
}

function summarize(b: { briefs: number; pages_with_gsc: number; total_clicks: number; total_imps: number; accepted: number; feedback_count: number }) {
  return {
    briefs:           b.briefs,
    pages_with_gsc:   b.pages_with_gsc,
    total_clicks:     b.total_clicks,
    total_impressions: b.total_imps,
    avg_ctr:          b.total_imps > 0 ? +(b.total_clicks / b.total_imps).toFixed(4) : 0,
    feedback_count:   b.feedback_count,
    acceptance_rate:  b.feedback_count > 0 ? +(b.accepted / b.feedback_count).toFixed(3) : 0,
  }
}

interface VariantSummary {
  total_clicks:     number
  avg_ctr:          number
  acceptance_rate:  number
}

function computeCombinedScores(en: VariantSummary, id: VariantSummary) {
  // Min-max normalization across the two variants per metric.
  const norm = (a: number, b: number) => {
    const min = Math.min(a, b)
    const max = Math.max(a, b)
    if (max - min < 1e-9) return { a: 0.5, b: 0.5 }   // tie
    return { a: (a - min) / (max - min), b: (b - min) / (max - min) }
  }
  const nClicks = norm(en.total_clicks,    id.total_clicks)
  const nCtr    = norm(en.avg_ctr,         id.avg_ctr)
  const nAccept = norm(en.acceptance_rate, id.acceptance_rate)

  const enScore = nClicks.a * 0.40 + nCtr.a * 0.30 + nAccept.a * 0.30
  const idScore = nClicks.b * 0.40 + nCtr.b * 0.30 + nAccept.b * 0.30

  const winner: 'en_translate' | 'id_native' | 'tie' =
    Math.abs(enScore - idScore) < 0.05 ? 'tie' : enScore > idScore ? 'en_translate' : 'id_native'

  return { en: +enScore.toFixed(3), id: +idScore.toFixed(3), winner }
}
