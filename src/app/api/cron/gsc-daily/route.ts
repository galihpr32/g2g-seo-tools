import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getRefreshedClientFull, getRefreshedClient } from '@/lib/gsc/auth'
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
import { getGA4OrganicTraffic, getGA4ContentPerformance, parseGA4Rows, sumMetric } from '@/lib/ga4/client'

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

  const { data: connections } = await supabase.from('gsc_connections').select('*')
  if (!connections?.length) return NextResponse.json({ message: 'No connections found' })

  // Sprint 12: iterate each (connection × active site) so OffGamers gets its
  // own GSC sync, not just whichever site happens to be in conn.site_url.
  // Tokens cover all GSC properties under the same Google account.
  const { data: sites } = await supabase
    .from('site_configs')
    .select('slug, gsc_property')
    .eq('is_active', true)
  const activeSites = (sites ?? []) as Array<{ slug: string; gsc_property: string }>
  if (activeSites.length === 0) {
    return NextResponse.json({ error: 'No active site_configs' }, { status: 500 })
  }

  const results: Record<string, unknown> = {}

  for (const conn of connections) {
    try {
      const { client: auth, newCredentials } = await getRefreshedClientFull(
        conn.access_token, conn.refresh_token, conn.expires_at
      )

      // Persist refreshed token so future cold starts don't see an expired token
      if (newCredentials) {
        await supabase.from('gsc_connections').update({
          access_token: newCredentials.accessToken,
          expires_at:   newCredentials.expiresAt,
          updated_at:   new Date().toISOString(),
        }).eq('user_id', conn.user_id)
      }

      // Sprint 12: iterate each active site for this connection. The
      // existing per-site logic below uses `siteUrl` which is now bound
      // by this outer loop instead of the legacy single-value
      // conn.site_url. Tokens are shared across properties under the
      // same Google account, so one OAuth set covers all sites.
      for (const site of activeSites) {
      const siteUrl = site.gsc_property
      const today = getDateRange(0)

      // ── Task 1: Ranking Drop Alert ──────────────────────────────────────
      const [currentRows, previousRows, queryRows] = await Promise.all([
        getSearchAnalytics(auth, siteUrl, getDateRange(7), getDateRange(1), ['page'], 1000),
        getSearchAnalytics(auth, siteUrl, getDateRange(14), getDateRange(8), ['page'], 1000),
        getSearchAnalytics(auth, siteUrl, getDateRange(7), getDateRange(1), ['page', 'query'], 2000),
      ])

      const toRankingRow = (rows: typeof currentRows): RankingRow[] =>
        rows.map(r => ({
          page: r.keys?.[0] ?? '',
          clicks: r.clicks ?? 0,
          impressions: r.impressions ?? 0,
          ctr: r.ctr ?? 0,
          position: r.position ?? 0,
        }))

      // ── URL pre-filter — only alert on relevant pages ───────────────────
      const ALERT_URL_INCLUDE = ['/categories/']
      const ALERT_URL_EXCLUDE = ['/offer/']
      function isAlertablePage(url: string) {
        const p = url.toLowerCase()
        if (ALERT_URL_INCLUDE.length > 0 && !ALERT_URL_INCLUDE.some(inc => p.includes(inc))) return false
        if (ALERT_URL_EXCLUDE.some(ex => p.includes(ex))) return false
        return true
      }

      const current = toRankingRow(currentRows)
      const previous = toRankingRow(previousRows)
      const drops = detectRankingDrops(current, previous)

      // Load notification prefs once per user (used by all 3 alert types below)
      const { data: notifSettings } = await supabase
        .from('notification_settings')
        .select('slack_clicks_alerts, slack_cwv_alerts, slack_index_alerts')
        .eq('user_id', conn.user_id)
        .single()

      // Save raw ranking snapshot
      if (current.length) {
        await supabase.from('gsc_ranking_snapshots').upsert(
          current.map(r => ({
            site_url: siteUrl,
            snapshot_date: today,
            page: r.page,
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: r.ctr,
            position: r.position,
          })),
          { onConflict: 'site_url,snapshot_date,page', ignoreDuplicates: true }
        )
      }

      // Save detected drops to dedicated table (so page reads from DB, not live API)
      if (drops.length) {
        // Upsert drop records
        await supabase.from('gsc_ranking_drops').upsert(
          drops.map(d => ({
            site_url: siteUrl,
            snapshot_date: today,
            page: d.page,
            clicks_now: d.currentClicks,
            clicks_prev: d.previousClicks,
            clicks_drop: d.clicksDrop,
            impressions_now: d.currentImpressions,
            impressions_prev: d.previousImpressions,
            impressions_drop: d.impressionsDrop,
            position_now: d.currentPosition,
            position_prev: d.previousPosition,
            position_diff: d.positionChange,
          })),
          { onConflict: 'site_url,snapshot_date,page', ignoreDuplicates: false }
        )

        // Build query map and save per-page queries
        const queryMap = new Map<string, typeof queryRows>()
        for (const row of queryRows) {
          const page = row.keys?.[0] ?? ''
          if (!queryMap.has(page)) queryMap.set(page, [])
          queryMap.get(page)!.push(row)
        }

        // Only save queries for pages that had drops (keeps DB lean)
        const queryInserts = []
        for (const drop of drops) {
          const pageQueries = (queryMap.get(drop.page) ?? [])
            .sort((a, b) => (b.clicks ?? 0) - (a.clicks ?? 0))
            .slice(0, 20)

          for (const q of pageQueries) {
            queryInserts.push({
              site_url: siteUrl,
              snapshot_date: today,
              page: drop.page,
              query: q.keys?.[1] ?? '',
              clicks: q.clicks ?? 0,
              impressions: q.impressions ?? 0,
              ctr: q.ctr ?? 0,
              position: q.position ?? 0,
            })
          }
        }

        if (queryInserts.length) {
          await supabase.from('gsc_ranking_drop_queries').upsert(queryInserts, {
            onConflict: 'site_url,snapshot_date,page,query',
            ignoreDuplicates: false,
          })
        }

        // Send Slack alert only for alertable pages (respects URL pre-filter)
        // Sprint MULTI.3 — pass routing context so config-mapped channels win.
        const alertableDrops = drops.filter(d => isAlertablePage(d.page))
        if (alertableDrops.length && (notifSettings?.slack_clicks_alerts ?? false)) {
          await sendRankingDropAlert(alertableDrops, {
            db: supabase, ownerId: conn.user_id, type: 'daily_alerts', siteSlug: site.slug,
          })
          await supabase.from('alert_log').insert({
            alert_type: 'ranking_drop',
            site_url: siteUrl,
            title: `${alertableDrops.length} pages dropped >15% WoW`,
            message: alertableDrops.map(d => d.page).join(', '),
            severity: alertableDrops.length > 5 ? 'critical' : 'warning',
            slack_sent: !!process.env.SLACK_WEBHOOK_URL,
            metadata: { drops: alertableDrops },
          })
        }
      }

      // ── Task 2: Index Coverage ──────────────────────────────────────────
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
        errors: 0,
      }, { onConflict: 'site_url,snapshot_date' })

      if (notifSettings?.slack_index_alerts ?? true) {
        await sendIndexCoverageAlert({
          indexedPages: totalIndexed,
          previousIndexed: prevIndexed,
          errors: 0,
          previousErrors: prevErrors,
        }, { db: supabase, ownerId: conn.user_id, type: 'daily_alerts', siteSlug: site.slug })
      }

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
          lcp_good: cwv.lcp.good, lcp_ni: cwv.lcp.ni, lcp_poor: cwv.lcp.poor,
          cls_good: cwv.cls.good, cls_ni: cwv.cls.ni, cls_poor: cwv.cls.poor,
          inp_good: cwv.inp.good, inp_ni: cwv.inp.ni, inp_poor: cwv.inp.poor,
        }, { onConflict: 'site_url,snapshot_date,origin' })

        if (prevCWV) {
          const THRESHOLD = 0.05
          const degradations = []
          if (cwv.lcp.poor - prevCWV.lcp_poor > THRESHOLD)
            degradations.push({ origin, metric: 'LCP', current: cwv.lcp.poor, previous: prevCWV.lcp_poor })
          if (cwv.cls.poor - prevCWV.cls_poor > THRESHOLD)
            degradations.push({ origin, metric: 'CLS', current: cwv.cls.poor, previous: prevCWV.cls_poor })
          if (cwv.inp.poor - prevCWV.inp_poor > THRESHOLD)
            degradations.push({ origin, metric: 'INP', current: cwv.inp.poor, previous: prevCWV.inp_poor })

          if (degradations.length && (notifSettings?.slack_cwv_alerts ?? false)) {
            await sendCWVAlert(degradations, {
              db: supabase, ownerId: conn.user_id, type: 'daily_alerts', siteSlug: site.slug,
            })
            await supabase.from('alert_log').insert({
              alert_type: 'cwv',
              site_url: siteUrl,
              title: `CWV degradation on ${origin}`,
              message: degradations.map(d => d.metric).join(', '),
              severity: 'warning',
              slack_sent: !!process.env.SLACK_WEBHOOK_URL,
              metadata: { degradations },
            })
          }
        }
      }

      // ── Task 11 & 14: GA4 Organic Traffic + Content Performance ───────────
      const ga4PropertyId = process.env.GA4_PROPERTY_ID
      if (ga4PropertyId) {
        try {
          const ga4Auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)

          // Task 11: Weekly organic traffic snapshot
          const { thisWeek } = await getGA4OrganicTraffic(ga4Auth, ga4PropertyId)
          const weekRows = parseGA4Rows(thisWeek)
          const ga4Sessions = Math.round(sumMetric(weekRows, 'sessions'))
          const ga4Engaged = Math.round(sumMetric(weekRows, 'engagedSessions'))
          const ga4Views = Math.round(sumMetric(weekRows, 'screenPageViews'))
          const ga4Bounce = weekRows.length > 0
            ? weekRows.reduce((s, r) => s + parseFloat(r.bounceRate ?? '0'), 0) / weekRows.length
            : 0

          await supabase.from('ga4_organic_snapshots').upsert({
            site_url: siteUrl,
            snapshot_date: today,
            sessions: ga4Sessions,
            engaged_sessions: ga4Engaged,
            page_views: ga4Views,
            bounce_rate: ga4Bounce,
          }, { onConflict: 'site_url,snapshot_date' })

          // Task 14: Monthly content performance snapshot
          const { thisMonth } = await getGA4ContentPerformance(ga4Auth, ga4PropertyId)
          const contentRows = parseGA4Rows(thisMonth)
          const topPages = contentRows.slice(0, 50).map(r => ({
            path: r.pagePath ?? '',
            sessions: parseInt(r.sessions ?? '0'),
            engaged: parseInt(r.engagedSessions ?? '0'),
            bounce: parseFloat(r.bounceRate ?? '0'),
            views: parseInt(r.screenPageViews ?? '0'),
            avgDuration: parseFloat(r.averageSessionDuration ?? '0'),
          }))

          await supabase.from('ga4_content_snapshots').upsert({
            site_url: siteUrl,
            snapshot_date: today,
            pages: topPages,
          }, { onConflict: 'site_url,snapshot_date' })

        } catch (ga4Err) {
          // GA4 errors shouldn't fail the whole cron — just log
          console.error('GA4 cron error:', ga4Err)
        }
      }

      results[`${conn.user_id}::${siteUrl}`] = { status: 'ok', drops: drops.length }
      }   // end for site of activeSites
    } catch (err) {
      results[`${conn.user_id}::error`] = { status: 'error', error: String(err) }
    }
  }

  return NextResponse.json({ success: true, results })
}
