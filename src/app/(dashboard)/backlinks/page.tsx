'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import PortfolioDashboard from '@/components/backlinks/PortfolioDashboard'

// ── Country config ─────────────────────────────────────────────────────────────
const COUNTRIES: { code: string; flag: string; label: string; currency: string }[] = [
  { code: 'global', flag: '🌐', label: 'Global',        currency: 'USD' },
  { code: 'us',     flag: '🇺🇸', label: 'United States', currency: 'USD' },
  { code: 'id',     flag: '🇮🇩', label: 'Indonesia',     currency: 'IDR' },
  { code: 'sg',     flag: '🇸🇬', label: 'Singapore',     currency: 'SGD' },
  { code: 'my',     flag: '🇲🇾', label: 'Malaysia',      currency: 'MYR' },
  { code: 'ph',     flag: '🇵🇭', label: 'Philippines',   currency: 'PHP' },
  { code: 'th',     flag: '🇹🇭', label: 'Thailand',      currency: 'THB' },
  { code: 'vn',     flag: '🇻🇳', label: 'Vietnam',       currency: 'VND' },
  { code: 'au',     flag: '🇦🇺', label: 'Australia',     currency: 'AUD' },
  { code: 'gb',     flag: '🇬🇧', label: 'United Kingdom',currency: 'GBP' },
  { code: 'eu',     flag: '🇪🇺', label: 'Europe',        currency: 'EUR' },
  { code: 'br',     flag: '🇧🇷', label: 'Brazil',        currency: 'BRL' },
  { code: 'jp',     flag: '🇯🇵', label: 'Japan',         currency: 'JPY' },
  { code: 'kr',     flag: '🇰🇷', label: 'South Korea',   currency: 'KRW' },
]

function countryMeta(code: string) {
  return COUNTRIES.find(c => c.code === code) ?? COUNTRIES[0]
}

// ── Types ──────────────────────────────────────────────────────────────────────
type PositionHistory = { date: string; position: number | null }[]

type Backlink = {
  id: string
  site_name: string
  external_url: string
  anchor_text: string
  target_page: string
  target_keyword: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_term: string | null
  utm_content: string | null
  link_status: 'active' | 'broken' | 'pending'
  last_checked_at: string | null
  check_method: string | null
  position_history: PositionHistory
  position_current: number | null
  position_at_creation: number | null
  cost_amount: number | null
  cost_currency: string
  live_date: string | null
  notes: string | null
  target_country: string
  created_at: string
}

type FormData = {
  site_name: string
  external_url: string
  anchor_text: string
  target_page: string
  target_keyword: string
  cost_amount: string
  cost_currency: string
  live_date: string
  notes: string
  target_country: string
  utm_source: string
  utm_medium: string
  utm_campaign: string
  utm_term: string
  utm_content: string
}

const EMPTY_FORM: FormData = {
  site_name: '', external_url: '', anchor_text: '', target_page: '',
  target_keyword: '', cost_amount: '', cost_currency: 'USD', live_date: '',
  notes: '', target_country: 'global',
  utm_source: '', utm_medium: 'referral', utm_campaign: '', utm_term: '', utm_content: '',
}

// ── UTM URL builder ───────────────────────────────────────────────────────────
function buildUtmUrl(baseUrl: string, params: { source: string; medium: string; campaign: string; term: string; content: string }): string {
  if (!baseUrl) return ''
  try {
    const url = new URL(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`)
    if (params.source)   url.searchParams.set('utm_source',   params.source)
    if (params.medium)   url.searchParams.set('utm_medium',   params.medium)
    if (params.campaign) url.searchParams.set('utm_campaign', params.campaign)
    if (params.term)     url.searchParams.set('utm_term',     params.term)
    if (params.content)  url.searchParams.set('utm_content',  params.content)
    return url.toString()
  } catch { return '' }
}

// ── Standalone UTM Generator Card ─────────────────────────────────────────────
function UtmGeneratorCard() {
  const [targetPage, setTargetPage] = useState('')
  const [source, setSource]         = useState('')
  const [medium, setMedium]         = useState('referral')
  const [campaign, setCampaign]     = useState('')
  const [term, setTerm]             = useState('')
  const [content, setContent]       = useState('')
  const [copied, setCopied]         = useState(false)

  const utmUrl = buildUtmUrl(targetPage, { source, medium, campaign, term, content })

  async function handleCopy() {
    if (!utmUrl) return
    await navigator.clipboard.writeText(utmUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4 sticky top-6">
      <div>
        <h2 className="text-white font-semibold text-sm mb-0.5">🔗 UTM Generator</h2>
        <p className="text-gray-500 text-xs">Generate a tracking URL to send to the partner site</p>
      </div>

      <div>
        <label className="block text-gray-500 text-xs mb-1">Target page (G2G URL)</label>
        <input value={targetPage} onChange={e => setTargetPage(e.target.value)}
          placeholder="https://www.g2g.com/categories/wow-gold"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-gray-500 text-xs mb-1">utm_source</label>
          <input value={source} onChange={e => setSource(e.target.value)}
            placeholder="e.g. ign"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
        </div>
        <div>
          <label className="block text-gray-500 text-xs mb-1">utm_medium</label>
          <input value={medium} onChange={e => setMedium(e.target.value)}
            placeholder="referral"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
        </div>
      </div>

      <div>
        <label className="block text-gray-500 text-xs mb-1">utm_campaign</label>
        <input value={campaign} onChange={e => setCampaign(e.target.value)}
          placeholder="e.g. r6-accounts-q2-2026"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-gray-500 text-xs mb-1">utm_term</label>
          <input value={term} onChange={e => setTerm(e.target.value)}
            placeholder="optional"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
        </div>
        <div>
          <label className="block text-gray-500 text-xs mb-1">utm_content</label>
          <input value={content} onChange={e => setContent(e.target.value)}
            placeholder="optional"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
        </div>
      </div>

      {utmUrl ? (
        <div className="space-y-2">
          <p className="text-gray-500 text-xs">Generated URL — share this with the partner:</p>
          <code className="block bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-green-400 break-all leading-relaxed">{utmUrl}</code>
          <button onClick={handleCopy}
            className={`w-full py-2 rounded-lg text-xs font-medium transition ${copied ? 'bg-green-700 text-white' : 'bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500'}`}>
            {copied ? '✓ Copied!' : 'Copy URL'}
          </button>
        </div>
      ) : (
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-3 text-center">
          <p className="text-gray-600 text-xs">Fill in Target Page + Source + Campaign to generate URL</p>
        </div>
      )}
    </div>
  )
}

// ── Add / Edit Form ───────────────────────────────────────────────────────────
function BacklinkForm({
  initial, onSave, onCancel,
}: {
  initial?: Backlink
  onSave: (data: FormData) => Promise<void>
  onCancel: () => void
}) {
  const [form, setForm] = useState<FormData>(initial ? {
    site_name: initial.site_name,
    external_url: initial.external_url,
    anchor_text: initial.anchor_text,
    target_page: initial.target_page,
    target_keyword: initial.target_keyword ?? '',
    cost_amount: initial.cost_amount?.toString() ?? '',
    cost_currency: initial.cost_currency ?? 'USD',
    live_date: initial.live_date ?? '',
    notes: initial.notes ?? '',
    target_country: initial.target_country ?? 'global',
    utm_source: initial.utm_source ?? '',
    utm_medium: initial.utm_medium ?? 'referral',
    utm_campaign: initial.utm_campaign ?? '',
    utm_term: initial.utm_term ?? '',
    utm_content: initial.utm_content ?? '',
  } : EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.site_name || !form.external_url || !form.anchor_text || !form.target_page) {
      setError('Site name, external URL, anchor text, and target page are required.')
      return
    }
    setSaving(true); setError(null)
    try { await onSave(form) } catch (err) { setError(String(err)) } finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-gray-400 text-xs font-medium mb-1">Site name *</label>
          <input value={form.site_name} onChange={e => setForm(f => ({ ...f, site_name: e.target.value }))}
            placeholder="e.g. IGN, PCGamer Blog"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
        </div>
        <div>
          <label className="block text-gray-400 text-xs font-medium mb-1">Target country</label>
          <select
            value={form.target_country}
            onChange={e => {
              const country = countryMeta(e.target.value)
              setForm(f => ({ ...f, target_country: e.target.value, cost_currency: country.currency }))
            }}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
          >
            {COUNTRIES.map(c => (
              <option key={c.code} value={c.code}>{c.flag} {c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-gray-400 text-xs font-medium mb-1">Live date</label>
          <input type="date" value={form.live_date} onChange={e => setForm(f => ({ ...f, live_date: e.target.value }))}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500" />
        </div>
      </div>

      <div>
        <label className="block text-gray-400 text-xs font-medium mb-1">External URL (page containing the backlink) *</label>
        <input value={form.external_url} onChange={e => setForm(f => ({ ...f, external_url: e.target.value }))}
          placeholder="https://www.ign.com/articles/best-r6-accounts"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-gray-400 text-xs font-medium mb-1">Anchor text *</label>
          <input value={form.anchor_text} onChange={e => setForm(f => ({ ...f, anchor_text: e.target.value }))}
            placeholder="e.g. buy r6 accounts"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
        </div>
        <div>
          <label className="block text-gray-400 text-xs font-medium mb-1">Target keyword (for ranking tracking)</label>
          <input value={form.target_keyword} onChange={e => setForm(f => ({ ...f, target_keyword: e.target.value }))}
            placeholder="e.g. r6 accounts for sale"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
        </div>
      </div>

      <div>
        <label className="block text-gray-400 text-xs font-medium mb-1">Target page (our G2G page) *</label>
        <input value={form.target_page} onChange={e => setForm(f => ({ ...f, target_page: e.target.value }))}
          placeholder="https://www.g2g.com/categories/rainbow-six-siege-account"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-gray-400 text-xs font-medium mb-1">Cost paid</label>
          <div className="flex gap-2">
            <input type="number" min="0" step="0.01" value={form.cost_amount} onChange={e => setForm(f => ({ ...f, cost_amount: e.target.value }))}
              placeholder="0.00"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500" />
            <select value={form.cost_currency} onChange={e => setForm(f => ({ ...f, cost_currency: e.target.value }))}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none">
              {['USD', 'EUR', 'GBP', 'IDR', 'SGD', 'MYR'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-gray-400 text-xs font-medium mb-1">Notes</label>
          <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            placeholder="Optional notes"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
        </div>
      </div>

      {/* UTM fields (record what was used) */}
      <div className="border border-gray-700/60 rounded-xl p-4 space-y-3 bg-gray-800/30">
        <p className="text-gray-500 text-xs font-medium uppercase tracking-wide">UTM Parameters (optional — record what was given to the partner)</p>
        <div className="grid grid-cols-2 gap-3">
          {([
            { key: 'utm_source', placeholder: 'e.g. ign' },
            { key: 'utm_medium', placeholder: 'referral' },
          ] as { key: keyof FormData; placeholder: string }[]).map(({ key, placeholder }) => (
            <div key={key}>
              <label className="block text-gray-500 text-xs mb-1">{key}</label>
              <input value={form[key] as string} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                placeholder={placeholder}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
            </div>
          ))}
        </div>
        <div>
          <label className="block text-gray-500 text-xs mb-1">utm_campaign</label>
          <input value={form.utm_campaign} onChange={e => setForm(f => ({ ...f, utm_campaign: e.target.value }))}
            placeholder="e.g. r6-accounts-q2-2026"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
        </div>
      </div>

      {error && <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving}
          className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition">
          {saving ? 'Saving…' : initial ? '✓ Save Changes' : '+ Add Backlink'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-gray-500 hover:text-gray-300 transition">Cancel</button>
      </div>
    </form>
  )
}

// ── Position change indicator ─────────────────────────────────────────────────
function PositionDelta({ current, creation }: { current: number | null; creation: number | null }) {
  if (current == null) return <span className="text-gray-600 text-xs">—</span>
  if (creation == null) return <span className="text-gray-400 text-xs">#{current}</span>
  const delta = creation - current // positive = improved (lower position number is better)
  return (
    <span className="text-xs font-medium">
      <span className="text-gray-400">#{current}</span>
      {delta !== 0 && (
        <span className={`ml-1 ${delta > 0 ? 'text-green-400' : 'text-red-400'}`}>
          {delta > 0 ? `▲${delta}` : `▼${Math.abs(delta)}`}
        </span>
      )}
    </span>
  )
}

// ── Mini sparkline for position history ───────────────────────────────────────
function PositionSparkline({ history }: { history: PositionHistory }) {
  const recent = history.filter(h => h.position != null).slice(-6)
  if (recent.length < 2) return <span className="text-gray-600 text-xs">no history</span>
  return (
    <div className="flex items-end gap-0.5 h-5">
      {recent.map((h, i) => {
        const pos = h.position!
        const maxPos = Math.max(...recent.map(r => r.position!))
        const minPos = Math.min(...recent.map(r => r.position!))
        const range = maxPos - minPos || 1
        const heightPct = 1 - ((pos - minPos) / range) // higher = better rank
        const barH = Math.max(2, Math.round(heightPct * 16))
        return (
          <div key={i} title={`${h.date}: #${pos}`}
            className="w-2 bg-blue-500 rounded-sm opacity-80 hover:opacity-100 transition"
            style={{ height: `${barH}px` }} />
        )
      })}
    </div>
  )
}

// ── Types for GA4 analytics ──────────────────────────────────────────────────
type BacklinkAnalytics = {
  id: string
  sessions: number | null
  conversions: number | null
}

type SortKey = 'live_date' | 'site_name' | 'cost' | 'sessions' | 'rank'

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function BacklinksPage() {
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshResult, setRefreshResult] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [analyticsMap, setAnalyticsMap] = useState<Map<string, BacklinkAnalytics>>(new Map())
  const [analyticsNote, setAnalyticsNote] = useState<string | null>(null)
  const [analyticsDays, setAnalyticsDays] = useState(30)
  const [analyticsTotals, setAnalyticsTotals] = useState<{ sessions: number | null; conversions: number | null } | null>(null)

  // ── Filter + sort state ───────────────────────────────────────────────────
  const [search,        setSearch]        = useState('')
  const [statusFilter,  setStatusFilter]  = useState<'all' | 'active' | 'broken' | 'pending'>('all')
  const [countryFilter, setCountryFilter] = useState('all')
  // Sprint BL.COST.FILTER — Paid (cost > 0) vs Free (cost null/0) derived from cost_amount.
  // No schema change needed; classification is logical at filter time.
  const [costFilter,    setCostFilter]    = useState<'all' | 'paid' | 'free'>('all')
  const [dateFrom,      setDateFrom]      = useState('')
  const [dateTo,        setDateTo]        = useState('')
  const [sortKey,       setSortKey]       = useState<SortKey>('live_date')
  const [sortDir,       setSortDir]       = useState<'asc' | 'desc'>('desc')

  // Sprint BL.VERIFY.UI.1 — multi-select + bulk verify
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkVerifying, setBulkVerifying] = useState(false)
  const [bulkProgress,  setBulkProgress]  = useState<{
    done: number; total: number; flipped_active: number; flipped_broken: number; errors: number
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/backlinks')
      const data = await res.json()
      setBacklinks(data.backlinks ?? [])
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  const loadAnalytics = useCallback(async (days: number) => {
    try {
      const res = await fetch(`/api/backlinks/analytics?days=${days}`)
      const data = await res.json()
      if (data.note) setAnalyticsNote(data.note)
      const map = new Map<string, BacklinkAnalytics>()
      for (const b of data.byBacklink ?? []) map.set(b.id, b)
      setAnalyticsMap(map)
      setAnalyticsTotals(data.summary ?? null)
    } catch { /* silent */ }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadAnalytics(analyticsDays) }, [loadAnalytics, analyticsDays])

  async function handleAdd(form: FormData) {
    const res = await fetch('/api/backlinks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    setBacklinks(prev => [data.backlink, ...prev])
    setShowForm(false)
  }

  async function handleEdit(id: string, form: FormData) {
    const res = await fetch(`/api/backlinks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    setBacklinks(prev => prev.map(b => b.id === id ? data.backlink : b))
    setEditingId(null)
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this backlink?')) return
    setDeletingId(id)
    await fetch(`/api/backlinks/${id}`, { method: 'DELETE' })
    setBacklinks(prev => prev.filter(b => b.id !== id))
    setDeletingId(null)
  }

  async function handleCheck(id: string) {
    setCheckingId(id)
    const res = await fetch('/api/backlinks/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const data = await res.json()
    if (res.ok) {
      setBacklinks(prev => prev.map(b => b.id === id
        ? { ...b, link_status: data.link_status, last_checked_at: new Date().toISOString(), check_method: data.method }
        : b
      ))
    }
    setCheckingId(null)
  }

  async function handleRefreshAll() {
    setRefreshing(true); setRefreshResult(null)
    try {
      const res = await fetch('/api/backlinks/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const data = await res.json()
      setRefreshResult(`✓ Refreshed ${data.checked} backlinks — ${data.active} active, ${data.broken} broken`)
      await load() // reload to get updated position data
    } catch (err) { setRefreshResult(`✗ Failed: ${err}`) }
    setRefreshing(false)
  }

  const totalCost = backlinks
    .filter(b => b.cost_amount && b.cost_currency === 'USD')
    .reduce((sum, b) => sum + (b.cost_amount ?? 0), 0)

  const activeCount = backlinks.filter(b => b.link_status === 'active').length
  const brokenCount = backlinks.filter(b => b.link_status === 'broken').length

  // ── Filtered + sorted list ────────────────────────────────────────────────
  const visibleBacklinks = useMemo(() => {
    let list = backlinks

    // Search: site_name, anchor_text, external_url, target_page
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(b =>
        b.site_name.toLowerCase().includes(q) ||
        b.anchor_text.toLowerCase().includes(q) ||
        b.external_url.toLowerCase().includes(q) ||
        b.target_page.toLowerCase().includes(q) ||
        (b.utm_campaign ?? '').toLowerCase().includes(q)
      )
    }

    // Status filter
    if (statusFilter !== 'all') list = list.filter(b => b.link_status === statusFilter)

    // Country filter
    if (countryFilter !== 'all') list = list.filter(b => (b.target_country ?? 'global') === countryFilter)

    // Sprint BL.COST.FILTER — Paid vs Free
    if (costFilter === 'paid') list = list.filter(b => (b.cost_amount ?? 0) > 0)
    if (costFilter === 'free') list = list.filter(b => !b.cost_amount || b.cost_amount === 0)

    // Date range (live_date)
    if (dateFrom) list = list.filter(b => b.live_date && b.live_date >= dateFrom)
    if (dateTo)   list = list.filter(b => b.live_date && b.live_date <= dateTo)

    // Sort
    return [...list].sort((a, b) => {
      let diff = 0
      if (sortKey === 'live_date') {
        diff = (a.live_date ?? '').localeCompare(b.live_date ?? '')
      } else if (sortKey === 'site_name') {
        diff = a.site_name.localeCompare(b.site_name)
      } else if (sortKey === 'cost') {
        diff = (a.cost_amount ?? 0) - (b.cost_amount ?? 0)
      } else if (sortKey === 'sessions') {
        const sa = analyticsMap.get(a.id)?.sessions ?? -1
        const sb = analyticsMap.get(b.id)?.sessions ?? -1
        diff = sa - sb
      } else if (sortKey === 'rank') {
        const ra = a.position_current ?? 999
        const rb = b.position_current ?? 999
        diff = ra - rb
      }
      return sortDir === 'asc' ? diff : -diff
    })
  }, [backlinks, search, statusFilter, countryFilter, costFilter, dateFrom, dateTo, sortKey, sortDir, analyticsMap])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const hasFilters = search || statusFilter !== 'all' || countryFilter !== 'all' || costFilter !== 'all' || dateFrom || dateTo

  // Sprint BL.VERIFY.UI.1 — selection helpers + date presets
  function toggleRow(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function selectAllVisible() {
    setSelectedIds(new Set(visibleBacklinks.map(b => b.id)))
  }
  function clearSelection() {
    setSelectedIds(new Set())
  }
  function applyDatePreset(preset: 'today' | 'week' | 'month' | 'last7' | 'last30' | 'clear') {
    const now = new Date()
    const yyyymmdd = (d: Date) => d.toISOString().slice(0, 10)
    if (preset === 'clear') {
      setDateFrom('')
      setDateTo('')
    } else if (preset === 'today') {
      setDateFrom(yyyymmdd(now))
      setDateTo(yyyymmdd(now))
    } else if (preset === 'week') {
      const mondayOffset = (now.getDay() + 6) % 7
      const monday = new Date(now)
      monday.setDate(now.getDate() - mondayOffset)
      setDateFrom(yyyymmdd(monday))
      setDateTo(yyyymmdd(now))
    } else if (preset === 'month') {
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      setDateFrom(yyyymmdd(firstOfMonth))
      setDateTo(yyyymmdd(now))
    } else if (preset === 'last7') {
      setDateFrom(yyyymmdd(new Date(now.getTime() - 7  * 86_400_000)))
      setDateTo(yyyymmdd(now))
    } else if (preset === 'last30') {
      setDateFrom(yyyymmdd(new Date(now.getTime() - 30 * 86_400_000)))
      setDateTo(yyyymmdd(now))
    }
  }

  /**
   * Sprint BL.VERIFY.UI.1 — Bulk verify selected rows.
   *
   * Reuses existing single-id /api/backlinks/check endpoint (which already
   * uses the canonical checkLinkLive helper — see BL.VERIFY.FIX). Throttled
   * to 3 concurrent because:
   *  • Firecrawl fallback is slow per call (5-15s)
   *  • Going too parallel slams remote sites and our Firecrawl quota
   *  • 50 rows × 3 concurrent × ~10s avg ≈ 3 min wall time — acceptable
   */
  async function handleBulkVerify() {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    if (!confirm(`Verify ${ids.length} backlink${ids.length !== 1 ? 's' : ''}? Plain fetch first, Firecrawl fallback for blocked sites. ~5-15s per row.`)) return

    setBulkVerifying(true)
    setBulkProgress({ done: 0, total: ids.length, flipped_active: 0, flipped_broken: 0, errors: 0 })

    const CONCURRENCY = 3
    const oldStatuses = new Map<string, string>()
    for (const id of ids) {
      const bl = backlinks.find(b => b.id === id)
      if (bl) oldStatuses.set(id, bl.link_status)
    }

    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const chunk = ids.slice(i, i + CONCURRENCY)
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(chunk.map(async id => {
        try {
          const res = await fetch('/api/backlinks/check', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ id }),
          })
          const data = await res.json()
          if (res.ok) {
            const newStatus = data.link_status as 'active' | 'broken'
            const oldStatus = oldStatuses.get(id)
            setBacklinks(prev => prev.map(b => b.id === id
              ? { ...b, link_status: newStatus, last_checked_at: new Date().toISOString(), check_method: data.method }
              : b
            ))
            setBulkProgress(p => {
              if (!p) return p
              const flippedActive = (oldStatus !== 'active' && newStatus === 'active') ? p.flipped_active + 1 : p.flipped_active
              const flippedBroken = (oldStatus !== 'broken' && newStatus === 'broken') ? p.flipped_broken + 1 : p.flipped_broken
              return { ...p, done: p.done + 1, flipped_active: flippedActive, flipped_broken: flippedBroken }
            })
          } else {
            setBulkProgress(p => p ? { ...p, done: p.done + 1, errors: p.errors + 1 } : p)
          }
        } catch {
          setBulkProgress(p => p ? { ...p, done: p.done + 1, errors: p.errors + 1 } : p)
        }
      }))
    }

    setBulkVerifying(false)
    // Keep progress visible after done so user sees final summary; clear selection
    clearSelection()
  }

  return (
    <div className="p-8 min-h-screen">
      {/* Header */}
      <div className="flex items-start justify-between mb-6 flex-wrap gap-4 max-w-7xl">
        <div>
          <h1 className="text-2xl font-bold text-white">🔗 Backlink Tracker</h1>
          <p className="text-gray-400 text-sm mt-1">Track all inbound links (paid + free guest posts + organic mentions) — monitor if they&apos;re still live and their ranking impact</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={handleRefreshAll} disabled={refreshing || backlinks.length === 0}
            className="text-sm px-4 py-2 rounded-lg border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 disabled:opacity-40 transition flex items-center gap-2">
            {refreshing ? <><span className="animate-spin inline-block">⟳</span> Refreshing…</> : '⟳ Monthly Refresh'}
          </button>
          <button onClick={() => { setShowForm(true); setEditingId(null) }}
            className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition">
            + Add Backlink
          </button>
        </div>
      </div>

      {refreshResult && (
        <div className={`mb-4 text-sm px-4 py-2 rounded-lg border max-w-7xl ${refreshResult.startsWith('✓') ? 'text-green-400 bg-green-500/10 border-green-500/20' : 'text-red-400 bg-red-500/10 border-red-500/20'}`}>
          {refreshResult}
        </div>
      )}

      {/* Portfolio dashboard — derived analytics from the backlinks list */}
      <div className="max-w-7xl mb-5">
        <PortfolioDashboard backlinks={backlinks} />
      </div>

      {/* 2-column layout: main content + UTM Generator sidebar */}
      <div className="flex gap-6 max-w-7xl items-start">
        {/* Left: main tracker */}
        <div className="flex-1 min-w-0 space-y-5">
          {/* Stats row */}
          {backlinks.length > 0 && (
            <div className="grid grid-cols-4 gap-4">
              {[
                { label: 'Total Backlinks', value: backlinks.length, color: 'text-white' },
                { label: 'Active', value: activeCount, color: 'text-green-400' },
                { label: 'Broken', value: brokenCount, color: brokenCount > 0 ? 'text-red-400' : 'text-gray-500' },
                { label: 'Total Cost (USD)', value: `$${totalCost.toFixed(0)}`, color: 'text-yellow-400' },
              ].map(s => (
                <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <p className="text-gray-500 text-xs mb-1">{s.label}</p>
                  <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Sprint BACKLINK.GA4.SUMMARY.1 — Collapsed GA4 panel.
              Was a flat list per-backlink (didn't scale past ~30 rows). Now
              shows totals + top 5 referrers by sessions, with a link to
              /backlinks/ga4-analytics for the full searchable view. */}
          {backlinks.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <div>
                  <h2 className="text-white font-semibold text-sm">📈 GA4 Click Analytics</h2>
                  <p className="text-gray-500 text-xs mt-0.5">Sessions driven from each backlink via UTM / referral matching</p>
                </div>
                <div className="flex items-center gap-2">
                  {[7, 30, 90].map(d => (
                    <button key={d} onClick={() => setAnalyticsDays(d)}
                      className={`text-xs px-2.5 py-1 rounded-lg transition ${analyticsDays === d ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
                      {d}d
                    </button>
                  ))}
                  <a
                    href={`/backlinks/ga4-analytics?days=${analyticsDays}`}
                    className="text-xs px-2.5 py-1 rounded-lg bg-blue-600/30 hover:bg-blue-600/50 border border-blue-500/40 text-blue-200 transition ml-1"
                  >
                    Full breakdown →
                  </a>
                </div>
              </div>

              {analyticsNote && (
                <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 text-yellow-400 text-xs mb-4">
                  {analyticsNote}
                </div>
              )}

              {analyticsTotals && analyticsTotals.sessions !== null && (
                <div className="flex gap-6 mb-4 pb-4 border-b border-gray-800">
                  <div>
                    <p className="text-2xl font-bold text-white">{analyticsTotals.sessions?.toLocaleString()}</p>
                    <p className="text-xs text-gray-500">Total sessions (last {analyticsDays}d)</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-green-400">{analyticsTotals.conversions?.toLocaleString()}</p>
                    <p className="text-xs text-gray-500">Total conversions</p>
                  </div>
                </div>
              )}

              {/* Top 5 referrers by sessions */}
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Top 5 by sessions</p>
                {(() => {
                  const activeBacklinks = backlinks.filter(b => b.link_status === 'active')
                  const enriched = activeBacklinks
                    .map(b => ({ bl: b, analytics: analyticsMap.get(b.id) }))
                    .sort((a, b) => (b.analytics?.sessions ?? -1) - (a.analytics?.sessions ?? -1))
                  const top5 = enriched.slice(0, 5)
                  const maxSessions = Math.max(...top5.map(t => t.analytics?.sessions ?? 0), 1)
                  if (top5.every(t => t.analytics?.sessions == null || t.analytics.sessions === 0)) {
                    return (
                      <p className="text-xs text-gray-600 italic py-2">
                        No GA4 sessions tracked yet for any backlink. Wait 24-48h after a backlink goes live, or check that UTM tags are firing correctly.
                      </p>
                    )
                  }
                  return top5.map(({ bl: b, analytics }) => {
                    const sessions    = analytics?.sessions
                    const conversions = analytics?.conversions
                    return (
                      <div key={b.id} className="flex items-center gap-3">
                        <div className="w-40 flex-shrink-0">
                          <p className="text-xs text-gray-300 truncate">{b.site_name}</p>
                          <p className="text-[10px] text-gray-600 truncate">{b.anchor_text}</p>
                        </div>
                        <div className="flex-1">
                          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-600 rounded-full transition-all"
                              style={{ width: sessions != null ? `${((sessions) / maxSessions) * 100}%` : '0%' }} />
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0 w-28">
                          {sessions != null ? (
                            <span className="text-xs text-white font-medium">
                              {sessions.toLocaleString()} sessions
                              {conversions != null && conversions > 0 && (
                                <span className="text-green-400 ml-1">· {conversions} conv</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-600">—</span>
                          )}
                        </div>
                      </div>
                    )
                  })
                })()}
                {(() => {
                  const activeCount = backlinks.filter(b => b.link_status === 'active').length
                  if (activeCount > 5) {
                    return (
                      <p className="text-[11px] text-gray-500 pt-2 border-t border-gray-800 mt-2">
                        Showing top 5 of {activeCount} active backlinks ·{' '}
                        <a href={`/backlinks/ga4-analytics?days=${analyticsDays}`} className="text-blue-400 hover:text-blue-300">
                          See all sites and per-row sessions →
                        </a>
                      </p>
                    )
                  }
                  return null
                })()}
              </div>
            </div>
          )}

          {/* Add form */}
          {showForm && !editingId && (
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-6">
              <h2 className="text-white font-semibold mb-4">Add New Backlink</h2>
              <BacklinkForm onSave={handleAdd} onCancel={() => setShowForm(false)} />
            </div>
          )}

          {/* ── Filter + Sort bar ─────────────────────────────────────────── */}
          {backlinks.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                {/* Search */}
                <div className="relative flex-1 min-w-[200px]">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">🔍</span>
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search site, anchor, URL…"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-red-500"
                  />
                  {search && (
                    <button onClick={() => setSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white text-xs">✕</button>
                  )}
                </div>

                {/* Status filter */}
                <select
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-red-500"
                >
                  <option value="all">All statuses</option>
                  <option value="active">🟢 Active</option>
                  <option value="broken">🔴 Broken</option>
                  <option value="pending">🟡 Pending</option>
                </select>

                {/* Country filter */}
                <select
                  value={countryFilter}
                  onChange={e => setCountryFilter(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-red-500"
                >
                  <option value="all">All countries</option>
                  {COUNTRIES.map(c => (
                    <option key={c.code} value={c.code}>{c.flag} {c.label}</option>
                  ))}
                </select>

                {/* Sprint BL.COST.FILTER — Paid vs Free derived from cost_amount */}
                <select
                  value={costFilter}
                  onChange={e => setCostFilter(e.target.value as typeof costFilter)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-red-500"
                  title="Paid = cost > 0; Free = cost is 0 or empty"
                >
                  <option value="all">All cost types</option>
                  <option value="paid">💰 Paid</option>
                  <option value="free">🆓 Free</option>
                </select>

                {/* Date range with quick presets */}
                <div className="flex items-center gap-1.5">
                  {/* Sprint BL.VERIFY.UI.1 — preset shortcuts */}
                  <div className="flex items-center gap-1 mr-1">
                    {([
                      { k: 'today',  l: 'Today' },
                      { k: 'week',   l: 'This week' },
                      { k: 'month',  l: 'This month' },
                      { k: 'last7',  l: 'Last 7d' },
                      { k: 'last30', l: 'Last 30d' },
                    ] as const).map(p => (
                      <button
                        key={p.k}
                        onClick={() => applyDatePreset(p.k)}
                        className="px-2 py-1 rounded text-[11px] bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition"
                      >
                        {p.l}
                      </button>
                    ))}
                  </div>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={e => setDateFrom(e.target.value)}
                    title="Live date from"
                    className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-red-500 w-32"
                  />
                  <span className="text-gray-600 text-xs">→</span>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={e => setDateTo(e.target.value)}
                    title="Live date to"
                    className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-red-500 w-32"
                  />
                </div>

                {/* Clear filters */}
                {hasFilters && (
                  <button
                    onClick={() => { setSearch(''); setStatusFilter('all'); setCountryFilter('all'); setCostFilter('all'); setDateFrom(''); setDateTo('') }}
                    className="text-xs text-gray-500 hover:text-white transition"
                  >
                    Clear filters
                  </button>
                )}
              </div>

              {/* Sort row */}
              <div className="flex items-center gap-2 border-t border-gray-800 pt-2.5">
                <span className="text-xs text-gray-600">Sort:</span>
                {([
                  { key: 'live_date', label: 'Date' },
                  { key: 'site_name', label: 'Site' },
                  { key: 'cost',      label: 'Cost' },
                  { key: 'sessions',  label: 'Sessions' },
                  { key: 'rank',      label: 'Rank' },
                ] as { key: SortKey; label: string }[]).map(s => (
                  <button
                    key={s.key}
                    onClick={() => toggleSort(s.key)}
                    className={`px-2.5 py-1 rounded text-xs transition ${sortKey === s.key ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-white'}`}
                  >
                    {s.label}
                    {sortKey === s.key && (sortDir === 'desc' ? ' ↓' : ' ↑')}
                  </button>
                ))}
                <span className="ml-auto text-xs text-gray-600">
                  {visibleBacklinks.length === backlinks.length
                    ? `${backlinks.length} backlinks`
                    : `${visibleBacklinks.length} of ${backlinks.length}`}
                </span>
              </div>
            </div>
          )}

          {/* Sprint BL.VERIFY.UI.1 — Bulk-select toolbar (shows when ≥1 selected) */}
          {visibleBacklinks.length > 0 && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedIds.size > 0 && visibleBacklinks.every(b => selectedIds.has(b.id))}
                  onChange={() => {
                    const allSelected = visibleBacklinks.every(b => selectedIds.has(b.id))
                    if (allSelected) clearSelection()
                    else selectAllVisible()
                  }}
                />
                Select all visible ({visibleBacklinks.length})
              </label>
              {selectedIds.size > 0 && (
                <>
                  <span className="text-xs text-gray-600">·</span>
                  <span className="text-xs text-emerald-400">{selectedIds.size} selected</span>
                  <button
                    onClick={handleBulkVerify}
                    disabled={bulkVerifying}
                    className="px-3 py-1 rounded-lg text-xs bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-medium transition"
                    title="Re-verify selected via fetch → Firecrawl fallback. Updates link_status per result."
                  >
                    {bulkVerifying ? `⟳ Verifying ${bulkProgress?.done ?? 0}/${bulkProgress?.total ?? 0}…` : `🔍 Verify ${selectedIds.size} selected`}
                  </button>
                  <button
                    onClick={clearSelection}
                    disabled={bulkVerifying}
                    className="text-xs text-gray-500 hover:text-white transition disabled:opacity-50"
                  >
                    Clear selection
                  </button>
                </>
              )}
            </div>
          )}

          {/* Sprint BL.VERIFY.UI.1 — Final summary after bulk verify */}
          {!bulkVerifying && bulkProgress && bulkProgress.done === bulkProgress.total && bulkProgress.total > 0 && (
            <div className="mb-3 bg-emerald-900/15 border border-emerald-700/30 rounded-lg p-3 text-xs flex items-center justify-between">
              <span className="text-emerald-200">
                ✓ Verified {bulkProgress.total} backlinks ·
                <span className="text-emerald-300 font-semibold"> {bulkProgress.flipped_active} flipped to active</span>
                {bulkProgress.flipped_broken > 0 && <span className="text-red-300 font-semibold"> · {bulkProgress.flipped_broken} flipped to broken</span>}
                {bulkProgress.errors > 0 && <span className="text-amber-300"> · {bulkProgress.errors} errors</span>}
              </span>
              <button onClick={() => setBulkProgress(null)} className="text-gray-500 hover:text-white">✕</button>
            </div>
          )}

          {/* Backlink list */}
          {loading ? (
            <div className="text-gray-500 text-sm text-center py-12">Loading backlinks…</div>
          ) : backlinks.length === 0 && !showForm ? (
            <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
              <p className="text-3xl mb-3">🔗</p>
              <p className="text-white font-semibold mb-1">No backlinks tracked yet</p>
              <p className="text-gray-500 text-sm mb-5">Add your first paid backlink or guest post to start tracking</p>
              <button onClick={() => setShowForm(true)}
                className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition">
                + Add First Backlink
              </button>
            </div>
          ) : visibleBacklinks.length === 0 && hasFilters ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
              <p className="text-gray-500 text-sm">No backlinks match the current filters.</p>
              <button onClick={() => { setSearch(''); setStatusFilter('all'); setCountryFilter('all'); setCostFilter('all'); setDateFrom(''); setDateTo('') }}
                className="text-xs text-red-400 hover:text-red-300 mt-2 transition">Clear filters</button>
            </div>
          ) : (
            <div className="space-y-3">
              {visibleBacklinks.map(bl => (
            <div key={bl.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              {editingId === bl.id ? (
                <div className="p-6">
                  <h3 className="text-white font-semibold mb-4">Edit Backlink</h3>
                  <BacklinkForm
                    initial={bl}
                    onSave={form => handleEdit(bl.id, form)}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              ) : (
                <div className="p-4">
                  {/* Top row */}
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    {/* Sprint BL.VERIFY.UI.1 — checkbox per row */}
                    <label
                      className="flex items-start pt-1 cursor-pointer select-none"
                      onClick={e => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(bl.id)}
                        onChange={() => toggleRow(bl.id)}
                        className="mt-0.5 accent-emerald-500"
                      />
                    </label>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-white font-semibold text-sm">{bl.site_name}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
                          bl.link_status === 'active'  ? 'text-green-400 bg-green-500/10 border-green-500/20' :
                          bl.link_status === 'broken'  ? 'text-red-400 bg-red-500/10 border-red-500/20' :
                          'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
                        }`}>{bl.link_status}</span>
                        {(() => { const c = countryMeta(bl.target_country ?? 'global'); return c.code !== 'global' ? (
                          <span className="text-xs px-2 py-0.5 rounded-full border text-gray-300 bg-gray-800 border-gray-700">
                            {c.flag} {c.label}
                          </span>
                        ) : null })()}
                        {bl.cost_amount && (
                          <span className="text-xs text-gray-500">{bl.cost_currency} {bl.cost_amount.toFixed(0)}</span>
                        )}
                        {bl.live_date && (
                          <span className="text-xs text-gray-600">live: {bl.live_date}</span>
                        )}
                      </div>
                      <a href={bl.external_url} target="_blank" rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 text-xs truncate block max-w-lg">
                        {bl.external_url}
                      </a>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button onClick={() => handleCheck(bl.id)} disabled={checkingId === bl.id}
                        className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition disabled:opacity-50">
                        {checkingId === bl.id ? '⟳' : '🔍 Check'}
                      </button>
                      <button onClick={() => { setEditingId(bl.id); setShowForm(false) }}
                        className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white transition">
                        ✏️ Edit
                      </button>
                      <button onClick={() => handleDelete(bl.id)} disabled={deletingId === bl.id}
                        className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-800 text-gray-600 hover:border-red-800 hover:text-red-500 transition disabled:opacity-50">
                        {deletingId === bl.id ? '…' : '✕'}
                      </button>
                    </div>
                  </div>

                  {/* Details row */}
                  <div className="mt-3 flex items-center gap-6 flex-wrap text-xs">
                    <div>
                      <span className="text-gray-500">Anchor: </span>
                      <span className="text-gray-300 font-medium">&ldquo;{bl.anchor_text}&rdquo;</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Target: </span>
                      <a href={bl.target_page} target="_blank" rel="noopener noreferrer"
                        className="text-gray-400 hover:text-blue-400 transition truncate max-w-xs inline-block align-bottom">
                        {(() => { try { return new URL(bl.target_page).pathname } catch { return bl.target_page } })()}
                      </a>
                    </div>
                    {bl.target_keyword && (
                      <div>
                        <span className="text-gray-500">Keyword: </span>
                        <span className="text-gray-300">{bl.target_keyword}</span>
                      </div>
                    )}
                    {bl.position_current != null && (
                      <div>
                        <span className="text-gray-500">Rank: </span>
                        <PositionDelta current={bl.position_current} creation={bl.position_at_creation} />
                      </div>
                    )}
                    {bl.position_history.length > 1 && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-500">Trend:</span>
                        <PositionSparkline history={bl.position_history} />
                      </div>
                    )}
                  </div>

                  {/* UTM + last checked */}
                  <div className="mt-2 flex items-center gap-4 flex-wrap text-xs text-gray-600">
                    {bl.utm_campaign && (
                      <span>utm_campaign: <span className="text-gray-500">{bl.utm_campaign}</span></span>
                    )}
                    {bl.last_checked_at && (
                      <span>
                        Last checked: {new Date(bl.last_checked_at).toLocaleDateString('id-ID')}
                        {bl.check_method && <span className="text-gray-700"> via {bl.check_method}</span>}
                      </span>
                    )}
                    {bl.notes && <span className="text-gray-600 italic">{bl.notes}</span>}
                  </div>
                </div>
              )}
            </div>
          ))}
            </div>
          )}
        </div>{/* end left column */}

        {/* Right: UTM Generator */}
        <div className="w-80 flex-shrink-0">
          <UtmGeneratorCard />
        </div>
      </div>{/* end 2-column */}
    </div>
  )
}
