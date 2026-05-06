'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

// ── Types ────────────────────────────────────────────────────────────────────
interface NewsSource {
  id:               string
  name:             string
  rss_url:          string
  homepage_url:     string | null
  category:         string
  is_active:        boolean
  last_fetched_at:  string | null
  last_item_count:  number | null
  notes:            string | null
}

interface NewsItem {
  id:                 string
  source_name:        string | null
  url:                string
  title:              string
  excerpt:            string | null
  published_at:       string | null
  fetched_at:         string
  scraped_at:         string | null
  scraped_word_count: number | null
  extraction_status:  string
}

interface ExtractionRow {
  news_item_id:  string
  game_name:     string
  game_name_norm: string
  news_type:     string | null
  mentions_count: number
  kb_matched:    boolean
}

interface GameRollup {
  game_name:      string
  game_name_norm: string
  article_count:  number
  kb_matched:     boolean
  type_breakdown: Record<string, number>
  latest_titles:  string[]
}

interface BifrostRun {
  id:              string
  started_at:      string
  finished_at:     string | null
  status:          string
  sources_polled:  number | null
  items_new:       number | null
  items_extracted: number | null
  actions_queued:  number | null
  summary:         string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────
export default function NewsSignalsPage() {
  const [tab, setTab]                     = useState<'signals' | 'sources'>('signals')

  // Signals state
  const [items, setItems]                 = useState<NewsItem[]>([])
  const [extractions, setExtractions]     = useState<ExtractionRow[]>([])
  const [games, setGames]                 = useState<GameRollup[]>([])
  const [latestRun, setLatestRun]         = useState<BifrostRun | null>(null)
  const [loading, setLoading]             = useState(true)
  const [windowDays, setWindowDays]       = useState<7 | 14 | 30>(14)
  const [kbMatchedOnly, setKbMatchedOnly] = useState(true)

  // Push state
  const [pushingGame, setPushingGame]     = useState<string | null>(null)
  const [pushedGames, setPushedGames]     = useState<Set<string>>(new Set())
  const [pushError, setPushError]         = useState<string | null>(null)

  // Rematch state
  const [rematchLoading, setRematchLoading] = useState(false)
  const [rematchResult,  setRematchResult]  = useState<string | null>(null)

  // Deep dive state
  const [deepDiveItemId, setDeepDiveItemId] = useState<string | null>(null)
  const [deepDiveContent, setDeepDiveContent] = useState<string | null>(null)
  const [deepDiveLoading, setDeepDiveLoading] = useState(false)

  // Sources state
  const [sources, setSources]             = useState<NewsSource[]>([])
  const [showAddForm, setShowAddForm]     = useState(false)
  const [newName, setNewName]             = useState('')
  const [newRss,  setNewRss]              = useState('')
  const [newCat,  setNewCat]              = useState('general')
  const [adding, setAdding]               = useState(false)
  const [addError, setAddError]           = useState<string | null>(null)

  // ── Fetchers ─────────────────────────────────────────────────────────────
  const fetchSignals = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/news/items?days=${windowDays}&kbMatchedOnly=${kbMatchedOnly}`)
      if (!res.ok) return
      const d = await res.json()
      setItems(d.items ?? [])
      setExtractions(d.extractions ?? [])
      setGames(d.games ?? [])
      setLatestRun(d.latestRun ?? null)
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [windowDays, kbMatchedOnly])

  const fetchSources = useCallback(async () => {
    try {
      const res = await fetch('/api/news/sources')
      if (!res.ok) return
      const d = await res.json()
      setSources(d.sources ?? [])
    } catch { /* silent */ }
  }, [])

  useEffect(() => { fetchSignals() }, [fetchSignals])
  useEffect(() => { if (tab === 'sources') fetchSources() }, [tab, fetchSources])

  // ── Actions ──────────────────────────────────────────────────────────────
  async function pushToBragi(game: GameRollup) {
    setPushingGame(game.game_name_norm)
    setPushError(null)
    try {
      const dominantType = Object.entries(game.type_breakdown).sort((a, b) => b[1] - a[1])[0]?.[0]
      const res = await fetch('/api/news/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game_name:            game.game_name,
          game_name_norm:       game.game_name_norm,
          article_count:        game.article_count,
          dominant_news_type:   dominantType,
          suggested_brief_type: 'category_page',
          latest_titles:        game.latest_titles,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setPushError(data.error ?? `HTTP ${res.status}`)
        return
      }
      setPushedGames(prev => new Set(prev).add(game.game_name_norm))
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Push failed')
    } finally {
      setPushingGame(null)
    }
  }

  async function rematchKb() {
    setRematchLoading(true)
    setRematchResult(null)
    try {
      const res = await fetch('/api/news/rematch', { method: 'POST' })
      const d = await res.json() as { ok?: boolean; evaluated?: number; newly_matched?: number; kept_matched?: number; error?: string }
      if (!res.ok || !d.ok) {
        setRematchResult(`⚠️ ${d.error ?? `HTTP ${res.status}`}`)
      } else {
        setRematchResult(
          `✓ Re-matched ${d.evaluated} extractions. ${d.newly_matched} newly matched. ${d.kept_matched} already matched.`,
        )
        // Reload signals to reflect updated kb_matched flags
        fetchSignals()
      }
    } catch (err) {
      setRematchResult(`⚠️ ${err instanceof Error ? err.message : 'Rematch failed'}`)
    } finally {
      setRematchLoading(false)
    }
  }

  async function deepDive(itemId: string) {
    setDeepDiveItemId(itemId)
    setDeepDiveLoading(true)
    setDeepDiveContent(null)
    try {
      const res = await fetch('/api/news/deep-fetch', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ news_item_id: itemId }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) {
        setDeepDiveContent(`⚠️ ${d.error ?? 'Scrape failed'}`)
      } else {
        setDeepDiveContent(d.scraped_md ?? '(empty)')
      }
    } catch (err) {
      setDeepDiveContent(`⚠️ ${err instanceof Error ? err.message : 'Network error'}`)
    } finally {
      setDeepDiveLoading(false)
    }
  }

  // ── Source management ────────────────────────────────────────────────────
  async function addSource() {
    if (!newName.trim() || !newRss.trim()) {
      setAddError('Name + RSS URL required')
      return
    }
    setAdding(true); setAddError(null)
    try {
      const res = await fetch('/api/news/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, rss_url: newRss, category: newCat }),
      })
      const d = await res.json()
      if (!res.ok) { setAddError(d.error ?? `HTTP ${res.status}`); return }
      setNewName(''); setNewRss(''); setNewCat('general')
      setShowAddForm(false)
      fetchSources()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Add failed')
    } finally {
      setAdding(false)
    }
  }

  async function toggleSource(id: string, isActive: boolean) {
    await fetch(`/api/news/sources?id=${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !isActive }),
    })
    fetchSources()
  }

  async function deleteSource(id: string) {
    if (!confirm('Delete this source? All articles from it will also be removed.')) return
    await fetch(`/api/news/sources?id=${id}`, { method: 'DELETE' })
    fetchSources()
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="p-8">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">📰 Bifrost — Gaming News Signals</h1>
          <p className="text-gray-400 text-sm mt-1">
            Editorial buzz from gaming news sites. Conservative threshold: ≥3 articles in {windowDays}d + KB matched → eligible to push to Pipeline Journey.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/content/trends" className="text-xs text-gray-500 hover:text-white border border-gray-800 px-3 py-2 rounded-lg transition">
            ← Game Trends (Odin)
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="flex rounded-lg overflow-hidden border border-gray-800">
          {([
            { id: 'signals', label: '📊 News Signals' },
            { id: 'sources', label: '⚙️ Sources' },
          ] as const).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`text-xs px-4 py-2 transition ${tab === t.id ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {latestRun && tab === 'signals' && (
          <span className="text-xs text-gray-500">
            Last run: {latestRun.started_at ? new Date(latestRun.started_at).toLocaleString('id-ID') : '—'} · {latestRun.summary ?? '(no summary)'}
          </span>
        )}
      </div>

      {/* ───── Tab: Signals ───── */}
      {tab === 'signals' && (
        <>
          {/* Filters */}
          <div className="flex items-center gap-3 mb-4 flex-wrap text-xs">
            <span className="text-gray-500">Window:</span>
            {([7, 14, 30] as const).map(d => (
              <button
                key={d}
                onClick={() => setWindowDays(d)}
                className={`px-3 py-1 rounded-lg border transition ${
                  windowDays === d ? 'bg-red-500/15 border-red-500/40 text-white' : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-white hover:border-gray-600'
                }`}
              >
                {d}d
              </button>
            ))}
            <label className="flex items-center gap-1.5 cursor-pointer text-gray-400 hover:text-white ml-2">
              <input
                type="checkbox"
                checked={kbMatchedOnly}
                onChange={e => setKbMatchedOnly(e.target.checked)}
                className="w-3.5 h-3.5 accent-red-500"
              />
              KB-matched only
            </label>
            <button
              onClick={rematchKb}
              disabled={rematchLoading}
              title="Re-evaluate KB matching against existing extractions using the latest fuzzy matcher (token overlap + abbreviations). Free — does not re-run Haiku."
              className="px-3 py-1 rounded-lg border border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 transition disabled:opacity-50"
            >
              {rematchLoading ? '⏳ Re-matching…' : '🔁 Re-match KB'}
            </button>
            <span className="text-[10px] text-gray-600 ml-auto">
              ⓘ KB-matched = game name overlaps with your Knowledge Base categories. Toggles off to surface new candidates.
            </span>
          </div>
          {rematchResult && (
            <p className="text-xs text-gray-400 mb-3">{rematchResult}</p>
          )}

          {pushError && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300 mb-3">⚠️ {pushError}</div>
          )}

          {loading ? (
            <p className="text-gray-500 text-sm">Loading signals…</p>
          ) : games.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
              <p className="text-3xl mb-3">📰</p>
              <p className="text-white font-semibold mb-1">No game signals yet</p>
              <p className="text-gray-400 text-sm">
                Bifrost runs every 6 hours via GitHub Actions. First run will seed Tier 1 sources (IGN, Polygon, PC Gamer, Eurogamer, Game Rant) + extract game mentions via Haiku.
              </p>
              <p className="text-gray-500 text-xs mt-3">
                Manage sources in the <button onClick={() => setTab('sources')} className="text-blue-400 hover:text-blue-300 underline">⚙️ Sources</button> tab.
              </p>
            </div>
          ) : (
            <>
              {/* By-game rollup */}
              <h2 className="text-white font-semibold text-sm mb-3">🎯 By-game rollup ({games.length} games over last {windowDays}d)</h2>
              <div className="space-y-2 mb-8">
                {games.map(g => {
                  const dominant = Object.entries(g.type_breakdown).sort((a, b) => b[1] - a[1])[0]
                  const meetsThreshold = g.article_count >= 3 && g.kb_matched
                  const isPushed       = pushedGames.has(g.game_name_norm)
                  return (
                    <div key={g.game_name_norm} className={`bg-gray-900 border rounded-xl p-4 ${meetsThreshold ? 'border-purple-500/30' : 'border-gray-800'}`}>
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <p className="text-white font-medium text-sm">{g.game_name}</p>
                            {g.kb_matched ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">✓ KB matched</span>
                            ) : (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">new candidate</span>
                            )}
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-300 font-mono">
                              {g.article_count} article{g.article_count !== 1 ? 's' : ''}
                            </span>
                            {dominant && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/30 text-blue-300">
                                {dominant[0]} ×{dominant[1]}
                              </span>
                            )}
                          </div>
                          {g.latest_titles.length > 0 && (
                            <ul className="space-y-0.5">
                              {g.latest_titles.map((t, i) => (
                                <li key={i} className="text-xs text-gray-400 truncate">• {t}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div className="flex-shrink-0">
                          {isPushed ? (
                            <span className="text-[10px] px-3 py-1.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">✓ Pushed</span>
                          ) : (
                            <button
                              onClick={() => pushToBragi(g)}
                              disabled={pushingGame === g.game_name_norm || !meetsThreshold}
                              title={meetsThreshold ? 'Create opportunity in Pipeline Journey' : 'Need ≥3 articles + KB match before pushing'}
                              className="px-3 py-1.5 text-xs rounded-md bg-purple-600 hover:bg-purple-500 text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              {pushingGame === g.game_name_norm ? '…' : '🚀 Push to Bragi'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Articles timeline */}
              <h2 className="text-white font-semibold text-sm mb-3">📋 Article feed ({items.length})</h2>
              <div className="space-y-1">
                {items.map(it => {
                  const itemExtractions = extractions.filter(e => e.news_item_id === it.id)
                  const isOpen = deepDiveItemId === it.id
                  return (
                    <div key={it.id} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-[10px] text-gray-500 mb-1 flex-wrap">
                            <span className="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-300">{it.source_name ?? '?'}</span>
                            {it.published_at && <span>{new Date(it.published_at).toLocaleDateString('id-ID', { month: 'short', day: 'numeric' })}</span>}
                            {itemExtractions.map(e => (
                              <span key={e.game_name_norm} className={`px-1.5 py-0.5 rounded ${e.kb_matched ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-gray-800 border border-gray-700 text-gray-400'}`}>
                                {e.game_name} · {e.news_type}
                              </span>
                            ))}
                          </div>
                          <a href={it.url} target="_blank" rel="noopener noreferrer" className="text-sm text-white hover:text-blue-300 transition truncate block">
                            {it.title}
                          </a>
                          {it.excerpt && (
                            <p className="text-xs text-gray-500 mt-1 line-clamp-2">{it.excerpt}</p>
                          )}
                        </div>
                        <button
                          onClick={() => deepDive(it.id)}
                          disabled={deepDiveLoading && deepDiveItemId === it.id}
                          title="FireCrawl-scrape full article body"
                          className="text-[10px] px-2 py-1 rounded-md bg-blue-500/10 border border-blue-500/30 text-blue-300 hover:bg-blue-500/20 transition disabled:opacity-50 flex-shrink-0"
                        >
                          {deepDiveLoading && deepDiveItemId === it.id ? '⏳' : (it.scraped_at ? '🔍 View deep' : '🔬 Deep dive')}
                        </button>
                      </div>
                      {isOpen && (
                        <div className="mt-3 pt-3 border-t border-gray-800">
                          {deepDiveLoading ? (
                            <p className="text-xs text-blue-300 animate-pulse">⏳ FireCrawl scraping…</p>
                          ) : deepDiveContent ? (
                            <pre className="text-xs text-gray-300 whitespace-pre-wrap font-sans max-h-[400px] overflow-y-auto leading-relaxed">{deepDiveContent}</pre>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}

      {/* ───── Tab: Sources ───── */}
      {tab === 'sources' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm text-gray-400">
              {sources.length} source{sources.length !== 1 ? 's' : ''} configured. Tier 1 defaults are auto-seeded on first cron run.
            </p>
            <button
              onClick={() => { setShowAddForm(o => !o); setAddError(null) }}
              className="px-3 py-1.5 text-xs rounded-lg bg-red-600 hover:bg-red-700 text-white transition"
            >
              {showAddForm ? '✕ Cancel' : '+ Add RSS source'}
            </button>
          </div>

          {showAddForm && (
            <div className="bg-gray-900 border border-blue-500/30 rounded-xl p-4 space-y-3">
              {addError && (
                <p className="text-xs text-red-400">⚠️ {addError}</p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] text-gray-400 mb-1">Name</label>
                  <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. PocketGamer"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white" />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[10px] text-gray-400 mb-1">RSS feed URL</label>
                  <input value={newRss} onChange={e => setNewRss(e.target.value)} placeholder="https://example.com/feed/"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white font-mono" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <select value={newCat} onChange={e => setNewCat(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white">
                  <option value="general">general</option>
                  <option value="mobile">mobile</option>
                  <option value="esports">esports</option>
                  <option value="publisher">publisher</option>
                </select>
                <button onClick={addSource} disabled={adding || !newName.trim() || !newRss.trim()}
                  className="px-3 py-1.5 text-xs rounded-md bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white transition">
                  {adding ? '…' : '✓ Save'}
                </button>
              </div>
            </div>
          )}

          {sources.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-8 text-center">
              <p className="text-gray-400 text-sm">No sources yet — Tier 1 defaults will seed on next cron run.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {sources.map(s => (
                <div key={s.id} className={`bg-gray-900 border rounded-xl p-3 ${s.is_active ? 'border-gray-800' : 'border-gray-900 opacity-60'}`}>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <p className="text-sm font-medium text-white">{s.name}</p>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{s.category}</span>
                        {!s.is_active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-500">disabled</span>}
                      </div>
                      <p className="text-[11px] text-gray-500 font-mono truncate">{s.rss_url}</p>
                      {s.last_fetched_at && (
                        <p className="text-[10px] text-gray-600 mt-0.5">Last fetched {new Date(s.last_fetched_at).toLocaleString('id-ID')} · {s.last_item_count ?? 0} items</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button onClick={() => toggleSource(s.id, s.is_active)}
                        className="text-[10px] px-2 py-1 rounded-md bg-gray-800 border border-gray-700 text-gray-300 hover:text-white transition">
                        {s.is_active ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => deleteSource(s.id)}
                        className="text-[10px] px-2 py-1 rounded-md bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 transition">
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
