'use client'

import { useEffect, useState } from 'react'

type Connection = { connected: boolean; siteUrl?: string; propertyId?: string }
type Site = { url: string; level: string }

type WorkspaceMember = {
  id: string
  member_email: string
  member_user_id: string | null
  role: 'member' | 'manager'
  status: 'pending' | 'active' | 'rejected'
  created_at: string
  approved_at: string | null
}

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

function initials(email: string) {
  const parts = email.split('@')[0].split(/[._-]/)
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || (email[0]?.toUpperCase() ?? '?')
}

// ── Team Section ──────────────────────────────────────────────────────────────
function TeamSection() {
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [loading, setLoading] = useState(true)
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState<'member' | 'manager'>('member')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')
  const [actionLoading, setActionLoading] = useState<string | null>(null) // member id

  useEffect(() => {
    fetchMembers()
  }, [])

  async function fetchMembers() {
    setLoading(true)
    try {
      const res = await fetch('/api/team')
      const data = await res.json()
      setMembers(data.members ?? [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  async function addMember(e: React.FormEvent) {
    e.preventDefault()
    if (!newEmail.trim()) return
    setAdding(true)
    setAddError('')
    try {
      const res = await fetch('/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail.trim().toLowerCase(), role: newRole }),
      })
      const data = await res.json()
      if (!res.ok) { setAddError(data.error); return }
      setMembers(prev => [data.member, ...prev])
      setNewEmail('')
    } catch {
      setAddError('Something went wrong')
    } finally {
      setAdding(false)
    }
  }

  async function doAction(id: string, action: 'approve' | 'reject' | 'remove' | 'set_role', role?: string) {
    setActionLoading(id + action)
    try {
      const res = await fetch('/api/team', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, role }),
      })
      if (!res.ok) return
      if (action === 'remove') {
        setMembers(prev => prev.filter(m => m.id !== id))
      } else if (action === 'approve') {
        setMembers(prev => prev.map(m => m.id === id ? { ...m, status: 'active', approved_at: new Date().toISOString() } : m))
      } else if (action === 'reject') {
        setMembers(prev => prev.map(m => m.id === id ? { ...m, status: 'rejected' } : m))
      } else if (action === 'set_role' && role) {
        setMembers(prev => prev.map(m => m.id === id ? { ...m, role: role as 'member' | 'manager' } : m))
      }
    } finally {
      setActionLoading(null)
    }
  }

  const pending  = members.filter(m => m.status === 'pending')
  const active   = members.filter(m => m.status === 'active')
  const rejected = members.filter(m => m.status === 'rejected')

  return (
    <div className="space-y-6">
      {/* Add member form */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h3 className="text-white font-semibold mb-1">Invite Team Member</h3>
        <p className="text-gray-400 text-sm mb-4">
          Pre-register their email. Once they sign up with that email, you'll see them here to approve.
        </p>
        <form onSubmit={addMember} className="flex gap-2 flex-wrap">
          <input
            type="email"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
            placeholder="colleague@g2g.com"
            className="flex-1 min-w-48 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
          />
          <select
            value={newRole}
            onChange={e => setNewRole(e.target.value as 'member' | 'manager')}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 focus:outline-none focus:ring-2 focus:ring-red-600"
          >
            <option value="member">Member</option>
            <option value="manager">Manager</option>
          </select>
          <button
            type="submit"
            disabled={adding || !newEmail.trim()}
            className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition"
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </form>
        {addError && (
          <p className="text-red-400 text-xs mt-2">{addError}</p>
        )}
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm px-1">Loading team members…</p>
      ) : members.length === 0 ? (
        <p className="text-gray-600 text-sm px-1">No team members yet. Add someone above.</p>
      ) : (
        <div className="space-y-6">
          {/* Pending approval */}
          {pending.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-yellow-400 uppercase tracking-wider mb-2 px-1">
                ⏳ Pending ({pending.length}) — approve after sign-up, or ⚡ Force Activate if invited via Supabase
              </h4>
              <div className="space-y-2">
                {pending.map(m => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    actionLoading={actionLoading}
                    onAction={doAction}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Active members */}
          {active.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-green-400 uppercase tracking-wider mb-2 px-1">
                ✅ Active ({active.length})
              </h4>
              <div className="space-y-2">
                {active.map(m => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    actionLoading={actionLoading}
                    onAction={doAction}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Rejected */}
          {rejected.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2 px-1">
                Rejected ({rejected.length})
              </h4>
              <div className="space-y-2">
                {rejected.map(m => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    actionLoading={actionLoading}
                    onAction={doAction}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MemberRow({
  member: m,
  actionLoading,
  onAction,
}: {
  member: WorkspaceMember
  actionLoading: string | null
  onAction: (id: string, action: 'approve' | 'reject' | 'remove' | 'set_role', role?: string) => void
}) {
  const hasSignedUp = !!m.member_user_id
  const isBusy = (action: string) => actionLoading === m.id + action

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center gap-4">
      {/* Avatar */}
      <span className="w-8 h-8 rounded-full bg-indigo-700 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
        {initials(m.member_email)}
      </span>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium truncate">{m.member_email}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {/* Role badge */}
          <span className={`text-xs px-1.5 py-0.5 rounded border ${
            m.role === 'manager'
              ? 'text-purple-300 border-purple-700 bg-purple-700/20'
              : 'text-gray-400 border-gray-700 bg-gray-800'
          }`}>
            {m.role === 'manager' ? '★ Manager' : 'Member'}
          </span>
          {/* Sign-up status */}
          {m.status === 'pending' && (
            <span className={`text-xs ${hasSignedUp ? 'text-yellow-400' : 'text-gray-600'}`}>
              {hasSignedUp ? '● Signed up — awaiting approval' : '○ Not signed up yet'}
            </span>
          )}
          {m.status === 'active' && m.approved_at && (
            <span className="text-xs text-gray-600">
              Active since {new Date(m.approved_at).toLocaleDateString('id-ID')}
            </span>
          )}
          {m.status === 'rejected' && (
            <span className="text-xs text-gray-600">Rejected</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {m.status === 'pending' && (
          <>
            <button
              onClick={() => onAction(m.id, 'approve')}
              disabled={isBusy('approve')}
              title={hasSignedUp ? 'Member has signed up — approve access' : 'Force activate (e.g. invited manually via Supabase)'}
              className={`text-xs px-3 py-1.5 rounded-lg font-medium transition disabled:opacity-50 ${
                hasSignedUp
                  ? 'bg-green-700 hover:bg-green-600 text-white'
                  : 'border border-gray-600 text-gray-400 hover:border-green-600 hover:text-green-400'
              }`}
            >
              {isBusy('approve') ? '…' : hasSignedUp ? '✓ Approve' : '⚡ Force Activate'}
            </button>
            <button
              onClick={() => onAction(m.id, 'reject')}
              disabled={isBusy('reject')}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-red-700 hover:text-red-400 transition disabled:opacity-50"
            >
              {isBusy('reject') ? '…' : 'Reject'}
            </button>
          </>
        )}
        {m.status === 'active' && (
          <select
            value={m.role}
            onChange={e => onAction(m.id, 'set_role', e.target.value)}
            className="text-xs bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 focus:outline-none focus:ring-1 focus:ring-red-600"
          >
            <option value="member">Member</option>
            <option value="manager">Manager</option>
          </select>
        )}
        {m.status === 'rejected' && (
          <button
            onClick={() => onAction(m.id, 'approve')}
            disabled={isBusy('approve')}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-green-600 hover:text-green-400 transition disabled:opacity-50"
          >
            Re-approve
          </button>
        )}
        <button
          onClick={() => onAction(m.id, 'remove')}
          disabled={isBusy('remove')}
          className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-800 text-gray-600 hover:border-red-800 hover:text-red-500 transition disabled:opacity-50"
          title="Remove from workspace"
        >
          {isBusy('remove') ? '…' : '✕'}
        </button>
      </div>
    </div>
  )
}

// ── Diagnostic Panel ──────────────────────────────────────────────────────────
type DiagResult = { ok: boolean; label: string; detail?: string; balance?: string; latency_ms?: number }

function DiagnosticPanel() {
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<Record<string, DiagResult> | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)

  async function runDiagnostic() {
    setRunning(true)
    setResults(null)
    try {
      const res = await fetch('/api/settings/health')
      const data = await res.json()
      setResults(data.results)
      setCheckedAt(data.checked_at)
    } catch {
      setResults({ error: { ok: false, label: 'Error', detail: 'Failed to reach diagnostic endpoint' } })
    }
    setRunning(false)
  }

  const allOk = results && Object.values(results).every(r => r.ok)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
      <div className="flex items-center justify-between mb-1">
        <div>
          <h2 className="text-white font-semibold">API Diagnostic</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Live-check all API connections and view remaining balances
          </p>
        </div>
        <button
          onClick={runDiagnostic}
          disabled={running}
          className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border border-gray-700 text-gray-300 hover:border-gray-500 hover:text-white transition disabled:opacity-50"
        >
          {running ? <><span className="animate-spin inline-block">⟳</span> Checking…</> : '🔬 Run Diagnostic'}
        </button>
      </div>

      {checkedAt && (
        <p className="text-xs text-gray-600 mb-4">
          Last checked: {new Date(checkedAt).toLocaleString('id-ID')}
          {allOk && <span className="ml-2 text-green-500">· All systems operational ✓</span>}
        </p>
      )}

      {results && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
          {Object.values(results).map(r => (
            <div
              key={r.label}
              className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border ${
                r.ok
                  ? 'bg-green-500/5 border-green-500/20'
                  : 'bg-red-500/5 border-red-500/20'
              }`}
            >
              <span className={`text-sm mt-0.5 flex-shrink-0 ${r.ok ? 'text-green-400' : 'text-red-400'}`}>
                {r.ok ? '✓' : '✕'}
              </span>
              <div className="min-w-0">
                <p className={`text-sm font-medium ${r.ok ? 'text-green-300' : 'text-red-300'}`}>
                  {r.label}
                  {r.latency_ms !== undefined && (
                    <span className="ml-1.5 text-xs text-gray-500 font-normal">{r.latency_ms}ms</span>
                  )}
                </p>
                {r.balance && <p className="text-xs text-gray-400 mt-0.5">{r.balance}</p>}
                {r.detail  && <p className={`text-xs mt-0.5 ${r.ok ? 'text-gray-500' : 'text-red-400/80'}`}>{r.detail}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main Settings Page ────────────────────────────────────────────────────────
export default function SettingsPage() {
  const [gsc, setGsc] = useState<Connection>({ connected: false })
  const [ga4, setGa4] = useState<Connection>({ connected: false })
  const [slack, setSlack] = useState<Connection>({ connected: false })
  const [semrush, setSemrush] = useState<Connection>({ connected: false })
  const [sites, setSites] = useState<Site[]>([])
  const [loadingSites, setLoadingSites] = useState(false)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [savingProperty, setSavingProperty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'connections' | 'team'>('connections')

  // Notification settings
  const [notifLoading, setNotifLoading] = useState(false)
  const [notifSaving, setNotifSaving] = useState(false)
  const [notifSettings, setNotifSettings] = useState({
    slack_clicks_alerts: false,
    slack_cwv_alerts:    false,
    slack_index_alerts:  true,
  })

  useEffect(() => {
    async function loadNotifSettings() {
      try {
        setNotifLoading(true)
        const res = await fetch('/api/settings/notifications')
        if (res.ok) setNotifSettings(await res.json())
      } catch { /* silent */ }
      finally { setNotifLoading(false) }
    }
    loadNotifSettings()
  }, [])

  async function saveNotifSetting(key: keyof typeof notifSettings, value: boolean) {
    const updated = { ...notifSettings, [key]: value }
    setNotifSettings(updated)
    setNotifSaving(true)
    try {
      await fetch('/api/settings/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      })
    } catch { /* silent */ }
    finally { setNotifSaving(false) }
  }

  useEffect(() => {
    async function loadStatus() {
      setLoadingStatus(true)
      try {
        const res = await fetch('/api/settings/status')
        const status = await res.json()
        setGsc({ connected: status.gsc.connected, siteUrl: status.gsc.siteUrl })
        setGa4({ connected: status.ga4.connected, propertyId: status.ga4.propertyId })
        setSlack({ connected: status.slack.connected })
        setSemrush({ connected: status.semrush.connected })
        if (status.gsc.connected) {
          setLoadingSites(true)
          const sitesRes = await fetch('/api/gsc/properties')
          const sitesData = await sitesRes.json()
          setSites(sitesData.sites ?? [])
          setLoadingSites(false)
        }
      } catch (e) {
        console.error('Failed to load integration status', e)
      }
      setLoadingStatus(false)
    }
    loadStatus()
  }, [])

  async function handleSync() {
    setSyncing(true); setSyncResult(null)
    try {
      const res = await fetch('/api/cron/trigger', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        const drops = Object.values(data.data?.results ?? {}).reduce(
          (sum: number, r: unknown) => sum + ((r as { drops?: number }).drops ?? 0), 0
        )
        setSyncResult(`✅ Sync complete! Found ${drops} ranking drop(s).`)
      } else {
        setSyncResult(`❌ Sync failed: ${data.error}`)
      }
    } catch { setSyncResult('❌ Sync failed — check Vercel logs') }
    setSyncing(false)
  }

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
        <a href="/api/auth/google" className="text-sm font-medium text-red-400 hover:text-red-300 transition">
          {gsc.connected ? 'Reconnect' : 'Connect →'}
        </a>
      ),
      detail: null,
    },
    {
      key: 'ga4',
      name: 'Google Analytics 4',
      description: 'Organic traffic, content performance, landing pages',
      icon: '📈',
      connection: ga4,
      action: ga4.connected ? (
        <a href="/api/auth/google" className="text-sm font-medium text-red-400 hover:text-red-300 transition">Reconnect</a>
      ) : null,
      detail: ga4.connected
        ? <span className="text-xs text-gray-500 mt-0.5 block">Property ID: {ga4.propertyId}</span>
        : <span className="text-xs text-gray-500 mt-0.5 block">Add GA4_PROPERTY_ID to Vercel env</span>,
    },
    {
      key: 'slack',
      name: 'Slack',
      description: 'Daily alerts for ranking drops, index issues, CWV degradation',
      icon: '💬',
      connection: slack,
      action: slack.connected
        ? <span className="text-xs text-green-500 font-medium">Webhook active ✓</span>
        : <span className="text-xs text-gray-500">Add SLACK_WEBHOOK_URL to Vercel env</span>,
      detail: null,
    },
    {
      key: 'semrush',
      name: 'SEMrush',
      description: 'Keyword rankings, clustering, site audit, competitor tracking',
      icon: '🎯',
      connection: semrush,
      action: semrush.connected
        ? <span className="text-xs text-green-500 font-medium">API key active ✓</span>
        : <span className="text-xs text-gray-500">Add SEMRUSH_API_KEY to Vercel env</span>,
      detail: null,
    },
    {
      key: 'dataforseo',
      name: 'DataForSEO',
      description: 'SERP data, PAA, keyword suggestions for brief generation',
      icon: '📊',
      connection: { connected: true }, // always set via env
      action: <span className="text-xs text-green-500 font-medium">API key active ✓</span>,
      detail: null,
    },
    {
      key: 'firecrawl',
      name: 'Firecrawl',
      description: 'Page crawling for on-page content brief generation',
      icon: '🕷️',
      connection: { connected: true }, // always set via env
      action: <span className="text-xs text-green-500 font-medium">API key active ✓</span>,
      detail: null,
    },
    {
      key: 'anthropic',
      name: 'Anthropic (Claude)',
      description: 'AI generation for briefs, ideas, and content drafts',
      icon: '🤖',
      connection: { connected: true }, // always set via env
      action: <span className="text-xs text-green-500 font-medium">API key active ✓</span>,
      detail: null,
    },
  ]

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">⚙️ Settings & Connections</h1>
        <p className="text-gray-400 text-sm mt-1">Manage integrations, GSC property, and your team</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-6 border-b border-gray-800">
        {(['connections', 'team'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
              activeTab === tab
                ? 'border-red-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab === 'connections' ? '🔌 Connections' : '👥 Team'}
          </button>
        ))}
      </div>

      {/* ── Connections tab ──────────────────────────────────────────────────── */}
      {activeTab === 'connections' && (
        <>
          {/* Product Tiers shortcut — Sprint A foundation */}
          <a
            href="/settings/product-tiers"
            className="bg-gray-900 border border-gray-800 hover:border-amber-700/50 rounded-xl p-5 flex items-center justify-between mb-4 transition group"
          >
            <div>
              <p className="text-white font-medium">🎯 Product Tiers</p>
              <p className="text-gray-400 text-sm mt-0.5">Manage Tier 1 (top 10) + Tier 2 (next 25) products per brand — drives priority alerts, deeper Bragi prompts, hybrid review gates.</p>
            </div>
            <span className="text-gray-500 group-hover:text-amber-400 transition">→</span>
          </a>

          {/* G2G CMS Token shortcut — manual weekly JWT refresh */}
          <a
            href="/settings/cms-token"
            className="bg-gray-900 border border-gray-800 hover:border-blue-700/50 rounded-xl p-5 flex items-center justify-between mb-4 transition group"
          >
            <div>
              <p className="text-white font-medium">🔐 CMS Token</p>
              <p className="text-gray-400 text-sm mt-0.5">Paste a fresh admin JWT weekly — powers auto-upload of generated content into the CMS (marketing + SEO + FAQ).</p>
            </div>
            <span className="text-gray-500 group-hover:text-blue-400 transition">→</span>
          </a>

          {/* G2G Product Catalog — canonical mirror of CMS catalog */}
          <a
            href="/settings/g2g-products"
            className="bg-gray-900 border border-gray-800 hover:border-purple-700/50 rounded-xl p-5 flex items-center justify-between mb-4 transition group"
          >
            <div>
              <p className="text-white font-medium">📚 Product Catalog</p>
              <p className="text-gray-400 text-sm mt-0.5">Upload the latest CSV export from your CMS admin. Powers CMS upload caching, tier admin autocomplete, sheet validation, and opportunity-to-product mapping. Scoped to active brand.</p>
            </div>
            <span className="text-gray-500 group-hover:text-purple-400 transition">→</span>
          </a>

          {/* News & Trends Export — shareable Google Sheet for other divisions */}
          <a
            href="/settings/news-export"
            className="bg-gray-900 border border-gray-800 hover:border-emerald-700/50 rounded-xl p-5 flex items-center justify-between mb-4 transition group"
          >
            <div>
              <p className="text-white font-medium">📤 News & Trends Export</p>
              <p className="text-gray-400 text-sm mt-0.5">Configure a Google Sheet to receive News Signals + Game Trends snapshots. Auto-pushed every Monday morning, plus manual trigger. Hand off to other divisions cleanly.</p>
            </div>
            <span className="text-gray-500 group-hover:text-emerald-400 transition">→</span>
          </a>

          {/* Tyr Auto-Publish — quality thresholds per tier */}
          <a
            href="/settings/tyr-autopublish"
            className="bg-gray-900 border border-gray-800 hover:border-cyan-700/50 rounded-xl p-5 flex items-center justify-between mb-4 transition group"
          >
            <div>
              <p className="text-white font-medium">⚖ Tyr Auto-Publish Rules</p>
              <p className="text-gray-400 text-sm mt-0.5">Per-tier thresholds that decide if a brief skips human review and goes straight to <code className="text-cyan-300">auto_approved</code>. Removes the manual review bottleneck for non-top products.</p>
            </div>
            <span className="text-gray-500 group-hover:text-cyan-400 transition">→</span>
          </a>

          {/* Slack routing — multi-channel webhooks per notification type */}
          <a
            href="/settings/slack-routing"
            className="bg-gray-900 border border-gray-800 hover:border-pink-700/50 rounded-xl p-5 flex items-center justify-between mb-4 transition group"
          >
            <div>
              <p className="text-white font-medium">🔀 Slack Channel Routing</p>
              <p className="text-gray-400 text-sm mt-0.5">Send each notification type (daily alerts, weekly reports, agent digests, CMS alerts, bug reports) to a different Slack channel. Falls back to <code className="text-pink-300">SLACK_WEBHOOK_URL</code> env when unmapped.</p>
            </div>
            <span className="text-gray-500 group-hover:text-pink-400 transition">→</span>
          </a>

          {/* Manual Sync */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-center justify-between mb-6">
            <div>
              <p className="text-white font-medium">Manual Data Sync</p>
              <p className="text-gray-400 text-sm mt-0.5">Pull latest GSC data now — normally runs automatically at 8am daily</p>
              {syncResult && <p className="text-sm mt-2 font-medium text-green-400">{syncResult}</p>}
            </div>
            <button
              onClick={handleSync}
              disabled={syncing || !gsc.connected}
              className="flex items-center gap-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition flex-shrink-0 ml-4"
            >
              {syncing ? <><span className="animate-spin inline-block">⟳</span> Syncing...</> : <>⟳ Sync Now</>}
            </button>
          </div>

          {/* Integrations */}
          <div className="space-y-4 mb-10">
            {loadingStatus ? (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 text-gray-500 text-sm">
                Loading integration status...
              </div>
            ) : (
              integrations.map(int => (
                <div key={int.key} className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <span className="text-2xl">{int.icon}</span>
                    <div>
                      <div className="flex items-center gap-2.5">
                        <p className="text-white font-medium">{int.name}</p>
                        <StatusBadge connected={int.connection.connected} />
                      </div>
                      <p className="text-gray-400 text-sm mt-0.5">{int.description}</p>
                      {int.detail}
                    </div>
                  </div>
                  <div className="flex-shrink-0 ml-4">{int.action}</div>
                </div>
              ))
            )}
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
        </>
      )}

      {/* ── Team tab ─────────────────────────────────────────────────────────── */}
      {activeTab === 'team' && <TeamSection />}

      {/* ── Slack Notification Toggles ───────────────────────────────────────── */}
      {slack.connected && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-white font-semibold">🔔 Slack Notification Settings</h2>
              <p className="text-gray-500 text-xs mt-0.5">
                Control which alerts get sent to your Slack channel via the GSC daily cron.
              </p>
            </div>
            {notifSaving && <span className="text-xs text-gray-500 animate-pulse">Saving…</span>}
            {notifLoading && <span className="text-xs text-gray-500 animate-pulse">Loading…</span>}
          </div>

          <div className="space-y-3">
            {([
              { key: 'slack_clicks_alerts' as const, label: 'Clicks Drop Alert', desc: 'Notify when pages lose >15% organic clicks WoW', icon: '📉' },
              { key: 'slack_index_alerts'  as const, label: 'Index Coverage Alert', desc: 'Notify when indexed pages drop by 50+ or new crawl errors appear', icon: '🔍' },
              { key: 'slack_cwv_alerts'    as const, label: 'Core Web Vitals Alert', desc: 'Notify when LCP / CLS / INP poor ratio degrades by >5%', icon: '⚡' },
            ] as const).map(({ key, label, desc, icon }) => (
              <div key={key} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                <div>
                  <p className="text-sm text-white font-medium">{icon} {label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                </div>
                <button
                  onClick={() => saveNotifSetting(key, !notifSettings[key])}
                  disabled={notifLoading || notifSaving}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                    notifSettings[key] ? 'bg-red-600' : 'bg-gray-700'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      notifSettings[key] ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── API Diagnostic (always visible at bottom) ────────────────────────── */}
      <DiagnosticPanel />
    </div>
  )
}
