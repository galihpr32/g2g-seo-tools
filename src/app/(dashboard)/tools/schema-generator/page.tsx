'use client'

/**
 * /tools/schema-generator
 *
 * Sprint: SKILL.SCHEMA.1
 * Skill:  searchfit-seo:schema-markup
 *
 * One-shot schema generation tool. Enter a URL, optionally hint the page type,
 * and get back valid JSON-LD schema markup ready to copy and test.
 *
 * No DB storage — on-demand generation only.
 * Kill switch: SKILL_SCHEMA_GEN_ENABLED (API returns 503 when false).
 */

import { useState, useCallback } from 'react'
import type { SchemaGeneratorResponse, SchemaItem } from '@/app/api/tools/schema-generator/route'

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_TYPES = [
  { value: '',                   label: 'Auto-detect' },
  { value: 'Product',            label: 'Product / Game listing' },
  { value: 'FAQPage',            label: 'FAQ page' },
  { value: 'Article',            label: 'Article / Blog post' },
  { value: 'HowTo',              label: 'How-To / Tutorial' },
  { value: 'BreadcrumbList',     label: 'Breadcrumb' },
  { value: 'Organization',       label: 'Organization / Homepage' },
  { value: 'ItemList',           label: 'Category listing' },
  { value: 'SoftwareApplication', label: 'SaaS / App' },
]

// Schema type → colour palette for the tab strip
const TYPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  Product:              { bg: 'bg-violet-900/40',  text: 'text-violet-300',  border: 'border-violet-600/50'  },
  FAQPage:              { bg: 'bg-sky-900/40',      text: 'text-sky-300',     border: 'border-sky-600/50'     },
  Article:              { bg: 'bg-emerald-900/40',  text: 'text-emerald-300', border: 'border-emerald-600/50' },
  BlogPosting:          { bg: 'bg-emerald-900/40',  text: 'text-emerald-300', border: 'border-emerald-600/50' },
  HowTo:                { bg: 'bg-amber-900/40',    text: 'text-amber-300',   border: 'border-amber-600/50'   },
  BreadcrumbList:       { bg: 'bg-gray-800',        text: 'text-gray-300',    border: 'border-gray-600/50'    },
  Organization:         { bg: 'bg-indigo-900/40',   text: 'text-indigo-300',  border: 'border-indigo-600/50'  },
  ItemList:             { bg: 'bg-teal-900/40',     text: 'text-teal-300',    border: 'border-teal-600/50'    },
  WebPage:              { bg: 'bg-gray-800',        text: 'text-gray-300',    border: 'border-gray-600/50'    },
  SoftwareApplication:  { bg: 'bg-pink-900/40',     text: 'text-pink-300',    border: 'border-pink-600/50'    },
  VideoObject:          { bg: 'bg-red-900/40',      text: 'text-red-300',     border: 'border-red-600/50'     },
  Review:               { bg: 'bg-orange-900/40',   text: 'text-orange-300',  border: 'border-orange-600/50'  },
  Service:              { bg: 'bg-cyan-900/40',     text: 'text-cyan-300',    border: 'border-cyan-600/50'    },
}
const DEFAULT_COLOR = { bg: 'bg-gray-800', text: 'text-gray-300', border: 'border-gray-600/50' }

// ── Sub-components ─────────────────────────────────────────────────────────────

function SchemaCard({ schema, richResultsUrl }: { schema: SchemaItem; richResultsUrl: string }) {
  const [copied, setCopied] = useState(false)
  const col   = TYPE_COLORS[schema.type] ?? DEFAULT_COLOR
  const jsonStr = JSON.stringify(schema.json_ld, null, 2)
  const scriptTag = `<script type="application/ld+json">\n${jsonStr}\n</script>`

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(scriptTag)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard permission denied */
    }
  }

  return (
    <div className={`rounded-xl border ${col.border} overflow-hidden`}>
      {/* Card header */}
      <div className={`${col.bg} px-4 py-3 flex items-center justify-between gap-3`}>
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-xs font-bold uppercase tracking-wider ${col.text} flex-shrink-0`}>
            {schema.type}
          </span>
          {schema.description && (
            <span className="text-xs text-gray-400 truncate hidden sm:block">
              — {schema.description}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <a
            href={richResultsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-indigo-400 hover:text-indigo-300 transition whitespace-nowrap"
          >
            Test ↗
          </a>
          <button
            onClick={handleCopy}
            className={`text-xs px-3 py-1 rounded-md border transition whitespace-nowrap ${
              copied
                ? 'bg-emerald-800/50 border-emerald-600/50 text-emerald-300'
                : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-white'
            }`}
          >
            {copied ? '✓ Copied' : 'Copy <script>'}
          </button>
        </div>
      </div>

      {/* JSON-LD code block */}
      <div className="bg-gray-950 overflow-auto max-h-[500px]">
        <pre className="text-xs text-gray-300 p-4 leading-relaxed font-mono whitespace-pre">
          {`<script type="application/ld+json">\n${jsonStr}\n</script>`}
        </pre>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SchemaGeneratorPage() {
  const [url,       setUrl]       = useState('')
  const [pageType,  setPageType]  = useState('')
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [disabled,  setDisabled]  = useState(false)
  const [result,    setResult]    = useState<SchemaGeneratorResponse | null>(null)
  const [activeTab, setActiveTab] = useState(0)

  const richResultsUrl = result
    ? `https://search.google.com/test/rich-results?url=${encodeURIComponent(result.url)}`
    : ''

  const handleGenerate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) return

    setLoading(true)
    setError(null)
    setResult(null)
    setActiveTab(0)

    try {
      const res = await fetch('/api/tools/schema-generator', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: trimmed, page_type: pageType || undefined }),
      })

      const data = await res.json() as SchemaGeneratorResponse | { ok: false; error?: string; disabled?: boolean }

      if (!data.ok) {
        if ('disabled' in data && data.disabled) {
          setDisabled(true)
          setError('Schema Generator is currently disabled. Enable it via SKILL_SCHEMA_GEN_ENABLED.')
        } else {
          setError(('error' in data ? data.error : null) ?? 'Generation failed')
        }
        return
      }

      setResult(data as SchemaGeneratorResponse)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [url, pageType])

  if (disabled) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <p className="text-gray-500 text-sm">Schema Generator is currently disabled by your administrator.</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <span>🧬</span> Schema Generator
        </h1>
        <p className="text-gray-400 text-sm mt-1">
          Generate valid JSON-LD structured data for any URL. Powered by the{' '}
          <span className="text-indigo-400 font-mono text-xs">searchfit-seo:schema-markup</span> skill.
        </p>
      </div>

      {/* Input form */}
      <form onSubmit={handleGenerate} className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        {/* URL input */}
        <div>
          <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
            Page URL
          </label>
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://www.g2g.com/categories/..."
            required
            disabled={loading}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition disabled:opacity-50"
          />
        </div>

        {/* Page type hint */}
        <div>
          <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
            Page Type <span className="text-gray-600 normal-case font-normal">(optional — helps if auto-detect is wrong)</span>
          </label>
          <select
            value={pageType}
            onChange={e => setPageType(e.target.value)}
            disabled={loading}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition disabled:opacity-50"
          >
            {PAGE_TYPES.map(pt => (
              <option key={pt.value} value={pt.value}>{pt.label}</option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={loading || !url.trim()}
          className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900 disabled:text-indigo-600 text-white text-sm font-semibold rounded-lg transition"
        >
          {loading ? 'Generating…' : 'Generate Schema'}
        </button>
      </form>

      {/* Loading */}
      {loading && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">Fetching page content and generating schema…</p>
          <p className="text-gray-600 text-xs">Using DataForSEO JS renderer + Claude Haiku</p>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-4">
          <p className="text-red-300 text-sm font-medium">Generation failed</p>
          <p className="text-red-400/80 text-xs mt-1">{error}</p>
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="space-y-4">

          {/* Meta bar */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
            <span>
              <span className="text-gray-400">URL:</span>{' '}
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-400 hover:text-indigo-300 transition truncate max-w-[320px] inline-block align-bottom"
              >
                {result.url}
              </a>
            </span>
            <span>
              <span className="text-gray-400">Source:</span>{' '}
              <span className="font-mono">{result.source}</span>
            </span>
            <span>
              <span className="text-gray-400">Schemas:</span>{' '}
              {result.schemas.length}
            </span>
            <a
              href={richResultsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 transition ml-auto"
            >
              🔍 Test all in Google Rich Results ↗
            </a>
          </div>

          {/* Tab strip (when 2+ schemas) */}
          {result.schemas.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setActiveTab(-1)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                  activeTab === -1
                    ? 'bg-indigo-600 border-indigo-500 text-white font-semibold'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
              >
                All schemas
              </button>
              {result.schemas.map((s, i) => {
                const col = TYPE_COLORS[s.type] ?? DEFAULT_COLOR
                return (
                  <button
                    key={i}
                    onClick={() => setActiveTab(i)}
                    className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                      activeTab === i
                        ? `${col.bg} ${col.border} ${col.text} font-semibold`
                        : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700'
                    }`}
                  >
                    {s.type}
                  </button>
                )
              })}
            </div>
          )}

          {/* Schema cards */}
          <div className="space-y-4">
            {(activeTab === -1 || result.schemas.length === 1
              ? result.schemas
              : [result.schemas[activeTab]]
            ).map((schema, i) => (
              <SchemaCard
                key={i}
                schema={schema}
                richResultsUrl={richResultsUrl}
              />
            ))}
          </div>

          {/* Attribution */}
          <p className="text-xs text-gray-600 pt-1">
            {result.attribution}
          </p>
        </div>
      )}
    </div>
  )
}
