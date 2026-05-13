'use client'

import { useState, useEffect, useCallback } from 'react'
import HermodFindingsPanel from '@/components/agents/HermodFindingsPanel'
import OutreachFunnel from '@/components/outreach/OutreachFunnel'
import LogReplyButton from '@/components/outreach/LogReplyButton'

// ── Opener Modal ──────────────────────────────────────────────────────────────
function OpenerModal({ prospect, onClose }: {
  prospect: Prospect
  onClose:  () => void
}) {
  const [tone,    setTone]    = useState<'professional' | 'casual' | 'direct'>('professional')
  const [mode,    setMode]    = useState<'opener' | 'full'>('opener')
  const [loading, setLoading] = useState(false)
  const [subject, setSubject] = useState('')
  const [opener,  setOpener]  = useState('')
  const [error,   setError]   = useState('')
  const [copied,  setCopied]  = useState<'subject' | 'opener' | 'both' | null>(null)

  async function generate() {
    setLoading(true)
    setError('')
    setSubject('')
    setOpener('')
    try {
      const res  = await fetch(`/api/outreach/prospects/${prospect.id}/generate-opener`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tone, mode }),
      })
      const data = await res.json() as { ok: boolean; subject?: string; opener?: string; body?: string; error?: string }
      if (!data.ok) throw new Error(data.error ?? 'Generation failed')
      setSubject(data.subject ?? '')
      // For full mode, response uses `body` instead of `opener` — store both in `opener` state for display
      setOpener((mode === 'full' ? data.body : data.opener) ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  function copy(field: 'subject' | 'opener' | 'both') {
    const text = field === 'subject' ? subject : field === 'opener' ? opener : `Subject: ${subject}\n\n${opener}`
    navigator.clipboard.writeText(text).then(() => {
      setCopied(field)
      setTimeout(() => setCopied(null), 1800)
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-white font-semibold">✍️ Draft Outreach Opener</h2>
            <p className="text-gray-500 text-xs mt-0.5">{prospect.domain}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Prospect summary */}
          <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-4 py-3 text-xs text-gray-400 space-y-1">
            {prospect.contact_name  && <p>👤 {prospect.contact_name}{prospect.contact_email ? ` · ${prospect.contact_email}` : ''}</p>}
            {prospect.topic         && <p>📝 Topic: {prospect.topic}</p>}
            {prospect.target_url    && <p>🔗 Target: {prospect.target_url}</p>}
            {prospect.anchor_text   && <p>⚓ Anchor: "{prospect.anchor_text}"</p>}
            {prospect.source_keyword && <p>🔑 Keyword: "{prospect.source_keyword}"</p>}
          </div>

          {/* Mode + tone selectors */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-2">Mode</label>
              <div className="flex gap-2">
                {(['opener', 'full'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                      mode === m ? 'bg-purple-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                    }`}
                  >
                    {m === 'opener' ? '✂️ Opener only' : '📧 Full email'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-2">Tone</label>
              <div className="flex gap-2">
                {(['professional', 'casual', 'direct'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setTone(t)}
                    className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                      tone === t ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                    }`}
                  >
                    {t === 'professional' ? '🤝' : t === 'casual' ? '😊' : '⚡'} {t}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Generate button */}
          <button
            onClick={generate}
            disabled={loading}
            className="w-full py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition flex items-center justify-center gap-2"
          >
            {loading
              ? <><span className="animate-spin">⟳</span> Bragi is writing…</>
              : mode === 'full' ? '✨ Generate Full Email' : '✨ Generate Opener'}
          </button>

          {error && <p className="text-sm text-red-400">{error}</p>}

          {/* Generated content */}
          {subject && (
            <div className="space-y-3">
              {/* Subject */}
              <div className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Subject line</label>
                  <button
                    onClick={() => copy('subject')}
                    className="text-[10px] text-gray-500 hover:text-gray-300 transition"
                  >
                    {copied === 'subject' ? '✓ Copied' : '⎘ Copy'}
                  </button>
                </div>
                <p className="text-white text-sm">{subject}</p>
              </div>

              {/* Opener / Full body */}
              <div className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                    {mode === 'full' ? 'Full email body' : 'Email opener'}
                  </label>
                  <button
                    onClick={() => copy('opener')}
                    className="text-[10px] text-gray-500 hover:text-gray-300 transition"
                  >
                    {copied === 'opener' ? '✓ Copied' : '⎘ Copy'}
                  </button>
                </div>
                <p className="text-gray-200 text-sm leading-relaxed whitespace-pre-wrap">{opener}</p>
              </div>

              {/* Copy both */}
              <button
                onClick={() => copy('both')}
                className="w-full py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs rounded-lg transition"
              >
                {copied === 'both' ? '✓ Copied!' : `⎘ Copy subject + ${mode === 'full' ? 'body' : 'opener'}`}
              </button>

              <p className="text-[10px] text-gray-600 text-center">
                Bragi generated this {mode === 'full' ? 'email' : 'opener'}. Review before sending — {mode === 'full' ? 'fill placeholders, double-check facts' : 'personalise the greeting and add your name'}.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Push to Backlinks Modal ───────────────────────────────────────────────────
function PushToBacklinksModal({ prospect, onClose, onPushed }: {
  prospect: Prospect
  onClose:  () => void
  onPushed: () => void
}) {
  const [cost,     setCost]     = useState('')
  const [currency, setCurrency] = useState('USD')
  const [liveDate, setLiveDate] = useState(prospect.published_date ?? '')
  const [pushing,  setPushing]  = useState(false)
  const [error,    setError]    = useState('')

  async function handlePush() {
    setPushing(true)
    setError('')
    try {
      const res  = await fetch(`/api/outreach/prospects/${prospect.id}/push-to-backlinks`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          cost_amount:   cost ? parseFloat(cost) : null,
          cost_currency: currency,
          live_date:     liveDate || null,
        }),
      })
      const data = await res.json() as { ok: boolean; existing?: boolean; error?: string }
      if (!data.ok) throw new Error(data.error ?? 'Push failed')
      onPushed()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Push failed')
    } finally {
      setPushing(false)
    }
  }

  const missing: string[] = []
  if (!prospect.target_url)  missing.push('target URL')
  if (!prospect.anchor_text) missing.push('anchor text')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-white font-semibold">→ Push to Backlinks Tracker</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">✕</button>
        </div>
        <div className="p-5 space-y-4">
          {/* Preview */}
          <div className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-4 py-3 text-xs text-gray-400 space-y-1">
            <p>🌐 Site: <span className="text-gray-200">{prospect.domain}</span></p>
            <p>🔗 External URL: <span className="text-gray-200">{prospect.published_url ?? `https://${prospect.domain}`}</span></p>
            <p>📄 Target page: <span className="text-gray-200">{prospect.target_url ?? '—'}</span></p>
            <p>⚓ Anchor: <span className="text-gray-200">{prospect.anchor_text ?? '—'}</span></p>
          </div>

          {missing.length > 0 && (
            <div className="bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2 text-xs text-amber-300">
              ⚠ Missing: {missing.join(', ')}. Edit the prospect to fill these in before pushing.
            </div>
          )}

          {missing.length === 0 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Cost (optional)</label>
                  <input
                    type="number"
                    value={cost}
                    onChange={e => setCost(e.target.value)}
                    placeholder="0"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Currency</label>
                  <select
                    value={currency}
                    onChange={e => setCurrency(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
                  >
                    <option>USD</option><option>IDR</option><option>SGD</option><option>GBP</option><option>EUR</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Live date</label>
                <input
                  type="date"
                  value={liveDate}
                  onChange={e => setLiveDate(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
                />
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              <button
                onClick={handlePush}
                disabled={pushing}
                className="w-full py-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
              >
                {pushing ? '⏳ Pushing…' : '🚀 Push to Backlinks Tracker'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

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
  // Hermod v2 score fields
  overallScore:    number
  nicheScore:      number
  qualityScore:    number
  outreachScore:   number
  audienceScore:   number
  trustScore:      number
  outreachAngle:   string
  hasWriteForUs:   boolean
  contactEmail:    string | null
  notes:           string
  cached:          boolean
  evaluatedAt:     string
  belowThreshold:  boolean
  // Legacy fields kept for backward compat
  organicTraffic:  number
  organicKeywords: number
  authorityScore:  number
  inTracker:       boolean
  trackerStatus:   string | null
}

// Map UI region → DataForSEO location_code + language_code
const REGION_MAP: Record<string, { locationCode: number; languageCode: string; flag: string; label: string }> = {
  us: { locationCode: 2840, languageCode: 'en', flag: '🇺🇸', label: 'US' },
  uk: { locationCode: 2826, languageCode: 'en', flag: '🇬🇧', label: 'UK' },
  au: { locationCode: 2036, languageCode: 'en', flag: '🇦🇺', label: 'AU' },
  sg: { locationCode: 2702, languageCode: 'en', flag: '🇸🇬', label: 'SG' },
  id: { locationCode: 2360, languageCode: 'id', flag: '🇮🇩', label: 'ID' },
}

type Threshold = 'strict' | 'balanced' | 'loose'

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
function DiscoveryPanel({ onAddToTracker }: { onAddToTracker: (c: Candidate, kw: string, briefMode: boolean) => void }) {
  const [keyword,        setKeyword]        = useState('')
  const [region,         setRegion]         = useState<keyof typeof REGION_MAP>('us')
  const [threshold,      setThreshold]      = useState<Threshold>('balanced')
  const [includeBelow,   setIncludeBelow]   = useState(false)
  const [briefMode,      setBriefMode]      = useState(false)
  const [candidates,     setCandidates]     = useState<Candidate[]>([])
  const [meta,           setMeta]           = useState<{ autoSkipped: number; belowThreshold: number; thresholdValue: number } | null>(null)
  const [loading,        setLoading]        = useState(false)
  const [error,          setError]          = useState('')
  const [searched,       setSearched]       = useState('')
  const [adding,         setAdding]         = useState<Set<string>>(new Set())

  async function handleSearch() {
    if (!keyword.trim()) return
    setLoading(true)
    setError('')
    setCandidates([])
    setMeta(null)
    try {
      const r = REGION_MAP[region]
      const params = new URLSearchParams({
        keyword,
        threshold,
        locationCode: String(r.locationCode),
        languageCode: r.languageCode,
        ...(includeBelow ? { includeBelow: '1' } : {}),
      })
      const res = await fetch(`/api/outreach/discover?${params.toString()}`)
      if (!res.ok) {
        const d = await res.json()
        setError(d.error ?? 'Failed to fetch')
        return
      }
      const data = await res.json()
      setCandidates(data.candidates ?? [])
      setMeta({
        autoSkipped:    data.autoSkipped    ?? 0,
        belowThreshold: data.belowThreshold ?? 0,
        thresholdValue: data.thresholdValue ?? 0,
      })
      setSearched(keyword)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleAdd(c: Candidate) {
    setAdding(prev => new Set(prev).add(c.domain))
    await onAddToTracker(c, searched, briefMode)
    setAdding(prev => { const n = new Set(prev); n.delete(c.domain); return n })
    // Refresh: mark as inTracker
    setCandidates(prev => prev.map(x => x.domain === c.domain ? { ...x, inTracker: true, trackerStatus: briefMode ? 'pending_approval' : 'prospecting' } : x))
  }

  return (
    <div>
      {/* Search bar */}
      <div className="flex gap-3 mb-3">
        <input
          type="text"
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="e.g. buy gaming currency, game marketplace, diablo 4 gold"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
        />
        <select
          value={region}
          onChange={e => setRegion(e.target.value as keyof typeof REGION_MAP)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
        >
          {Object.entries(REGION_MAP).map(([k, v]) => (
            <option key={k} value={k}>{v.flag} {v.label}</option>
          ))}
        </select>
        <select
          value={threshold}
          onChange={e => setThreshold(e.target.value as Threshold)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
          title="Score threshold for filtering candidates"
        >
          <option value="strict">⚙️ Strict (≥7.5)</option>
          <option value="balanced">⚙️ Balanced (≥6.5)</option>
          <option value="loose">⚙️ Loose (≥5.5)</option>
        </select>
        <button
          onClick={handleSearch}
          disabled={loading || !keyword.trim()}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg flex items-center gap-2"
        >
          {loading ? <span className="animate-spin">⟳</span> : '🔍'} {loading ? 'Evaluating…' : 'Discover'}
        </button>
      </div>

      {/* Toggles row */}
      <div className="flex items-center gap-4 mb-5 text-xs">
        <label className="inline-flex items-center gap-1.5 text-gray-400 cursor-pointer hover:text-gray-200">
          <input
            type="checkbox"
            checked={includeBelow}
            onChange={e => setIncludeBelow(e.target.checked)}
            className="accent-red-600"
          />
          Show below-threshold candidates
        </label>
        <label className="inline-flex items-center gap-1.5 text-gray-400 cursor-pointer hover:text-gray-200" title="Brief mode queues prospects as pending_approval — they wait until you click Send instead of auto-running through the pipeline.">
          <input
            type="checkbox"
            checked={briefMode}
            onChange={e => setBriefMode(e.target.checked)}
            className="accent-yellow-600"
          />
          📝 Brief mode (queue as pending_approval)
        </label>
        <p className="text-gray-600">
          Powered by DataForSEO SERP + FireCrawl + Haiku — replaces SEMrush. Cached 14d per domain.
        </p>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {meta && (
        <p className="text-xs text-gray-500 mb-3">
          Found <strong className="text-gray-300">{candidates.length}</strong> qualifying candidate{candidates.length !== 1 ? 's' : ''} for <strong className="text-yellow-400">&quot;{searched}&quot;</strong> at <strong className="text-gray-300">{threshold}</strong> threshold (≥{meta.thresholdValue}).
          {meta.autoSkipped    > 0 && <> Auto-skipped <strong className="text-gray-400">{meta.autoSkipped}</strong> social/marketplace domain{meta.autoSkipped !== 1 ? 's' : ''}.</>}
          {meta.belowThreshold > 0 && !includeBelow && <> {meta.belowThreshold} below-threshold hidden — toggle &quot;show below&quot; to see all.</>}
        </p>
      )}

      {candidates.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">#</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Domain</th>
                <th className="px-3 py-2.5 text-center text-xs font-semibold uppercase tracking-wider text-gray-500" title="Overall weighted score (0-10)">Score</th>
                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Outreach Angle</th>
                <th className="px-3 py-2.5 text-center text-xs font-semibold uppercase tracking-wider text-gray-500">Signals</th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-gray-500"></th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c, i) => {
                const scoreColor = c.overallScore >= 7.5 ? 'text-emerald-400' : c.overallScore >= 6.5 ? 'text-green-400' : c.overallScore >= 5.5 ? 'text-yellow-400' : 'text-gray-500'
                const scoreBg    = c.overallScore >= 7.5 ? 'bg-emerald-900/30 border-emerald-700/50' : c.overallScore >= 6.5 ? 'bg-green-900/30 border-green-800/50' : c.overallScore >= 5.5 ? 'bg-yellow-900/20 border-yellow-800/40' : 'bg-gray-800/50 border-gray-700/40'
                const breakdownTitle = `Niche ${c.nicheScore} · Quality ${c.qualityScore} · Outreach ${c.outreachScore} · Audience ${c.audienceScore} · Trust ${c.trustScore}`
                return (
                  <tr key={c.domain} className={`border-b border-gray-800/50 hover:bg-gray-800/30 ${c.belowThreshold ? 'opacity-60' : ''}`}>
                    <td className="px-3 py-2.5 text-gray-500 text-xs align-top">{i + 1}</td>
                    <td className="px-3 py-2.5 align-top">
                      <a href={`https://${c.domain}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline text-sm font-medium">
                        {c.domain}
                      </a>
                      <p className="text-gray-600 text-xs truncate max-w-xs">SERP #{c.position} · {c.rankingUrl}</p>
                      {c.cached && <span className="text-[10px] text-gray-600">cached {new Date(c.evaluatedAt).toLocaleDateString()}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center align-top">
                      <div className={`inline-flex flex-col items-center px-2 py-1 rounded-lg border ${scoreBg}`} title={breakdownTitle}>
                        <span className={`text-lg font-bold leading-none ${scoreColor}`}>{c.overallScore.toFixed(1)}</span>
                        <span className="text-[10px] text-gray-500 mt-0.5">/ 10</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-gray-300 text-xs max-w-md align-top">
                      <p className="line-clamp-3">{c.outreachAngle || '—'}</p>
                    </td>
                    <td className="px-3 py-2.5 text-center align-top">
                      <div className="flex flex-col items-center gap-1">
                        {c.hasWriteForUs && (
                          <span className="text-[10px] bg-purple-900/40 text-purple-300 px-1.5 py-0.5 rounded border border-purple-700/40" title="Site has a public Write for Us / Contribute / Submissions page">✍️ Write for us</span>
                        )}
                        {c.contactEmail && (
                          <a href={`mailto:${c.contactEmail}`} className="text-[10px] text-blue-300 hover:underline" title={c.contactEmail}>📧 contact</a>
                        )}
                        {!c.hasWriteForUs && !c.contactEmail && (
                          <span className="text-[10px] text-gray-600">no signals</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right align-top">
                      {c.inTracker ? (
                        <span className="text-xs text-green-500">✓ {c.trackerStatus === 'pending_approval' ? 'Queued' : 'Added'}</span>
                      ) : (
                        <button
                          onClick={() => handleAdd(c)}
                          disabled={adding.has(c.domain)}
                          className={`px-2.5 py-1 disabled:opacity-50 text-white text-xs rounded-lg ${briefMode ? 'bg-yellow-700 hover:bg-yellow-600' : 'bg-red-700 hover:bg-red-600'}`}
                          title={briefMode ? 'Queue as pending_approval — wait for Send' : 'Add to active tracker'}
                        >
                          {adding.has(c.domain) ? '…' : briefMode ? '+ Brief' : '+ Track'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && candidates.length === 0 && !meta && (
        <div className="text-center py-16 text-gray-600">
          <p className="text-4xl mb-3">🔍</p>
          <p className="text-sm">Enter a keyword to discover & evaluate guestpost candidates.</p>
          <p className="text-xs mt-1">Each domain is FireCrawl-scraped and Haiku-scored on niche/quality/outreach/audience/trust.</p>
        </div>
      )}

      {!loading && !error && meta && candidates.length === 0 && (
        <div className="text-center py-16 text-gray-600">
          <p className="text-4xl mb-3">📭</p>
          <p className="text-sm">No candidates passed the {threshold} threshold (≥{meta.thresholdValue}).</p>
          <p className="text-xs mt-1">Try a looser threshold, or toggle &quot;show below&quot; to see what was filtered.</p>
        </div>
      )}
    </div>
  )
}

// ── Tracker Table ─────────────────────────────────────────────────────────────
function TrackerTable({ prospects, counts, onEdit, onDelete, onCheck, checking, onOpenOpener, onPushBacklinks }: {
  prospects:       Prospect[]
  counts:          Record<string, number>
  onEdit:          (p: Prospect) => void
  onDelete:        (p: Prospect) => void
  onCheck:         (p: Prospect) => void
  checking:        Set<string>
  onOpenOpener:    (p: Prospect) => void
  onPushBacklinks: (p: Prospect) => void
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
                      {/* Bragi opener */}
                      <button
                        onClick={() => onOpenOpener(p)}
                        className="px-2 py-1 text-xs text-purple-400 hover:text-purple-300 hover:bg-purple-900/30 rounded transition"
                        title="Draft outreach opener with Bragi"
                      >
                        ✍️
                      </button>

                      {/* Push to backlinks (accepted / published only) */}
                      {(p.status === 'accepted' || p.status === 'published') && (
                        <button
                          onClick={() => onPushBacklinks(p)}
                          className="px-2 py-1 text-xs text-green-400 hover:text-green-300 hover:bg-green-900/30 rounded transition"
                          title="Push to Backlinks Tracker"
                        >
                          → BL
                        </button>
                      )}

                      {/* Check liveness (published + url) */}
                      {p.status === 'published' && p.published_url && (
                        <button
                          onClick={() => onCheck(p)}
                          disabled={checking.has(p.id)}
                          className="px-2 py-1 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-900/30 rounded transition disabled:opacity-50"
                          title="Check if backlink is still live"
                        >
                          {checking.has(p.id) ? '⟳' : '🔍'}
                        </button>
                      )}

                      <LogReplyButton prospectId={p.id} variant="compact" />

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
  const [tab,         setTab]        = useState<'discover' | 'tracker'>('discover')
  const [prospects,   setProspects]  = useState<Prospect[]>([])
  const [counts,      setCounts]     = useState<Record<string, number>>({})
  const [loading,     setLoading]    = useState(true)
  const [editModal,   setEditModal]  = useState<Prospect | 'new' | null>(null)
  const [checking,    setChecking]   = useState<Set<string>>(new Set())
  const [openerModal, setOpenerModal] = useState<Prospect | null>(null)
  const [pushModal,   setPushModal]  = useState<Prospect | null>(null)

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

  async function handleAddToTracker(c: Candidate, keyword: string, briefMode = false, discoveredVia: string = 'hermod_v2') {
    await fetch('/api/outreach/prospects', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain:             c.domain,
        // Hermod v2 carries score data — we pass overall_score in
        // authority_score for now so the existing column is reused. The
        // raw 5-dim score is also stored in the data field below.
        authority_score:    c.overallScore != null ? Math.round(c.overallScore * 10) : c.authorityScore,
        organic_traffic:    c.organicTraffic,
        organic_keywords:   c.organicKeywords,
        contact_email:      c.contactEmail ?? undefined,
        topic:              c.outreachAngle || undefined,
        source_keyword:     keyword,
        discovered_via:     discoveredVia,
        approval_required:  briefMode,
        score_breakdown:    {
          overall:  c.overallScore,
          niche:    c.nicheScore,
          quality:  c.qualityScore,
          outreach: c.outreachScore,
          audience: c.audienceScore,
          trust:    c.trustScore,
          has_write_for_us: c.hasWriteForUs,
          notes:    c.notes,
        },
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

      {/* Funnel — pulse view at top */}
      <div className="mb-6">
        <OutreachFunnel defaultDays={90} />
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
                overallScore:    0,
                nicheScore:      0,
                qualityScore:    0,
                outreachScore:   0,
                audienceScore:   0,
                trustScore:      0,
                outreachAngle:   '',
                hasWriteForUs:   false,
                contactEmail:    null,
                notes:           '',
                cached:          false,
                evaluatedAt:     '',
                belowThreshold:  false,
                organicTraffic:  0,
                organicKeywords: 0,
                authorityScore:  0,
                inTracker:       false,
                trackerStatus:   null,
              }, d.keyword ?? '', false, 'hermod_finding')
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
            onOpenOpener={p => setOpenerModal(p)}
            onPushBacklinks={p => setPushModal(p)}
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

      {/* Bragi Opener Modal */}
      {openerModal && (
        <OpenerModal
          prospect={openerModal}
          onClose={() => setOpenerModal(null)}
        />
      )}

      {/* Push to Backlinks Modal */}
      {pushModal && (
        <PushToBacklinksModal
          prospect={pushModal}
          onClose={() => setPushModal(null)}
          onPushed={fetchProspects}
        />
      )}
    </div>
  )
}
