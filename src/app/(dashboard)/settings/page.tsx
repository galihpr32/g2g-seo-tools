'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Site = { url: string; level: string }
type Connection = { connected: boolean; siteUrl?: string; propertyId?: string }

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${
      connected ? 'bg-green-500/15 text-green-400' : 'bg-gray-700 text-gray-400'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-gray-500'}`} />
      {connected ? 'Connected' : 'Not connected'}
    </span>
  )
}

export default function SettingsPage() {
  const supabase = createClient()
  const [gsc, setGsc] = useState<Connection>({ connected: false })
  const [ga4, setGa4] = useState<Connection>({ connected: false })
  const [slack, setSlack] = useState<Connection>({ connected: false })
  const [semrush, setSemrush] = useState<Connection>({ connected: false })
  const [sites, setSites] = useState<Site[]>([])
  const [loadingSites, setLoadingSites] = useState(false)
  const [savingProperty, setSavingProperty] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    async function loadConnections() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: gscConn } = await supabase
        .from('gsc_connections')
        .select('site_url')
        .eq('user_id', user.id)
        .single()

      if (gscConn) {
        setGsc({ connected: true, siteUrl: gscConn.site_url })
        // Load sites list
        setLoadingSites(true)
        const res = await fetch('/api/gsc/properties')
        const data = await res.json()
        setSites(data.sites ?? [])
        setLoadingSites(false)
      }

      // GA4 — check if property ID is configured
      const hasGA4 = !!process.env.NEXT_PUBLIC_GA4_PROPERTY_ID
      setGa4({ connected: hasGA4 })

      // Slack — just show pending until webhook is set
      setSlack({ connected: false })

      // SEMrush
      setSemrush({ connected: false })
    }
    loadConnections()
  }, [])

  async function selectProperty(siteUrl: string) {
    setSavingProperty(true)
    await fetch('/api/gsc/select-property', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteUrl }),
    })
    setGsc(prev => ({ ...prev, siteUrl }))
    setSavingProperty(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const integrations = [
    {
      key: 'gsc',
      name: 'Google Search Console',
      description: 'Ranking drops, index coverage, Core Web Vitals',
      icon: '🔍',
      connection: gsc,
      action: (
        <a
          href="/api/auth/google"
          className="text-sm font-medium text-red-400 hover:text-red-300 transition"
        >
          {gsc.connected ? 'Reconnect' : 'Connect →'}
        </a>
      ),
    },
    {
      key: 'ga4',
      name: 'Google Analytics 4',
      description: 'Organic traffic, content performance, landing pages',
      icon: '📈',
      connection: ga4,
      action: ga4.connected ? null : (
        <span className="text-xs text-gray-500">Add GA4_PROPERTY_ID to Vercel env</span>
      ),
    },
    {
      key: 'slack',
      name: 'Slack',
      description: 'Daily alerts for ranking drops, index issues, CWV degradation',
      icon: '💬',
      connection: slack,
      action: (
        <span className="text-xs text-gray-500">Add SLACK_WEBHOOK_URL to Vercel env</span>
      ),
    },
    {
      key: 'semrush',
      name: 'SEMrush',
      description: 'Keyword rankings, clustering, site audit, competitor tracking',
      icon: '🎯',
      connection: semrush,
      action: (
        <span className="text-xs text-gray-500">Add SEMRUSH_API_KEY to Vercel env</span>
      ),
    },
  ]

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">⚙️ Settings & Connections</h1>
        <p className="text-gray-400 text-sm mt-1">Manage your API integrations and GSC property</p>
      </div>

      {/* Integrations */}
      <div className="space-y-4 mb-10">
        {integrations.map(int => (
          <div key={int.key} className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="text-2xl">{int.icon}</span>
              <div>
                <div className="flex items-center gap-2.5">
                  <p className="text-white font-medium">{int.name}</p>
                  <StatusBadge connected={int.connection.connected} />
                </div>
                <p className="text-gray-400 text-sm mt-0.5">{int.description}</p>
              </div>
            </div>
            <div>{int.action}</div>
          </div>
        ))}
      </div>

      {/* GSC Property Selector */}
      {gsc.connected && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h2 className="text-white font-semibold mb-1">GSC Property</h2>
          <p className="text-gray-400 text-sm mb-4">Select which property to track for all GSC tasks</p>

          {loadingSites ? (
            <p className="text-gray-500 text-sm">Loading properties...</p>
          ) : sites.length === 0 ? (
            <p className="text-gray-500 text-sm">No properties found. Make sure GSC is connected.</p>
          ) : (
            <div className="space-y-2">
              {sites.map(site => (
                <button
                  key={site.url}
                  onClick={() => selectProperty(site.url)}
                  disabled={savingProperty}
                  className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border text-sm transition ${
                    gsc.siteUrl === site.url
                      ? 'border-red-600 bg-red-700/20 text-white'
                      : 'border-gray-700 hover:border-gray-600 text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  <span>{site.url}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">{site.level}</span>
                    {gsc.siteUrl === site.url && (
                      <span className="text-xs text-red-400 font-medium">● Active</span>
                    )}
                  </div>
                </button>
              ))}
              {saved && <p className="text-green-400 text-sm mt-2">✅ Property saved!</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
