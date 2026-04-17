import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import CampaignKanban from './CampaignKanban'
import type { Campaign } from './CampaignKanban'

export default async function CampaignsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { data } = await supabase
    .from('campaigns')
    .select(`
      id, name, description, color, position, goals, gsc_site_url,
      parent_campaign_id, created_at, updated_at, status, campaign_notes,
      campaign_pages (id, page_url, action_item_id, position, notes, status, eta)
    `)
    .eq('owner_user_id', ownerId)
    .order('position', { ascending: true })

  const campaigns = (data ?? []) as Campaign[]

  return (
    <div className="h-screen flex flex-col">
      <CampaignKanban initial={campaigns} />
    </div>
  )
}
