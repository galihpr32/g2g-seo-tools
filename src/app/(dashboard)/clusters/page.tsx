'use client'

/**
 * /clusters — Saga's authoritative brand → sub-product hierarchy.
 *
 * Replaces the flat keyword_maps view with a 2-level tree. Each brand row
 * expands to reveal its sub-products. Each sub-product carries:
 *   - keyword_count + page_count
 *   - source badge (saga / tracked_product / manual)
 *   - links to /clusters/[id] for full keyword + page management
 *
 * Top toolbar:
 *   [Recluster site]  [+ New brand]
 *
 * "Recluster site" calls /api/saga/recluster which kicks off the Sonnet
 * builder for the current site. UI shows a progress shimmer while the
 * call is in flight (typically 2-5 min). On success, the tree refetches.
 */

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'
import { LottieLoader } from '@/components/ui/LottieLoader'

interface ClusterNode {
  id:             string
  topic:          string
  topic_slug:     string
  level:          number
  parent_map_id:  string | null
  source:         string
  auto_generated: boolean
  description:    string | null
  status:         string | null
  created_at:     string
  updated_at:     string | null
  keyword_count:  number
  page_count:     number
  children:       ClusterNode[]
}

interface ReclusterResult {
  brandsCreated:        number
  brandsExisting:       number
  subProductsCreated:   number
  subProductsExisting:  number
  keywordsLinked:       number
  keywordsSkipped:      number
  pagesLinked:          number
  classifyCalls:        number
  totalKeywordsLooked:  number
  warnings:             string[]
}

const SOURCE_BADGES: Record<string, { label: string; color: string }> = {
  saga:            { label: 'saga',            color: 'bg-purple-900/40 text-purple-300 border-purple-700' },
  tracked_product: { label: 'tracked-product', color: 'bg-blue-900/40   text-blue-300   border-blue-700'   },
  manual:          { label: 'manual',          color: 'bg-gray-800     text-gray-300   border-gray-600'   },
  keyword_gap:     { label: 'keyword-gap',     color: 'bg-amber-900/40 text-amber-300 border-amber-700'   },
}

function SourceBadge({ source }: { source: string }) {
  const cfg = SOURCE_BADGES[source] ?? { label: source, color: 'bg-gray-800 text-gray-300 border-gray-600' }
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border ${cfg.color}`}>
      {cfg.label}
    </span>
  )
}

export default function ClustersPage() {
  const siteSlug = useSiteSlug()
  const [brands, setBrands]  = useState<ClusterNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [reclustering, setReclustering] = useState(false)
  const [reclusterResult, setReclusterResult] = useState<ReclusterResult | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState<{ level: 0 | 1; parent_id?: string } | null>(null)
  const [newTopic, setNewTopic] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/clusters?site=${encodeURIComponent(siteSlug)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setBrands((d.brands ?? []) as ClusterNode[])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [siteSlug])

  useEffect(() => { void load() }, [load])

  async function recluster() {
    if (!confirm(`Re-cluster the entire ${siteSlug.toUpperCase()} keyword universe? This costs ~$0.05 in Sonnet calls and takes 2-5 minutes.`)) return
    setReclustering(true); setReclusterResult(null); setError(null)
    try {
      const r = await fetch('/api/saga/recluster', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ site: siteSlug }),
      })
      const d = await r.json()
      if (!r.ok || !d.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setReclusterResult(d.result as ReclusterResult)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setReclustering(false)
    }
  }

  async function createCluster() {
    if (!newTopic.trim() || !creating) return
    try {
      const r = await fetch('/api/clusters', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          topic:         newTopic.trim(),
          level:         creating.level,
          parent_map_id: creating.parent_id,
          site:          siteSlug,
        }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setCreating(null); setNewTopic('')
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const totalBrands     = brands.length
  const totalSubs       = brands.reduce((s, b) => s + b.children.length, 0)
  const totalKeywords   = brands.reduce((s, b) => s + b.keyword_count, 0)
  const totalPages      = brands.reduce((s, b) => s + b.page_count, 0)

  return (
    <div className="p-8 max-w-6xl">
      <header className="mb-6 flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">📚 Clusters</h1>
          <p className="text-gray-400 text-sm mt-1">
            Brand → sub-product hierarchy. Saga rebuilds this monthly using Sonnet to classify keywords from tracked products, GSC, keyword-gap, and existing universe data.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={recluster}
            disabled={reclustering}
            className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium transition"
          >
            {reclustering ? 'Reclustering…' : '🔄 Recluster site'}
          </button>
          <button
            onClick={() => { setCreating({ level: 0 }); setNewTopic('') }}
            className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium border border-gray-700 transition"
          >
            + New brand
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4 bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-200 text-sm">
          {error}
        </div>
      )}

      {reclusterResult && (
        <div className="mb-4 bg-purple-900/20 border border-purple-700 rounded-lg p-4 text-sm">
          <p className="text-purple-200 font-semibold mb-1">Recluster complete</p>
          <p className="text-gray-300">
            Looked at {reclusterResult.totalKeywordsLooked} keywords ·
            {' '}created {reclusterResult.brandsCreated} brand{reclusterResult.brandsCreated !== 1 ? 's' : ''} +
            {' '}{reclusterResult.subProductsCreated} sub-product{reclusterResult.subProductsCreated !== 1 ? 's' : ''} ·
            {' '}linked {reclusterResult.keywordsLinked} keywords ·
            {' '}{reclusterResult.pagesLinked} page link{reclusterResult.pagesLinked !== 1 ? 's' : ''} ·
            {' '}{reclusterResult.classifyCalls} Sonnet call{reclusterResult.classifyCalls !== 1 ? 's' : ''}
            {reclusterResult.keywordsSkipped > 0 && ` · skipped ${reclusterResult.keywordsSkipped}`}
          </p>
          {reclusterResult.warnings.length > 0 && (
            <p className="text-amber-300 text-xs mt-2">
              ⚠ {reclusterResult.warnings.length} warning(s): {reclusterResult.warnings[0]}
              {reclusterResult.warnings.length > 1 && ` (+${reclusterResult.warnings.length - 1} more)`}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-gray-500 text-xs mb-1">Brands</p>
          <p className="text-2xl font-bold text-white">{totalBrands}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-gray-500 text-xs mb-1">Sub-products</p>
          <p className="text-2xl font-bold text-white">{totalSubs}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-gray-500 text-xs mb-1">Keywords</p>
          <p className="text-2xl font-bold text-white">{totalKeywords}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <p className="text-gray-500 text-xs mb-1">Linked pages</p>
          <p className="text-2xl font-bold text-white">{totalPages}</p>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><LottieLoader /></div>
      ) : brands.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-gray-400 text-sm mb-4">No clusters yet. Run an initial recluster to seed from your tracked products + GSC data.</p>
          <button
            onClick={recluster}
            disabled={reclustering}
            className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 text-white text-sm font-medium"
          >
            {reclustering ? 'Reclustering…' : '🔄 Run first recluster'}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {brands.map(brand => (
            <div key={brand.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div
                onClick={() => toggle(brand.id)}
                className="p-4 flex items-center gap-3 cursor-pointer hover:bg-gray-850 transition"
              >
                <span className="text-gray-500 text-sm w-4">{expanded.has(brand.id) ? '▼' : '▶'}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/clusters/${brand.id}`}
                      onClick={e => e.stopPropagation()}
                      className="text-white font-semibold hover:text-purple-300 transition truncate"
                    >
                      {brand.topic}
                    </Link>
                    <SourceBadge source={brand.source} />
                    {brand.auto_generated && (
                      <span className="text-[10px] text-gray-500 italic">auto</span>
                    )}
                  </div>
                  {brand.description && (
                    <p className="text-gray-500 text-xs mt-0.5 truncate">{brand.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-400">
                  <span>{brand.children.length} sub</span>
                  <span>{brand.keyword_count} kw</span>
                  <span>{brand.page_count} pg</span>
                </div>
              </div>

              {expanded.has(brand.id) && (
                <div className="border-t border-gray-800 bg-gray-950 p-3">
                  {brand.children.length === 0 ? (
                    <p className="text-gray-500 text-xs italic px-2 py-3">No sub-products yet.</p>
                  ) : (
                    <div className="space-y-1">
                      {brand.children.map(sub => (
                        <Link
                          key={sub.id}
                          href={`/clusters/${sub.id}`}
                          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-900 transition group"
                        >
                          <span className="text-gray-700 text-xs">└</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-gray-200 group-hover:text-purple-300 transition text-sm">{sub.topic}</span>
                              <SourceBadge source={sub.source} />
                            </div>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-gray-500">
                            <span>{sub.keyword_count} kw</span>
                            <span>{sub.page_count} pg</span>
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-2 px-3">
                    <button
                      onClick={() => { setCreating({ level: 1, parent_id: brand.id }); setNewTopic('') }}
                      className="text-xs text-gray-500 hover:text-purple-300 transition"
                    >
                      + Add sub-product
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {creating && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setCreating(null)}>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-semibold mb-3">
              {creating.level === 0 ? 'New brand cluster' : 'New sub-product cluster'}
            </h3>
            <input
              type="text"
              autoFocus
              value={newTopic}
              onChange={e => setNewTopic(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void createCluster() }}
              placeholder={creating.level === 0 ? 'e.g. World of Warcraft' : 'e.g. WoW Gold'}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setCreating(null)}
                className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={createCluster}
                disabled={!newTopic.trim()}
                className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 text-white text-sm"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
