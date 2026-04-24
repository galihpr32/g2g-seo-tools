import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import NotificationsClient from './NotificationsClient'

export const revalidate = 30

const STALE_DAYS    = 7
const ETA_WARN_DAYS = 3

// ── Types ─────────────────────────────────────────────────────────────────────
import type { ActionItem, EtaPage, DmcaBriefHit } from './NotificationsClient'

// ── Page ──────────────────────────────────────────────────────────────────────
export default async function NotificationsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const ownerId = user ? await getEffectiveOwnerId(supabase, user.id) : null

  const { data: conn } = ownerId
    ? await supabase.from('gsc_connections').select('site_url').eq('user_id', ownerId).single()
    : { data: null }

  const siteUrl = conn?.site_url

  let staleItems:     ActionItem[]   = []
  let unassignedItems: ActionItem[]  = []
  let etaPages:        EtaPage[]     = []
  let dmcaBriefHits:   DmcaBriefHit[] = []

  if (ownerId) {
    const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const etaThreshold   = new Date(Date.now() + ETA_WARN_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    const [staleRes, unassignedRes, etaRes, dmcaRes] = await Promise.all([
      // Stale in_progress action items
      siteUrl
        ? supabase.from('seo_action_items')
            .select('id, page, action_type, status, notes, assigned_to, created_at, snapshot_date')
            .eq('site_url', siteUrl).eq('status', 'in_progress')
            .lt('created_at', staleThreshold).order('created_at', { ascending: true })
        : Promise.resolve({ data: [] }),

      // Unassigned in_progress action items
      siteUrl
        ? supabase.from('seo_action_items')
            .select('id, page, action_type, status, notes, assigned_to, created_at, snapshot_date')
            .eq('site_url', siteUrl).eq('status', 'in_progress')
            .is('assigned_to', null).order('created_at', { ascending: false })
        : Promise.resolve({ data: [] }),

      // Campaign pages with overdue or upcoming ETA
      supabase.from('campaign_pages')
        .select('id, page_url, notes, eta, status, campaign_id, campaigns!inner(name, color, owner_user_id)')
        .eq('campaigns.owner_user_id', ownerId)
        .neq('status', 'done')
        .not('eta', 'is', null)
        .lte('eta', etaThreshold)
        .order('eta', { ascending: true }),

      // Unresolved DMCA hits for published briefs
      supabase.from('dmca_hits')
        .select(`
          id, detected_at,
          dmca_terms!inner ( original_term, replacement_term ),
          seo_content_briefs!inner ( id, page, title, action_item_id )
        `)
        .eq('owner_user_id', ownerId)
        .eq('resolved', false)
        .order('detected_at', { ascending: false }),
    ])

    staleItems      = (staleRes.data      ?? []) as ActionItem[]
    unassignedItems = (unassignedRes.data ?? []) as ActionItem[]

    // Shape ETA results
    etaPages = ((etaRes.data ?? []) as {
      id: string; page_url: string; notes: string | null; eta: string; status: string
      campaign_id: string
      campaigns: { name: string; color: string; owner_user_id: string } | { name: string; color: string; owner_user_id: string }[]
    }[]).map(row => {
      const camp = Array.isArray(row.campaigns) ? row.campaigns[0] : row.campaigns
      return {
        id: row.id, page_url: row.page_url, notes: row.notes, eta: row.eta,
        status: row.status, campaign_id: row.campaign_id,
        campaign_name: camp?.name ?? '', campaign_color: camp?.color ?? '#6366f1',
      }
    })

    // Group DMCA hits by brief
    const dmcaHitsRaw = (dmcaRes.data ?? []) as Array<{
      id: string; detected_at: string
      dmca_terms: { original_term: string; replacement_term: string } | { original_term: string; replacement_term: string }[]
      seo_content_briefs: { id: string; page: string; title: string | null; action_item_id: string | null } |
                          { id: string; page: string; title: string | null; action_item_id: string | null }[]
    }>

    const briefMap = new Map<string, DmcaBriefHit>()
    for (const hit of dmcaHitsRaw) {
      const brief = Array.isArray(hit.seo_content_briefs) ? hit.seo_content_briefs[0] : hit.seo_content_briefs
      const term  = Array.isArray(hit.dmca_terms) ? hit.dmca_terms[0] : hit.dmca_terms
      if (!brief || !term) continue
      if (!briefMap.has(brief.id)) {
        briefMap.set(brief.id, {
          briefId: brief.id,
          briefPage: brief.page,
          briefTitle: brief.title,
          actionItemId: brief.action_item_id,
          terms: [],
        })
      }
      briefMap.get(brief.id)!.terms.push({
        hitId:       hit.id,
        original:    term.original_term,
        replacement: term.replacement_term,
        detectedAt:  hit.detected_at,
      })
    }
    dmcaBriefHits = Array.from(briefMap.values())
  }

  return (
    <NotificationsClient
      staleItems={staleItems}
      unassignedItems={unassignedItems}
      etaPages={etaPages}
      dmcaBriefHits={dmcaBriefHits}
    />
  )
}
