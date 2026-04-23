import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getGA4ContentPerformance, parseGA4Rows } from '@/lib/ga4/client'
import ContentPagesClient from './ContentPagesClient'

export const revalidate = 1800

export default async function ContentPerformancePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const effectiveOwnerId = user ? await getEffectiveOwnerId(supabase, user.id) : null
  const { data: conn } = effectiveOwnerId
    ? await supabase.from('gsc_connections').select('*').eq('user_id', effectiveOwnerId).single()
    : { data: null }

  const propertyId = process.env.GA4_PROPERTY_ID
  const today = new Date().toISOString().split('T')[0]

  type PageData = {
    path: string
    sessions: number
    engaged: number
    bounce: number
    views: number
    avgDuration: number
  }

  let currentPages: PageData[] = []
  let prevEntries: { path: string; sessions: number }[] = []
  let fetchError: string | null = null
  let dataSource: 'live' | 'none' = 'none'

  const notConfigured = !propertyId || !conn?.access_token

  if (conn?.access_token && propertyId) {
    try {
      const auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
      const data = await getGA4ContentPerformance(auth, propertyId)

      const thisRows = parseGA4Rows(data.thisMonth)
      const prevRows = parseGA4Rows(data.lastMonth)

      currentPages = thisRows.map(r => ({
        path: r.pagePath ?? '',
        sessions: parseInt(r.sessions ?? '0'),
        engaged: parseInt(r.engagedSessions ?? '0'),
        bounce: parseFloat(r.bounceRate ?? '0'),
        views: parseInt(r.screenPageViews ?? '0'),
        avgDuration: parseFloat(r.averageSessionDuration ?? '0'),
      })).filter(p => p.path)

      prevEntries = prevRows.map(r => ({
        path: r.pagePath ?? '',
        sessions: parseInt(r.sessions ?? '0'),
      })).filter(e => e.path)

      dataSource = 'live'
    } catch (e) {
      fetchError = String(e)
    }
  }

  const decayingCount = currentPages.filter(p => {
    const prev = prevEntries.find(e => e.path === p.path)
    if (!prev || prev.sessions === 0) return false
    return (prev.sessions - p.sessions) / prev.sessions >= 0.2
  }).length

  const growingCount = currentPages.filter(p => {
    const prev = prevEntries.find(e => e.path === p.path)
    if (!prev || prev.sessions === 0) return false
    return (p.sessions - prev.sessions) / prev.sessions >= 0.1
  }).length

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📄 Content Performance Audit</h1>
          <p className="text-gray-400 text-sm mt-1">30-day analysis — decaying pages flagged for refresh or consolidation</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1.5 rounded-full">{today}</span>
          {dataSource === 'live' && (
            <span className="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2.5 py-1 rounded-full">🔄 live</span>
          )}
        </div>
      </div>

      {notConfigured && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-6 mb-6">
          <p className="text-yellow-400 font-medium">GA4 not fully configured</p>
          <p className="text-gray-400 text-sm mt-1">
            {!propertyId ? 'Add GA4_PROPERTY_ID to Vercel env.' : 'Reconnect Google in Settings to grant Analytics access.'}
          </p>
        </div>
      )}

      {fetchError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-sm text-red-400">
          ⚠️ {fetchError}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className={`${decayingCount > 0 ? 'bg-red-500/10 border-red-500/20' : 'bg-gray-900 border-gray-800'} border rounded-xl p-5`}>
          <p className={`text-3xl font-bold ${decayingCount > 0 ? 'text-red-400' : 'text-white'}`}>{decayingCount}</p>
          <p className="text-gray-400 text-sm mt-1">Decaying pages (&gt;20% drop)</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-3xl font-bold text-white">{currentPages.length}</p>
          <p className="text-gray-400 text-sm mt-1">Total pages tracked</p>
        </div>
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-5">
          <p className="text-3xl font-bold text-green-400">{growingCount}</p>
          <p className="text-gray-400 text-sm mt-1">Pages growing MoM</p>
        </div>
      </div>

      {/* Interactive content sections (decaying, growing, all pages with filter/sort) */}
      {currentPages.length === 0 && dataSource !== 'live' ? (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 text-center text-gray-500 text-sm">
          Configure GA4 to see content performance data
        </div>
      ) : (
        <ContentPagesClient currentPages={currentPages} prevEntries={prevEntries} />
      )}
    </div>
  )
}
