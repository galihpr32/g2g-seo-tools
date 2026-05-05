'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { markdownToHtml, DEFAULT_HTML_FORMAT, type BrandHtmlFormat } from '@/lib/agents/markdown-to-html'

/**
 * FinalContentPanel
 *
 * The single-pane "writer's working surface" for an SEO brief.
 *
 *   1. Empty state    — brief has no final_content. Show "Generate Final Content" CTA.
 *   2. Generating     — assembly was just triggered; poll for completion.
 *   3. View / Edit    — markdown render with toggleable inline editor + Save.
 *   4. Translate      — dropdown of supported langs; clicking triggers /translate.
 *                        Switching active language flips the visible body.
 *
 * All API calls go through the existing endpoints — this component is pure UI.
 */

const SUPPORTED_LANGS: Array<{ code: string; label: string }> = [
  { code: 'en',  label: '🇺🇸 English (source)' },
  { code: 'id',  label: '🇮🇩 Indonesian' },
  { code: 'es',  label: '🇪🇸 Spanish' },
  { code: 'pt',  label: '🇧🇷 Portuguese' },
  { code: 'th',  label: '🇹🇭 Thai' },
  { code: 'vi',  label: '🇻🇳 Vietnamese' },
]

interface FinalContentPanelProps {
  briefId:                  string
  initialFinalContent:      string | null
  initialGeneratedAt:       string | null
  initialEditedAt:          string | null
  initialTranslations:      Record<string, string>
  initialStatus:            string
  initialTyrStatus:         string | null
  // Outreach briefs render a different "Outreach Pitch" header + don't show
  // CMS HTML modes (emails are pasted into Gmail, not a CMS). Pass the
  // brief_type so the panel can switch behaviours.
  briefType?:               string
}

export default function FinalContentPanel({
  briefId,
  initialFinalContent,
  initialGeneratedAt,
  initialEditedAt,
  initialTranslations,
  initialStatus,
  initialTyrStatus,
  briefType,
}: FinalContentPanelProps) {
  const isOutreach = briefType === 'outreach'
  const [content,        setContent]        = useState(initialFinalContent ?? '')
  const [generatedAt,    setGeneratedAt]    = useState(initialGeneratedAt)
  const [editedAt,       setEditedAt]       = useState(initialEditedAt)
  const [translations,   setTranslations]   = useState<Record<string, string>>(initialTranslations ?? {})
  const [activeLang,     setActiveLang]     = useState('en')

  const [isAssembling,   setIsAssembling]   = useState(false)
  const [isTranslating,  setIsTranslating]  = useState<string | null>(null)
  const [isEditing,      setIsEditing]      = useState(false)
  const [editDraft,      setEditDraft]      = useState('')
  const [isSaving,       setIsSaving]       = useState(false)
  const [error,          setError]          = useState<string | null>(null)
  const [toast,          setToast]          = useState<string | null>(null)

  // View mode: rendered preview, raw HTML (CMS-paste), or markdown (read-friendly)
  const [viewMode,    setViewMode]    = useState<'preview' | 'html' | 'markdown'>('preview')
  const [brandFormat, setBrandFormat] = useState<BrandHtmlFormat>(DEFAULT_HTML_FORMAT)

  const pollTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Load brand HTML format once on mount so converted HTML matches the CMS template
  useEffect(() => {
    fetch('/api/knowledge-base/brand-format')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.format) setBrandFormat(d.format) })
      .catch(() => { /* keep defaults */ })
  }, [])

  const fetchBrief = useCallback(async () => {
    try {
      const res = await fetch(`/api/content/briefs/${briefId}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as {
        brief: {
          final_content?:               string | null
          final_content_generated_at?:  string | null
          final_content_edited_at?:     string | null
          final_content_translations?:  Record<string, string> | null
        }
      }
      const b = data.brief
      if (typeof b.final_content === 'string') setContent(b.final_content)
      if (b.final_content_generated_at)        setGeneratedAt(b.final_content_generated_at)
      if (b.final_content_edited_at)           setEditedAt(b.final_content_edited_at)
      if (b.final_content_translations)        setTranslations(b.final_content_translations)
    } catch { /* silent — next poll will retry */ }
  }, [briefId])

  // ── Polling: when assembling or translating, refetch every 5s until result lands ──
  useEffect(() => {
    if (!isAssembling && !isTranslating) return
    pollTimerRef.current = setInterval(() => {
      fetchBrief().then(() => {
        if (isAssembling && content && content.length > 200) {
          setIsAssembling(false)
          setToast('✅ Final content ready!')
          setTimeout(() => setToast(null), 4000)
        }
        if (isTranslating && translations[isTranslating]) {
          setToast(`✅ Translation done (${isTranslating.toUpperCase()})`)
          setIsTranslating(null)
          setTimeout(() => setToast(null), 4000)
        }
      })
    }, 5000)
    return () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current) }
  }, [isAssembling, isTranslating, content, translations, fetchBrief])

  // ── Actions ──

  const handleAssemble = async () => {
    setError(null)
    setIsAssembling(true)
    try {
      const res = await fetch(`/api/content/briefs/${briefId}/assemble`, { method: 'POST' })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      // Polling effect picks up the result
    } catch (err) {
      setIsAssembling(false)
      setError(err instanceof Error ? err.message : 'Assembly trigger failed')
    }
  }

  const handleTranslate = async (lang: string) => {
    if (!content) { setError('No source content to translate yet'); return }
    setError(null)
    setIsTranslating(lang)
    try {
      const res = await fetch(`/api/content/briefs/${briefId}/translate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ lang }),
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setActiveLang(lang)   // flip view to the language being translated
    } catch (err) {
      setIsTranslating(null)
      setError(err instanceof Error ? err.message : 'Translate trigger failed')
    }
  }

  const startEdit = () => {
    setEditDraft(activeLang === 'en' ? content : (translations[activeLang] ?? ''))
    setIsEditing(true)
    setError(null)
  }

  const saveEdit = async () => {
    setIsSaving(true)
    setError(null)
    try {
      const body = activeLang === 'en'
        ? { final_content: editDraft }
        : { final_content_translations: { [activeLang]: editDraft } }
      const res = await fetch(`/api/content/briefs/${briefId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)

      if (activeLang === 'en') {
        setContent(editDraft)
        setEditedAt(new Date().toISOString())
      } else {
        setTranslations(t => ({ ...t, [activeLang]: editDraft }))
      }
      setIsEditing(false)
      setToast('✅ Saved')
      setTimeout(() => setToast(null), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }

  // ── Derived state ──
  const visibleBody  = activeLang === 'en' ? content : (translations[activeLang] ?? '')
  const hasContent   = !!content && content.length >= 200
  const hasTyrPassed = initialTyrStatus === 'reviewed'
  const isPublished  = initialStatus === 'published'
  const wordCount    = visibleBody.split(/\s+/).filter(Boolean).length

  // The HTML view + Preview both convert markdown → HTML using the brand template.
  // Computed lazily; cheap (<5ms for typical 1500-word articles).
  const htmlBody = visibleBody ? markdownToHtml(visibleBody, brandFormat) : ''

  const handleCopy = async (kind: 'html' | 'markdown') => {
    const text = kind === 'html' ? htmlBody : visibleBody
    try {
      await navigator.clipboard.writeText(text)
      setToast(`✅ Copied ${kind === 'html' ? 'HTML' : 'markdown'} to clipboard`)
      setTimeout(() => setToast(null), 2500)
    } catch {
      setError('Clipboard write failed — your browser may block it on non-HTTPS')
    }
  }

  // ── Render ──

  if (!hasContent && !isAssembling) {
    // Outreach briefs auto-stamp final_content during generation, so the
    // empty state here means generation hasn't run yet (or failed). Show a
    // neutral hint instead of the SEO assembly CTA.
    if (isOutreach) {
      return (
        <section className="bg-amber-900/10 border border-amber-700/30 rounded-xl p-6 mb-5">
          <h2 className="text-white font-semibold text-base mb-1">📨 Outreach Pitch</h2>
          <p className="text-amber-300 text-sm">
            No outreach pitch yet. Bragi auto-stamps the email skeleton when this brief is generated — try clicking <strong>Regenerate</strong> in the action bar.
          </p>
        </section>
      )
    }
    return (
      <section className="bg-gradient-to-br from-purple-900/20 to-indigo-900/20 border border-purple-700/30 rounded-xl p-6 mb-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-white font-semibold text-base mb-1">📝 Final Content</h2>
            <p className="text-gray-400 text-sm">
              {hasTyrPassed
                ? 'Tyr passed this brief. Click below to generate the publish-ready article body.'
                : 'Assembly is available, but Tyr hasn\'t signed off yet — make sure the brief is reviewed first for best results.'}
            </p>
          </div>
          <button
            onClick={handleAssemble}
            className="px-4 py-2 text-sm rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition disabled:opacity-50"
            disabled={isAssembling}
          >
            🚀 Generate Final Content
          </button>
        </div>
        {error && (
          <p className="text-xs text-red-400 mt-3">⚠️ {error}</p>
        )}
      </section>
    )
  }

  if (isAssembling && !hasContent) {
    return (
      <section className="bg-purple-900/10 border border-purple-700/30 rounded-xl p-6 mb-5 animate-pulse">
        <h2 className="text-white font-semibold text-base mb-1">📝 Final Content</h2>
        <p className="text-purple-300 text-sm">⏳ Bragi is assembling the full article… typically 30-60s. Page polls automatically.</p>
        <div className="mt-4 space-y-2">
          <div className="h-3 bg-purple-700/30 rounded w-3/4" />
          <div className="h-3 bg-purple-700/30 rounded w-full" />
          <div className="h-3 bg-purple-700/30 rounded w-5/6" />
          <div className="h-3 bg-purple-700/30 rounded w-2/3" />
        </div>
      </section>
    )
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5 space-y-4">
      {/* Header row: title + lang switcher + actions */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-white font-semibold text-base">
            {isOutreach ? '📨 Outreach Pitch' : '📝 Final Content'}
          </h2>
          <span className="text-xs text-gray-500 font-mono">{wordCount} words</span>
          {generatedAt && (
            <span className="text-xs text-gray-500">Assembled {new Date(generatedAt).toLocaleString('id-ID')}</span>
          )}
          {editedAt && activeLang === 'en' && (
            <span className="text-xs text-blue-400">✎ Edited {new Date(editedAt).toLocaleString('id-ID')}</span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Language switcher */}
          <select
            value={activeLang}
            onChange={e => setActiveLang(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-purple-500"
          >
            {SUPPORTED_LANGS.map(l => {
              const has = l.code === 'en' ? hasContent : !!translations[l.code]
              return (
                <option key={l.code} value={l.code} disabled={!has && l.code !== 'en'}>
                  {l.label} {has || l.code === 'en' ? '' : '(not yet)'}
                </option>
              )
            })}
          </select>

          {/* Edit / Save / Cancel */}
          {!isEditing && !isPublished && (
            <button
              onClick={startEdit}
              className="px-2.5 py-1.5 text-xs rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-300 hover:bg-blue-500/20 transition"
            >
              ✎ Edit
            </button>
          )}
          {isEditing && (
            <>
              <button
                onClick={saveEdit}
                disabled={isSaving}
                className="px-2.5 py-1.5 text-xs rounded-lg bg-green-600 hover:bg-green-500 text-white transition disabled:opacity-50"
              >
                {isSaving ? 'Saving…' : '💾 Save'}
              </button>
              <button
                onClick={() => { setIsEditing(false); setEditDraft('') }}
                className="px-2.5 py-1.5 text-xs rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition"
              >
                Cancel
              </button>
            </>
          )}

          {/* Re-assemble (SEO only — outreach has no assembly step). */}
          {!isEditing && !isOutreach && hasContent && activeLang === 'en' && !isPublished && (
            <button
              onClick={handleAssemble}
              disabled={isAssembling}
              className="px-2.5 py-1.5 text-xs rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-300 hover:bg-purple-500/20 transition disabled:opacity-50"
              title="Discard current EN body and regenerate from the structured brief"
            >
              🔄 Re-assemble
            </button>
          )}
        </div>
      </div>

      {/* Translate row */}
      {!isEditing && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-gray-500">Translate to:</span>
          {SUPPORTED_LANGS.filter(l => l.code !== 'en').map(l => {
            const hasTranslation = !!translations[l.code]
            const isThisLoading  = isTranslating === l.code
            return (
              <button
                key={l.code}
                onClick={() => handleTranslate(l.code)}
                disabled={!hasContent || isThisLoading}
                className={`px-2 py-1 rounded-md transition ${
                  hasTranslation
                    ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20'
                    : 'bg-gray-800 border border-gray-700 text-gray-400 hover:bg-gray-700'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
                title={hasTranslation ? 'Re-translate (overwrites existing)' : `Generate ${l.label} translation`}
              >
                {isThisLoading ? '⏳' : hasTranslation ? '✓' : '+'} {l.label.replace(/^.\s/, '')}
              </button>
            )
          })}
        </div>
      )}

      {/* Toast / error */}
      {toast && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 text-sm text-green-300">{toast}</div>
      )}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-sm text-red-300">⚠️ {error}</div>
      )}

      {/* View-mode toggle (only when not editing) — Preview / Markdown / HTML
          plus per-mode copy buttons. Lets writers paste straight into the CMS
          without leaving the page. */}
      {!isEditing && (
        <div className="flex items-center justify-between flex-wrap gap-2 border-b border-gray-800 pb-3">
          <div className="inline-flex rounded-lg overflow-hidden border border-gray-700 text-xs">
            {/* Outreach hides HTML mode — emails go to Gmail, not a CMS, so the
                CMS-class HTML wrappers don't apply. Markdown + Preview only. */}
            {(isOutreach
              ? (['preview', 'markdown'] as const)
              : (['preview', 'markdown', 'html'] as const)
            ).map(m => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                className={`px-3 py-1.5 transition ${
                  viewMode === m
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {m === 'preview' ? '👁 Preview' : m === 'html' ? '🧩 HTML' : '✍ Markdown'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {!isOutreach && (
              <button
                onClick={() => handleCopy('html')}
                disabled={!htmlBody}
                className="px-2.5 py-1 text-xs rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 transition disabled:opacity-40"
                title="Copy CMS-ready HTML to clipboard"
              >
                📋 Copy HTML
              </button>
            )}
            <button
              onClick={() => handleCopy('markdown')}
              disabled={!visibleBody}
              className="px-2.5 py-1 text-xs rounded-md bg-blue-500/10 border border-blue-500/30 text-blue-300 hover:bg-blue-500/20 transition disabled:opacity-40"
              title={isOutreach ? 'Copy email markdown — paste into Gmail compose' : 'Copy markdown to clipboard'}
            >
              📋 {isOutreach ? 'Copy Email' : 'Copy MD'}
            </button>
          </div>
        </div>
      )}

      {/* Body — view or edit */}
      {isEditing ? (
        <textarea
          value={editDraft}
          onChange={e => setEditDraft(e.target.value)}
          rows={Math.min(40, Math.max(12, editDraft.split('\n').length + 2))}
          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-4 py-3 text-sm text-gray-200 font-mono leading-relaxed focus:outline-none focus:border-blue-500 resize-y"
          spellCheck={false}
        />
      ) : viewMode === 'preview' ? (
        <div
          className="bg-gray-950 border border-gray-800 rounded-lg p-5 max-h-[800px] overflow-y-auto prose prose-invert max-w-none text-gray-200"
          dangerouslySetInnerHTML={{ __html: htmlBody || '<p class="text-gray-500">(empty)</p>' }}
        />
      ) : viewMode === 'html' ? (
        <pre className="bg-gray-950 border border-gray-800 rounded-lg p-5 max-h-[800px] overflow-auto text-xs text-emerald-200 font-mono leading-relaxed whitespace-pre-wrap">
          {htmlBody || '(empty)'}
        </pre>
      ) : (
        <div className="bg-gray-950 border border-gray-800 rounded-lg p-5 max-h-[800px] overflow-y-auto">
          <pre className="text-sm text-gray-200 whitespace-pre-wrap font-sans leading-relaxed">{visibleBody || '(empty)'}</pre>
        </div>
      )}
    </section>
  )
}
