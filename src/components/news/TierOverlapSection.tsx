'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// ─── Tier × News Overlap pinned section ────────────────────────────────────
// Renders at the top of /content/news-signals. Each row is a Tier 1/2 product
// that's been mentioned in news articles within the lookback window, with the
// matching headlines + extracted keyword chips inline.
//
// Action buttons per product:
//   🚀 Push to Bragi    — create brief opportunity tied to this product
//   🔍 Open detail      — go to /priority-products/[id] for keyword tracking
//   📝 Update brief     — when a brief already exists, jump to brief editor

interface Keyword { phrase: string; relevance: 'high' | 'medium' | 'low' }

interface OverlapProduct {
  tier_id:         string
  tier:            number
  product_name:    string
  category:        string | null
  relation_id:     string | null
  url:             string | null
  latest_brief_id: string | null
  article_count:   number
  top_keywords:    Keyword[]
  news_types:      string[]
  latest_articles: Array<{
    id:           string
    title:        string
    url:          string
    source_name:  string | null
    published_at: string | null
    news_type:    string | null
    importance:   number
  }>
}

export default function TierOverlapSection({ days = 14, onPushed }: { days?: number; onPushed?: () => void }) {
  const [products, setProducts] = useState<OverlapProduct[]>([])
  const [loading,  setLoading]  = useState(true)
  const [pushingId, setPushingId] = useState<string | null>(null)
  const [error,    setError]    = useState<string | null>(null)
  const [pushedSet, setPushedSet] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const res  = await fetch(`/api/news/tier-overlap?days=${days}`)
        const data = await res.json() as { products?: OverlapProduct[] }
        if (!cancelled) setProducts(data.products ?? [])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [days])

  async function pushToBragi(p: OverlapProduct) {
    if (pushingId) return
    setPushingId(p.tier_id)
    try {
      // Reuse the existing /api/news/push endpoint
      const res = await fetch('/api/news/push', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          game_name:           p.product_name,
          topic_slug:          p.product_name.toLowerCase().replace(/\s+/g, '-'),
          suggested_brief_type: 'optimize_existing',
          source:              'tier_news_overlap',
        }),
      })
      if (res.ok) {
        setPushedSet(prev => new Set(prev).add(p.tier_id))
        onPushed?.()
      } else {
        const data = await res.json().catch(() => ({}))
        alert(`Push failed: ${data.error ?? res.status}`)
      }
    } catch (e) {
      alert(`Push error: ${e instanceof Error ? e.message : String(e)}`)
    }
    setPushingId(null)
  }

  if (loading) return null   // silently skip — main page shows its own loader
  if (error)   return null
  if (products.length === 0) return null

  return (
    <section className="mb-6 rounded-xl border border-amber-700/30 bg-gradient-to-br from-amber-500/5 to-transparent p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            🎯 Tier × News Overlap
            <span className="text-[10px] font-normal text-amber-300 px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10">
              {products.length} priority {products.length === 1 ? 'product' : 'products'}
            </span>
          </h2>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Tier 1/2 products mentioned in news this week. Act on these first — they&apos;re both high-traffic and currently trending.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {products.map(p => {
          const isPushed = pushedSet.has(p.tier_id)
          return (
            <div
              key={p.tier_id}
              className={`rounded-lg border p-3 ${
                p.tier === 1
                  ? 'border-amber-500/40 bg-amber-500/5'
                  : 'border-blue-500/30 bg-blue-500/5'
              }`}
            >
              {/* Header */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      p.tier === 1 ? 'bg-amber-600 text-white' : 'bg-blue-600 text-white'
                    }`}>
                      T{p.tier}
                    </span>
                    <h3 className="text-sm font-semibold text-white truncate">{p.product_name}</h3>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {p.category ?? 'Uncategorized'}
                    {p.news_types.length > 0 && <> · {p.news_types.join(' / ')}</>}
                    {' · '}
                    <span className="text-amber-300">{p.article_count} article{p.article_count !== 1 ? 's' : ''}</span>
                  </p>
                </div>
              </div>

              {/* Keyword chips */}
              {p.top_keywords.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {p.top_keywords.map((k, i) => (
                    <span
                      key={i}
                      title={`Relevance: ${k.relevance}`}
                      className={`text-[10px] px-1.5 py-0.5 rounded border ${
                        k.relevance === 'high'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : k.relevance === 'medium'
                          ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                          : 'border-gray-700 bg-gray-800/40 text-gray-400'
                      }`}
                    >
                      {k.relevance === 'high' ? '🟢' : k.relevance === 'medium' ? '🟡' : ''} {k.phrase}
                    </span>
                  ))}
                </div>
              )}

              {/* Top 3 article titles inline */}
              <ul className="space-y-0.5 mb-3">
                {p.latest_articles.slice(0, 3).map(a => (
                  <li key={a.id} className="text-[11px] truncate">
                    <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-gray-300 hover:text-blue-300 transition">
                      • {a.title}
                    </a>
                    <span className="text-gray-600 ml-1">— {a.source_name ?? '?'}</span>
                  </li>
                ))}
                {p.latest_articles.length > 3 && (
                  <li className="text-[10px] text-gray-500">+{p.latest_articles.length - 3} more article(s)</li>
                )}
              </ul>

              {/* Action buttons */}
              <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-white/5">
                {p.tier_id && (
                  <Link
                    href={`/priority-products/${p.tier_id}`}
                    className="text-[10px] px-2 py-1 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 transition"
                  >
                    🔍 Open detail
                  </Link>
                )}
                {p.latest_brief_id ? (
                  <Link
                    href={`/content/briefs/${p.latest_brief_id}`}
                    className="text-[10px] px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white transition"
                  >
                    📝 Update brief
                  </Link>
                ) : null}
                {isPushed ? (
                  <span className="text-[10px] px-2 py-1 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                    ✓ Pushed to Bragi
                  </span>
                ) : (
                  <button
                    onClick={() => pushToBragi(p)}
                    disabled={pushingId === p.tier_id}
                    className="text-[10px] px-2 py-1 rounded-md bg-purple-600 hover:bg-purple-500 text-white transition disabled:opacity-50"
                  >
                    {pushingId === p.tier_id ? '⏳ …' : '🚀 Push to Bragi'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
