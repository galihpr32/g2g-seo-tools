'use client'

import { useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────
interface AnalysisResult {
  url:             string
  title:           string
  metaDescription: string
  metaKeywords:    string
  canonical:       string
  robots:          string
  ogTitle:         string
  ogImage:         string
  h1s:             string[]
  h2s:             string[]
  h3s:             string[]
  wordCount:       number
  topKeywords:     { word: string; count: number }[]
  links: {
    internalCount:  number
    externalCount:  number
    internalSample: string[]
    externalSample: string[]
  }
  images: {
    total:      number
    withAlt:    number
    withoutAlt: number
  }
  scores: {
    hasTitle:      boolean
    titleLength:   number
    hasMetaDesc:   boolean
    metaDescLength: number
    hasH1:         boolean
    hasCanonical:  boolean
    robotsIndexed: boolean
    hasStructuredData?: boolean
    hasHreflang?:       boolean
    ogComplete?:        boolean
  }
  // ── Phase D: FireCrawl-derived enrichments ──────────────────────────────────
  structuredData?: { count: number; types: string[]; raw: string[] }
  hreflang?:       { count: number; languages: string[] }
  ogCompleteness?: {
    has_title: boolean; has_description: boolean; has_image: boolean
    has_url:   boolean; has_type: boolean
  }
  analyzed_with?: 'firecrawl' | 'fallback'
  firecrawl_content_word_count?: number | null
}

// ── Score badge ───────────────────────────────────────────────────────────────
function CheckItem({ pass, label, note }: { pass: boolean; label: string; note?: string }) {
  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded-lg text-sm ${
      pass ? 'bg-green-500/10 border border-green-500/20' : 'bg-red-500/10 border border-red-500/20'
    }`}>
      <span className={pass ? 'text-green-400' : 'text-red-400'}>{pass ? '✓' : '✗'}</span>
      <div>
        <span className={pass ? 'text-green-300' : 'text-red-300'}>{label}</span>
        {note && <span className="text-gray-500 ml-2 text-xs">{note}</span>}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function PageAnalyzerPage() {
  const [url,     setUrl]     = useState('')
  const [loading, setLoading] = useState(false)
  const [result,  setResult]  = useState<AnalysisResult | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'headings' | 'keywords' | 'links'>('overview')

  async function analyze() {
    if (!url.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res  = await fetch('/api/competitive/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setResult(json)
      setActiveTab('overview')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const titleStatus = result
    ? result.scores.titleLength === 0 ? 'missing'
      : result.scores.titleLength < 30 ? 'too short'
      : result.scores.titleLength > 60 ? 'too long'
      : 'good'
    : null

  const descStatus = result
    ? result.scores.metaDescLength === 0 ? 'missing'
      : result.scores.metaDescLength < 50 ? 'too short'
      : result.scores.metaDescLength > 160 ? 'too long'
      : 'good'
    : null

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">🔎 Page Analyzer</h1>
        <p className="text-gray-400 text-sm mt-1">
          Analyze any URL — title, meta, heading structure, keyword density, and link signals.
        </p>
      </div>

      {/* URL input */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <div className="flex gap-3">
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && analyze()}
            placeholder="https://competitor.com/their-page"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
          />
          <button
            onClick={analyze}
            disabled={loading || !url.trim()}
            className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition whitespace-nowrap"
          >
            {loading ? '⏳ Analyzing…' : '🔎 Analyze'}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-2">
          Fetches the page from our server and extracts on-page SEO signals. Works on publicly accessible URLs.
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-red-400 text-sm">
          ⚠️ {error}
        </div>
      )}

      {result && (
        <>
          {/* SEO Score summary */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white font-semibold">SEO Signal Check</h2>
              <a href={result.url} target="_blank" rel="noopener noreferrer"
                className="text-xs text-blue-400 hover:text-blue-300 truncate max-w-xs">
                {result.url}
              </a>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <CheckItem
                pass={result.scores.hasTitle && titleStatus === 'good'}
                label="Title tag"
                note={result.scores.titleLength > 0 ? `${result.scores.titleLength} chars · ${titleStatus}` : 'missing'}
              />
              <CheckItem
                pass={result.scores.hasMetaDesc && descStatus === 'good'}
                label="Meta description"
                note={result.scores.metaDescLength > 0 ? `${result.scores.metaDescLength} chars · ${descStatus}` : 'missing'}
              />
              <CheckItem
                pass={result.scores.hasH1}
                label="H1 heading"
                note={result.h1s.length > 1 ? `${result.h1s.length} H1s (should be 1)` : `${result.h1s.length} found`}
              />
              <CheckItem pass={result.scores.hasCanonical} label="Canonical tag" />
              <CheckItem
                pass={result.scores.robotsIndexed}
                label="Indexable"
                note={result.robots}
              />
              <CheckItem
                pass={result.images.withoutAlt === 0}
                label="Image alt text"
                note={`${result.images.withAlt}/${result.images.total} images have alt`}
              />
            </div>
          </div>

          {/* Tabs */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl">
            <div className="flex border-b border-gray-800">
              {(['overview', 'headings', 'keywords', 'links'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-5 py-3 text-sm font-medium capitalize transition ${
                    activeTab === tab ? 'text-white border-b-2 border-red-500' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  {tab === 'overview' ? '📋 Overview' : tab === 'headings' ? '📝 Headings' : tab === 'keywords' ? '🔑 Keywords' : '🔗 Links'}
                </button>
              ))}
            </div>

            <div className="p-5">
              {activeTab === 'overview' && (
                <div className="space-y-4">
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Title</p>
                    <p className="text-white">{result.title || <span className="text-gray-600 italic">Missing</span>}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Meta Description</p>
                    <p className="text-gray-300 text-sm">{result.metaDescription || <span className="text-gray-600 italic">Missing</span>}</p>
                  </div>
                  {result.ogTitle && (
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">OG Title</p>
                      <p className="text-gray-300 text-sm">{result.ogTitle}</p>
                    </div>
                  )}
                  {result.metaKeywords && (
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Meta Keywords</p>
                      <p className="text-gray-300 text-sm">{result.metaKeywords}</p>
                    </div>
                  )}
                  {result.canonical && (
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Canonical</p>
                      <a href={result.canonical} target="_blank" rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 text-sm">{result.canonical}</a>
                    </div>
                  )}
                  <div className="flex gap-6 pt-2 border-t border-gray-800">
                    <div>
                      <p className="text-xs text-gray-500">Word Count {result.analyzed_with === 'firecrawl' && <span className="text-purple-400 text-[10px]">(content-only)</span>}</p>
                      <p className="text-white font-semibold text-lg">{result.wordCount.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Internal Links</p>
                      <p className="text-white font-semibold text-lg">{result.links.internalCount}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">External Links</p>
                      <p className="text-white font-semibold text-lg">{result.links.externalCount}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Images</p>
                      <p className="text-white font-semibold text-lg">{result.images.total}</p>
                    </div>
                  </div>

                  {/* ── Phase D: Advanced SEO signals (FireCrawl + raw HTML scan) ─ */}
                  {(result.structuredData || result.hreflang || result.ogCompleteness) && (
                    <div className="pt-4 mt-2 border-t border-gray-800 space-y-3">
                      <p className="text-xs text-gray-500 uppercase tracking-wider">Advanced signals</p>

                      {/* Structured data (Schema.org) */}
                      {result.structuredData && (
                        <div className="flex items-start gap-3 bg-gray-800/40 border border-gray-800 rounded-lg p-3">
                          <span className={result.structuredData.count > 0 ? 'text-emerald-400' : 'text-gray-600'}>
                            {result.structuredData.count > 0 ? '✓' : '○'}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white">
                              Structured Data (JSON-LD) ·{' '}
                              <span className={result.structuredData.count > 0 ? 'text-emerald-400' : 'text-gray-500'}>
                                {result.structuredData.count} block{result.structuredData.count !== 1 ? 's' : ''}
                              </span>
                            </p>
                            {result.structuredData.types.length > 0 && (
                              <p className="text-[11px] text-gray-400 mt-0.5">
                                Schema types: {result.structuredData.types.slice(0, 8).join(', ')}
                                {result.structuredData.types.length > 8 && ` +${result.structuredData.types.length - 8}`}
                              </p>
                            )}
                            {result.structuredData.count === 0 && (
                              <p className="text-[11px] text-gray-500 mt-0.5">No JSON-LD found — missing rich snippets opportunity.</p>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Hreflang */}
                      {result.hreflang && (
                        <div className="flex items-start gap-3 bg-gray-800/40 border border-gray-800 rounded-lg p-3">
                          <span className={result.hreflang.count > 0 ? 'text-emerald-400' : 'text-gray-600'}>
                            {result.hreflang.count > 0 ? '✓' : '○'}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white">
                              Hreflang (international SEO) ·{' '}
                              <span className={result.hreflang.count > 0 ? 'text-emerald-400' : 'text-gray-500'}>
                                {result.hreflang.count} language{result.hreflang.count !== 1 ? 's' : ''}
                              </span>
                            </p>
                            {result.hreflang.languages.length > 0 && (
                              <p className="text-[11px] text-gray-400 mt-0.5">
                                {result.hreflang.languages.slice(0, 12).join(', ')}
                              </p>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Open Graph completeness */}
                      {result.ogCompleteness && (
                        <div className="flex items-start gap-3 bg-gray-800/40 border border-gray-800 rounded-lg p-3">
                          <span className={result.scores.ogComplete ? 'text-emerald-400' : 'text-amber-400'}>
                            {result.scores.ogComplete ? '✓' : '⚠'}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white">Open Graph (social sharing)</p>
                            <p className="text-[11px] text-gray-400 mt-0.5">
                              {(['title', 'description', 'image', 'url', 'type'] as const).map(k => (
                                <span key={k} className={`mr-2 ${result.ogCompleteness![`has_${k}` as keyof typeof result.ogCompleteness] ? 'text-emerald-400' : 'text-gray-600'}`}>
                                  {result.ogCompleteness![`has_${k}` as keyof typeof result.ogCompleteness] ? '✓' : '✗'} {k}
                                </span>
                              ))}
                            </p>
                          </div>
                        </div>
                      )}

                      {/* Tech meta */}
                      {result.analyzed_with && (
                        <p className="text-[10px] text-gray-600 italic pt-1">
                          Analyzed with: {result.analyzed_with === 'firecrawl' ? '🔥 FireCrawl (clean content extraction)' : 'Raw HTML fallback'}
                          {result.firecrawl_content_word_count && result.analyzed_with === 'firecrawl' && (
                            <span> · main content {result.firecrawl_content_word_count.toLocaleString()} words</span>
                          )}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'headings' && (
                <div className="space-y-4">
                  {result.h1s.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">H1 ({result.h1s.length})</p>
                      <div className="space-y-1">
                        {result.h1s.map((h, i) => (
                          <p key={i} className="text-white text-sm border-l-2 border-red-500 pl-3">{h}</p>
                        ))}
                      </div>
                    </div>
                  )}
                  {result.h2s.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">H2 ({result.h2s.length})</p>
                      <div className="space-y-1">
                        {result.h2s.map((h, i) => (
                          <p key={i} className="text-gray-300 text-sm border-l-2 border-orange-500/50 pl-3">{h}</p>
                        ))}
                      </div>
                    </div>
                  )}
                  {result.h3s.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">H3 ({result.h3s.length})</p>
                      <div className="space-y-1">
                        {result.h3s.map((h, i) => (
                          <p key={i} className="text-gray-400 text-sm border-l-2 border-gray-600 pl-3">{h}</p>
                        ))}
                      </div>
                    </div>
                  )}
                  {result.h1s.length === 0 && result.h2s.length === 0 && result.h3s.length === 0 && (
                    <p className="text-gray-500 text-sm">No headings found.</p>
                  )}
                </div>
              )}

              {activeTab === 'keywords' && (
                <div>
                  <p className="text-xs text-gray-500 mb-3">Top 20 most-used words on the page (stop words removed)</p>
                  <div className="space-y-2">
                    {result.topKeywords.map(kw => {
                      const maxCount = result.topKeywords[0]?.count ?? 1
                      const pct      = Math.round((kw.count / maxCount) * 100)
                      return (
                        <div key={kw.word} className="flex items-center gap-3">
                          <span className="text-xs text-gray-300 w-36 truncate font-medium">{kw.word}</span>
                          <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div className="h-full bg-red-600/70 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-gray-500 w-14 text-right">
                            {kw.count}× ({pct}%)
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {activeTab === 'links' && (
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                      Internal Links ({result.links.internalCount})
                    </p>
                    {result.links.internalSample.length > 0 ? (
                      <div className="space-y-1">
                        {result.links.internalSample.map((link, i) => {
                          let path = link
                          try { path = new URL(link).pathname } catch { /* keep */ }
                          return (
                            <a key={i} href={link} target="_blank" rel="noopener noreferrer"
                              className="text-xs text-blue-400 hover:text-blue-300 block truncate">
                              {path}
                            </a>
                          )
                        })}
                        {result.links.internalCount > 10 && (
                          <p className="text-xs text-gray-600 mt-1">
                            +{result.links.internalCount - 10} more not shown
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-gray-500 text-sm">No internal links found.</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                      External Links ({result.links.externalCount})
                    </p>
                    {result.links.externalSample.length > 0 ? (
                      <div className="space-y-1">
                        {result.links.externalSample.map((link, i) => {
                          let domain = link
                          try { domain = new URL(link).hostname } catch { /* keep */ }
                          return (
                            <a key={i} href={link} target="_blank" rel="noopener noreferrer"
                              className="text-xs text-blue-400 hover:text-blue-300 block truncate">
                              {domain}
                            </a>
                          )
                        })}
                        {result.links.externalCount > 10 && (
                          <p className="text-xs text-gray-600 mt-1">
                            +{result.links.externalCount - 10} more not shown
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-gray-500 text-sm">No external links found.</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {!result && !loading && !error && (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">🔎</p>
          <p className="text-white font-semibold mb-1">Enter a URL to analyze</p>
          <p className="text-gray-400 text-sm">
            Extract title, meta, heading structure, keyword density, and link signals from any page.
          </p>
        </div>
      )}
    </div>
  )
}
