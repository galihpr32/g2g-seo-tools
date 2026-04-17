import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { BriefViewer } from './BriefViewer'

export const dynamic = 'force-dynamic'

export default async function ActionItemBriefPage({ params }: { params: { id: string } }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: conn } = user
    ? await supabase.from('gsc_connections').select('site_url').eq('user_id', user.id).single()
    : { data: null }

  // Load the action item
  const { data: item } = await supabase
    .from('seo_action_items')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!item) notFound()

  // Check if a brief already exists for this action item
  const { data: existingBrief } = await supabase
    .from('seo_content_briefs')
    .select('id, status, brief_type, created_at')
    .eq('action_item_id', item.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  let path = item.page
  try { path = new URL(item.page).pathname } catch { /* keep */ }

  const ACTION_LABELS = {
    on_page:  { label: 'On-Page Optimization', icon: '✏️', color: 'text-blue-400' },
    off_page: { label: 'Off-Page Content',      icon: '📣', color: 'text-purple-400' },
  }
  const at = ACTION_LABELS[item.action_type as 'on_page' | 'off_page']

  const STATUS_COLORS = {
    pending:     'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    in_progress: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
    done:        'text-green-400 bg-green-500/10 border-green-500/20',
  }

  return (
    <div className="p-8 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-gray-500 mb-6">
        <a href="/gsc/action-items" className="hover:text-gray-300 transition">Action Items</a>
        <span>›</span>
        <span className="text-gray-400">{path}</span>
      </div>

      {/* Page header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <span className={`text-sm font-semibold ${at.color}`}>{at.icon} {at.label}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_COLORS[item.status as keyof typeof STATUS_COLORS]}`}>
            {item.status}
          </span>
          {item.clicks_drop && (
            <span className="text-xs text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full">
              -{Math.round(item.clicks_drop * 100)}% clicks
            </span>
          )}
          {item.position_change >= 5 && (
            <span className="text-xs text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded-full">
              +{item.position_change?.toFixed(1)} pos
            </span>
          )}
        </div>
        <h1 className="text-xl font-bold text-white">
          <a href={item.page} target="_blank" rel="noopener noreferrer" className="hover:text-blue-400 transition">
            {path}
          </a>
        </h1>
        {item.notes && (
          <p className="text-gray-400 text-sm mt-1.5">{item.notes}</p>
        )}
        <p className="text-gray-600 text-xs mt-1">
          Added {new Date(item.created_at).toLocaleDateString('id-ID')}
          {' · '}snapshot {item.snapshot_date}
        </p>
      </div>

      {/* Brief area */}
      <BriefViewer
        actionItemId={item.id}
        existingBriefId={existingBrief?.id ?? null}
        actionType={item.action_type}
      />
    </div>
  )
}
