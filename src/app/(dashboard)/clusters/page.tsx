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

// Sprint CLUSTER.RENAME.3 — inline rename. Click pencil → input + save/cancel.
function InlineRenameLabel({ clusterId, topic, href, bold, onSaved }: {
  clusterId: string
  topic:     string
  href:      string
  bold:      boolean
  onSaved:   () => void
}) {
  const [editing, setEditing] = useState(false)
  const [val,     setVal]     = useState(topic)
  const [saving,  setSaving]  = useState(false)

  async function save() {
    if (!val.trim() || val.trim() === topic) { setEditing(false); return }
    setSaving(true)
    try {
      const r = await fetch(`/api/clusters/${clusterId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ topic: val.trim() }),
      })
      const d = await r.json()
      if (!r.ok) {
        alert(d.error ?? `HTTP ${r.status}`)
        setSaving(false)
        return
      }
      setEditing(false)
      onSaved()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally { setSaving(false) }
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1" onClick={e => e.stopPropagation()}>
        <input
          autoFocus
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') { setVal(topic); setEditing(false) }
          }}
          disabled={saving}
          className="bg-gray-800 border border-purple-500 rounded px-2 py-0.5 text-white text-sm min-w-[160px] focus:outline-none"
        />
        <button onClick={() => void save()} disabled={saving} className="text-emerald-400 hover:text-emerald-300 text-xs px-1">{saving ? '…' : '✓'}</button>
        <button onClick={() => { setVal(topic); setEditing(false) }} disabled={saving} className="text-gray-500 hover:text-gray-300 text-xs px-1">✕</button>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 group" onClick={e => e.stopPropagation()}>
      <Link href={href} className={`${bold ? 'text-white font-semibold' : 'text-gray-200'} hover:text-purple-300 transition truncate`}>
        {topic}
      </Link>
      <button
        onClick={() => { setVal(topic); setEditing(true) }}
        className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-purple-300 text-[10px] transition"
        title="Rename"
      >✎</button>
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
  // Sprint CLUSTER.RENAME.2 — re-seed modal state
  const [reseedOpen, setReseedOpen] = useState(false)

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
            onClick={() => setReseedOpen(true)}
            className="px-4 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-sm font-medium border border-amber-600 transition"
            title="Fix garbage cluster names from the first-word auto-seed (e.g. 'Counter' → 'CSGO')"
          >
            ✨ Re-seed names
          </button>
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

      {reseedOpen && (
        <ReseedModal siteSlug={siteSlug} onClose={() => setReseedOpen(false)} onApplied={() => { setReseedOpen(false); void load() }} />
      )}

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
                    <InlineRenameLabel
                      clusterId={brand.id}
                      topic={brand.topic}
                      href={`/clusters/${brand.id}`}
                      bold
                      onSaved={() => void load()}
                    />
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
                        <div
                          key={sub.id}
                          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-900 transition group"
                        >
                          <span className="text-gray-700 text-xs">└</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <InlineRenameLabel
                                clusterId={sub.id}
                                topic={sub.topic}
                                href={`/clusters/${sub.id}`}
                                bold={false}
                                onSaved={() => void load()}
                              />
                              <SourceBadge source={sub.source} />
                            </div>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-gray-500">
                            <span>{sub.keyword_count} kw</span>
                            <span>{sub.page_count} pg</span>
                          </div>
                        </div>
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

// Sprint CLUSTER.RENAME.2 — Re-seed modal: preview rename plan, then apply.
interface ReseedRow {
  cluster_id: string
  level:      number
  old:        string
  new:        string
  source:     'override' | 'catalog' | 'name' | 'strip-prefix'
  parent_id:  string | null
}
function ReseedModal({ siteSlug, onClose, onApplied }: {
  siteSlug: string
  onClose:  () => void
  onApplied: () => void
}) {
  const [preview, setPreview] = useState<ReseedRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError]   = useState<string | null>(null)
  const [done, setDone]     = useState<number | null>(null)

  async function loadPreview() {
    setLoading(true); setError(null); setPreview(null); setDone(null)
    try {
      const r = await fetch(`/api/clusters/re-seed?site=${encodeURIComponent(siteSlug)}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ dry_run: true }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setPreview((d.preview ?? []) as ReseedRow[])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  async function apply() {
    setApplying(true); setError(null)
    try {
      const r = await fetch(`/api/clusters/re-seed?site=${encodeURIComponent(siteSlug)}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ dry_run: false }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setDone(d.applied as number)
      setTimeout(() => onApplied(), 800)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setApplying(false) }
  }

  useEffect(() => { void loadPreview() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const lvl0 = (preview ?? []).filter(r => r.level === 0)
  const lvl1 = (preview ?? []).filter(r => r.level === 1)

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-gray-800">
          <h3 className="text-base font-semibold text-white">✨ Re-seed cluster names</h3>
          <p className="text-xs text-gray-400 mt-1">
            Fix garbage names from the first-word auto-seed (Counter → CSGO, World → World of Warcraft, etc.).
            Updates topic in-place — cluster IDs preserved, all FKs intact, old names backed up to <code className="text-violet-300">topic_original</code>.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading && <p className="text-sm text-gray-500 italic py-8 text-center">Loading preview…</p>}
          {error   && <p className="text-sm text-red-300 bg-red-900/20 border border-red-800/40 rounded p-3">{error}</p>}
          {!loading && !error && preview && preview.length === 0 && (
            <p className="text-sm text-gray-400 py-8 text-center">No clusters need rename — all good ✨</p>
          )}
          {!loading && !error && preview && preview.length > 0 && (
            <>
              <div className="text-xs text-gray-400 mb-2">
                <strong className="text-white">{preview.length}</strong> rename{preview.length === 1 ? '' : 's'} planned
                {' · '}<strong className="text-emerald-300">{lvl0.length}</strong> brand{lvl0.length === 1 ? '' : 's'}
                {' · '}<strong className="text-blue-300">{lvl1.length}</strong> sub-product{lvl1.length === 1 ? '' : 's'}
              </div>
              <table className="w-full text-xs">
                <thead className="text-[10px] text-gray-500 uppercase tracking-wider">
                  <tr>
                    <th className="text-left  px-2 py-1.5 w-16">Level</th>
                    <th className="text-left  px-2 py-1.5">Old</th>
                    <th className="text-left  px-2 py-1.5">New</th>
                    <th className="text-center px-2 py-1.5 w-24">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={`${r.cluster_id}-${i}`} className="border-t border-gray-800">
                      <td className="px-2 py-1.5 text-gray-500">
                        <span className={`text-[9px] font-semibold px-1 py-0.5 rounded border ${r.level === 0 ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-blue-500/15 text-blue-300 border-blue-500/30'}`}>
                          L{r.level}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-gray-400 line-through">{r.old}</td>
                      <td className="px-2 py-1.5 text-white font-medium">{r.new}</td>
                      <td className="px-2 py-1.5 text-center">
                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700">
                          {r.source}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-between gap-3">
          <div className="text-xs">
            {done != null && <span className="text-emerald-300">✓ Applied {done} rename{done === 1 ? '' : 's'}</span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={applying}
              className="px-4 py-1.5 text-sm text-gray-300 hover:text-white bg-gray-800 border border-gray-700 rounded-md disabled:opacity-50"
            >{done != null ? 'Close' : 'Cancel'}</button>
            {!done && preview && preview.length > 0 && (
              <button
                onClick={apply}
                disabled={applying}
                className="px-4 py-1.5 text-sm bg-amber-600 hover:bg-amber-500 text-white rounded-md font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >{applying ? 'Applying…' : `Apply ${preview.length} rename${preview.length === 1 ? '' : 's'}`}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
