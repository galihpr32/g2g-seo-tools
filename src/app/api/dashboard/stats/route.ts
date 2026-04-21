import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 30

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Get GSC site_url for this owner
  const { data: conn } = await db
    .from('gsc_connections')
    .select('site_url')
    .eq('user_id', ownerId)
    .maybeSingle()

  const siteUrl = conn?.site_url ?? null

  // ── Fetch in parallel ────────────────────────────────────────────────────────
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10)

  const [
    actionItemsRes,
    briefsRes,
    campaignsRes,
    rankingDropsRes,
  ] = await Promise.all([
    // All action items (status, type, assignee, created_at)
    siteUrl
      ? db
          .from('seo_action_items')
          .select('id, status, action_type, assigned_to, created_at, snapshot_date')
          .eq('site_url', siteUrl)
      : Promise.resolve({ data: [], error: null }),

    // All briefs (status, created_at)
    siteUrl
      ? supabase
          .from('seo_content_briefs')
          .select('id, status, created_at')
          .eq('site_url', siteUrl)
      : Promise.resolve({ data: [], error: null }),

    // Campaigns + page counts
    supabase
      .from('campaigns')
      .select('id, name, campaign_pages(id)')
      .eq('owner_user_id', ownerId),

    // Last 30 days of ranking drops for clicks sparkline
    siteUrl
      ? supabase
          .from('gsc_ranking_drops')
          .select('snapshot_date, clicks_now, impressions_now')
          .eq('site_url', siteUrl)
          .gte('snapshot_date', thirtyDaysAgo)
          .order('snapshot_date', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ])

  const items   = actionItemsRes.data ?? []
  const briefs  = briefsRes.data ?? []
  const camps   = campaignsRes.data ?? []
  const drops   = rankingDropsRes.data ?? []

  // ── Action items stats ────────────────────────────────────────────────────────
  const actionStats = {
    total:      items.length,
    pending:    items.filter(i => i.status === 'pending').length,
    in_progress: items.filter(i => i.status === 'in_progress').length,
    done:       items.filter(i => i.status === 'done').length,
    on_page:    items.filter(i => i.action_type === 'on_page').length,
    off_page:   items.filter(i => i.action_type === 'off_page').length,
    unassigned_in_progress: items.filter(i => i.status === 'in_progress' && !i.assigned_to).length,
  }

  // Items created per week (last 8 weeks)
  const now = Date.now()
  const weeklyItems: { week: string; count: number }[] = []
  for (let w = 7; w >= 0; w--) {
    const weekStart = new Date(now - (w + 1) * 7 * 24 * 60 * 60 * 1000)
    const weekEnd   = new Date(now - w * 7 * 24 * 60 * 60 * 1000)
    const label     = weekStart.toISOString().slice(5, 10) // MM-DD
    const count     = items.filter(i => {
      const d = new Date(i.created_at)
      return d >= weekStart && d < weekEnd
    }).length
    weeklyItems.push({ week: label, count })
  }

  // ── Brief stats ────────────────────────────────────────────────────────────
  const briefStats = {
    total:      briefs.length,
    generating: briefs.filter(b => b.status === 'generating').length,
    draft:      briefs.filter(b => b.status === 'draft').length,
    reviewed:   briefs.filter(b => b.status === 'reviewed').length,
    published:  briefs.filter(b => b.status === 'published').length,
  }

  // ── Campaign stats ─────────────────────────────────────────────────────────
  const campaignStats = {
    total: camps.length,
    totalPages: camps.reduce((sum, c) => sum + (Array.isArray(c.campaign_pages) ? c.campaign_pages.length : 0), 0),
  }

  // ── Clicks sparkline (aggregate by date) ──────────────────────────────────
  const clicksByDate = new Map<string, number>()
  const impressionsByDate = new Map<string, number>()
  for (const d of drops) {
    clicksByDate.set(d.snapshot_date, (clicksByDate.get(d.snapshot_date) ?? 0) + (d.clicks_now ?? 0))
    impressionsByDate.set(d.snapshot_date, (impressionsByDate.get(d.snapshot_date) ?? 0) + (d.impressions_now ?? 0))
  }
  const sparkline = Array.from(clicksByDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, clicks]) => ({ date, clicks, impressions: impressionsByDate.get(date) ?? 0 }))

  // Total clicks last 30d vs prev 30d
  const totalClicksNow  = sparkline.reduce((s, d) => s + d.clicks, 0)
  // Use older half as "previous" approximation
  const half = Math.floor(sparkline.length / 2)
  const totalClicksPrev = sparkline.slice(0, half).reduce((s, d) => s + d.clicks, 0)
  const totalClicksCurr = sparkline.slice(half).reduce((s, d) => s + d.clicks, 0)
  const clicksDelta = totalClicksPrev > 0
    ? Math.round(((totalClicksCurr - totalClicksPrev) / totalClicksPrev) * 100)
    : null

  // ── Assignee breakdown ─────────────────────────────────────────────────────
  const assigneeMap = new Map<string, { in_progress: number; done: number }>()
  for (const item of items) {
    const key = item.assigned_to ?? '(unassigned)'
    if (!assigneeMap.has(key)) assigneeMap.set(key, { in_progress: 0, done: 0 })
    const entry = assigneeMap.get(key)!
    if (item.status === 'in_progress') entry.in_progress++
    if (item.status === 'done')        entry.done++
  }
  const assignees = Array.from(assigneeMap.entries())
    .map(([email, counts]) => ({ email, ...counts, total: counts.in_progress + counts.done }))
    .filter(a => a.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)

  // Brief published per assignee
  const publishedBriefIds = new Set(briefs.filter(b => b.status === 'published').map(b => b.id))
  // We can't easily join briefs→items→assignee without a full join, so we'll skip for now.

  return NextResponse.json({
    actionStats,
    weeklyItems,
    briefStats,
    campaignStats,
    sparkline,
    totalClicksNow,
    clicksDelta,
    assignees,
    siteUrl,
    generatedAt: new Date().toISOString(),
  })
}
