'use client'

import { useState, useEffect, useCallback } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────────

type ContentIdea = {
  content_type: 'blog_post' | 'forum' | 'social' | string
  title: string
  platform: string
  target_keyword: string
  notes: string
  draft?: string
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
  // off_page_draft now stores the internal link strategy
  off_page_draft?: string
  published_url?: string
  created_at: string
  updated_at: string
}

// ── Off-page content type config ──────────────────────────────────────────────

const CONTENT_TYPE_CONFIG: Record<string, { label: string; emoji: string; color: string }> = {
  blog_post: { label: 'Blog / Article', emoji: '📝', color: 'text-blue-400' },
  forum:     { label: 'Forum / Community', emoji: '💬', color: 'text-green-400' },
  social:    { label: 'Social Media', emoji: '📱', color: 'text-purple-400' },
  video:     { label: 'Video', emoji: '🎬', color: 'text-red-400' },
  other:     { label: 'Other', emoji: '📄', color: 'text-gray-400' },
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
      className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition"
    >
      {copied ? '✓ Copied!' : label}
    </button>
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
function DraftEditor({
  brief,
  onSaved,
}: {
  brief: Brief
  onSaved: (newDraft: string) => void
}) {
  const draftField = brief.brief_type === 'on_page' ? 'content_draft' : 'off_page_draft'
  const currentDraft = (brief.brief_type === 'on_page' ? brief.content_draft : brief.off_page_draft) ?? ''

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(currentDraft)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  useEffect(() => { setDraft(currentDraft) }, [currentDraft])

  async function saveDraft() {
    setSaving(true)
    setSaveMsg(null)
    try {
      const res = await fetch('/api/brief/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: brief.id, [draftField]: draft }),
      })
      if (!res.ok) throw new Error('Save failed')
      onSaved(draft)
      setEditing(false)
      setSaveMsg('✓ Saved')
      setTimeout(() => setSaveMsg(null), 2500)
    } catch {
      setSaveMsg('✗ Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <p className="text-white font-semibold text-sm">Content Draft</p>
          {saveMsg && (
            <span className={`text-xs font-medium ${saveMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
              {saveMsg}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {draft && !editing && <CopyButton text={draft} label="Copy" />}
          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition"
            >
              ✏️ Edit
            </button>
          ) : (
            <>
              <button
                onClick={() => { setEditing(false); setDraft(currentDraft) }}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                onClick={saveDraft}
                disabled={saving}
                className="text-xs px-3 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 text-white font-semibold transition disabled:opacity-50"
              >
                {saving ? 'Saving…' : '✓ Save'}
              </button>
            </>
          )}
        </div>
      </div>

      {draft ? (
        editing ? (
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className="w-full h-[600px] bg-gray-800 border border-gray-600 rounded-xl px-4 py-3 text-gray-200 text-sm font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
            spellCheck={false}
          />
        ) : (
          <pre className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap font-sans max-h-[600px] overflow-y-auto">
            {draft}
          </pre>
        )
      ) : (
        <p className="text-gray-500 text-sm">Draft not available yet.</p>
      )}

      {draft && (
        <p className="text-gray-600 text-xs mt-3 text-right">
          {draft.split(/\s+/).filter(Boolean).length} words
        </p>
      )}
    </div>
  )
}

// ── Off-page Content Type Draft Editor ────────────────────────────────────────
// Edits the `draft` field embedded in the first idea of a given content_type
function ContentTypeDraftEditor({
  brief,
  contentType,
  ideas,
  onSaved,
}: {
  brief: Brief
  contentType: string
  ideas: ContentIdea[]
  onSaved: (updatedIdeas: ContentIdea[]) => void
}) {
  const priorityIdea = ideas.find(i => i.draft !== undefined)
  const currentDraft = priorityIdea?.draft ?? ''

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(currentDraft)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  useEffect(() => { setDraft(currentDraft) }, [currentDraft])

  async function saveDraft() {
    setSaving(true)
    setSaveMsg(null)
    try {
      // Update draft in the ideas array
      const allIdeas = brief.content_ideas ?? []
      const updatedIdeas = allIdeas.map(idea => {
        if (idea.content_type === contentType && idea === (priorityIdea ?? ideas[0])) {
          return { ...idea, draft }
        }
        return idea
      })
      // If no priority idea existed yet, attach draft to first idea of this type
      if (!priorityIdea) {
        const firstIdx = allIdeas.findIndex(i => i.content_type === contentType)
        if (firstIdx >= 0) {
          updatedIdeas[firstIdx] = { ...updatedIdeas[firstIdx], draft }
        }
      }

      const res = await fetch('/api/brief/update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: brief.id, content_ideas: updatedIdeas }),
      })
      if (!res.ok) throw new Error('Save failed')
      onSaved(updatedIdeas)
      setEditing(false)
      setSaveMsg('✓ Saved')
      setTimeout(() => setSaveMsg(null), 2500)
    } catch {
      setSaveMsg('✗ Save failed')
    } finally {
      setSaving(false)
    }
  }

  const cfg = CONTENT_TYPE_CONFIG[contentType] ?? CONTENT_TYPE_CONFIG.other

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mt-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <p className="text-white font-semibold text-sm">{cfg.emoji} {cfg.label} Draft</p>
          {saveMsg && (
            <span className={`text-xs font-medium ${saveMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
              {saveMsg}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {draft && !editing && <CopyButton text={draft} label="Copy" />}
          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition"
            >
              ✏️ Edit
            </button>
          ) : (
            <>
              <button
                onClick={() => { setEditing(false); setDraft(currentDraft) }}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                onClick={saveDraft}
                disabled={saving}
                className="text-xs px-3 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 text-white font-semibold transition disabled:opacity-50"
              >
                {saving ? 'Saving…' : '✓ Save'}
              </button>
            </>
          )}
        </div>
      </div>

      {draft ? (
        editing ? (
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className="w-full h-[500px] bg-gray-800 border border-gray-600 rounded-xl px-4 py-3 text-gray-200 text-sm font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
            spellCheck={false}
          />
        ) : (
          <pre className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap font-sans max-h-[500px] overflow-y-auto">
            {draft}
          </pre>
        )
      ) : (
        <p className="text-gray-500 text-sm italic">Draft not generated for this content type.</p>
      )}

      {draft && (
        <p className="text-gray-600 text-xs mt-3 text-right">
          {draft.split(/\s+/).filter(Boolean).length} words
        </p>
      )}
    </div>
  )
}

// ── crew-vue Publish Panel (on-page only) ─────────────────────────────────────
function CrewVuePanel({ brief }: { brief: Brief }) {
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  async function handlePublish() {
    setPublishing(true)
    setResult(null)
    try {
      const res = await fetch('/api/brief/publish-cms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief_id: brief.id }),
      })
      const data = await res.json()
      setResult({ ok: res.ok, message: data.message ?? (res.ok ? 'Published!' : data.error) })
    } catch (err) {
      setResult({ ok: false, message: String(err) })
    } finally {
      setPublishing(false)
    }
  }

  const cmsConfigured = false // flip to true once crew-vue API is integrated

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mt-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-white font-semibold text-sm">🚀 Publish to crew-vue CMS</h3>
          <p className="text-gray-500 text-xs mt-0.5">
            Upload draft content directly to the product page in crew-vue
          </p>
        </div>
        {cmsConfigured ? (
          <button
            onClick={handlePublish}
            disabled={publishing}
            className="text-sm font-semibold px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-white transition disabled:opacity-50"
          >
            {publishing ? 'Publishing…' : 'Publish →'}
          </button>
        ) : (
          <span className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-3 py-1.5 rounded-full">
            ⚙️ Needs API setup
          </span>
        )}
      </div>

      {!cmsConfigured && (
        <div className="bg-gray-800 rounded-lg px-4 py-3 text-xs text-gray-400 space-y-1">
          <p className="font-medium text-gray-300">To enable direct CMS publishing, dev needs to provide:</p>
          <p>• crew-vue REST API base URL (e.g. <code className="text-gray-300">https://cms.g2g.com/api/v1</code>)</p>
          <p>• Authentication method (API key header, OAuth token, session cookie)</p>
          <p>• Product update endpoint + payload schema (which fields map to content, meta title, meta desc)</p>
          <p>• Whether product is identified by slug, ID, or URL path</p>
        </div>
      )}

      {result && (
        <p className={`mt-3 text-sm font-medium ${result.ok ? 'text-green-400' : 'text-red-400'}`}>
          {result.ok ? '✓' : '✗'} {result.message}
        </p>
      )}
    </div>
  )
}

// ── Main BriefViewer ──────────────────────────────────────────────────────────
export function BriefViewer({
  actionItemId,
  existingBriefId,
  actionType,
}: {
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

  // Tab state — on-page: 'analysis' | 'draft'
  //             off-page: 'analysis' | 'blog_post' | 'forum' | 'social' | 'links'
  const [activeTab, setActiveTab] = useState<string>('analysis')

  const pollBrief = useCallback(async (id: string) => {
    const res = await fetch(`/api/brief/generate?id=${id}`)
    if (!res.ok) return
    const data: Brief = await res.json()
    setBrief(data)
    setPublishedUrl(data.published_url ?? '')
    if (data.status === 'generating') {
      setTimeout(() => pollBrief(id), 3000)
    } else {
      setGenerating(false)
    }
  }, [])

  useEffect(() => {
    if (existingBriefId) pollBrief(existingBriefId)
  }, [existingBriefId, pollBrief])

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    setActiveTab('analysis')
    try {
      const res = await fetch('/api/brief/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_item_id: actionItemId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      pollBrief(data.brief_id)
    } catch (err) {
      setError(String(err))
      setGenerating(false)
    }
  }

  async function markReviewed() {
    if (!brief) return
    setMarkingReviewed(true)
    await fetch('/api/brief/update', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: brief.id, status: 'reviewed' }),
    })
    setBrief(b => b ? { ...b, status: 'reviewed' } : b)
    setMarkingReviewed(false)
  }

  async function savePublishedUrl() {
    if (!brief) return
    setSavingUrl(true)
    await fetch('/api/brief/update', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: brief.id, published_url: publishedUrl }),
    })
    setBrief(b => b ? { ...b, published_url: publishedUrl } : b)
    setSavingUrl(false)
  }

  // ── Not yet generated ──────────────────────────────────────────────────────
  if (!brief && !generating) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 text-center">
        <p className="text-3xl mb-3">{actionType === 'on_page' ? '✏️' : '📣'}</p>
        <h2 className="text-white font-bold text-lg mb-2">
          {actionType === 'on_page' ? 'On-Page Optimization Brief' : 'Off-Page Content Brief'}
        </h2>
        <p className="text-gray-400 text-sm mb-1">
          {actionType === 'on_page'
            ? 'Claude will crawl the page, analyze GSC data + SERP, and generate keyword recommendations, content outline, and a full draft.'
            : 'Claude will analyze the SERP landscape, find content gaps, and generate content ideas + full drafts for Blog, Forum, and Social.'}
        </p>
        <p className="text-gray-600 text-xs mb-6">Takes ~30-60 seconds</p>
        {error && (
          <p className="text-red-400 text-sm mb-4 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2">{error}</p>
        )}
        <button
          onClick={handleGenerate}
          className="bg-red-700 hover:bg-red-600 text-white font-semibold px-6 py-3 rounded-xl transition"
        >
          Generate Brief →
        </button>
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
          <p>🤖 Claude is writing the drafts</p>
        </div>
      </div>
    )
  }

  if (!brief) return null

  // ── Build tab list ──────────────────────────────────────────────────────────
  // ON-PAGE: analysis | draft
  // OFF-PAGE: analysis | [content types present] | links
  const tabs: { key: string; label: string }[] =
    brief.brief_type === 'on_page'
      ? [
          { key: 'analysis', label: '📋 Analysis' },
          { key: 'draft', label: '📝 Draft Content' },
        ]
      : [
          { key: 'analysis', label: '📊 Analysis' },
          ...Array.from(new Set((brief.content_ideas ?? []).map(i => i.content_type)))
            .map(ct => {
              const cfg = CONTENT_TYPE_CONFIG[ct] ?? CONTENT_TYPE_CONFIG.other
              return { key: ct, label: `${cfg.emoji} ${cfg.label}` }
            }),
          { key: 'links', label: '🔗 Internal Links' },
        ]

  // Group off-page ideas by content type
  const ideasByType: Record<string, ContentIdea[]> = {}
  for (const idea of (brief.content_ideas ?? [])) {
    const ct = idea.content_type ?? 'other'
    if (!ideasByType[ct]) ideasByType[ct] = []
    ideasByType[ct].push(idea)
  }

  const hasDraftContent = brief.brief_type === 'on_page'
    ? !!brief.content_draft
    : Object.values(ideasByType).some(ideas => ideas.some(i => i.draft))

  // ── Brief ready ─────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
            brief.status === 'draft'     ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
            : brief.status === 'reviewed'  ? 'text-blue-400 bg-blue-500/10 border-blue-500/20'
            : brief.status === 'published' ? 'text-green-400 bg-green-500/10 border-green-500/20'
            : 'text-gray-400 bg-gray-500/10 border-gray-500/20'
          }`}>
            {brief.status}
          </span>
          <span className="text-gray-500 text-xs">
            Generated {new Date(brief.created_at).toLocaleString('id-ID')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {brief.status === 'draft' && hasDraftContent && (
            <button
              onClick={markReviewed}
              disabled={markingReviewed}
              className="text-xs px-3 py-1.5 rounded-lg border border-blue-700 text-blue-400 hover:bg-blue-700 hover:text-white transition disabled:opacity-50"
            >
              {markingReviewed ? '…' : '✓ Mark Reviewed'}
            </button>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition disabled:opacity-50"
          >
            ↺ Regenerate
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-5 border-b border-gray-800 overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition -mb-px whitespace-nowrap ${
              activeTab === tab.key
                ? 'border-red-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── ANALYSIS TAB (shared structure, different content per type) ──────── */}
      {activeTab === 'analysis' && brief.brief_type === 'on_page' && (
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
                    <p className="text-gray-500 mt-0.5">
                      vol: {kw.search_volume?.toLocaleString() ?? '—'}
                      {kw.cpc ? ` · $${kw.cpc?.toFixed(2)} CPC` : ''}
                    </p>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {!!brief.content_outline?.length && (
            <Section title="📐 Content Outline">
              <div className="space-y-1">
                {(brief.content_outline as any[]).map((item, i) => (
                  <p key={i} className="text-gray-300 text-sm">{item.text}</p>
                ))}
              </div>
            </Section>
          )}

          {!!brief.faq_suggestions?.length && (
            <Section title="❓ FAQ Suggestions">
              <div className="space-y-3">
                {(brief.faq_suggestions as any[]).map((faq, i) => (
                  <div key={i} className="border-l-2 border-gray-700 pl-3">
                    <p className="text-white text-sm font-medium">{faq.question}</p>
                    {faq.suggested_answer && (
                      <p className="text-gray-400 text-xs mt-1">{faq.suggested_answer}</p>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      {activeTab === 'analysis' && brief.brief_type === 'off_page' && (
        <>
          {!!brief.competitor_analysis?.length && (
            <Section title="🏆 Competitor Landscape">
              <div className="space-y-3">
                {(brief.competitor_analysis as any[]).map((c, i) => (
                  <div key={i} className="border-l-2 border-gray-700 pl-3">
                    <p className="text-xs text-gray-500">#{i + 1}</p>
                    <a href={c.url} target="_blank" rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-300 text-sm font-medium">
                      {c.title}
                    </a>
                    {c.angle && <p className="text-gray-400 text-xs mt-0.5">{c.angle}</p>}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Off-page content type summary cards */}
          {Object.keys(ideasByType).length > 0 && (
            <Section title="📋 Content Plan Overview">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {Object.entries(ideasByType).map(([ct, ideas]) => {
                  const cfg = CONTENT_TYPE_CONFIG[ct] ?? CONTENT_TYPE_CONFIG.other
                  return (
                    <button
                      key={ct}
                      onClick={() => setActiveTab(ct)}
                      className="bg-gray-800 hover:bg-gray-700 rounded-xl p-4 text-left transition border border-gray-700 hover:border-gray-500"
                    >
                      <p className={`text-lg mb-1`}>{cfg.emoji}</p>
                      <p className={`text-sm font-semibold ${cfg.color}`}>{cfg.label}</p>
                      <p className="text-gray-500 text-xs mt-0.5">{ideas.length} idea{ideas.length > 1 ? 's' : ''}</p>
                      {ideas[0]?.draft && (
                        <p className="text-green-400 text-xs mt-1">✓ Draft ready</p>
                      )}
                    </button>
                  )
                })}
              </div>
            </Section>
          )}

          {/* Publication tracker */}
          <Section title="📌 Publication Tracking">
            <p className="text-gray-400 text-xs mb-3">After publishing, paste the URL here for report tracking.</p>
            <div className="flex gap-2">
              <input
                type="url"
                value={publishedUrl}
                onChange={e => setPublishedUrl(e.target.value)}
                placeholder="https://..."
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
              />
              <button
                onClick={savePublishedUrl}
                disabled={savingUrl || !publishedUrl}
                className="px-4 py-2 bg-green-700 hover:bg-green-600 text-white text-sm font-medium rounded-lg transition disabled:opacity-50"
              >
                {savingUrl ? 'Saving…' : 'Save'}
              </button>
            </div>
            {brief.published_url && (
              <p className="text-green-400 text-xs mt-2">
                ✓ Published: <a href={brief.published_url} target="_blank" rel="noopener noreferrer" className="underline">{brief.published_url}</a>
              </p>
            )}
          </Section>
        </>
      )}

      {/* ── ON-PAGE: DRAFT TAB ─────────────────────────────────────────────── */}
      {brief.brief_type === 'on_page' && activeTab === 'draft' && (
        <>
          <DraftEditor
            brief={brief}
            onSaved={newDraft => setBrief(b => b ? { ...b, content_draft: newDraft } : b)}
          />
          <CrewVuePanel brief={brief} />
        </>
      )}

      {/* ── OFF-PAGE: CONTENT TYPE TABS ────────────────────────────────────── */}
      {brief.brief_type === 'off_page' && activeTab !== 'analysis' && activeTab !== 'links' && (
        (() => {
          const ideas = ideasByType[activeTab] ?? []
          const cfg = CONTENT_TYPE_CONFIG[activeTab] ?? CONTENT_TYPE_CONFIG.other
          return (
            <>
              {/* Ideas list */}
              {ideas.length > 0 && (
                <Section title={`${cfg.emoji} ${cfg.label} Ideas`}>
                  <div className="space-y-4">
                    {ideas.map((idea, i) => (
                      <div
                        key={i}
                        className={`rounded-xl p-4 border ${i === 0 ? 'border-red-500/30 bg-red-500/5' : 'border-gray-800 bg-gray-800/50'}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-white font-semibold text-sm">{idea.title || '(untitled)'}</p>
                          {i === 0 && (
                            <span className="text-xs text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full flex-shrink-0">
                              Priority
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-2 flex-wrap">
                          {idea.platform && (
                            <span className="text-xs text-gray-400 bg-gray-700 px-2 py-0.5 rounded">
                              📍 {idea.platform}
                            </span>
                          )}
                          {idea.target_keyword && (
                            <span className="text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">
                              🎯 {idea.target_keyword}
                            </span>
                          )}
                        </div>
                        {idea.notes && (
                          <p className="text-gray-500 text-xs mt-2">{idea.notes}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* Editable draft for this content type */}
              <ContentTypeDraftEditor
                brief={brief}
                contentType={activeTab}
                ideas={ideas}
                onSaved={updatedIdeas =>
                  setBrief(b => b ? { ...b, content_ideas: updatedIdeas } : b)
                }
              />
            </>
          )
        })()
      )}

      {/* ── OFF-PAGE: INTERNAL LINKS TAB ───────────────────────────────────── */}
      {brief.brief_type === 'off_page' && activeTab === 'links' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="text-white font-semibold text-sm">🔗 Internal Link Strategy</p>
            {brief.off_page_draft && <CopyButton text={brief.off_page_draft} label="Copy" />}
          </div>
          {brief.off_page_draft ? (
            <pre className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap font-sans">
              {brief.off_page_draft}
            </pre>
          ) : (
            <p className="text-gray-500 text-sm">Internal link strategy not available.</p>
          )}
        </div>
      )}
    </div>
  )
}
