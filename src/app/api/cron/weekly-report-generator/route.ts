import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { buildWeeklyReportPptx, type WeeklyReportData } from '@/lib/reports/pptx-builder-weekly'
import { uploadFileToDrive } from '@/lib/google/drive'
import { resolveSlackWebhook } from '@/lib/slack/routing'

export const maxDuration = 300

/**
 * GET /api/cron/weekly-report-generator
 *
 * Runs every Monday at 01:00 UTC (08:00 WIB) via GitHub Actions. Per (owner ×
 * active site) pair:
 *   1. POST /api/reports/weekly to generate the report row (existing flow)
 *   2. Build the PPTX deck from the freshly-stored report_data
 *   3. Upload PPTX to Google Drive (configured folder)
 *   4. Post a Slack message with:
 *        - Brand + week label
 *        - 3 headline KPIs (clicks, impressions, avg position)
 *        - Link to in-tool report viewer
 *        - Direct PPTX download link
 *
 * Failures isolated per (owner × site) — one bad combo doesn't block others.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: owners, error: ownersErr } = await db
    .from('gsc_connections')
    .select('user_id')

  if (ownersErr) return NextResponse.json({ error: ownersErr.message }, { status: 500 })

  const uniqueOwners = Array.from(new Set((owners ?? []).map(o => o.user_id as string)))
  if (uniqueOwners.length === 0) {
    return NextResponse.json({ message: 'No active owners — nothing to generate.' })
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')
  if (!appUrl) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL not configured' }, { status: 500 })
  }

  const { data: sites } = await db
    .from('site_configs')
    .select('slug')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })

  const activeSlugs: string[] = (sites ?? []).map(s => s.slug as string)
  if (activeSlugs.length === 0) activeSlugs.push('g2g')

  const results: Record<string, Record<string, unknown>> = {}
  let totalTriggered = 0
  let totalDelivered = 0

  for (const ownerId of uniqueOwners) {
    results[ownerId] = {}
    for (const siteSlug of activeSlugs) {
      totalTriggered++
      try {
        // ── 1. Generate the report row ──────────────────────────────────────
        const res = await fetch(`${appUrl}/api/reports/weekly`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${process.env.CRON_SECRET}`,
          },
          body: JSON.stringify({
            owner_user_id: ownerId,
            site:          siteSlug,
          }),
        })

        const payload = await res.json().catch(() => null) as { report?: { id?: string } } | null
        const reportId = payload?.report?.id ?? null
        if (!res.ok || !reportId) {
          results[ownerId][siteSlug] = { ok: false, status: res.status, error: 'report generation failed' }
          continue
        }

        // ── 2. Build PPTX + 3. Upload to Drive + 4. Post Slack ──────────────
        const delivery = await deliverWeeklyPptx(db, ownerId, siteSlug, reportId)
        results[ownerId][siteSlug] = { ok: true, reportId, ...delivery }
        if (delivery.slack_posted) totalDelivered++

      } catch (err) {
        results[ownerId][siteSlug] = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  return NextResponse.json({
    triggered: totalTriggered,
    delivered: totalDelivered,
    owners:    uniqueOwners.length,
    sites:     activeSlugs,
    results,
  })
}

// ─── PPTX build → Drive upload → Slack post ─────────────────────────────────

interface DeliveryResult {
  pptx_url?:     string
  drive_id?:     string
  slack_posted?: boolean
  notes?:        string[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deliverWeeklyPptx(db: any, ownerId: string, siteSlug: string, reportId: string): Promise<DeliveryResult> {
  const notes: string[] = []
  const result: DeliveryResult = { notes }

  // Re-load the just-saved report (cron flow doesn't have user-context auth,
  // so call the DB directly via service-role client).
  const { data: report } = await db
    .from('weekly_reports')
    .select('id, week_start, week_end, site_slug, report_data, ai_narrative, ai_action_plan')
    .eq('id', reportId)
    .eq('owner_user_id', ownerId)
    .single()

  if (!report) {
    notes.push('Report row not found after generation')
    return result
  }

  // ── Build PPTX ─────────────────────────────────────────────────────────
  const wpd = adaptToWeeklyReportData(report)
  let pptxBuffer: Buffer
  try {
    pptxBuffer = await buildWeeklyReportPptx({
      reportData:   wpd,
      aiNarrative:  String(report.ai_narrative   ?? ''),
      aiActionPlan: String(report.ai_action_plan ?? ''),
      theme:        siteSlug === 'offgamers' ? { accent: '2563EB' } : undefined,
    })
  } catch (e) {
    notes.push(`PPTX build failed: ${e instanceof Error ? e.message : String(e)}`)
    return result
  }

  // ── Upload to Drive ────────────────────────────────────────────────────
  const brand = wpd.siteName.replace(/[^a-z0-9 _-]/gi, '')
  const filename = `${brand} Weekly Report — ${wpd.weekLabel.replace(/\s+/g, '-')}.pptx`

  try {
    const uploaded = await uploadFileToDrive(
      pptxBuffer,
      filename,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      { makePublic: true },
    )
    result.pptx_url = uploaded.webViewLink
    result.drive_id = uploaded.id
  } catch (e) {
    notes.push(`Drive upload failed: ${e instanceof Error ? e.message : String(e)}`)
    // Continue — we can still post a Slack message with just the dashboard link.
  }

  // ── Post to Slack ──────────────────────────────────────────────────────
  // Sprint MULTI.3 — routed per-owner for weekly_report
  const webhookUrl = await resolveSlackWebhook(db, ownerId, 'weekly_report', { siteSlug })
  if (!webhookUrl) {
    notes.push('No Slack webhook resolved (config + env both empty) — skipping Slack delivery')
    return result
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')
  const dashboardUrl = `${appUrl}/${siteSlug}/reports/weekly?id=${reportId}`

  // Headline KPI summary for the Slack message
  const g = wpd.gsc
  const summaryLines: string[] = []
  if (g) {
    summaryLines.push(`• Clicks: *${fmtNum(g.weekClicks)}*${fmtDelta(g.clicksPct)}`)
    summaryLines.push(`• Impressions: *${fmtNum(g.weekImpressions)}*${fmtDelta(g.impressionsPct)}`)
    summaryLines.push(`• Avg position: *#${g.avgPosition?.toFixed(1) ?? '—'}*`)
    if (g.topGainers?.length) {
      const top = g.topGainers[0]
      summaryLines.push(`• Top gainer: \`${truncate(top.page.replace(/^https?:\/\//, ''), 40)}\` (+${fmtNum(top.delta)} clicks)`)
    }
  } else {
    summaryLines.push('_GSC data unavailable for this week._')
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📊 ${brand} Weekly Report — ${wpd.weekLabel}`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: summaryLines.join('\n') },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '📄 View in Dashboard' },
          url:  dashboardUrl,
        },
        ...(result.pptx_url ? [{
          type: 'button',
          text: { type: 'plain_text', text: '⬇ Download PPTX' },
          url:  result.pptx_url,
        }] : []),
      ],
    },
  ]

  try {
    const slackRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    })
    if (slackRes.ok) {
      result.slack_posted = true
    } else {
      notes.push(`Slack post failed: ${slackRes.status} ${await slackRes.text()}`)
    }
  } catch (e) {
    notes.push(`Slack post threw: ${e instanceof Error ? e.message : String(e)}`)
  }

  return result
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adaptToWeeklyReportData(report: any): WeeklyReportData {
  const rd = (report.report_data ?? {}) as Record<string, unknown>
  const startFmt = new Date(report.week_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const endFmt   = new Date(report.week_end)  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return {
    weekStart:   report.week_start,
    weekEnd:     report.week_end,
    weekLabel:   (rd.weekLabel as string) ?? `${startFmt}–${endFmt}`,
    prevLabel:   (rd.prevWeekLabel as string) ?? 'previous week',
    siteSlug:    report.site_slug,
    siteName:    (rd.siteName as string) ?? (report.site_slug === 'offgamers' ? 'OffGamers' : 'G2G'),
    generatedAt: (rd.generatedAt as string) ?? new Date().toISOString(),
    gsc:         (rd.gsc ?? null) as WeeklyReportData['gsc'],
  }
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function fmtDelta(pct: number | null | undefined): string {
  if (pct == null) return ''
  const sign = pct >= 0 ? '+' : ''
  const arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '→'
  return ` (${arrow} ${sign}${pct}%)`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}
