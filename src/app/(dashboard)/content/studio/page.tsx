'use client'

import { useState, useEffect, useRef, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { LottieLoader } from '@/components/ui/LottieLoader'

// ── Types ─────────────────────────────────────────────────────────────────────
interface KeywordSuggestion {
  keyword:            string
  search_volume:      number | null
  cpc:                number | null
  keyword_difficulty: number | null
}

interface Draft {
  id:           string
  title:        string
  topic:        string
  game_name:    string | null
  content_type: string
  tone:         string
  language:     string
  status:       string
  target_keywords: string[]
  created_at:   string
  updated_at:   string
}

// Platform entries from Knowledge Base — shape mirrors KB platform tab
// (tone, format, guidelines, examples, notes). Used to pick the publication
// target for a piece of content; backend uses the picked platform's data
// to instruct Bragi/Claude on house rules (e.g. Reddit = no shilling).
interface KBPlatform {
  id:    string
  name:  string
  data:  {
    tone?:        string
    format?:      string
    guidelines?:  string
    examples?:    string
    notes?:       string
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
const CONTENT_TYPES = [
  { value: 'blog_post',     label: 'Blog Post',       icon: '📝', desc: 'Long-form article for content marketing' },
  { value: 'landing_page',  label: 'Landing Page',    icon: '🎯', desc: 'Product page with CTAs for G2G' },
  { value: 'category_page', label: 'Category Page',   icon: '🗂️', desc: 'SEO-optimised listing/category page' },
  { value: 'guide',         label: 'Guide / Tutorial', icon: '📚', desc: 'Step-by-step how-to guide' },
  { value: 'listicle',      label: 'Listicle',         icon: '📋', desc: 'Top N list — best games, tips, etc.' },
]

const TONES = [
  { value: 'informative',  label: 'Informative',  icon: '📖', desc: 'Clear and educational' },
  { value: 'persuasive',   label: 'Persuasive',   icon: '💪', desc: 'Conversion-focused' },
  { value: 'casual',       label: 'Casual',       icon: '😎', desc: 'Friendly and relatable' },
  { value: 'professional', label: 'Professional', icon: '💼', desc: 'Polished and authoritative' },
]

const LANGUAGES = [
  { value: 'en',  label: '🇺🇸 English' },
  { value: 'id',  label: '🇮🇩 Indonesian' },
  { value: 'pt',  label: '🇧🇷 Portuguese' },
  { value: 'es',  label: '🇪🇸 Spanish' },
  { value: 'th',  label: '🇹🇭 Thai' },
  { value: 'vi',  label: '🇻🇳 Vietnamese' },
]

const WORD_COUNTS = [
  { value: 500,  label: '~500 words',  desc: 'Short / social' },
  { value: 800,  label: '~800 words',  desc: 'Standard' },
  { value: 1200, label: '~1,200 words', desc: 'In-depth' },
  { value: 2000, label: '~2,000 words', desc: 'Long-form' },
]

const STEPS = ['Topic', 'Keywords', 'Format', 'Style', 'Generate']

// ── Step indicator ────────────────────────────────────────────────────────────
function StepBar({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEPS.map((label, i) => (
        <div key={i} className="flex items-center flex-1 last:flex-none">
          <div className={`flex items-center gap-2 ${i <= current ? 'text-white' : 'text-gray-600'}`}>
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition ${
              i < current  ? 'bg-green-600 text-white' :
              i === current ? 'bg-red-600 text-white' :
              'bg-gray-800 text-gray-600'
            }`}>
              {i < current ? '✓' : i + 1}
            </div>
            <span className="text-xs font-medium hidden sm:block">{label}</span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={`flex-1 h-px mx-3 ${i < current ? 'bg-green-600/50' : 'bg-gray-800'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

// ── Main component (inner, uses searchParams) ─────────────────────────────────
function ContentStudioInner() {
  const searchParams = useSearchParams()
  const router       = useRouter()

  // Pre-fill from Game Trends
  const prefillGame    = searchParams.get('game')    ?? ''
  const prefillKeyword = searchParams.get('keyword') ?? ''
  const prefillVol     = searchParams.get('vol')     ?? ''

  const [step, setStep] = useState(0)

  // Step 1: Topic
  const [topic,          setTopic]       = useState(prefillGame
    ? prefillKeyword ? `${prefillKeyword} - ${prefillGame}` : `${prefillGame} items - buy on G2G`
    : '')
  const [gameName,       setGameName]    = useState(prefillGame)
  const [customContext,  setContext]      = useState('')

  // Step 2: Keywords
  const [kwLoading,      setKwLoading]   = useState(false)
  const [kwSuggestions,  setKwSuggestions] = useState<KeywordSuggestion[]>([])
  const [targetKeywords, setTargetKws]   = useState<string[]>(
    prefillKeyword ? [prefillKeyword] : []
  )
  const [customKw,       setCustomKw]    = useState('')

  // Step 3: Format
  const [contentType,    setContentType] = useState('blog_post')
  const [wordCount,      setWordCount]   = useState(1000)
  const [language,       setLanguage]    = useState('en')
  // Optional publication target (KB-driven). When set, Bragi gets the
  // platform's house rules in its system prompt so output respects tone +
  // format constraints of that destination (e.g. Reddit, Steam Community,
  // Discord, internal G2G blog).
  const [platformId,     setPlatformId]  = useState<string>('')      // '' = no platform context
  const [platforms,      setPlatforms]   = useState<KBPlatform[]>([])

  // Step 4: Style
  const [tone,           setTone]        = useState('informative')
  const [audience,       setAudience]    = useState('')
  const [imageUrls,      setImageUrls]   = useState<string[]>([])
  const [imageInput,     setImageInput]  = useState('')
  const [customInstr,    setCustomInstr] = useState('')

  // Step 5: Generate
  const [generating,     setGenerating]  = useState(false)
  const [generated,      setGenerated]   = useState<{
    draft_id?: string; title?: string; meta_title?: string; meta_description?: string; content?: string
  } | null>(null)
  const [genError,       setGenError]    = useState<string | null>(null)

  // Drafts list (sidebar)
  const [drafts,         setDrafts]      = useState<Draft[]>([])
  const [showDrafts,     setShowDrafts]  = useState(false)

  // Draft viewer modal
  const [viewingDraft,   setViewingDraft] = useState<{
    id: string; title?: string; content?: string; meta_title?: string; meta_description?: string
    topic?: string; content_type?: string; tone?: string; language?: string
    target_keywords?: string[]; created_at?: string
  } | null>(null)
  const [loadingDraftId, setLoadingDraftId] = useState<string | null>(null)

  async function openDraft(id: string) {
    setLoadingDraftId(id)
    try {
      const res  = await fetch(`/api/content/studio?id=${id}`)
      const data = await res.json()
      if (data.draft) setViewingDraft(data.draft)
    } catch { /* silent */ }
    finally { setLoadingDraftId(null) }
  }

  // ── Fetch keyword suggestions when entering step 2 ────────────────────────
  useEffect(() => {
    if (step !== 1 || !topic.trim()) return
    setKwLoading(true)
    const seed = gameName.trim() || topic.trim()
    fetch(`/api/trends/game-keywords?game=${encodeURIComponent(seed)}`)
      .then(r => r.json())
      .then(d => setKwSuggestions(d.keywords ?? []))
      .catch(() => {})
      .finally(() => setKwLoading(false))
  }, [step]) // eslint-disable-line

  // ── Load drafts ───────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/content/studio')
      .then(r => r.json())
      .then(d => setDrafts(d.drafts ?? []))
      .catch(() => {})
  }, [])

  // ── Load KB platforms (for platform selector in Step 2) ───────────────────
  // Same KB endpoint used by /knowledge-base — filter to category='platform'
  // (singular, matching how KB UI persists). If no platforms configured, the
  // selector simply hides itself.
  useEffect(() => {
    fetch('/api/knowledge-base')
      .then(r => r.json())
      .then(d => {
        const items = (d.items ?? []) as Array<{ id: string; category: string; name: string; data: KBPlatform['data'] }>
        setPlatforms(items.filter(i => i.category === 'platform').map(i => ({ id: i.id, name: i.name, data: i.data ?? {} })))
      })
      .catch(() => {})
  }, [])

  // ── Generate content ───────────────────────────────────────────────────────
  async function generate() {
    setGenerating(true); setGenError(null); setGenerated(null)
    try {
      const res  = await fetch('/api/content/studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          game_name:           gameName || null,
          content_type:        contentType,
          tone,
          language,
          target_audience:     audience || null,
          word_count:          wordCount,
          target_keywords:     targetKeywords,
          image_urls:          imageUrls,
          custom_instructions: customInstr || null,
          platform_id:         platformId || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setGenerated(data)
      // Refresh drafts
      fetch('/api/content/studio').then(r => r.json()).then(d => setDrafts(d.drafts ?? []))
    } catch (e) {
      setGenError(String(e))
    } finally {
      setGenerating(false)
    }
  }

  function toggleKeyword(kw: string) {
    setTargetKws(prev =>
      prev.includes(kw) ? prev.filter(k => k !== kw) : [...prev, kw]
    )
  }

  function addCustomKeyword() {
    const kw = customKw.trim().toLowerCase()
    if (!kw || targetKeywords.includes(kw)) return
    setTargetKws(prev => [...prev, kw])
    setCustomKw('')
  }

  function addImageUrl() {
    const url = imageInput.trim()
    if (!url || imageUrls.includes(url)) return
    setImageUrls(prev => [...prev, url])
    setImageInput('')
  }

  function deleteDraft(id: string) {
    fetch(`/api/content/studio?id=${id}`, { method: 'DELETE' })
      .then(() => setDrafts(prev => prev.filter(d => d.id !== id)))
      .catch(() => {})
  }

  const canNext = [
    topic.trim().length > 0,                        // step 0
    targetKeywords.length > 0,                       // step 1
    true,                                            // step 2 (always valid)
    true,                                            // step 3 (always valid)
    true,                                            // step 4
  ]

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">✍️ Content Studio</h1>
          <p className="text-gray-400 text-sm mt-1">
            Create publish-ready content — from game trends, product pages, or any idea.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push('/content/trends')}
            className="text-xs px-4 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition"
          >
            🎮 Game Trends
          </button>
          <button
            onClick={() => setShowDrafts(v => !v)}
            className="text-xs px-4 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition"
          >
            📂 Saved Drafts {drafts.length > 0 && `(${drafts.length})`}
          </button>
        </div>
      </div>

      {/* Drafts drawer */}
      {showDrafts && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6">
          <h3 className="text-white font-semibold text-sm mb-3">Saved Drafts</h3>
          {drafts.length === 0 ? (
            <p className="text-gray-500 text-xs">No drafts yet.</p>
          ) : (
            <div className="space-y-2">
              {drafts.map(d => (
                <div key={d.id} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2 hover:bg-gray-750 transition">
                  <div className="flex-1 min-w-0 mr-3">
                    <p className="text-white text-xs font-medium truncate">{d.title}</p>
                    <p className="text-gray-500 text-[10px]">
                      {d.content_type} · {d.tone} · {d.language.toUpperCase()} ·{' '}
                      {new Date(d.updated_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                      d.status === 'done' ? 'bg-green-500/20 text-green-400' :
                      d.status === 'generating' ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-gray-700 text-gray-400'
                    }`}>
                      {d.status}
                    </span>
                    <button
                      onClick={() => openDraft(d.id)}
                      disabled={loadingDraftId === d.id}
                      className="text-xs px-2 py-1 rounded border border-gray-600 text-gray-300 hover:border-gray-400 hover:text-white transition disabled:opacity-50"
                    >
                      {loadingDraftId === d.id ? '…' : '👁 View'}
                    </button>
                    <button onClick={() => deleteDraft(d.id)}
                      className="text-gray-600 hover:text-red-400 text-xs transition">🗑️</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Step bar */}
      <StepBar current={step} />

      {/* ── Step 0: Topic ──────────────────────────────────────────────────────── */}
      {step === 0 && (
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-semibold text-white mb-2">What do you want to write about?</label>
            <textarea
              value={topic}
              onChange={e => setTopic(e.target.value)}
              rows={3}
              placeholder="e.g. Buy Monopoly Go dice links, Free Fire diamonds top-up guide, Best Roblox games to earn Robux…"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 resize-none"
            />
            <p className="text-xs text-gray-600 mt-1">Be as specific or as broad as you want. More detail = better output.</p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-white mb-2">
              Game name <span className="text-gray-500 font-normal">(optional — leave blank for non-game content)</span>
            </label>
            <input
              value={gameName}
              onChange={e => setGameName(e.target.value)}
              placeholder="e.g. Monopoly Go, Free Fire, Roblox…"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-white mb-2">
              Context / brief <span className="text-gray-500 font-normal">(optional)</span>
            </label>
            <textarea
              value={customContext}
              onChange={e => setContext(e.target.value)}
              rows={2}
              placeholder="Any background, key points to cover, or things to avoid…"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 resize-none"
            />
          </div>

          {prefillGame && (
            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-3 flex items-center gap-2.5">
              <span className="text-xl">🎮</span>
              <p className="text-green-300 text-xs">
                Pre-filled from Game Trends: <strong>{prefillGame}</strong>
                {prefillKeyword && <> · Keyword: <strong>{prefillKeyword}</strong></>}
                {prefillVol && <> · Volume: <strong>{parseInt(prefillVol).toLocaleString()}</strong></>}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Step 1: Keywords ──────────────────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-semibold text-white mb-1">Select target keywords</label>
            <p className="text-xs text-gray-500 mb-3">Pick 3–5 keywords to optimise for. Pick a primary keyword first.</p>

            {/* Selected keywords */}
            {targetKeywords.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {targetKeywords.map((kw, i) => (
                  <span key={kw}
                    className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border cursor-pointer transition ${
                      i === 0
                        ? 'bg-red-500/20 border-red-500/40 text-red-300'
                        : 'bg-gray-700 border-gray-600 text-gray-300'
                    }`}
                    onClick={() => toggleKeyword(kw)}
                  >
                    {i === 0 && <span className="text-[9px] font-bold text-red-400">PRIMARY</span>}
                    {kw}
                    <span className="text-gray-500 hover:text-white">✕</span>
                  </span>
                ))}
              </div>
            )}

            {/* Suggestions */}
            {kwLoading ? (
              <div className="flex justify-center py-6">
                <LottieLoader size={50} text="Fetching keyword ideas…" />
              </div>
            ) : (
              <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
                {kwSuggestions.slice(0, 30).map(kw => {
                  const isSelected = targetKeywords.includes(kw.keyword)
                  return (
                    <div key={kw.keyword}
                      onClick={() => toggleKeyword(kw.keyword)}
                      className={`flex items-center justify-between rounded-lg px-3 py-2 cursor-pointer transition ${
                        isSelected ? 'bg-red-500/15 border border-red-500/30' : 'bg-gray-900 border border-transparent hover:border-gray-700'
                      }`}
                    >
                      <span className={`text-xs ${isSelected ? 'text-white font-medium' : 'text-gray-300'}`}>
                        {kw.keyword}
                      </span>
                      <div className="flex items-center gap-3">
                        {kw.search_volume != null && (
                          <span className="text-xs text-gray-500">{kw.search_volume.toLocaleString()}</span>
                        )}
                        {kw.keyword_difficulty != null && (
                          <span className={`text-xs ${kw.keyword_difficulty <= 30 ? 'text-green-400' : kw.keyword_difficulty <= 60 ? 'text-yellow-400' : 'text-red-400'}`}>
                            KD {kw.keyword_difficulty}
                          </span>
                        )}
                        <span className={`text-xs ${isSelected ? 'text-red-400' : 'text-gray-700'}`}>
                          {isSelected ? '✓' : '+'}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Manual keyword add */}
            <div className="flex gap-2 mt-3">
              <input
                value={customKw}
                onChange={e => setCustomKw(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addCustomKeyword()}
                placeholder="Add custom keyword…"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
              />
              <button onClick={addCustomKeyword}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition">
                + Add
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 2: Format ────────────────────────────────────────────────────── */}
      {step === 2 && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-semibold text-white mb-3">Content type</label>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {CONTENT_TYPES.map(ct => (
                <button key={ct.value} onClick={() => setContentType(ct.value)}
                  className={`text-left p-3 rounded-xl border transition ${
                    contentType === ct.value
                      ? 'bg-red-500/15 border-red-500/40'
                      : 'bg-gray-900 border-gray-800 hover:border-gray-600'
                  }`}
                >
                  <span className="text-xl block mb-1">{ct.icon}</span>
                  <p className={`text-xs font-semibold mb-0.5 ${contentType === ct.value ? 'text-white' : 'text-gray-300'}`}>
                    {ct.label}
                  </p>
                  <p className="text-[10px] text-gray-500">{ct.desc}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-white mb-3">Length</label>
            <div className="grid grid-cols-4 gap-2">
              {WORD_COUNTS.map(wc => (
                <button key={wc.value} onClick={() => setWordCount(wc.value)}
                  className={`p-3 rounded-xl border transition text-center ${
                    wordCount === wc.value
                      ? 'bg-red-500/15 border-red-500/40'
                      : 'bg-gray-900 border-gray-800 hover:border-gray-600'
                  }`}
                >
                  <p className={`text-xs font-semibold ${wordCount === wc.value ? 'text-white' : 'text-gray-300'}`}>
                    {wc.label}
                  </p>
                  <p className="text-[10px] text-gray-500">{wc.desc}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-white mb-2">Language</label>
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map(lang => (
                <button key={lang.value} onClick={() => setLanguage(lang.value)}
                  className={`text-xs px-4 py-2 rounded-lg border transition ${
                    language === lang.value
                      ? 'bg-red-500/15 border-red-500/40 text-white'
                      : 'bg-gray-900 border-gray-800 text-gray-400 hover:border-gray-600 hover:text-white'
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
          </div>

          {/* Platform selector — sourced from KB (category='platform').
              Only renders when at least one platform is configured. Defaults
              to "no platform context" so generation behaves as before. */}
          {platforms.length > 0 && (
            <div>
              <label className="block text-sm font-semibold text-white mb-2">
                Publication target <span className="text-gray-500 font-normal text-xs">(optional)</span>
              </label>
              <p className="text-[11px] text-gray-500 mb-2">
                Pick a platform to apply its house rules (tone, format, guidelines) to the generation prompt.
                Manage platforms in <a href="/knowledge-base" className="text-red-400 hover:text-red-300 underline">Knowledge Base → Platforms</a>.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setPlatformId('')}
                  className={`text-xs px-3 py-2 rounded-lg border transition ${
                    platformId === ''
                      ? 'bg-red-500/15 border-red-500/40 text-white'
                      : 'bg-gray-900 border-gray-800 text-gray-400 hover:border-gray-600 hover:text-white'
                  }`}
                >
                  None
                </button>
                {platforms.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPlatformId(p.id)}
                    title={[
                      p.data.tone        && `Tone: ${p.data.tone}`,
                      p.data.format      && `Format: ${p.data.format}`,
                      p.data.guidelines  && `Guidelines: ${p.data.guidelines.slice(0, 200)}${p.data.guidelines.length > 200 ? '…' : ''}`,
                    ].filter(Boolean).join('\n') || p.name}
                    className={`text-xs px-3 py-2 rounded-lg border transition ${
                      platformId === p.id
                        ? 'bg-red-500/15 border-red-500/40 text-white'
                        : 'bg-gray-900 border-gray-800 text-gray-400 hover:border-gray-600 hover:text-white'
                    }`}
                  >
                    📡 {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Step 3: Style ─────────────────────────────────────────────────────── */}
      {step === 3 && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-semibold text-white mb-3">Tone</label>
            <div className="grid grid-cols-2 gap-3">
              {TONES.map(t => (
                <button key={t.value} onClick={() => setTone(t.value)}
                  className={`text-left p-3 rounded-xl border transition ${
                    tone === t.value
                      ? 'bg-red-500/15 border-red-500/40'
                      : 'bg-gray-900 border-gray-800 hover:border-gray-600'
                  }`}
                >
                  <span className="text-xl block mb-1">{t.icon}</span>
                  <p className={`text-xs font-semibold mb-0.5 ${tone === t.value ? 'text-white' : 'text-gray-300'}`}>
                    {t.label}
                  </p>
                  <p className="text-[10px] text-gray-500">{t.desc}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-white mb-1">
              Target audience <span className="text-gray-500 font-normal text-xs">(optional)</span>
            </label>
            <input
              value={audience}
              onChange={e => setAudience(e.target.value)}
              placeholder="e.g. Mobile gamers aged 18-35, parents buying Roblox credits for kids…"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
          </div>

          {/* Images */}
          <div>
            <label className="block text-sm font-semibold text-white mb-1">
              Images <span className="text-gray-500 font-normal text-xs">(optional — paste URLs or upload)</span>
            </label>
            <div className="flex gap-2 mb-2">
              <input
                value={imageInput}
                onChange={e => setImageInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addImageUrl()}
                placeholder="https://example.com/image.jpg"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
              />
              <button onClick={addImageUrl}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition">
                + Add
              </button>
            </div>
            {imageUrls.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {imageUrls.map(url => (
                  <div key={url} className="flex items-center gap-2 bg-gray-800 rounded-lg px-2 py-1 text-xs">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt="" className="w-8 h-8 object-cover rounded" onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    <span className="text-gray-400 max-w-[120px] truncate">{url}</span>
                    <button onClick={() => setImageUrls(prev => prev.filter(u => u !== url))}
                      className="text-gray-600 hover:text-red-400">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-semibold text-white mb-1">
              Additional instructions <span className="text-gray-500 font-normal text-xs">(optional)</span>
            </label>
            <textarea
              value={customInstr}
              onChange={e => setCustomInstr(e.target.value)}
              rows={3}
              placeholder="e.g. Mention that G2G offers the cheapest prices, include a comparison table, avoid mentioning competitor X…"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 resize-none"
            />
          </div>
        </div>
      )}

      {/* ── Step 4: Generate ──────────────────────────────────────────────────── */}
      {step === 4 && (
        <div>
          {/* Summary */}
          {!generating && !generated && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5 space-y-3">
              <h3 className="text-white font-semibold text-sm">Ready to generate</h3>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="text-gray-500">Topic:</span>
                  <span className="text-white ml-2">{topic}</span>
                </div>
                {gameName && (
                  <div>
                    <span className="text-gray-500">Game:</span>
                    <span className="text-white ml-2">{gameName}</span>
                  </div>
                )}
                <div>
                  <span className="text-gray-500">Type:</span>
                  <span className="text-white ml-2">{CONTENT_TYPES.find(c => c.value === contentType)?.label}</span>
                </div>
                <div>
                  <span className="text-gray-500">Tone:</span>
                  <span className="text-white ml-2">{TONES.find(t => t.value === tone)?.label}</span>
                </div>
                <div>
                  <span className="text-gray-500">Length:</span>
                  <span className="text-white ml-2">~{wordCount} words</span>
                </div>
                <div>
                  <span className="text-gray-500">Language:</span>
                  <span className="text-white ml-2">{LANGUAGES.find(l => l.value === language)?.label}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-gray-500">Keywords:</span>
                  <span className="text-white ml-2">{targetKeywords.join(', ')}</span>
                </div>
              </div>

              <button onClick={generate}
                className="w-full bg-red-700 hover:bg-red-600 text-white font-semibold py-3 rounded-xl transition text-sm flex items-center justify-center gap-2 mt-2">
                ✨ Generate Content with Claude
              </button>
              <p className="text-xs text-gray-600 text-center">~30-60 seconds · Uses Claude Opus</p>
            </div>
          )}

          {/* Generating */}
          {generating && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <LottieLoader size={90} text="Claude is writing your content…" />
              <p className="text-gray-500 text-xs">This usually takes 30–60 seconds</p>
            </div>
          )}

          {/* Error */}
          {genError && !generating && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-4 text-red-400 text-sm">
              ⚠️ {genError}
              <button onClick={generate} className="ml-4 text-xs underline text-red-300 hover:text-red-200">Retry</button>
            </div>
          )}

          {/* Result */}
          {generated && !generating && (
            <div className="space-y-4">
              {/* Meta */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
                <div>
                  <p className="text-xs text-gray-500 mb-1">Meta title</p>
                  <input
                    defaultValue={generated.meta_title ?? ''}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
                  />
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">Meta description</p>
                  <textarea
                    defaultValue={generated.meta_description ?? ''}
                    rows={2}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 resize-none"
                  />
                </div>
              </div>

              {/* Content editor */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-gray-400">Content (markdown) — edit directly</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(generated.content ?? '')
                      }}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white transition"
                    >
                      📋 Copy
                    </button>
                    <button onClick={generate}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white transition">
                      🔄 Regenerate
                    </button>
                  </div>
                </div>
                <textarea
                  defaultValue={generated.content ?? ''}
                  rows={30}
                  className="w-full bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 text-sm text-gray-200 font-mono focus:outline-none focus:border-red-500 resize-y"
                />
              </div>

              <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-3 text-green-300 text-xs flex items-center gap-2">
                ✅ Draft saved automatically · {drafts.length} draft{drafts.length !== 1 ? 's' : ''} total
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Nav buttons ───────────────────────────────────────────────────────── */}
      {!(step === 4 && generating) && (
        <div className="flex items-center justify-between mt-8 pt-6 border-t border-gray-800">
          <button
            onClick={() => setStep(s => Math.max(0, s - 1))}
            disabled={step === 0}
            className="text-sm px-5 py-2.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition disabled:opacity-30"
          >
            ← Back
          </button>

          {step < 4 ? (
            <button
              onClick={() => setStep(s => s + 1)}
              disabled={!canNext[step]}
              className="text-sm bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white font-semibold px-6 py-2.5 rounded-lg transition"
            >
              Next →
            </button>
          ) : (
            !generated && !generating && (
              <button onClick={generate}
                className="text-sm bg-red-700 hover:bg-red-600 text-white font-semibold px-6 py-2.5 rounded-lg transition flex items-center gap-2">
                ✨ Generate
              </button>
            )
          )}
        </div>
      )}

      {/* ── Draft Viewer Modal ──────────────────────────────────────────────── */}
      {viewingDraft && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 overflow-y-auto py-10 px-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-3xl shadow-2xl">
            {/* Modal header */}
            <div className="flex items-start justify-between p-5 border-b border-gray-800">
              <div className="flex-1 min-w-0">
                <h2 className="text-white font-bold text-lg truncate">{viewingDraft.title ?? 'Untitled Draft'}</h2>
                <p className="text-gray-500 text-xs mt-0.5">
                  {viewingDraft.content_type} · {viewingDraft.tone} · {viewingDraft.language?.toUpperCase()}
                  {viewingDraft.created_at && ` · ${new Date(viewingDraft.created_at).toLocaleDateString()}`}
                </p>
                {viewingDraft.target_keywords && viewingDraft.target_keywords.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {viewingDraft.target_keywords.map(kw => (
                      <span key={kw} className="text-[10px] bg-red-500/10 text-red-400 border border-red-500/20 px-1.5 py-0.5 rounded-full">{kw}</span>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => setViewingDraft(null)}
                className="ml-4 text-gray-500 hover:text-white text-xl leading-none flex-shrink-0 transition"
              >✕</button>
            </div>

            {/* Meta info */}
            {(viewingDraft.meta_title || viewingDraft.meta_description) && (
              <div className="px-5 py-3 bg-gray-800/50 border-b border-gray-800 space-y-2">
                {viewingDraft.meta_title && (
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Meta Title</p>
                    <p className="text-sm text-gray-300">{viewingDraft.meta_title}</p>
                  </div>
                )}
                {viewingDraft.meta_description && (
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Meta Description</p>
                    <p className="text-sm text-gray-300">{viewingDraft.meta_description}</p>
                  </div>
                )}
              </div>
            )}

            {/* Content */}
            <div className="p-5">
              {viewingDraft.content ? (
                <div
                  className="prose prose-invert prose-sm max-w-none text-gray-300 text-sm leading-relaxed whitespace-pre-wrap"
                  style={{ fontFamily: 'inherit' }}
                >
                  {viewingDraft.content}
                </div>
              ) : (
                <p className="text-gray-500 text-sm text-center py-8">No content generated yet for this draft.</p>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-gray-800 flex justify-end gap-2">
              <button
                onClick={() => {
                  if (viewingDraft.content) {
                    navigator.clipboard.writeText(viewingDraft.content)
                  }
                }}
                className="text-xs px-4 py-2 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white transition"
              >
                📋 Copy Content
              </button>
              <button
                onClick={() => setViewingDraft(null)}
                className="text-xs px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 text-white font-semibold transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Page export (wraps in Suspense for useSearchParams) ───────────────────────
export default function ContentStudioPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-20"><LottieLoader size={80} text="Loading studio…" /></div>}>
      <ContentStudioInner />
    </Suspense>
  )
}
