// ─── GA4 traffic-by-channel breakdown ────────────────────────────────────────
//
// Pulls sessions/conversions/revenue per default channel group for a period
// and the prior period. Output is sorted by current sessions desc, with a
// per-channel MoM percentage delta.
//
// Used by /api/reports/monthly to populate report_data.channelBreakdown
// (rendered as table + bar chart in PPTX + report viewer page).

import { getGA4Report, parseGA4Rows } from '@/lib/ga4/client'
import type { OAuth2Client } from 'google-auth-library'

export interface ChannelRow {
  channel:        string             // e.g. 'Organic Search', 'Direct'
  sessions:       number
  prevSessions:   number
  sessionsPct:    number | null      // MoM %, null when prev=0 (avoid Infinity)
  conversions:    number
  prevConversions: number
  conversionsPct: number | null
  revenue:        number             // USD
  prevRevenue:    number
  revenuePct:     number | null
  share:          number             // % of TOTAL sessions this period (0-100, 1 decimal)
}

export interface ChannelBreakdown {
  rows:        ChannelRow[]
  totalCur:    { sessions: number; conversions: number; revenue: number }
  totalPrev:   { sessions: number; conversions: number; revenue: number }
  generatedAt: string
}

function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null
  return Math.round(((cur - prev) / prev) * 100)
}

/**
 * Pull GA4 sessions/conversions/revenue grouped by `sessionDefaultChannelGroup`
 * for [start..end] and the equivalent prior period. Returns null if GA4 is
 * unreachable (caller falls back to "no channel data" UI).
 */
export async function fetchChannelBreakdown(opts: {
  auth:        OAuth2Client
  propertyId:  string
  curStart:    string                // 'YYYY-MM-DD'
  curEnd:      string
  prevStart:   string
  prevEnd:     string
}): Promise<ChannelBreakdown | null> {
  const { auth, propertyId, curStart, curEnd, prevStart, prevEnd } = opts

  try {
    const [curRaw, prevRaw] = await Promise.all([
      getGA4Report(auth, propertyId, curStart, curEnd,
        ['sessionDefaultChannelGroup'],
        ['sessions', 'conversions', 'purchaseRevenue'],
        50),
      getGA4Report(auth, propertyId, prevStart, prevEnd,
        ['sessionDefaultChannelGroup'],
        ['sessions', 'conversions', 'purchaseRevenue'],
        50),
    ])

    const curRows  = parseGA4Rows(curRaw)
    const prevRows = parseGA4Rows(prevRaw)

    // Index prev by channel name for O(1) lookup
    const prevByChannel = new Map<string, { sessions: number; conversions: number; revenue: number }>()
    for (const r of prevRows) {
      const ch = r.sessionDefaultChannelGroup ?? 'Unknown'
      prevByChannel.set(ch, {
        sessions:    parseInt(r.sessions ?? '0'),
        conversions: parseInt(r.conversions ?? '0'),
        revenue:     parseFloat(r.purchaseRevenue ?? '0'),
      })
    }

    let totalCurSessions    = 0
    let totalCurConversions = 0
    let totalCurRevenue     = 0
    const rows: Omit<ChannelRow, 'share'>[] = []
    for (const r of curRows) {
      const channel     = r.sessionDefaultChannelGroup ?? 'Unknown'
      const sessions    = parseInt(r.sessions ?? '0')
      const conversions = parseInt(r.conversions ?? '0')
      const revenue     = parseFloat(r.purchaseRevenue ?? '0')
      const prev        = prevByChannel.get(channel) ?? { sessions: 0, conversions: 0, revenue: 0 }

      totalCurSessions    += sessions
      totalCurConversions += conversions
      totalCurRevenue     += revenue

      rows.push({
        channel,
        sessions,
        prevSessions:   prev.sessions,
        sessionsPct:    pctChange(sessions, prev.sessions),
        conversions,
        prevConversions: prev.conversions,
        conversionsPct: pctChange(conversions, prev.conversions),
        revenue:        +revenue.toFixed(2),
        prevRevenue:    +prev.revenue.toFixed(2),
        revenuePct:     pctChange(Math.round(revenue), Math.round(prev.revenue)),
      })
    }

    // Add channels that existed last month but vanished this month (so the
    // table surfaces "Email: 0 (-100%)" instead of silently dropping the row)
    for (const [channel, prev] of prevByChannel.entries()) {
      if (rows.some(r => r.channel === channel)) continue
      rows.push({
        channel,
        sessions: 0,
        prevSessions:   prev.sessions,
        sessionsPct:    pctChange(0, prev.sessions),
        conversions: 0,
        prevConversions: prev.conversions,
        conversionsPct: pctChange(0, prev.conversions),
        revenue: 0,
        prevRevenue:    +prev.revenue.toFixed(2),
        revenuePct:     pctChange(0, Math.round(prev.revenue)),
      })
    }

    let totalPrevSessions    = 0
    let totalPrevConversions = 0
    let totalPrevRevenue     = 0
    for (const v of prevByChannel.values()) {
      totalPrevSessions    += v.sessions
      totalPrevConversions += v.conversions
      totalPrevRevenue     += v.revenue
    }

    // Compute share AFTER total is known
    const enriched: ChannelRow[] = rows
      .map(r => ({
        ...r,
        share: totalCurSessions > 0
          ? Math.round((r.sessions / totalCurSessions) * 1000) / 10
          : 0,
      }))
      .sort((a, b) => b.sessions - a.sessions)

    return {
      rows:      enriched,
      totalCur:  {
        sessions:    totalCurSessions,
        conversions: totalCurConversions,
        revenue:     +totalCurRevenue.toFixed(2),
      },
      totalPrev: {
        sessions:    totalPrevSessions,
        conversions: totalPrevConversions,
        revenue:     +totalPrevRevenue.toFixed(2),
      },
      generatedAt: new Date().toISOString(),
    }
  } catch (err) {
    console.warn('[channel-breakdown] GA4 fetch failed:', err)
    return null
  }
}
