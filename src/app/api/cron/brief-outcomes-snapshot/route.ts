import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSearchAnalytics } from '@/lib/gsc/client'

export const maxDuration = 120

/**
 * GET /api/cron/brief-outcomes-snapshot
 *
 * Daily cron — captures GSC ranking snapshots for every published brief at
 * the +30d / +60d / +90d checkpoints. This is what the Ranking Impact
 * Tracker page reads from. Without this cron, all rows show "Not enough
 * data" forever.
 *
 * For each brief_outcomes row where the corresponding checkpoint is due
 * (i.e. published_at + Nd <= today AND pos_N IS NULL), this fetches the
 * page's position + clicks + impressions from GSC for the previous 7 days
 * (rolling avg) and writes it into pos_N / clicks_N / impressions_N.
 *
 * Auth: Bearer ${CRON_SECRET}
 */

const CHECKPOINTS = [30, 60, 90] as const

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

interface BriefOutcomeRow {
  id:               string
  brief_id:         string
  owner_user_id:    string
  page_url:         string
  primary_keyword:  string | null
  published_at:     string | null
  pos_0:            number | null
  pos_30:           number | null
  pos_60:           number | null
  pos_90:           number | null
}

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServiceClient()

  // Pull all outcome rows that have a published_at and at least one missing
  // checkpoint that is now overdue.
  const { data: outcomes } = await db
    .from('brief_outcomes')
    .select('id, brief_id, owner_user_id, page_url, primary_keyword, published_at, pos_0, pos_30, pos_60, pos_90')
    .not('published_at', 'is', null)

  const rows = (outcomes ?? []) as BriefOutcomeRow[]
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, message: 'No published briefs with outcomes', processed: 0 })
  }

  // Group by owner so we can re-use a single GSC auth client per workspace.
  const byOwner = new Map<string, BriefOutcomeRow[]>()
  for (const r of rows) {
    const arr = byOwner.get(r.owner_user_id) ?? []
    arr.push(r)
    byOwner.set(r.owner_user_id, arr)
  }

  const today    = new Date()
  let totalProcessed = 0
  let totalSnapshots = 0
  const results: Array<{ ownerId: string; processed: number; warnings: string[] }> = []

  for (const [ownerId, ownerRows] of byOwner) {
    const warnings: string[] = []
    let ownerProcessed = 0

    // Find this owner's GSC connection
    const { data: conn } = await db
      .from('gsc_connections')
      .select('access_token, refresh_token, expires_at, site_url')
      .eq('user_id', ownerId)
      .maybeSingle()

    if (!conn?.access_token || !conn?.site_url) {
      warnings.push('No GSC connection — skipping owner')
      results.push({ ownerId, processed: 0, warnings })
      continue
    }

    let auth
    try {
      auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
    } catch (err) {
      warnings.push(`GSC auth failed: ${err instanceof Error ? err.message : String(err)}`)
      results.push({ ownerId, processed: 0, warnings })
      continue
    }

    for (const row of ownerRows) {
      if (!row.published_at) continue
      const publishedAt = new Date(row.published_at)
      const ageDays = Math.floor((today.getTime() - publishedAt.getTime()) / 86400000)

      // Determine which checkpoints are due (≥ N days passed) AND missing.
      const dueCheckpoints = CHECKPOINTS.filter(cp => {
        const colName: keyof BriefOutcomeRow = `pos_${cp}` as keyof BriefOutcomeRow
        return ageDays >= cp && row[colName] == null
      })

      if (dueCheckpoints.length === 0) continue

      for (const cp of dueCheckpoints) {
        // Snapshot window: rolling 7-day ending at exactly +Nd from publish.
        // (E.g., for +30d, we sum the 7 days ending publish_date+30.)
        const windowEnd   = new Date(publishedAt.getTime() + cp * 86400000)
        const windowStart = new Date(windowEnd.getTime() - 7 * 86400000)
        // GSC max usable date = today - 2 (data lag). If checkpoint window
        // extends into the future, clamp.
        const maxQueryDate = new Date(today.getTime() - 2 * 86400000)
        if (windowEnd > maxQueryDate) {
          // Should not happen if ageDays >= cp, but defend.
          continue
        }

        try {
          const gscRows = await getSearchAnalytics(
            auth, conn.site_url, fmtDate(windowStart), fmtDate(windowEnd),
            ['page'], 5000,
          )
          // Find the matching page (URL exact OR pathname match)
          const target = (gscRows ?? []).find(g => {
            const p = g.keys?.[0] ?? ''
            return p === row.page_url || p.endsWith(new URL(row.page_url, 'https://x').pathname)
          })

          const update: Record<string, unknown> = {}
          update[`pos_${cp}`]         = target?.position ?? null
          update[`clicks_${cp}`]      = target?.clicks ?? 0
          update[`impressions_${cp}`] = target?.impressions ?? 0
          update[`snapshot_${cp}_at`] = new Date().toISOString()

          await db.from('brief_outcomes').update(update).eq('id', row.id)
          totalSnapshots++
          ownerProcessed++
        } catch (err) {
          warnings.push(`brief ${row.brief_id} cp+${cp}d failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      totalProcessed++
    }

    results.push({ ownerId, processed: ownerProcessed, warnings })
  }

  return NextResponse.json({
    ok:               true,
    workspaces:       byOwner.size,
    rowsScanned:      rows.length,
    rowsProcessed:    totalProcessed,
    snapshotsTaken:   totalSnapshots,
    results,
  })
}
