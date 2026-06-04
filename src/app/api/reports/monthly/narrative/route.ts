// Sprint #358 MONTHLY.SPLIT — AI narrative generator endpoint.
//
// The main /api/reports/monthly POST now only gathers data + saves the
// row (fits ~30s, < Vercel Hobby 60s cap). This endpoint fills in the
// remaining AI fields:
//   - ai_narrative       (4-5 paragraph exec summary, Opus)
//   - ai_action_plan     (6 prioritised tasks, Opus)
//   - report_data.trackedRankings.actionPlan  (per-product action items, Sonnet)
//
// Called automatically by the frontend right after generate() returns.
//
// Auth: same as parent route (user session OR Bearer CRON_SECRET).
//
// POST /api/reports/monthly/narrative
// Body: { id: string, owner_user_id?: string (cron only) }
// Returns: { ok: true, report: <updated row> } | { ok: false, error: string }

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { buildNarrativePrompt } from '@/lib/reports/monthly-narrative-prompt'
import { generateActionPlan } from '@/lib/reports/ranking-analysis'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60   // 1 Anthropic Opus call (~30-40s) + 1 Sonnet call (~15-20s)
export const dynamic     = 'force-dynamic'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: Request) {
  const body = await req.clone().json().catch(() => ({})) as { id?: string; owner_user_id?: string }
  const db   = createServiceClient()

  if (!body.id) {
    return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })
  }

  // Auth: user session OR Bearer CRON_SECRET
  const authHeader = req.headers.get('authorization')
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`

  let ownerId: string
  if (isCron) {
    if (!body.owner_user_id) {
      return NextResponse.json({ ok: false, error: 'Cron mode requires body.owner_user_id' }, { status: 400 })
    }
    ownerId = body.owner_user_id
  } else {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    ownerId = await getEffectiveOwnerId(supabase, user.id)
  }

  // ── Load the row ──────────────────────────────────────────────────────────
  const { data: row, error: loadErr } = await db
    .from('monthly_reports')
    .select('*')
    .eq('id', body.id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()

  if (loadErr)  return NextResponse.json({ ok: false, error: loadErr.message }, { status: 500 })
  if (!row)     return NextResponse.json({ ok: false, error: 'Report not found' }, { status: 404 })

  const reportData = row.report_data as Parameters<typeof buildNarrativePrompt>[0] & {
    siteSlug?: string
    trackedRankings?: {
      bucketsCur:   Parameters<typeof generateActionPlan>[0]['buckets']
      movements:    Parameters<typeof generateActionPlan>[0]['movements']
      actionPlan?:  unknown[] | null
      siteSlug?:    string
      periodStart:  string
      periodEnd:    string
    } | null
    siteName?: string
  }

  // Look up faviconDomain for the tracked-rankings action plan prompt.
  // Defaults to g2g.com for legacy rows (pre-multi-site).
  const slug = reportData.siteSlug ?? (row.site_slug as string | undefined) ?? 'g2g'
  const { data: siteConfig } = await db
    .from('site_configs')
    .select('favicon_domain')
    .eq('slug', slug)
    .maybeSingle()
  const faviconDomain = siteConfig?.favicon_domain ?? 'g2g.com'

  // ── Generate executive narrative (Opus) ──────────────────────────────────
  let aiNarrative  = ''
  let aiActionPlan = ''

  try {
    const prompt = buildNarrativePrompt(reportData)
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    })
    const raw = msg.content[0]?.type === 'text' ? msg.content[0].text : ''
    const [narrativePart, actionPart] = raw.split(/\n---ACTION_PLAN---\n/)
    aiNarrative  = narrativePart?.trim() ?? raw
    aiActionPlan = actionPart?.trim() ?? ''
  } catch (e) {
    console.warn('[monthly-narrative] Opus narrative failed:', e)
    aiNarrative  = '_AI narrative could not be generated. Check Anthropic API key._'
    aiActionPlan = ''
  }

  // ── Backfill trackedRankings.actionPlan (Sonnet) ─────────────────────────
  // Hot path called analyzeTrackedRankings with withActionPlan: false to
  // skip this AI call. Now we generate it from the SAVED movements +
  // buckets — no DataForSEO refetch needed.
  let updatedReportData = reportData
  const tr = reportData.trackedRankings
  if (tr && tr.movements && tr.bucketsCur && !tr.actionPlan) {
    try {
      const actionPlan = await generateActionPlan({
        siteName:    reportData.siteName ?? 'G2G',
        domain:      faviconDomain,
        movements:   tr.movements,
        buckets:     tr.bucketsCur,
        periodLabel: `${tr.periodStart} → ${tr.periodEnd}`,
      })
      updatedReportData = {
        ...reportData,
        trackedRankings: { ...tr, actionPlan },
      }
    } catch (e) {
      console.warn('[monthly-narrative] tracked-rankings action plan failed:', e)
      // Leave trackedRankings.actionPlan null — UI handles gracefully.
    }
  }

  // ── Persist updates ───────────────────────────────────────────────────────
  const { data: updated, error: updateErr } = await db
    .from('monthly_reports')
    .update({
      ai_narrative:   aiNarrative,
      ai_action_plan: aiActionPlan,
      report_data:    updatedReportData,
    })
    .eq('id', body.id)
    .eq('owner_user_id', ownerId)
    .select()
    .single()

  if (updateErr) return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 })
  return NextResponse.json({ ok: true, report: updated })
}
