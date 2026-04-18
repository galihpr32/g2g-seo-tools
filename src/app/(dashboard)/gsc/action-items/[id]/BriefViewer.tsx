'use client'

import { useState, useEffect, useCallback } from 'react'
import { SERP_COUNTRIES } from '@/lib/country-config'

// ── Types ──────────────────────────────────────────────────────────────────────

type ContentIdea = {
  content_type: 'blog_post' | 'forum' | 'social' | string
  title: string
  platform: string
  target_keyword: string
  notes: string
  draft?: string
  draft_status?: 'generating'
}

type Brief = {
  id: string
  status: string
  brief_type: 'on_page' | 'off_page'
  page: string
  primary_keyword?: string
  topic?: string
  current_content_summary?: string
  content_gaps?: string[]
  new_keywords?: { keyword: string; search_volume: number; cpc: number }[]
  longtail_keywords?: { keyword: string; intent: string }[]
  faq_suggestions?: { question: string; suggested_answer: string }[]
  content_draft?: string
  content_outline?: { text: string }[]
  content_ideas?: ContentIdea[]
  competitor_analysis?: { url: string; title: string; angle: string }[]
  off_page_draft?: string   // stores internal link strategy
  published_url?: string
  created_at: string
  updated_at: string
}

// ── Off-page content type config ──────────────────────────────────────────────

const CONTENT_TYPE_CONFIG: Record<string, { label: string; emoji: string; color: string }> = {
  blog_post: { label: 'Blog / Article',    emoji: '📝', color: 'text-blue-400' },
  forum:     { label: 'Forum / Community', emoji: '💬', color: 'text-green-400' },
  social:    { label: 'Social Media',      emoji: '📱', color: 'text-purple-400' },
  video:     { label: 'Video',             emoji: '🎬', color: 'text-red-400' },
  other:     { label: 'Other',             emoji: '📄', color: 'text-gray-400' },
}

// ── Pre-generation config (off-page only) ─────────────────────────────────────

type OffPageTypeConfig = { enabled: boolean; count: number; format?: 'short' | 'long' }
type OffPageConfig = { blog_post: OffPageTypeConfig; forum: OffPageTypeConfig; social: OffPageTypeConfig }

const DEFAULT_OFF_PAGE_CONFIG: OffPageConfig = {
  blog_post: { enabled: true,  count: 2 },
  forum:     { enabled: true,  count: 2, format: 'short' },
  social:    { enabled: false, count: 1 },
}

const OFF_PAGE_TYPE_LABELS: Record<keyof OffPageConfig, { emoji: string; label: string; desc: string }> = {
  blog_post: { emoji: '📝', label: 'Blog / Article',    desc: 'Long-form content for G2G blog, Medium, or gaming publications' },
  forum:     { emoji: '💬', label: 'Forum / Community', desc: 'Reddit posts, Discord threads, or gaming forum discussions' },
  social:    { emoji: '📱', label: 'Social Media',      desc: 'Twitter/X threads, TikTok scripts, Instagram carousels' },
}

function OffPageConfigPanel({
  config, onChange, customInstructions, onCustomInstructionsChange, serpCountry, onSerpCountryChange,
}: {
  config: OffPageConfig
  onChange: (c: OffPageConfig) => void
  customInstructions: string
  onCustomInstructionsChange: (v: string) => void
  serpCountry: string
  onSerpCountryChange: (v: string) => void
}) {
  function toggle(type: keyof OffPageConfig) {
    onChange({ ...config, [type]: { ...config[type], enabled: !config[type].enabled } })
  }
  function setCount(type: keyof OffPageConfig, count: number) {
    onChange({ ...config, [type]: { ...config[type], count } })
  }
  function setFormat(type: keyof OffPageConfig, format: 'short' | 'long') {
    onChange({ ...config, [type]: { ...config[type], format } })
  }
  const anyEnabled = Object.values(config).some(c => c.enabled)
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 mb-4">
      <p className="text-white font-semibold text-sm mb-1">Choose what to generate</p>
      <p className="text-gray-500 text-xs mb-4">Select content types and how many ideas per type</p>
      <div className="space-y-3">
        {(Object.keys(OFF_PAGE_TYPE_LABELS) as (keyof OffPageConfig)[]).map(type => {
          const meta = OFF_PAGE_TYPE_LABELS[type]
          const cfg  = config[type]
          return (
            <div key={type}>
              <div onClick={() => toggle(type)}
                className={`flex items-center gap-4 rounded-xl p-3.5 border cursor-pointer transition ${cfg.enabled ? 'border-red-600/50 bg-red-600/5' : 'border-gray-700 bg-gray-800/50 opacity-60'}`}
              >
                <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition ${cfg.enabled ? 'bg-red-600 border-red-600' : 'border-gray-600'}`}>
                  {cfg.enabled && <span className="text-white text-xs leading-none">✓</span>}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-medium">{meta.emoji} {meta.label}</p>
                  <p className="text-gray-500 text-xs truncate">{meta.desc}</p>
                </div>
                <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                  <button onClick={() => cfg.count > 1 && setCount(type, cfg.count - 1)} disabled={!cfg.enabled || cfg.count <= 1}
                    className="w-6 h-6 rounded border border-gray-600 text-gray-400 hover:text-white hover:border-gray-400 disabled:opacity-30 transition text-sm flex items-center justify-center">−</button>
                  <span className="text-white text-sm font-semibold w-4 text-center">{cfg.count}</span>
                  <button onClick={() => cfg.count < 5 && setCount(type, cfg.count + 1)} disabled={!cfg.enabled || cfg.count >= 5}
                    className="w-6 h-6 rounded border border-gray-600 text-gray-400 hover:text-white hover:border-gray-400 disabled:opacity-30 transition text-sm flex items-center justify-center">+</button>
                  <span className="text-gray-500 text-xs ml-1">ideas</span>
                </div>
              </div>
              {/* Forum format toggle — only when forum row is enabled */}
              {type === 'forum' && cfg.enabled && (
                <div className="ml-8 mt-1.5 flex items-center gap-2" onClick={e => e.stopPropagation()}>
                  <span className="text-gray-500 text-xs">Draft style:</span>
                  <button
                    onClick={() => setFormat('forum', 'short')}
                    className={`text-xs px-2.5 py-1 rounded-lg border transition ${cfg.format !== 'long' ? 'border-green-600 bg-green-600/10 text-green-300' : 'border-gray-700 text-gray-500 hover:text-gray-300'}`}
                  >
                    Short (50-150w)
                  </button>
                  <button
                    onClick={() => setFormat('forum', 'long')}
                    className={`text-xs px-2.5 py-1 rounded-lg border transition ${cfg.format === 'long' ? 'border-blue-600 bg-blue-600/10 text-blue-300' : 'border-gray-700 text-gray-500 hover:text-gray-300'}`}
                  >
                    Long (300-500w)
                  </button>
                  <span className="text-gray-600 text-xs">
                    {cfg.format === 'long' ? '— full Reddit thread with context' : '— native comment-style, no hard sell'}
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {!anyEnabled && <p className="text-yellow-400 text-xs mt-3">Select at least one content type.</p>}

      {/* SERP country + custom instructions */}
      <div className="mt-4 border-t border-gray-800 pt-4 space-y-3">
        <CountrySelector value={serpCountry} onChange={onSerpCountryChange} />
      </div>

      {/* Custom instructions */}
      <div className="mt-3">
        <label className="block text-gray-400 text-xs font-medium mb-1.5">
          Custom instructions <span className="text-gray-600 font-normal">(optional — Claude will follow these for this brief)</span>
        </label>
        <textarea
          value={customInstructions}
          onChange={e => onCustomInstructionsChange(e.target.value)}
          placeholder="e.g. Focus on Valorant points economy, avoid mentioning specific prices, write for beginners…"
          rows={3}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 resize-none"
        />
      </div>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition">
      {copied ? '✓ Copied!' : label}
    </button>
  )
}

// ── SERP Country Selector ─────────────────────────────────────────────────────
function CountrySelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-gray-500 text-xs">SERP country:</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-red-500 cursor-pointer"
      >
        <option value="">🌐 Auto-detect</option>
        {SERP_COUNTRIES.map(c => (
          <option key={c.code} value={c.code}>{c.flag} {c.label}</option>
        ))}
      </select>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-4">
      <h3 className="text-white font-semibold text-sm mb-3">{title}</h3>
      {children}
    </div>
  )
}

// ── On-page Draft Editor ───────────────────────────────────────────────────────
function DraftEditor({ brief, onSaved }: { brief: Brief; onSaved: (d: string) => void }) {
  const currentDraft = brief.content_draft ?? ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(currentDraft)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  useEffect(() => { setDraft(currentDraft) }, [currentDraft])

  async function save() {
    setSaving(true); setSaveMsg(null)
    try {
      const res = await fetch('/api/brief/update', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: brief.id, content_draft: draft }) })
      if (!res.ok) throw new Error()
      onSaved(draft); setEditing(false); setSaveMsg('✓ Saved'); setTimeout(() => setSaveMsg(null), 2500)
    } catch { setSaveMsg('✗ Failed') } finally { setSaving(false) }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <p className="text-white font-semibold text-sm">Content Draft</p>
          {saveMsg && <span className={`text-xs font-medium ${saveMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>{saveMsg}</span>}
        </div>
        <div className="flex items-center gap-2">
          {draft && !editing && <CopyButton text={draft} />}
          {!editing
            ? <button onClick={() => setEditing(true)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition">✏️ Edit</button>
            : <>
                <button onClick={() => { setEditing(false); setDraft(currentDraft) }} className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white transition">Cancel</button>
                <button onClick={save} disabled={saving} className="text-xs px-3 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 text-white font-semibold transition disabled:opacity-50">{saving ? 'Saving…' : '✓ Save'}</button>
              </>}
        </div>
      </div>
      {draft ? (
        editing
          ? <textarea value={draft} onChange={e => setDraft(e.target.value)} className="w-full h-[600px] bg-gray-800 border border-gray-600 rounded-xl px-4 py-3 text-gray-200 text-sm font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-red-600" spellCheck={false} />
          : <pre className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap font-sans max-h-[600px] overflow-y-auto">{draft}</pre>
      ) : <p className="text-gray-500 text-sm">Draft not available yet.</p>}
      {draft && <p className="text-gray-600 text-xs mt-3 text-right">{draft.split(/\s+/).filter(Boolean).length} words</p>}
    </div>
  )
}

// ── Per-idea Draft Editor (off-page) ──────────────────────────────────────────
function IdeaDraftEditor({ brief, idea, onSaved }: {
  brief: Brief
  idea: ContentIdea
  onSaved: (updatedIdeas: ContentIdea[]) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(idea.draft ?? '')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  useEffect(() => { setDraft(idea.draft ?? '') }, [idea.draft])

  async function save() {
    setSaving(true); setSaveMsg(null)
    try {
      const updatedIdeas = (brief.content_ideas ?? []).map(i =>
        i === idea ? { ...i, draft } : i
      )
      const res = await fetch('/api/brief/update', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: brief.id, content_ideas: updatedIdeas }) })
      if (!res.ok) throw new Error()
      onSaved(updatedIdeas); setEditing(false); setSaveMsg('✓ Saved'); setTimeout(() => setSaveMsg(null), 2500)
    } catch { setSaveMsg('✗ Failed') } finally { setSaving(false) }
  }

  return (
    <div className="mt-3 bg-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <p className="text-gray-300 text-xs font-semibold">Draft</p>
          {saveMsg && <span className={`text-xs ${saveMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>{saveMsg}</span>}
        </div>
        <div className="flex items-center gap-2">
          {draft && !editing && <CopyButton text={draft} />}
          {!editing
            ? <button onClick={() => setEditing(true)} className="text-xs px-2 py-1 rounded border border-gray-600 text-gray-400 hover:text-white transition">✏️ Edit</button>
            : <>
                <button onClick={() => { setEditing(false); setDraft(idea.draft ?? '') }} className="text-xs px-2 py-1 rounded border border-gray-600 text-gray-400 transition">Cancel</button>
                <button onClick={save} disabled={saving} className="text-xs px-2 py-1 rounded bg-green-700 hover:bg-green-600 text-white font-semibold transition disabled:opacity-50">{saving ? '…' : '✓ Save'}</button>
              </>}
        </div>
      </div>
      {editing
        ? <textarea value={draft} onChange={e => setDraft(e.target.value)}
            className="w-full h-80 bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-gray-200 text-sm font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-red-600" spellCheck={false} />
        : <pre className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap font-sans max-h-80 overflow-y-auto">{draft}</pre>}
      {draft && <p className="text-gray-600 text-xs mt-2 text-right">{draft.split(/\s+/).filter(Boolean).length} words</p>}
    </div>
  )
}

// ── Add More Ideas Panel (off-page) ───────────────────────────────────────────
function AddMoreIdeasPanel({ brief, onAdded }: { brief: Brief; onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<'blog_post' | 'forum' | 'social'>('blog_post')
  const [count, setCount] = useState(2)
  const [adding, setAdding] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function handleAdd() {
    setAdding(true); setMsg(null)
    try {
      const res = await fetch('/api/brief/add-ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief_id: brief.id, content_type: type, count }) })
      if (!res.ok) throw new Error()
      setMsg('✓ Generating — refresh in ~20 sec')
      onAdded()
      setOpen(false)
    } catch { setMsg('✗ Failed') } finally { setAdding(false) }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-4 mt-4">
      {!open ? (
        <button onClick={() => setOpen(true)} className="w-full text-sm text-gray-400 hover:text-white transition flex items-center justify-center gap-2">
          <span className="text-lg">+</span> Add more ideas
        </button>
      ) : (
        <>
          <p className="text-white text-sm font-semibold mb-3">Add more ideas</p>
          <div className="flex items-center gap-3 flex-wrap">
            <select value={type} onChange={e => setType(e.target.value as any)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-red-600">
              <option value="blog_post">📝 Blog / Article</option>
              <option value="forum">💬 Forum / Community</option>
              <option value="social">📱 Social Media</option>
            </select>
            <div className="flex items-center gap-2">
              <button onClick={() => count > 1 && setCount(c => c - 1)} className="w-7 h-7 rounded border border-gray-600 text-gray-400 hover:text-white flex items-center justify-center">−</button>
              <span className="text-white text-sm font-semibold w-4 text-center">{count}</span>
              <button onClick={() => count < 5 && setCount(c => c + 1)} className="w-7 h-7 rounded border border-gray-600 text-gray-400 hover:text-white flex items-center justify-center">+</button>
              <span className="text-gray-500 text-xs">ideas</span>
            </div>
            <button onClick={handleAdd} disabled={adding}
              className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition">
              {adding ? 'Generating…' : 'Generate'}
            </button>
            <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-300 text-xs transition">Cancel</button>
          </div>
          {msg && <p className={`text-xs mt-2 ${msg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>{msg}</p>}
        </>
      )}
    </div>
  )
}

// ── crew-vue Publish Panel (on-page only) ─────────────────────────────────────
function CrewVuePanel({ brief }: { brief: Brief }) {
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  async function handlePublish() {
    setPublishing(true); setResult(null)
    try {
      const res = await fetch('/api/brief/publish-cms', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief_id: brief.id }) })
      const data = await res.json()
      setResult({ ok: res.ok, message: data.message ?? (res.ok ? 'Published!' : data.error) })
    } catch (err) { setResult({ ok: false, message: String(err) }) } finally { setPublishing(false) }
  }

  const cmsConfigured = false

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mt-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-white font-semibold text-sm">🚀 Publish to crew-vue CMS</h3>
          <p className="text-gray-500 text-xs mt-0.5">Upload draft content directly to the product page</p>
        </div>
        {cmsConfigured
          ? <button onClick={handlePublish} disabled={publishing} className="text-sm font-semibold px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-white transition disabled:opacity-50">{publishing ? 'Publishing…' : 'Publish →'}</button>
          : <span className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-3 py-1.5 rounded-full">⚙️ Needs API setup</span>}
      </div>
      {!cmsConfigured && (
        <div className="bg-gray-800 rounded-lg px-4 py-3 text-xs text-gray-400 space-y-1">
          <p className="font-medium text-gray-300">To enable, dev needs to provide:</p>
          <p>• crew-vue REST API base URL</p>
          <p>• Authentication method (API key, OAuth, session cookie)</p>
          <p>• Product update endpoint + payload schema</p>
          <p>• Product identifier (slug, ID, or URL path)</p>
        </div>
      )}
      {result && <p className={`mt-3 text-sm font-medium ${result.ok ? 'text-green-400' : 'text-red-400'}`}>{result.ok ? '✓' : '✗'} {result.message}</p>}
    </div>
  )
}

// ── Main BriefViewer ──────────────────────────────────────────────────────────
export function BriefViewer({ actionItemId, existingBriefId, actionType }: {
  actionItemId: string
  existingBriefId: string | null
  actionType: 'on_page' | 'off_page'
}) {
  const [brief, setBrief] = useState<Brief | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [publishedUrl, setPublishedUrl] = useState('')
  const [savingUrl, setSavingUrl] = useState(false)
  const [markingReviewed, setMarkingReviewed] = useState(false)
  const [markingPublished, setMarkingPublished] = useState(false)
  const [offPageConfig, setOffPageConfig] = useState<OffPageConfig>(DEFAULT_OFF_PAGE_CONFIG)
  const [activeTab, setActiveTab] = useState<string>('analysis')
  // Track which ideas are generating their draft: key = `${content_type}::${title}`
  const [draftGenerating, setDraftGenerating] = useState<Set<string>>(new Set())
  // DMCA hit tracking
  const [dmcaHits, setDmcaHits] = useState<Array<{ id: string; dmca_terms: { original_term: string; replacement_term: string } }>>([])
  const [resolvingDmca, setResolvingDmca] = useState(false)

  // Keyword selection (on-page pre-generate step)
  type KwCandidate = { keyword: string; search_volume?: number | null; cpc?: number | null; source: 'gsc' | 'dataforseo'; selected: boolean }
  const [kwStep, setKwStep]           = useState<'hidden' | 'loading' | 'selecting'>('hidden')
  const [kwCandidates, setKwCandidates] = useState<KwCandidate[]>([])
  const [manualKw, setManualKw]       = useState('')
  const [customInstructions, setCustomInstructions] = useState('')
  const [serpCountry, setSerpCountry] = useState('')  // '' = auto-detect from page URL

  // Returns true if we should keep polling (initial gen OR any idea is generating)
  function shouldPoll(b: Brief): boolean {
    if (b.status === 'generating') return true
    return (b.content_ideas ?? []).some(i => i.draft_status === 'generating')
  }

  const pollBrief = useCallback(async (id: string) => {
    const res = await fetch(`/api/brief/generate?id=${id}`)
    if (!res.ok) return
    const data: Brief = await res.json()
    setBrief(data)
    setPublishedUrl(data.published_url ?? '')
    // Clear draftGenerating flags for ideas that now have drafts
    setDraftGenerating(prev => {
      const next = new Set(prev)
      for (const idea of data.content_ideas ?? []) {
        const key = `${idea.content_type}::${idea.title}`
        if (idea.draft && prev.has(key)) next.delete(key)
        if (idea.draft_status !== 'generating') next.delete(key)
      }
      return next
    })
    if (shouldPoll(data)) {
      setTimeout(() => pollBrief(id), 3000)
    } else {
      setGenerating(false)
    }
  }, [])

  useEffect(() => {
    if (existingBriefId) pollBrief(existingBriefId)
  }, [existingBriefId, pollBrief])

  // Fetch DMCA hits when brief is published
  useEffect(() => {
    if (brief?.id && brief.status === 'published') {
      fetch(`/api/dmca/brief/${brief.id}`)
        .then(r => r.json())
        .then(d => setDmcaHits(d.hits ?? []))
        .catch(() => {})
    } else {
      setDmcaHits([])
    }
  }, [brief?.id, brief?.status])

  async function resolveAllDmcaHits() {
    if (!brief) return
    setResolvingDmca(true)
    await fetch(`/api/dmca/brief/${brief.id}`, { method: 'DELETE' })
    setDmcaHits([])
    setResolvingDmca(false)
  }

  async function loadKeywordsForSelection() {
    setKwStep('loading')
    try {
      const res = await fetch(`/api/brief/keywords?action_item_id=${actionItemId}`)
      const json = await res.json()
      const gscKws: KwCandidate[] = (json.gsc_queries ?? []).map((q: { keyword: string; clicks: number; position: number }) => ({
        keyword: q.keyword, search_volume: null, cpc: null, source: 'gsc' as const, selected: true,
      }))
      const dfKws: KwCandidate[] = (json.suggestions ?? []).map((s: { keyword: string; search_volume: number | null; cpc: number | null }) => ({
        keyword: s.keyword, search_volume: s.search_volume, cpc: s.cpc, source: 'dataforseo' as const,
        selected: false,
      }))
      // De-dupe: remove DataForSEO entries already in GSC list
      const gscSet = new Set(gscKws.map(k => k.keyword.toLowerCase()))
      const unique = dfKws.filter(k => !gscSet.has(k.keyword.toLowerCase()))
      setKwCandidates([...gscKws, ...unique])
      setKwStep('selecting')
    } catch {
      setKwStep('hidden')
    }
  }

  async function handleGenerate(skipKwSelect = false) {
    const selectedKws = skipKwSelect
      ? undefined
      : kwCandidates.filter(k => k.selected).map(k => k.keyword).filter(Boolean)

    setGenerating(true); setError(null); setActiveTab('analysis'); setKwStep('hidden')
    try {
      const res = await fetch('/api/brief/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_item_id: actionItemId,
          ...(actionType === 'off_page' && { content_type_config: offPageConfig }),
          ...(selectedKws && selectedKws.length > 0 && { selected_keywords: selectedKws }),
          ...(customInstructions.trim() && { custom_instructions: customInstructions.trim() }),
          ...(serpCountry && { serp_country: serpCountry }),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      pollBrief(data.brief_id)
    } catch (err) { setError(String(err)); setGenerating(false) }
  }

  async function generateIdeaDraft(idea: ContentIdea, ideaIndex: number) {
    if (!brief) return
    const key = `${idea.content_type}::${idea.title}`
    setDraftGenerating(prev => new Set(prev).add(key))
    try {
      await fetch('/api/brief/generate-draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief_id: brief.id, content_type: idea.content_type, idea_index: ideaIndex }),
      })
      // Start polling to pick up the draft when ready
      pollBrief(brief.id)
    } catch {
      setDraftGenerating(prev => { const n = new Set(prev); n.delete(key); return n })
    }
  }

  async function markReviewed() {
    if (!brief) return
    setMarkingReviewed(true)
    await fetch('/api/brief/update', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: brief.id, status: 'reviewed' }) })
    setBrief(b => b ? { ...b, status: 'reviewed' } : b)
    setMarkingReviewed(false)
  }

  async function markPublished() {
    if (!brief) return
    setMarkingPublished(true)
    await fetch('/api/brief/update', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: brief.id, status: 'published' }) })
    setBrief(b => b ? { ...b, status: 'published' } : b)
    setMarkingPublished(false)
  }

  async function revertStatus(to: 'draft' | 'reviewed') {
    if (!brief) return
    await fetch('/api/brief/update', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: brief.id, status: to }) })
    setBrief(b => b ? { ...b, status: to } : b)
  }

  async function savePublishedUrl() {
    if (!brief) return
    setSavingUrl(true)
    await fetch('/api/brief/update', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: brief.id, published_url: publishedUrl }) })
    setBrief(b => b ? { ...b, published_url: publishedUrl } : b)
    setSavingUrl(false)
  }

  // ── Not yet generated ──────────────────────────────────────────────────────
  if (!brief && !generating) {
    const anyEnabled = Object.values(offPageConfig).some(c => c.enabled)
    return (
      <div className={actionType === 'off_page' ? '' : `bg-gray-900 border border-gray-800 rounded-xl p-10 ${kwStep !== 'selecting' ? 'text-center' : ''}`}>
        {actionType === 'on_page' && kwStep === 'hidden' && (
          <>
            <p className="text-3xl mb-3">✏️</p>
            <h2 className="text-white font-bold text-lg mb-2">On-Page Optimization Brief</h2>
            <p className="text-gray-400 text-sm mb-1">Claude will refresh the page content based on GSC data, SERP analysis, and your chosen keywords.</p>
            <p className="text-gray-600 text-xs mb-6">Takes ~30–60 seconds</p>
            {error && <p className="text-red-400 text-sm mb-4 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2">{error}</p>}
            <div className="flex items-center gap-3 justify-center">
              <button
                onClick={loadKeywordsForSelection}
                className="bg-red-700 hover:bg-red-600 text-white font-semibold px-6 py-3 rounded-xl transition"
              >
                Select Keywords →
              </button>
              <button
                onClick={() => handleGenerate(true)}
                className="text-sm text-gray-500 hover:text-gray-300 underline transition"
              >
                Skip & generate now
              </button>
            </div>
          </>
        )}

        {actionType === 'on_page' && kwStep === 'loading' && (
          <div className="text-center py-8">
            <div className="animate-spin text-2xl mb-3">⟳</div>
            <p className="text-gray-400 text-sm">Fetching keyword suggestions…</p>
          </div>
        )}

        {actionType === 'on_page' && kwStep === 'selecting' && (
          <div className="text-left">
            <h2 className="text-white font-bold text-lg mb-1">Select Focus Keywords</h2>
            <p className="text-gray-400 text-sm mb-4">
              Checked keywords will be prioritised in the content draft. GSC keywords are pre-selected (they already drive traffic).
            </p>

            {/* Keyword list */}
            <div className="space-y-1 max-h-80 overflow-y-auto mb-4 pr-1">
              {kwCandidates.map((kw, i) => (
                <label
                  key={i}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition ${
                    kw.selected ? 'bg-red-700/10 border border-red-700/30' : 'bg-gray-800 border border-gray-700'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={kw.selected}
                    onChange={() => setKwCandidates(prev => prev.map((k, j) => j === i ? { ...k, selected: !k.selected } : k))}
                    className="accent-red-600 w-4 h-4 flex-shrink-0"
                  />
                  <span className="flex-1 text-sm text-white font-medium">{kw.keyword}</span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {kw.source === 'gsc' && (
                      <span className="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded">GSC</span>
                    )}
                    {kw.search_volume != null && (
                      <span className="text-xs text-gray-500">{kw.search_volume.toLocaleString()} vol</span>
                    )}
                    {kw.cpc != null && (
                      <span className="text-xs text-gray-600">${kw.cpc.toFixed(2)}</span>
                    )}
                  </div>
                </label>
              ))}
            </div>

            {/* Manual keyword input */}
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={manualKw}
                onChange={e => setManualKw(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && manualKw.trim()) {
                    setKwCandidates(prev => [...prev, { keyword: manualKw.trim(), source: 'dataforseo', selected: true }])
                    setManualKw('')
                  }
                }}
                placeholder="Add a keyword manually…"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
              />
              <button
                onClick={() => {
                  if (manualKw.trim()) {
                    setKwCandidates(prev => [...prev, { keyword: manualKw.trim(), source: 'dataforseo', selected: true }])
                    setManualKw('')
                  }
                }}
                className="px-3 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition"
              >
                + Add
              </button>
            </div>

            {/* Custom instructions */}
            <div className="mb-5">
              <label className="block text-gray-400 text-xs font-medium mb-1.5">
                Custom instructions <span className="text-gray-600 font-normal">(optional)</span>
              </label>
              <textarea
                value={customInstructions}
                onChange={e => setCustomInstructions(e.target.value)}
                placeholder="e.g. Prioritise mobile-first angle, include seasonal promotions, avoid mentioning competitor prices…"
                rows={3}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 resize-none"
              />
            </div>

            <div className="mb-4">
              <CountrySelector value={serpCountry} onChange={setSerpCountry} />
            </div>

            {error && <p className="text-red-400 text-sm mb-3 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2">{error}</p>}

            <div className="flex items-center gap-3">
              <button
                onClick={() => handleGenerate(false)}
                className="bg-red-700 hover:bg-red-600 text-white font-semibold px-6 py-3 rounded-xl transition"
              >
                Generate Brief with {kwCandidates.filter(k => k.selected).length} keyword{kwCandidates.filter(k => k.selected).length !== 1 ? 's' : ''} →
              </button>
              <button onClick={() => setKwStep('hidden')} className="text-sm text-gray-500 hover:text-gray-300 transition">
                ← Back
              </button>
            </div>
          </div>
        )}
        {actionType === 'off_page' && (
          <>
            <div className="mb-4">
              <h2 className="text-white font-bold text-lg mb-1">📣 Off-Page Content Brief</h2>
              <p className="text-gray-400 text-sm">Claude will analyze the SERP landscape and generate ideas for each content type. Drafts are written on-demand per idea.</p>
            </div>
            <OffPageConfigPanel
              config={offPageConfig}
              onChange={setOffPageConfig}
              customInstructions={customInstructions}
              onCustomInstructionsChange={setCustomInstructions}
              serpCountry={serpCountry}
              onSerpCountryChange={setSerpCountry}
            />
            {error && <p className="text-red-400 text-sm mb-4 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2">{error}</p>}
            <div className="flex items-center gap-3">
              <button onClick={() => handleGenerate(true)} disabled={!anyEnabled}
                className="bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-xl transition">
                Generate Brief →
              </button>
              <p className="text-gray-500 text-xs">
                {Object.entries(offPageConfig).filter(([, c]) => c.enabled).map(([k, c]) => `${c.count} ${OFF_PAGE_TYPE_LABELS[k as keyof OffPageConfig].label}`).join(', ')} ideas · ~30-60 sec
              </p>
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Generating ─────────────────────────────────────────────────────────────
  if (generating && brief?.status === 'generating') {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 text-center">
        <div className="animate-spin text-3xl mb-4">⚙️</div>
        <p className="text-white font-semibold mb-2">Generating brief…</p>
        <div className="text-gray-500 text-sm space-y-1">
          <p>🔍 {actionType === 'on_page' ? 'Crawling page' : 'Analyzing SERP landscape'}</p>
          <p>📊 Pulling keyword data from DataForSEO</p>
          <p>🤖 Claude is writing the analysis</p>
        </div>
      </div>
    )
  }

  if (!brief) return null

  // ── Build tab list ─────────────────────────────────────────────────────────
  const ideasByType: Record<string, ContentIdea[]> = {}
  for (const idea of (brief.content_ideas ?? [])) {
    const ct = idea.content_type ?? 'other'
    if (!ideasByType[ct]) ideasByType[ct] = []
    ideasByType[ct].push(idea)
  }

  const tabs =
    brief.brief_type === 'on_page'
      ? [{ key: 'analysis', label: '📋 Analysis' }, { key: 'draft', label: '📝 Draft Content' }]
      : [
          { key: 'analysis', label: '📊 Analysis' },
          ...Array.from(new Set((brief.content_ideas ?? []).map(i => i.content_type))).map(ct => {
            const cfg = CONTENT_TYPE_CONFIG[ct] ?? CONTENT_TYPE_CONFIG.other
            return { key: ct, label: `${cfg.emoji} ${cfg.label}` }
          }),
          { key: 'links', label: '🔗 Internal Links' },
        ]

  const hasDraftContent = brief.brief_type === 'on_page'
    ? !!brief.content_draft
    : (brief.content_ideas ?? []).some(i => i.draft)

  // ── Brief ready ─────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
            brief.status === 'draft' ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
            : brief.status === 'reviewed' ? 'text-blue-400 bg-blue-500/10 border-blue-500/20'
            : brief.status === 'published' ? 'text-green-400 bg-green-500/10 border-green-500/20'
            : 'text-gray-400 bg-gray-500/10 border-gray-500/20'}`}>
            {brief.status}
          </span>
          <span className="text-gray-500 text-xs">Generated {new Date(brief.created_at).toLocaleString('id-ID')}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Workflow: draft → reviewed → published */}
          {brief.status === 'draft' && hasDraftContent && (
            <button onClick={markReviewed} disabled={markingReviewed}
              className="text-xs px-3 py-1.5 rounded-lg border border-blue-600 bg-blue-600/10 text-blue-400 hover:bg-blue-700 hover:text-white transition disabled:opacity-50">
              {markingReviewed ? '…' : '★ Mark Reviewed'}
            </button>
          )}
          {brief.status === 'reviewed' && (
            <>
              <button onClick={markPublished} disabled={markingPublished}
                className="text-xs px-3 py-1.5 rounded-lg border border-green-600 bg-green-600/10 text-green-400 hover:bg-green-700 hover:text-white transition disabled:opacity-50">
                {markingPublished ? '…' : '↗ Mark Published'}
              </button>
              <button onClick={() => revertStatus('draft')}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500 transition"
                title="Revert to draft">
                ← Back to Draft
              </button>
            </>
          )}
          {brief.status === 'published' && (
            <button onClick={() => revertStatus('reviewed')}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500 transition"
              title="Revert to reviewed">
              ← Back to Reviewed
            </button>
          )}
          <button
            onClick={() => { setBrief(null); setKwStep('hidden') }}
            disabled={generating}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition disabled:opacity-50">
            ↺ Regenerate
          </button>
        </div>
      </div>

      {/* DMCA Warning Banner (published briefs with flagged terms) */}
      {brief.status === 'published' && dmcaHits.length > 0 && (
        <div className="mb-4 bg-red-900/30 border border-red-700/50 rounded-xl px-4 py-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-red-300 font-semibold text-sm">
              🚫 {dmcaHits.length} DMCA term{dmcaHits.length !== 1 ? 's' : ''} detected in this published brief
            </p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {dmcaHits.map(hit => (
                <span key={hit.id} className="text-xs bg-red-900/50 border border-red-700 text-red-300 rounded px-2 py-0.5 font-mono">
                  {hit.dmca_terms.original_term} → {hit.dmca_terms.replacement_term}
                </span>
              ))}
            </div>
            <p className="text-red-400/70 text-xs mt-2">
              Edit the draft to replace these terms, then mark as resolved.
            </p>
          </div>
          <button
            onClick={resolveAllDmcaHits}
            disabled={resolvingDmca}
            className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg border border-red-600 text-red-300 hover:bg-red-700 hover:text-white transition disabled:opacity-50"
          >
            {resolvingDmca ? 'Resolving…' : '✓ Mark Resolved'}
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-0 mb-5 border-b border-gray-800 overflow-x-auto">
        {tabs.map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition -mb-px whitespace-nowrap ${activeTab === tab.key ? 'border-red-500 text-white' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── ON-PAGE: ANALYSIS ──────────────────────────────────────────────── */}
      {brief.brief_type === 'on_page' && activeTab === 'analysis' && (
        <>
          {brief.current_content_summary && (
            <Section title="📄 Current Content Summary">
              <p className="text-gray-300 text-sm leading-relaxed">{brief.current_content_summary}</p>
            </Section>
          )}
          {!!brief.content_gaps?.length && (
            <Section title="⚠️ Content Gaps vs Competitors">
              <ul className="space-y-1.5">
                {brief.content_gaps.map((gap, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                    <span className="text-red-400 mt-0.5 flex-shrink-0">✗</span> {gap}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {!!brief.new_keywords?.length && (
            <Section title="🎯 Keyword Opportunities">
              <div className="grid grid-cols-2 gap-2">
                {(brief.new_keywords as any[]).slice(0, 12).map((kw, i) => (
                  <div key={i} className="bg-gray-800 rounded-lg px-3 py-2 text-xs">
                    <p className="text-white font-medium">{kw.keyword}</p>
                    <p className="text-gray-500 mt-0.5">vol: {kw.search_volume?.toLocaleString() ?? '—'}{kw.cpc ? ` · $${kw.cpc?.toFixed(2)} CPC` : ''}</p>
                  </div>
                ))}
              </div>
            </Section>
          )}
          {!!brief.content_outline?.length && (
            <Section title="📐 Content Outline">
              <div className="space-y-1">
                {(brief.content_outline as any[]).map((item, i) => <p key={i} className="text-gray-300 text-sm">{item.text}</p>)}
              </div>
            </Section>
          )}
          {!!brief.faq_suggestions?.length && (
            <Section title="❓ FAQ Suggestions">
              <div className="space-y-3">
                {(brief.faq_suggestions as any[]).map((faq, i) => (
                  <div key={i} className="border-l-2 border-gray-700 pl-3">
                    <p className="text-white text-sm font-medium">{faq.question}</p>
                    {faq.suggested_answer && <p className="text-gray-400 text-xs mt-1">{faq.suggested_answer}</p>}
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      {/* ── ON-PAGE: DRAFT ─────────────────────────────────────────────────── */}
      {brief.brief_type === 'on_page' && activeTab === 'draft' && (
        <>
          <DraftEditor brief={brief} onSaved={d => setBrief(b => b ? { ...b, content_draft: d } : b)} />
          <CrewVuePanel brief={brief} />
        </>
      )}

      {/* ── OFF-PAGE: ANALYSIS ─────────────────────────────────────────────── */}
      {brief.brief_type === 'off_page' && activeTab === 'analysis' && (
        <>
          {!!brief.competitor_analysis?.length && (
            <Section title="🏆 Competitor Landscape">
              <div className="space-y-3">
                {(brief.competitor_analysis as any[]).map((c, i) => (
                  <div key={i} className="border-l-2 border-gray-700 pl-3">
                    <p className="text-xs text-gray-500">#{i + 1}</p>
                    <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-sm font-medium">{c.title}</a>
                    {c.angle && <p className="text-gray-400 text-xs mt-0.5">{c.angle}</p>}
                  </div>
                ))}
              </div>
            </Section>
          )}
          {Object.keys(ideasByType).length > 0 && (
            <Section title="📋 Content Plan Overview">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {Object.entries(ideasByType).map(([ct, ideas]) => {
                  const cfg = CONTENT_TYPE_CONFIG[ct] ?? CONTENT_TYPE_CONFIG.other
                  const draftsReady = ideas.filter(i => i.draft).length
                  return (
                    <button key={ct} onClick={() => setActiveTab(ct)}
                      className="bg-gray-800 hover:bg-gray-700 rounded-xl p-4 text-left transition border border-gray-700 hover:border-gray-500">
                      <p className="text-lg mb-1">{cfg.emoji}</p>
                      <p className={`text-sm font-semibold ${cfg.color}`}>{cfg.label}</p>
                      <p className="text-gray-500 text-xs mt-0.5">{ideas.length} idea{ideas.length > 1 ? 's' : ''}</p>
                      {draftsReady > 0 && <p className="text-green-400 text-xs mt-1">✓ {draftsReady} draft{draftsReady > 1 ? 's' : ''} ready</p>}
                    </button>
                  )
                })}
              </div>
            </Section>
          )}
          <Section title="📌 Publication Tracking">
            <p className="text-gray-400 text-xs mb-3">After publishing, paste the URL here for report tracking.</p>
            <div className="flex gap-2">
              <input type="url" value={publishedUrl} onChange={e => setPublishedUrl(e.target.value)} placeholder="https://..."
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent" />
              <button onClick={savePublishedUrl} disabled={savingUrl || !publishedUrl}
                className="px-4 py-2 bg-green-700 hover:bg-green-600 text-white text-sm font-medium rounded-lg transition disabled:opacity-50">
                {savingUrl ? 'Saving…' : 'Save'}
              </button>
            </div>
            {brief.published_url && (
              <p className="text-green-400 text-xs mt-2">✓ Published: <a href={brief.published_url} target="_blank" rel="noopener noreferrer" className="underline">{brief.published_url}</a></p>
            )}
          </Section>
        </>
      )}

      {/* ── OFF-PAGE: CONTENT TYPE TABS ────────────────────────────────────── */}
      {brief.brief_type === 'off_page' && activeTab !== 'analysis' && activeTab !== 'links' && (() => {
        const ideas = ideasByType[activeTab] ?? []
        const cfg = CONTENT_TYPE_CONFIG[activeTab] ?? CONTENT_TYPE_CONFIG.other
        // Count typeIndex within this content_type (for generate-draft API)
        let typeCounter = 0

        return (
          <>
            <Section title={`${cfg.emoji} ${cfg.label} Ideas`}>
              <div className="space-y-4">
                {ideas.map((idea, globalIdx) => {
                  const myTypeIdx = typeCounter++
                  const key = `${idea.content_type}::${idea.title}`
                  const isGenerating = idea.draft_status === 'generating' || draftGenerating.has(key)
                  const hasDraft = !!idea.draft

                  return (
                    <div key={globalIdx} className={`rounded-xl border ${globalIdx === 0 ? 'border-red-500/30 bg-red-500/5' : 'border-gray-800 bg-gray-800/50'}`}>
                      {/* Idea header */}
                      <div className="p-4">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-white font-semibold text-sm">{idea.title || '(untitled)'}</p>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {globalIdx === 0 && <span className="text-xs text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full">Priority</span>}
                            {isGenerating ? (
                              <span className="text-xs text-yellow-400 bg-yellow-500/10 px-3 py-1.5 rounded-lg border border-yellow-600/30 animate-pulse">⚙️ Writing…</span>
                            ) : hasDraft ? (
                              <span className="text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full">✓ Draft ready</span>
                            ) : (
                              <button
                                onClick={() => generateIdeaDraft(idea, myTypeIdx)}
                                className="text-xs px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white font-semibold transition"
                              >
                                Generate Draft →
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 mt-2 flex-wrap">
                          {idea.platform && <span className="text-xs text-gray-400 bg-gray-700 px-2 py-0.5 rounded">📍 {idea.platform}</span>}
                          {idea.target_keyword && <span className="text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">🎯 {idea.target_keyword}</span>}
                        </div>
                        {idea.notes && <p className="text-gray-500 text-xs mt-2">{idea.notes}</p>}
                      </div>
                      {/* Draft (show when ready) */}
                      {hasDraft && (
                        <div className="border-t border-gray-700/50 px-4 pb-4">
                          <IdeaDraftEditor
                            brief={brief}
                            idea={idea}
                            onSaved={updated => setBrief(b => b ? { ...b, content_ideas: updated } : b)}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </Section>

            {/* Add more ideas */}
            <AddMoreIdeasPanel
              brief={brief}
              onAdded={() => brief && setTimeout(() => pollBrief(brief.id), 20000)}
            />
          </>
        )
      })()}

      {/* ── OFF-PAGE: INTERNAL LINKS ────────────────────────────────────────── */}
      {brief.brief_type === 'off_page' && activeTab === 'links' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="text-white font-semibold text-sm">🔗 Internal Link Strategy</p>
            {brief.off_page_draft && <CopyButton text={brief.off_page_draft} />}
          </div>
          {brief.off_page_draft
            ? <pre className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap font-sans">{brief.off_page_draft}</pre>
            : <p className="text-gray-500 text-sm">Internal link strategy not available.</p>}
        </div>
      )}
    </div>
  )
}
