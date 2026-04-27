'use client'

import { useState, useEffect, useCallback } from 'react'
import HermodFindingsPanel from '@/components/agents/HermodFindingsPanel'

// ── Types ─────────────────────────────────────────────────────────────────────
type Status = 'prospecting' | 'contacted' | 'negotiating' | 'accepted' | 'published' | 'rejected'

interface Prospect {
  id:               string
  domain:           string
  authority_score:  number | null
  organic_traffic:  number | null
  organic_keywords: number | null
  contact_name:     string | null
  contact_email:    string | null
  topic:            string | null
  target_url:       string | null
  anchor_text:      string | null
  published_url:    string | null
  published_date:   string | null
  status:           Status
  notes:            string | null
  follow_up_date:   string | null
  source_keyword:   string | null
  backlink_live:    boolean | null
  last_checked_at:  string | null
  check_error:      string | null
  created_at:       string
  updated_at:       string
}

interface Candidate {
  domain:          string
  rankingUrl:      string
  position:        number
  organicTraffic:  number
  organicKeywords: number
  authorityScore:  number
  inTracker:       boolean
  trackerStatus:   string | null
}

// ── Constants ─────────────────────────────────────────────────────────────────
const STATUSES: Status[] = ['prospecting', 'contacted', 'negotiating', 'accepted', 'published', 'rejected']

const STATUS_COLORS: Record<Status, string> = {
  prospecting: 'bg-gray-700 text-gray-300',
  contacted:   'bg-blue-900 text-blue-300',
  negotiating: 'bg-yellow-900 text-yellow-300',
  accepted:    'bg-green-900/60 text-green-300',
  published:   'bg-green-800 text-green-200',
  rejected:    'bg-red-900 text-red-300',
}

const STATUS_ICONS: Record<Status, string> = {
  prospecting: '🔍',
  contacted:   '📧',
  negotiating: '🤝',
  accepted:    '✅',
  published:   '🚀',
  rejected:    '❌',
}

function fmt(n: number | null | undefined): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// ── Edit Modal ────────────────────────────────────────────────────────────────
function EditModal({ prospect, onClose, onSaved }: {
  prospect: Prospect | null
  onClose:  () => void
  onSaved:  (p: Prospect) => void
}) {
  const isNew = !prospect
  const [form, setForm] = useState({
    domain:        prospect?.domain        ?? '',
    contact_name:  prospect?.contact_name  ?? '',
    contact_email: prospect?.contact_email ?? '',
    topic:         prospect?.topic         ?? '',
    target_url:    prospect?.target_url    ?? '',
    anchor_text:   prospect?.anchor_text   ?? '',
    published_url: prospect?.published_url ?? '',
    notes:         prospect?.notes         ?? '',
    follow_up_date: prospect?.follow_up_date ?? '',
    status:        prospect?.status        ?? 'prospecting' as Status,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  async function handleSave() {
    if (!form.domain.trim()) { setError('Domain is required'); return }
    setSaving(true)
    setError('')
    try {
      let res: Response
      if (isNew) {
        res = await fetch('/api/outreach/prospects', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(form),
        })
      } else {
        res = await fetch(`/api/outreach/prospects/${prospect.id}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(form),
        })
      }
      if (!res.ok) {
        const d = await res.json()
        setError(d.error ?? 'Failed to save')
        return
      }
      const d = await res.json()
      onSaved(d.prospect)
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const field = (label: string, key: keyof typeof form, opts?: { type?: string; placeholder?: string }) => (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <input
        type={opts?.type ?? 'text'}
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        placeholder={opts?.placeholder ?? ''}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
      />
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-white font-semibold">{isNew ? 'Add Prospect' : `Edit ${prospect.domain}`}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3">
          {field('Domain *', 'domain', { placeholder: 'example.com' })}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Status</label>
            <select
              value={form.status}
              onChange={e => setForm(f => ({ ...f, status: e.target.value as Status }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
            >
              {STATUSES.map(s => (
                <option key={s} value={s}>{STATUS_ICONS[s]} {s.charAt(0).toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {field('Contact Name', 'contact_name')}
            {field('Contact Email', 'contact_email', { type: 'email' })}
          </div>
          {field('Proposed Topic', 'topic', { placeholder: 'Article/post topic' })}
          {field('Target URL (G2G page)', 'target_url', { placeholder: 'https://g2g.com/...' })}
          {field('Anchor Text', 'anchor_text', { placeholder: 'buy gaming currency' })}
          {field('Published URL', 'published_url', { placeholder: 'https://...' })}
          {field('Follow-up Date', 'follow_up_date', { type: 'date' })}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={3}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 resize-none"
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
        <div className="px-5 py-4 border-t border-gray-800 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm rounded-lg">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Discovery Panel ───────────────────────────────────────────────────────────
function DiscoveryPanel({ onAddToTracker }: { onAddToTracker: (c: Candidate, kw: string) => void }) {
  const [keyword,    setKeyword]    = useState('')
  const [database,   setDatabase]   = useState('us')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState('')
  const [searched,   setSearched]   = useState('')
  const [adding,     setAdding]     = useState<Set<string>>(new Set())

  async function handleSearch() {
    if (!keyword.trim()) return
    setLoading(true)
    setError('')
    setCandidates([])
    try {
      const res = await fetch(`/api/outreach/discover?keyword=${encodeURIComponent(keyword)}&database=${database}&limit=25`)
      if (!res.ok) {
        const d = await res.json()
        setError(d.error ?? 'Failed to fetch')
        return
      }
      const data = await res.json()
      setCandidates(data.candidates ?? [])
      setSearched(keyword)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleAdd(c: Candidate) {
    setAdding(prev => new Set(prev).add(c.domain))
    await onAddToTracker(c, searched)
    setAdding(prev => { const n = new Set(prev); n.delete(c.domain); return n })
    // Refresh: mark as inTracker
    setCandidates(prev => prev.map(x => x.domain === c.domain ? { ...x, inTracker: true, trackerStatus: 'prospecting' } : x))
  }

  return (
    <div>
      {/* Search bar */}
      <div className="flex gap-3 mb-5">
        <input
          type="text"
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="e.g. buy gaming currency, game marketplace, diablo 4 gold"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
        />
        <select
          value={database}
          onChange={e => setDatabase(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
        >
          <option value="us">🇺🇸 US</option>
          <option value="uk">🇬🇧 UK</option>
          <option value="au">🇦🇺 AU</option>
          <option value="sg">🇸🇬 SG</option>
        </select>
        <button
          onClick={handleSearch}
          disabled={loading || !keyword.trim()}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg flex items-center gap-2"
        >
          {loading ? <span className="animate-spin">⟳</span> : '🔍'} {loading ? 'Searching…' : 'Discover'}
        </button>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {candidates.length > 0 && (
        <>
          <p className="text-xs text-gray-500 mb-3">
            Found <strong className="text-gray-300">{candidates.length}</strong> domains ranking for <strong className="text-yellow-400">&quot;{searched}&quot;</strong>. Top 10 enriched with authority score.
          </p>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">#</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Domain</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">AS</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">Traffic</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">Keywords</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-gray-500"></th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c, i) => (
                  <tr key={c.domain} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-3 py-2.5 text-gray-500 text-xs">{i + 1}</td>
                    <td className="px-3 py-2.5">
                      <a href={`https://${c.domain}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline text-sm">
                        {c.domain}
                      </a>
                      <p className="text-gray-600 text-xs truncate max-w-xs">{c.rankingUrl}</p>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {c.authorityScore > 0 ? (
                        <span className={`text-sm font-medium ${c.authorityScore >= 60 ? 'text-green-400' : c.authorityScore >= 30 ? 'text-yellow-400' : 'text-gray-400'}`}>
                          {c.authorityScore}
                        </span>
                      ) : <span className="text-gray-600 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right text-gray-300 text-sm">{fmt(c.organicTraffic)}</td>
                    <td className="px-3 py-2.5 text-right text-gray-400 text-sm">{fmt(c.organicKeywords)}</td>
                    <td className="px-3 py-2.5 text-right">
                      {c.inTracker ? (
                        <span className="text-xs text-green-500">✓ Added</span>
                      ) : (
                        <button
                          onClick={() => handleAdd(c)}
                          disabled={adding.has(c.domain)}
                          className="px-2.5 py-1 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs rounded-lg"
                        >
                          {adding.has(c.domain) ? '…' : '+ Track'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!loading && !error && candidates.length === 0 && (
        <div className="text-center py-16 text-gray-600">
          <p className="text-4xl mb-3">🔍</p>
          <p className="text-sm">Enter a keyword to discover guestpost candidates that rank for it.</p>
          <p className="text-xs mt-1">Example: &quot;buy diablo 4 gold&quot;, &quot;game currency marketplace&quot;</p>
        </div>
      )}
    </div>
  )
}

// ── Tracker Table ─────────────────────────────────────────────────────────────
function TrackerTable({ prospects, counts, onEdit, onDelete, onCheck, checking }: {
  prospects: Prospect[]
  counts:    Record<string, number>
  onEdit:    (p: Prospect) => void
  onDelete:  (p: Prospect) => void
  onCheck:   (p: Prospect) => void
  checking:  Set<string>
}) {
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [search, setSearch] = useState('')

  const filtered = prospects.filter(p => {
    if (filterStatus !== 'all' && p.status !== filterStatus) return false
    if (search && !p.domain.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  return (
    <div>
      {/* Status filter tabs */}
      <div className="flex flex-wrap gap-2 mb-4">
        {(['all', ...STATUSES] as const).map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              filterStatus === s
                ? 'bg-red-700 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >
            {s !== 'all' && STATUS_ICONS[s as Status]} {s.charAt(0).toUpperCase() + s.slice(1)}
            <span className="ml-1.5 text-gray-500">{s === 'all' ? counts.all : (counts[s] ?? 0)}</span>
          </button>
        ))}
        <div className="ml-auto">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search domain…"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-red-500 w-44"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-600">
          <p className="text-4xl mb-3">📋</p>
          <p className="text-sm">No prospects yet. Use Discovery to find candidates, or add one manually.</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Domain</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Status</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Contact</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Topic</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Backlink</th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-3 py-3">
                    <div>
                      <a href={`https://${p.domain}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline text-sm font-medium">
                        {p.domain}
                      </a>
                      <div className="flex items-center gap-2 mt-0.5">
                        {p.authority_score != null && (
                          <span className="text-xs text-gray-500">AS {p.authority_score}</span>
                        )}
                        {p.organic_traffic != null && (
                          <span className="text-xs text-gray-600">{fmt(p.organic_traffic)} visits</span>
                        )}
                        {p.follow_up_date && (
                          <span className={`text-xs ${new Date(p.follow_up_date) < new Date() ? 'text-red-400' : 'text-yellow-600'}`}>
                            📅 {p.follow_up_date}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>

                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[p.status]}`}>
                      {STATUS_ICONS[p.status]} {p.status}
                    </span>
                  </td>

                  <td className="px-3 py-3">
                    {p.contact_email ? (
                      <div>
                        <p className="text-white text-sm leading-tight">{p.contact_name || p.contact_email}</p>
                        <a href={`mailto:${p.contact_email}`} className="text-gray-500 text-xs hover:text-blue-400">{p.contact_email}</a>
                      </div>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </td>

                  <td className="px-3 py-3">
                    <p className="text-gray-300 text-xs line-clamp-2 max-w-xs">{p.topic || '—'}</p>
                  </td>

                  <td className="px-3 py-3">
                    {p.status === 'published' ? (
                      <div>
                        {p.backlink_live === null ? (
                          <span className="text-gray-500 text-xs">Not checked</span>
                        ) : p.backlink_live ? (
                          <span className="text-green-400 text-xs">✓ Live</span>
                        ) : (
                          <span className="text-red-400 text-xs">✗ Gone{p.check_error ? ` (${p.check_error.slice(0, 30)})` : ''}</span>
                        )}
                        {p.last_checked_at && (
                          <p className="text-gray-600 text-xs mt-0.5">
                            {new Date(p.last_checked_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </p>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </td>

                  <td className="px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {p.status === 'published' && p.published_url && (
                        <button
                          onClick={() => onCheck(p)}
                          disabled={checking.has(p.id)}
                          className="px-2 py-1 text-xs text-purple-400 hover:text-purple-300 hover:bg-purple-900/30 rounded transition disabled:opacity-50"
                          title="Check if backlink is still live"
                        >
                          {checking.has(p.id) ? '⟳' : '🔍'}
                        </button>
                      )}
                      <button
                        onClick={() => onEdit(p)}
                        className="px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => onDelete(p)}
                        className="px-2 py-1 text-xs text-red-500 hover:text-red-400 hover:bg-red-900/30 rounded transition"
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function OutreachPage() {
  const [tab,       setTab]      = useState<'discover' | 'tracker'>('discover')
  const [prospects, setProspects] = useState<Prospect[]>([])
  const [counts,    setCounts]   = useState<Record<string, number>>({})
  const [loading,   setLoading]  = useState(true)
  const [editModal, setEditModal] = useState<Prospect | 'new' | null>(null)
  const [checking,  setChecking] = useState<Set<string>>(new Set())

  const fetchProspects = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/outreach/prospects')
      if (res.ok) {
        const data = await res.json()
        setProspects(data.items ?? [])
        setCounts(data.counts ?? {})
      }
    } catch { /* silent */ }
    setLoading(false)
  }, [])

  useEffect(() => { fetchProspects() }, [fetchProspects])

  async function handleAddToTracker(c: Candidate, keyword: string, discoveredVia: string = 'semrush') {
    await fetch('/api/outreach/prospects', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain:           c.domain,
        authority_score:  c.authorityScore,
        organic_traffic:  c.organicTraffic,
        organic_keywords: c.organicKeywords,
        source_keyword:   keyword,
        discovered_via:   discoveredVia,
      }),
    })
    await fetchProspects()
  }

  async function handleDelete(p: Prospect) {
    if (!confirm(`Remove ${p.domain} from tracker?`)) return
    await fetch(`/api/outreach/prospects/${p.id}`, { method: 'DELETE' })
    setProspects(prev => prev.filter(x => x.id !== p.id))
    setCounts(prev => {
      const n = { ...prev }
      n.all = (n.all ?? 1) - 1
      n[p.status] = Math.max(0, (n[p.status] ?? 1) - 1)
      return n
    })
  }

  async function handleCheck(p: Prospect) {
    setChecking(prev => new Set(prev).add(p.id))
    try {
      const res = await fetch(`/api/outreach/prospects/${p.id}/check`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setProspects(prev => prev.map(x => x.id === p.id
          ? { ...x, backlink_live: data.backlink_live, last_checked_at: data.checked_at, check_error: data.check_error }
          : x
        ))
      }
    } finally {
      setChecking(prev => { const n = new Set(prev); n.delete(p.id); return n })
    }
  }

  function handleSaved(saved: Prospect) {
    setProspects(prev => {
      const idx = prev.findIndex(p => p.id === saved.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = saved
        return next
      }
      return [saved, ...prev]
    })
    fetchProspects() // refresh counts
  }

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Outreach</h1>
          <p className="text-gray-400 text-sm mt-1">Discover guestpost candidates, track outreach pipeline, and monitor published backlinks.</p>
        </div>
        <button
          onClick={() => { setEditModal('new'); setTab('tracker') }}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg flex items-center gap-2"
        >
          + Add Manually
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {([
          { key: 'discover', label: '🔍 Discovery' },
          { key: 'tracker',  label: `📋 Tracker${counts.all ? ` (${counts.all})` : ''}` },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              tab === t.key ? 'bg-red-700 text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === 'discover' && (
        <>
          {/* Hermod agent's recently discovered prospects — surfaces
              candidates from automated runs above the manual discovery tool. */}
          <HermodFindingsPanel
            limit={150}
            onPromote={data => {
              const d = data as { domain?: string; keyword?: string; ranking_url?: string | null }
              handleAddToTracker({
                domain:          d.domain ?? '',
                rankingUrl:      d.ranking_url ?? '',
                position:        0,
                organicTraffic:  0,
                organicKeywords: 0,
                authorityScore:  0,
                inTracker:       false,
                trackerStatus:   null,
              }, d.keyword ?? '', 'hermod_finding')
              setTab('tracker')
            }}
          />
          <DiscoveryPanel onAddToTracker={handleAddToTracker} />
        </>
      )}

      {tab === 'tracker' && (
        loading ? (
          <div className="text-center py-20 text-gray-500">Loading…</div>
        ) : (
          <TrackerTable
            prospects={prospects}
            counts={counts}
            onEdit={p => setEditModal(p)}
            onDelete={handleDelete}
            onCheck={handleCheck}
            checking={checking}
          />
        )
      )}

      {/* Edit Modal */}
      {editModal !== null && (
        <EditModal
          prospect={editModal === 'new' ? null : editModal}
          onClose={() => setEditModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
