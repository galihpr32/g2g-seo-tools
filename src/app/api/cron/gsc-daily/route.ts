import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getRefreshedClient } from '@/lib/gsc/auth'
import {
  getSearchAnalytics,
  getDateRange,
  detectRankingDrops,
  getCWVData,
  type RankingRow,
} from '@/lib/gsc/client'
import {
  sendRankingDropAlert,
  sendIndexCoverageAlert,
  sendCWVAlert,
} from '@/lib/slack/alerts'

// Vercel cron security
export const maxDuration = 60

function verifyAuth(request: Request) {
  const authHeader = request.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(request: Request) {
  if (!verifyAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Get all GSC connections
  const { data: connections } = await supabase
    .from('gsc_connections')
    .select('*')

  if (!connections?.length) {
    return NextResponse.json({ message: 'No connections found' })
  }

  const results: Record<string, unknown> = {}

  for (const conn of connections) {
    try {
      const auth = await getRefreshedClient(
        conn.access_token,
        conn.refresh_token,
        conn.expires_at
      )
      const siteUrl = conn.site_url

      // ── Task 1: Ranking Drop Alert ──────────────────────────────────────
      const [currentRows, previousRows] = await Promise.all([
        getSearchAnalytics(auth, siteUrl, getDateRange(7), getDateRange(1)),
        getSearchAnalytics(auth, siteUrl, getDateRange(14), getDateRange(8)),
      ])

      const toRankingRow = (rows: typeof currentRows): RankingRow[] =>
        rows.map(r => ({
          page: r.keys?.[0] ?? '',
          clicks: r.clicks ?? 0,
          impressions: r.impressions ?? 0,
          ctr: r.ctr ?? 0,
          position: r.position ?? 0,
        }))

      const drops = detectRankingDrops(toRankingRow(currentRows), toRankingRow(previousRows))

      // Save ranking snapshot
      const today = getDateRange(0)
      const rankingInserts = toRankingRow(currentRows).map(r => ({
        site_url: siteUrl,
        snapshot_date: today,
        page: r.page,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }))
      if (rankingInserts.length) {
        await supabase.from('gsc_ranking_snapshots').upsert(rankingInserts, {
          onConflict: 'site_url,snapshot_date,page',
          ignoreDuplicates: true,
        })
      }

      if (drops.length) {
        await sendRankingDropAlert(drops)
        await supabase.from('alert_log').insert({
          alert_type: 'ranking_drop',
          site_url: siteUrl,
          title: `${drops.length} pages dropped >15% WoW`,
          message: drops.map(d => d.page).join(', '),
          severity: drops.length > 5 ? 'critical' : 'warning',
          slack_sent: true,
          metadata: { drops },
        })
      }

      // ── Task 2: Index Coverage ──────────────────────────────────────────
      // Approximate: count total unique pages appearing in search analytics
      const totalIndexed = currentRows.length

      const { data: prevSnapshot } = await supabase
        .from('gsc_index_snapshots')
        .select('indexed_pages, errors')
        .eq('site_url', siteUrl)
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .single()

      const prevIndexed = prevSnapshot?.indexed_pages ?? totalIndexed
      const prevErrors = prevSnapshot?.errors ?? 0

      await supabase.from('gsc_index_snapshots').upsert({
        site_url: siteUrl,
        snapshot_date: today,
        indexed_pages: totalIndexed,
        errors: 0, // Updated when URL inspection API is wired in
      }, { onConflict: 'site_url,snapshot_date' })

      await sendIndexCoverageAlert({
        indexedPages: totalIndexed,
        previousIndexed: prevIndexed,
        errors: 0,
        previousErrors: prevErrors,
      })

      // ── Task 3: Core Web Vitals ─────────────────────────────────────────
      const origin = new URL(siteUrl.replace('sc-domain:', 'https://')).origin
      const cwv = await getCWVData(origin)

      if (cwv) {
        const { data: prevCWV } = await supabase
          .from('gsc_cwv_snapshots')
          .select('*')
          .eq('site_url', siteUrl)
          .order('snapshot_date', { ascending: false })
          .limit(1)
          .single()

        await supabase.from('gsc_cwv_snapshots').upsert({
          site_url: siteUrl,
          snapshot_date: today,
          origin,
          lcp_good: cwv.lcp.good,
          lcp_ni: cwv.lcp.ni,
          lcp_poor: cwv.lcp.poor,
          cls_good: cwv.cls.good,
          cls_ni: cwv.cls.ni,
          cls_poor: cwv.cls.poor,
          inp_good: cwv.inp.good,
          inp_ni: cwv.inp.ni,
          inp_poor: cwv.inp.poor,
        }, { onConflict: 'site_url,snapshot_date,origin' })

        // Detect degradations vs previous
        if (prevCWV) {
          const THRESHOLD = 0.05
          const degradations = []
          if (cwv.lcp.poor - prevCWV.lcp_poor > THRESHOLD)
            degradations.push({ origin, metric: 'LCP', current: cwv.lcp.poor, previous: prevCWV.lcp_poor })
          if (cwv.cls.poor - prevCWV.cls_poor > THRESHOLD)
            degradations.push({ origin, metric: 'CLS', current: cwv.cls.poor, previous: prevCWV.cls_poor })
          if (cwv.inp.poor - prevCWV.inp_poor > THRESHOLD)
            degradations.push({ origin, metric: 'INP', current: cwv.inp.poor, previous: prevCWV.inp_poor })

          if (degradations.length) {
            await sendCWVAlert(degradations)
            await supabase.from('alert_log').insert({
              alert_type: 'cwv',
              site_url: siteUrl,
              title: `CWV degradation on ${origin}`,
              message: degradations.map(d => d.metric).join(', '),
              severity: 'warning',
              slack_sent: true,
              metadata: { degradations },
            })
          }
        }
      }

      results[siteUrl] = { status: 'ok', drops: drops.length }
    } catch (err) {
      results[conn.site_url] = { status: 'error', error: String(err) }
    }
  }

  return NextResponse.json({ success: true, results })
}
