'use client'

import { useState, useEffect, useCallback } from 'react'

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
  content_ideas?: { title: string; platform: string; target_keyword: string; notes: string }[]
  competitor_analysis?: { url: string; title: string; angle: string }[]
  off_page_draft?: string
  published_url?: string
  created_at: string
  updated_at: string
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={copy}
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
  const [activeTab, setActiveTab] = useState<'brief' | 'draft'>('brief')

  // Poll for brief status while generating
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

  // Load existing brief on mount
  useEffect(() => {
    if (existingBriefId) {
      pollBrief(existingBriefId)
    }
  }, [existingBriefId, pollBrief])

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/brief/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_item_id: actionItemId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      // Start polling
      pollBrief(data.brief_id)
    } catch (err) {
      setError(String(err))
      setGenerating(false)
    }
  }

  async function savePublishedUrl() {
    setSavingUrl(true)
    await fetch('/api/actions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: actionItemId, notes: publishedUrl }),
    })
    // Also update brief
    if (brief) {
      await fetch(`/api/brief/update`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: brief.id, published_url: publishedUrl }),
      })
    }
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
            : 'Claude will analyze the SERP landscape, find content gaps, and generate content ideas + a full article draft.'}
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

  // ── Generating ────────────────────────────────────────────────────────────
  if (generating && brief?.status === 'generating') {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 text-center">
        <div className="animate-spin text-3xl mb-4">⚙️</div>
        <p className="text-white font-semibold mb-2">Generating brief…</p>
        <div className="text-gray-500 text-sm space-y-1">
          <p>🔍 Crawling page</p>
          <p>📊 Pulling SERP + PAA data from DataForSEO</p>
          <p>🤖 Claude is analyzing and writing the draft</p>
        </div>
      </div>
    )
  }

  if (!brief) return null

  const draftContent = brief.brief_type === 'on_page' ? brief.content_draft : brief.off_page_draft

  // ── Brief ready ────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
            brief.status === 'draft' ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
            : brief.status === 'reviewed' ? 'text-blue-400 bg-blue-500/10 border-blue-500/20'
            : 'text-green-400 bg-green-500/10 border-green-500/20'
          }`}>
            {brief.status}
          </span>
          <span className="text-gray-500 text-xs">
            Generated {new Date(brief.created_at).toLocaleString('id-ID')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {draftContent && <CopyButton text={draftContent} label="Copy Draft" />}
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
      <div className="flex gap-2 mb-5 border-b border-gray-800 pb-0">
        {(['brief', 'draft'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition -mb-px ${
              activeTab === tab
                ? 'border-red-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab === 'brief' ? '📋 Analysis' : '📝 Draft Content'}
          </button>
        ))}
      </div>

      {/* ── ON-PAGE BRIEF VIEW ─────────────────────────────────────────────── */}
      {brief.brief_type === 'on_page' && activeTab === 'brief' && (
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

      {/* ── OFF-PAGE BRIEF VIEW ────────────────────────────────────────────── */}
      {brief.brief_type === 'off_page' && activeTab === 'brief' && (
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

          {!!brief.content_ideas?.length && (
            <Section title="💡 Content Ideas">
              <div className="space-y-4">
                {(brief.content_ideas as any[]).map((idea, i) => (
                  <div key={i} className={`rounded-xl p-4 border ${i === 0 ? 'border-red-500/30 bg-red-500/5' : 'border-gray-800 bg-gray-800/50'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-white font-semibold text-sm">{idea.title}</p>
                      {i === 0 && <span className="text-xs text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full flex-shrink-0">Priority</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-2 flex-wrap">
                      {idea.platform && (
                        <span className="text-xs text-gray-400 bg-gray-700 px-2 py-0.5 rounded">📍 {idea.platform}</span>
                      )}
                      {idea.target_keyword && (
                        <span className="text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">🎯 {idea.target_keyword}</span>
                      )}
                    </div>
                    {idea.notes && (
                      <p className="text-gray-500 text-xs mt-2 line-clamp-3">{idea.notes}</p>
                    )}
                  </div>
                ))}
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

      {/* ── DRAFT TAB ─────────────────────────────────────────────────────── */}
      {activeTab === 'draft' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="text-white font-semibold text-sm">
              {brief.brief_type === 'on_page' ? 'Content Draft' : 'Article Draft'}
            </p>
            {draftContent && <CopyButton text={draftContent} label="Copy all" />}
          </div>
          {draftContent ? (
            <pre className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap font-sans">
              {draftContent}
            </pre>
          ) : (
            <p className="text-gray-500 text-sm">Draft not available yet.</p>
          )}
        </div>
      )}
    </div>
  )
}
