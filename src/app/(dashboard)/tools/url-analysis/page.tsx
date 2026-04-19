'use client'

import { useState } from 'react'
import { SERP_COUNTRIES } from '@/lib/country-config'
import type { UrlAnalysisResponse } from '@/app/api/tools/url-analysis/route'
import { LottieLoader } from '@/components/ui/LottieLoader'

type LoadingStep = 'crawling' | 'serp' | 'keywords' | 'domain'

export default function UrlAnalysisPage() {
  const [url, setUrl] = useState('')
  const [country, setCountry] = useState('id')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<UrlAnalysisResponse | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'competitors' | 'keywords' | 'paa'>('overview')
  const [showMoreContent, setShowMoreContent] = useState(false)
  const [creatingActionItem, setCreatingActionItem] = useState(false)
  const [actionItemSuccess, setActionItemSuccess] = useState<{ type: string; id: string } | null>(null)

  const loadingSteps: LoadingStep[] = ['crawling', 'serp', 'keywords', 'domain']

  async function handleAnalyze(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim()) return

    setLoading(true)
    setError(null)
    setResult(null)
    setActionItemSuccess(null)

    try {
      const res = await fetch('/api/tools/url-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), country }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Analysis failed')
      }

      const data: UrlAnalysisResponse = await res.json()
      setResult(data)
      setActiveTab('overview')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateActionItem(actionType: 'on_page' | 'off_page') {
    if (!result) return

    setCreatingActionItem(true)
    try {
      const res = await fetch('/api/tools/url-analysis/action-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: result.url,
          action_type: actionType,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create action item')
      }

      const data = await res.json()
      setActionItemSuccess({ type: actionType, id: data.id })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create action item')
    } finally {
      setCreatingActionItem(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">🔍 URL Analysis</h1>
          <p className="text-gray-400">Analyze any page to uncover SEO opportunities, competitors, and keyword insights</p>
        </div>

        {/* Input Section */}
        <form onSubmit={handleAnalyze} className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="flex gap-3">
            <div className="flex-1 space-y-2">
              <label className="text-sm font-medium text-gray-300">URL to analyze</label>
              <input
                type="text"
                placeholder="https://example.com or example.com/blog/post"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={loading}
                className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder:text-gray-500 focus:outline-none focus:border-red-700 transition disabled:opacity-50"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-300">Country</label>
              <select
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                disabled={loading}
                className="px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-red-700 transition disabled:opacity-50"
              >
                {SERP_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.flag} {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <button
                type="submit"
                disabled={loading}
                className="px-6 py-3 bg-red-700 text-white font-medium rounded-lg hover:bg-red-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Analyzing...' : 'Analyze'}
              </button>
            </div>
          </div>
        </form>

        {/* Loading State */}
        {loading && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
            <div className="flex justify-center mb-2">
              <LottieLoader size={90} />
            </div>
            <p className="text-white font-medium mb-6">Analyzing page...</p>
            <div className="space-y-2">
              {loadingSteps.map((step) => (
                <div key={step} className="text-sm text-gray-400">
                  {step === 'crawling' && '📄 Crawling page content'}
                  {step === 'serp' && '🏆 Fetching SERP data'}
                  {step === 'keywords' && '🔑 Getting keyword suggestions'}
                  {step === 'domain' && '📊 Analyzing domain overview'}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error State */}
        {error && !loading && (
          <div className="bg-red-900/20 border border-red-700 rounded-2xl p-6">
            <p className="text-red-400 font-medium">Error: {error}</p>
          </div>
        )}

        {/* Results Section */}
        {result && !loading && (
          <div className="space-y-6">
            {/* Stats Cards */}
            <div className="grid grid-cols-4 gap-4">
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-gray-400 text-xs font-semibold uppercase mb-2">Word Count</p>
                <p className="text-2xl font-bold text-white">{result.page_data?.wordCount.toLocaleString() || '—'}</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-gray-400 text-xs font-semibold uppercase mb-2">Est. Traffic/mo</p>
                <p className="text-2xl font-bold text-white">{result.domain_overview?.organicTraffic.toLocaleString() || '—'}</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-gray-400 text-xs font-semibold uppercase mb-2">Organic Keywords</p>
                <p className="text-2xl font-bold text-white">{result.domain_overview?.organicKeywords.toLocaleString() || '—'}</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-gray-400 text-xs font-semibold uppercase mb-2">Top Keyword</p>
                <p className="text-lg font-bold text-white truncate">{result.primary_keyword}</p>
              </div>
            </div>

            {/* Tabs */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
              {/* Tab buttons */}
              <div className="flex border-b border-gray-800">
                {[
                  { id: 'overview' as const, label: '📋 Page Overview' },
                  { id: 'competitors' as const, label: '🏆 SERP Competitors' },
                  { id: 'keywords' as const, label: '🔑 Keywords' },
                  { id: 'paa' as const, label: '❓ People Also Ask' },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex-1 px-6 py-4 font-medium text-sm transition border-b-2 ${
                      activeTab === tab.id
                        ? 'text-white border-b-red-700'
                        : 'text-gray-400 border-b-transparent hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              <div className="p-6">
                {/* Page Overview */}
                {activeTab === 'overview' && (
                  result.page_data ? (
                    <div className="space-y-6">
                      <div>
                        <p className="text-xs uppercase text-gray-500 font-semibold mb-2">Title</p>
                        <p className="text-white">{result.page_data.title || '(Not found)'}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase text-gray-500 font-semibold mb-2">Meta Description</p>
                        <p className="text-gray-300">{result.page_data.description || '(Not found)'}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase text-gray-500 font-semibold mb-2">H1</p>
                        <p className="text-gray-300">{result.page_data.h1[0] || '(Not found)'}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase text-gray-500 font-semibold mb-2">H2 Headings</p>
                        {result.page_data.h2.length > 0 ? (
                          <ul className="space-y-1">
                            {result.page_data.h2.map((h, i) => (
                              <li key={i} className="text-gray-300 text-sm">• {h}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-gray-500 text-sm">(No H2 headings found)</p>
                        )}
                      </div>
                      <div>
                        <p className="text-xs uppercase text-gray-500 font-semibold mb-2">Content Preview</p>
                        <div className="bg-gray-800 rounded-lg p-4 max-h-64 overflow-y-auto">
                          <p className="text-gray-300 text-sm whitespace-pre-wrap">
                            {showMoreContent
                              ? result.page_data.contentPreview
                              : result.page_data.contentPreview.slice(0, 500)}
                          </p>
                          {result.page_data.contentPreview.length > 500 && (
                            <button
                              onClick={() => setShowMoreContent(!showMoreContent)}
                              className="mt-3 text-red-700 hover:text-red-600 text-sm font-medium transition"
                            >
                              {showMoreContent ? 'Show less' : 'Show more'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="py-6 text-center space-y-3">
                      <p className="text-4xl">🚫</p>
                      <p className="text-white font-medium">Page could not be crawled</p>
                      <p className="text-gray-400 text-sm max-w-md mx-auto">
                        Firecrawl was blocked by this page (anti-bot protection, login wall, or JS-rendered content).
                        SERP + keyword data above is still accurate — only the on-page content scan failed.
                      </p>
                      <a
                        href={result.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block mt-2 text-blue-400 hover:text-blue-300 text-sm transition"
                      >
                        Open page manually →
                      </a>
                    </div>
                  )
                )}

                {/* Competitors */}
                {activeTab === 'competitors' && (
                  <div className="space-y-3">
                    {result.serp.organicResults.length > 0 ? (
                      result.serp.organicResults.map((r) => (
                        <div key={r.url} className="bg-gray-800 rounded-lg p-4 border border-gray-700 hover:border-gray-600 transition">
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex items-center gap-3">
                              <span className="font-bold text-red-700">#{r.rank}</span>
                              <div className="min-w-0 flex-1">
                                <a
                                  href={r.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-400 hover:text-blue-300 text-sm truncate transition"
                                >
                                  {r.title}
                                </a>
                                <p className="text-xs text-gray-500 truncate">{r.url}</p>
                              </div>
                            </div>
                          </div>
                          <p className="text-gray-400 text-sm line-clamp-2">{r.description}</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-gray-400">No results found</p>
                    )}
                  </div>
                )}

                {/* Keywords */}
                {activeTab === 'keywords' && (
                  <div className="overflow-x-auto">
                    {result.keyword_suggestions.length > 0 ? (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-700">
                            <th className="text-left py-3 px-4 text-gray-400 font-semibold">Keyword</th>
                            <th className="text-right py-3 px-4 text-gray-400 font-semibold">Search Volume</th>
                            <th className="text-right py-3 px-4 text-gray-400 font-semibold">CPC</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.keyword_suggestions.map((kw) => (
                            <tr key={kw.keyword} className="border-b border-gray-800 hover:bg-gray-800/50 transition">
                              <td className="py-3 px-4 text-white">{kw.keyword}</td>
                              <td className="text-right py-3 px-4 text-gray-300">
                                {kw.search_volume ? kw.search_volume.toLocaleString() : '—'}
                              </td>
                              <td className="text-right py-3 px-4 text-gray-300">
                                {kw.cpc ? `$${kw.cpc.toFixed(2)}` : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="text-gray-400">No keyword suggestions available</p>
                    )}
                  </div>
                )}

                {/* People Also Ask */}
                {activeTab === 'paa' && (
                  <div className="space-y-4">
                    {result.serp.peopleAlsoAsk.length > 0 ? (
                      result.serp.peopleAlsoAsk.map((paa, idx) => (
                        <div key={idx} className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                          <p className="text-white font-medium mb-2">{paa.question}</p>
                          {paa.answer && <p className="text-gray-300 text-sm">{paa.answer}</p>}
                        </div>
                      ))
                    ) : (
                      <p className="text-gray-400">No People Also Ask results available</p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Action Panel */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
              {result.is_own_page ? (
                <div className="space-y-4">
                  <p className="text-white font-medium">Add to Action Items</p>
                  {result.existing_action_item_id ? (
                    <a
                      href={`/gsc/action-items/${result.existing_action_item_id}`}
                      className="block px-4 py-3 bg-green-700 text-white rounded-lg hover:bg-green-600 transition text-center font-medium"
                    >
                      ✓ Already in Action Items
                    </a>
                  ) : actionItemSuccess ? (
                    <a
                      href={`/gsc/action-items/${actionItemSuccess.id}`}
                      className="block px-4 py-3 bg-green-700 text-white rounded-lg hover:bg-green-600 transition text-center font-medium"
                    >
                      ✓ Created as {actionItemSuccess.type === 'on_page' ? 'On-Page' : 'Off-Page'} Action Item
                    </a>
                  ) : (
                    <div className="flex gap-3">
                      <button
                        onClick={() => handleCreateActionItem('on_page')}
                        disabled={creatingActionItem}
                        className="flex-1 px-4 py-3 bg-blue-700 text-white rounded-lg hover:bg-blue-600 transition font-medium disabled:opacity-50"
                      >
                        📋 Add as On-Page Action Item
                      </button>
                      <button
                        onClick={() => handleCreateActionItem('off_page')}
                        disabled={creatingActionItem}
                        className="flex-1 px-4 py-3 bg-purple-700 text-white rounded-lg hover:bg-purple-600 transition font-medium disabled:opacity-50"
                      >
                        📣 Add as Off-Page Action Item
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-gray-400">External page — analysis only. To add action items, analyze a g2g.com page.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
