'use client'

/**
 * /clusters/[id] — full detail view for a single cluster.
 *
 *   • Brand (level=0): shows children sub-products + linked pages + edit form
 *   • Sub-product (level=1): shows keywords table + linked pages + parent breadcrumb
 *
 * Inline edit, add-keyword, add-page, and delete-cluster are all wired to the
 * /api/clusters/[id]/* endpoints.
 */

import { useState, useEffect, useCallback, use as usePromise } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LottieLoader } from '@/components/ui/LottieLoader'

interface ClusterDetail {
  id:             string
  topic:          string
  topic_slug:     string
  level:          number
  parent_map_id:  string | null
  source:         string
  auto_generated: boolean
  description:    string | null
  status:         string | null
  site_slug:      string
  created_at:     string
}

interface ChildNode {
  id:            string
  topic:         string
  topic_slug:    string
  source:        string
  auto_generated: boolean
  status:        string | null
  keyword_count: number
  page_count:    number
}

interface KeywordRow {
  id:             string
  keyword:        string
  search_volume:  number | null
  difficulty:     number | null
  intent:         string | null
  content_type:   string | null
  source:         string
  status:         string
  is_pillar:      boolean
}

interface PageRow {
  id:        string
  page_url:  string
  role:      'pillar' | 'spoke' | 'category'
  notes:     string | null
}

interface DetailPayload {
  cluster:  ClusterDetail
  parent:   { id: string; topic: string; topic_slug: string; level: number } | null
  children: ChildNode[]
  keywords: KeywordRow[]
  pages:    PageRow[]
}

export default function ClusterDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params)
  const router = useRouter()
  const [data, setData]       = useState<DetailPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editTopic, setEditTopic]             = useState('')
  const [editDescription, setEditDescription] = useState('')

  // New keyword form
  const [newKeyword, setNewKeyword] = useState('')
  // New page form
  const [newPageUrl, setNewPageUrl]   = useState('')
  const [newPageRole, setNewPageRole] = useState<'spoke' | 'pillar' | 'category'>('spoke')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/clusters/${id}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setData(d as DetailPayload)
      setEditTopic((d as DetailPayload).cluster.topic)
      setEditDescription((d as DetailPayload).cluster.description ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  async function saveEdit() {
    try {
      const r = await fetch(`/api/clusters/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: editTopic, description: editDescription }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setEditing(false)
      await load()
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }

  async function deleteCluster() {
    if (!confirm(`Delete cluster "${data?.cluster.topic}" and all its keywords/pages? Cascades to children too.`)) return
    try {
      const r = await fetch(`/api/clusters/${id}`, { method: 'DELETE' })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error ?? `HTTP ${r.status}`)
      }
      router.push('/clusters')
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }

  async function addKeyword() {
    if (!newKeyword.trim()) return
    try {
      const r = await fetch(`/api/clusters/${id}/keywords`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: newKeyword.trim() }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setNewKeyword('')
      await load()
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }

  async function removeKeyword(keyword: string) {
    if (!confirm(`Remove "${keyword}" from this cluster?`)) return
    try {
      const r = await fetch(`/api/clusters/${id}/keywords?keyword=${encodeURIComponent(keyword)}`, { method: 'DELETE' })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error ?? `HTTP ${r.status}`)
      }
      await load()
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }

  async function addPage() {
    if (!newPageUrl.trim()) return
    try {
      const r = await fetch(`/api/clusters/${id}/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_url: newPageUrl.trim(), role: newPageRole }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setNewPageUrl('')
      await load()
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }

  async function removePage(pageUrl: string) {
    if (!confirm(`Remove "${pageUrl}" from this cluster?`)) return
    try {
      const r = await fetch(`/api/clusters/${id}/pages?page_url=${encodeURIComponent(pageUrl)}`, { method: 'DELETE' })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error ?? `HTTP ${r.status}`)
      }
      await load()
    } catch (e) { alert(e instanceof Error ? e.message : String(e)) }
  }

  if (loading) return <div className="flex justify-center py-24"><LottieLoader /></div>
  if (error || !data) return (
    <div className="p-8">
      <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-200">
        {error ?? 'Cluster not found'}
      </div>
      <Link href="/clusters" className="text-gray-400 hover:text-white text-sm mt-4 inline-block">← Back to clusters</Link>
    </div>
  )

  const { cluster, parent, children, keywords, pages } = data
  const isBrand = cluster.level === 0

  return (
    <div className="p-8 max-w-5xl">
      <header className="mb-6">
        <nav className="text-xs text-gray-500 mb-2">
          <Link href="/clusters" className="hover:text-white">Clusters</Link>
          {parent && (
            <>
              <span className="mx-2">/</span>
              <Link href={`/clusters/${parent.id}`} className="hover:text-white">{parent.topic}</Link>
            </>
          )}
          <span className="mx-2">/</span>
          <span className="text-gray-300">{cluster.topic}</span>
        </nav>

        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="flex-1">
            {editing ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={editTopic}
                  onChange={e => setEditTopic(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-xl font-bold focus:outline-none focus:border-purple-500"
                />
                <textarea
                  value={editDescription}
                  onChange={e => setEditDescription(e.target.value)}
                  rows={2}
                  placeholder="Optional description"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500"
                />
                <div className="flex gap-2">
                  <button onClick={saveEdit} className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm">Save</button>
                  <button onClick={() => { setEditing(false); setEditTopic(cluster.topic); setEditDescription(cluster.description ?? '') }}
                          className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <h1 className="text-2xl font-bold text-white flex items-center gap-3 flex-wrap">
                  <span>{isBrand ? '🏷️' : '📦'} {cluster.topic}</span>
                  <span className="text-xs text-gray-500 font-normal">level {cluster.level} · {cluster.source}{cluster.auto_generated ? ' · auto' : ''}</span>
                </h1>
                {cluster.description && (
                  <p className="text-gray-400 text-sm mt-1">{cluster.description}</p>
                )}
              </>
            )}
          </div>
          {!editing && (
            <div className="flex items-center gap-2">
              <button onClick={() => setEditing(true)}
                      className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm border border-gray-700">
                Edit
              </button>
              <button onClick={deleteCluster}
                      className="px-3 py-1.5 rounded-lg bg-red-900/30 hover:bg-red-900/50 text-red-300 text-sm border border-red-800">
                Delete
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Brand view: list children */}
      {isBrand && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-3">
            Sub-products ({children.length})
          </h2>
          {children.length === 0 ? (
            <p className="text-gray-500 text-sm italic">No sub-products yet. Add one or run a recluster from the main page.</p>
          ) : (
            <div className="space-y-1">
              {children.map(c => (
                <Link key={c.id} href={`/clusters/${c.id}`}
                      className="flex items-center gap-3 px-4 py-3 bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-lg transition group">
                  <span className="text-gray-200 group-hover:text-purple-300 transition flex-1">{c.topic}</span>
                  <span className="text-xs text-gray-500">{c.source}</span>
                  <span className="text-xs text-gray-500">{c.keyword_count} kw</span>
                  <span className="text-xs text-gray-500">{c.page_count} pg</span>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Sub-product view: keywords table */}
      {!isBrand && (
        <section className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
              Keywords ({keywords.length})
            </h2>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="p-3 border-b border-gray-800 bg-gray-950">
              <div className="flex gap-2">
                <input type="text" value={newKeyword} onChange={e => setNewKeyword(e.target.value)}
                       onKeyDown={e => { if (e.key === 'Enter') void addKeyword() }}
                       placeholder="Add keyword…"
                       className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-purple-500" />
                <button onClick={addKeyword} disabled={!newKeyword.trim()}
                        className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 text-white text-sm">
                  Add
                </button>
              </div>
            </div>
            {keywords.length === 0 ? (
              <p className="text-gray-500 text-sm italic px-4 py-6">No keywords yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-950 border-b border-gray-800">
                  <tr className="text-gray-500 text-xs uppercase">
                    <th className="text-left px-4 py-2 font-medium">Keyword</th>
                    <th className="text-right px-4 py-2 font-medium">SV</th>
                    <th className="text-right px-4 py-2 font-medium">KD</th>
                    <th className="text-left px-4 py-2 font-medium">Intent</th>
                    <th className="text-left px-4 py-2 font-medium">Source</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {keywords.map(k => (
                    <tr key={k.id} className="border-b border-gray-900 hover:bg-gray-950">
                      <td className="px-4 py-2 text-white">
                        {k.is_pillar && <span className="text-purple-400 mr-1">★</span>}
                        {k.keyword}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-300">{k.search_volume?.toLocaleString() ?? '—'}</td>
                      <td className="px-4 py-2 text-right text-gray-300">{k.difficulty ?? '—'}</td>
                      <td className="px-4 py-2 text-gray-400">{k.intent ?? '—'}</td>
                      <td className="px-4 py-2 text-gray-500 text-xs">{k.source}</td>
                      <td className="px-4 py-2 text-right">
                        <button onClick={() => removeKeyword(k.keyword)}
                                className="text-gray-600 hover:text-red-400 text-xs">×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {/* Pages section — both brand and sub-product */}
      <section>
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-3">
          Linked pages ({pages.length})
        </h2>
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="p-3 border-b border-gray-800 bg-gray-950 flex gap-2">
            <input type="text" value={newPageUrl} onChange={e => setNewPageUrl(e.target.value)}
                   placeholder="https://… or /path"
                   onKeyDown={e => { if (e.key === 'Enter') void addPage() }}
                   className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-purple-500" />
            <select value={newPageRole} onChange={e => setNewPageRole(e.target.value as 'spoke' | 'pillar' | 'category')}
                    className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-purple-500">
              <option value="spoke">spoke</option>
              <option value="pillar">pillar</option>
              <option value="category">category</option>
            </select>
            <button onClick={addPage} disabled={!newPageUrl.trim()}
                    className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 text-white text-sm">
              Link page
            </button>
          </div>
          {pages.length === 0 ? (
            <p className="text-gray-500 text-sm italic px-4 py-6">No pages linked yet.</p>
          ) : (
            <ul className="divide-y divide-gray-900">
              {pages.map(p => (
                <li key={p.id} className="px-4 py-2 flex items-center gap-3">
                  <span className="text-[10px] uppercase tracking-wider text-gray-500 w-16">{p.role}</span>
                  <a href={p.page_url.startsWith('http') ? p.page_url : `https://${p.page_url}`}
                     target="_blank" rel="noopener noreferrer"
                     className="flex-1 text-sm text-gray-200 hover:text-purple-300 truncate">
                    {p.page_url}
                  </a>
                  {p.notes && <span className="text-xs text-gray-500 italic truncate max-w-xs">{p.notes}</span>}
                  <button onClick={() => removePage(p.page_url)}
                          className="text-gray-600 hover:text-red-400 text-xs">×</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
