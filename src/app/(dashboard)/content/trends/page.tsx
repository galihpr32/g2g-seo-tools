'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { LottieLoader } from '@/components/ui/LottieLoader'

// ── Types ─────────────────────────────────────────────────────────────────────
interface GameTrend {
  steam_appid:       number
  name:              string
  developer:         string
  genre:             string
  players_2weeks:    number
  players_forever:   number
  avg_playtime_2w:   number
  search_volume:     number
  buy_search_volume: number
  search_trend:      { date: string; value: number }[] | null
  g2g_recommended:   boolean
  g2g_position:      number | null
  image_url:         string
  price:             number
}

interface KeywordSuggestion {
  keyword:            string
  search_volume:      number | null
  cpc:                number | null
  keyword_difficulty: number | null
}

interface TrendPoint { date: string; values: Record<string, number> }

interface GameDetail {
  game:         string
  keywords:     KeywordSuggestion[]
  buyKeywords:  KeywordSuggestion[]
  gameKeywords: KeywordSuggestion[]
  trends:       TrendPoint[]
}

// ── Mini sparkline ────────────────────────────────────────────────────────────
function Sparkline({ data, color = '#ef4444' }: { data: number[]; color?: string }) {
  if (!data.length) return <span className="text-gray-700 text-xs">—</span>
  const max = Math.max(...data, 1)
  const w = 60, h = 20
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - (v / max) * h
    return `${x},${y}`
  }).join(' ')
  return (
    <svg width={w} height={h} className="flex-shrink-0">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

// ── Game Card ─────────────────────────────────────────────────────────────────
function GameCard({ game, onSelect, onCreateContent }: {
  game: GameTrend
  onSelect: (g: GameTrend) => void
  onCreateContent: (g: GameTrend) => void
}) {
  const sparkData = game.search_trend?.map(p => p.value) ?? []

  return (
    <div
      onClick={() => onSelect(game)}
      className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden hover:border-gray-600 transition cursor-pointer group"
    >
      {/* Game banner */}
      <div className="relative h-28 bg-gray-800 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={game.image_url}
          alt={game.name}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-gray-900/80 to-transparent" />
        {/* Badges */}
        <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
          {game.g2g_recommended && (
            <span className="text-[10px] bg-green-500/90 text-white font-bold px-2 py-0.5 rounded-full">
              ⭐ G2G Sells
            </span>
          )}
          {game.price === 0 && (
            <span className="text-[10px] bg-blue-500/80 text-white px-2 py-0.5 rounded-full">Free</span>
          )}
        </div>
      </div>

      {/* Info */}
      <div className="p-3">
        <p className="text-white text-xs font-semibold truncate mb-0.5">{game.name}</p>
        <p className="text-gray-500 text-[10px] truncate mb-2">{game.developer}</p>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1 mb-3">
          {/* Steam players */}
          <div>
            <p className="text-[10px] text-gray-600">Steam 2wk</p>
            <p className="text-xs font-semibold text-white">
              {game.players_2weeks > 0 ? `${(game.players_2weeks / 1000).toFixed(0)}K` : '—'}
            </p>
          </div>
          {/* Search volume */}
          <div>
            <p className="text-[10px] text-gray-600">Search vol</p>
            <p className="text-xs font-semibold text-white">
              {game.search_volume > 0 ? game.search_volume.toLocaleString() : '—'}
            </p>
          </div>
          {/* Buy keyword volume */}
          <div>
            <p className="text-[10px] text-gray-600">Buy vol</p>
            <p className="text-xs font-semibold text-orange-300">
              {game.buy_search_volume > 0 ? game.buy_search_volume.toLocaleString() : '—'}
            </p>
          </div>
          {/* Trend sparkline */}
          <div className="flex flex-col">
            <p className="text-[10px] text-gray-600 mb-0.5">30d trend</p>
            <Sparkline data={sparkData} color={game.g2g_recommended ? '#22c55e' : '#ef4444'} />
          </div>
        </div>

        {/* CTA */}
        <button
          onClick={e => { e.stopPropagation(); onCreateContent(game) }}
          className="w-full text-xs bg-red-700/80 hover:bg-red-600 text-white font-semibold py-1.5 rounded-lg transition flex items-center justify-center gap-1.5"
        >
          ✍️ Create Content
        </button>
      </div>
    </div>
  )
}

// ── Detail Panel ──────────────────────────────────────────────────────────────
function DetailPanel({ game, onClose, onCreateContent }: {
  game: GameTrend
  onClose: () => void
  onCreateContent: (game: GameTrend, keyword?: string) => void
}) {
  const [detail, setDetail]     = useState<GameDetail | null>(null)
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    setDetail(null); setLoading(true)
    fetch(`/api/trends/game-keywords?game=${encodeURIComponent(game.name)}`)
      .then(r => r.json())
      .then(d => setDetail(d))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [game.name])

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-gray-950 border-l border-gray-800 flex flex-col h-full overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="p-5 border-b border-gray-800 flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={game.image_url} alt={game.name}
            className="w-20 h-12 object-cover rounded-lg flex-shrink-0 bg-gray-800"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <h2 className="text-white font-bold text-base">{game.name}</h2>
              {game.g2g_recommended && (
                <span className="text-[10px] bg-green-500/20 text-green-400 border border-green-500/30 px-2 py-0.5 rounded-full font-semibold">
                  ⭐ G2G Sells
                </span>
              )}
            </div>
            <p className="text-gray-500 text-xs">{game.developer} · {game.genre || 'Game'}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg transition flex-shrink-0">✕</button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 p-4 border-b border-gray-800">
          <div className="bg-gray-900 rounded-lg p-3 text-center">
            <p className="text-white font-bold text-lg">
              {game.players_2weeks > 0 ? `${(game.players_2weeks / 1000).toFixed(0)}K` : '—'}
            </p>
            <p className="text-gray-500 text-[10px]">Steam players 2wk</p>
          </div>
          <div className="bg-gray-900 rounded-lg p-3 text-center">
            <p className="text-white font-bold text-lg">
              {game.search_volume > 0 ? game.search_volume.toLocaleString() : '—'}
            </p>
            <p className="text-gray-500 text-[10px]">Monthly searches</p>
          </div>
          <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-3 text-center">
            <p className="text-orange-400 font-bold text-lg">
              {game.buy_search_volume > 0 ? game.buy_search_volume.toLocaleString() : '—'}
            </p>
            <p className="text-gray-500 text-[10px]">"{game.name} buy"</p>
          </div>
        </div>

        {/* Create content CTA */}
        <div className="p-4 border-b border-gray-800">
          <button
            onClick={() => onCreateContent(game)}
            className="w-full bg-red-700 hover:bg-red-600 text-white text-sm font-semibold py-2.5 rounded-lg transition flex items-center justify-center gap-2"
          >
            ✍️ Create Content for {game.name} →
          </button>
        </div>

        {/* Keywords */}
        <div className="p-4 flex-1">
          {loading ? (
            <div className="flex justify-center py-8">
              <LottieLoader size={60} text="Loading keywords…" />
            </div>
          ) : detail ? (
            <>
              {/* Buy-intent keywords */}
              {detail.buyKeywords.length > 0 && (
                <div className="mb-5">
                  <h3 className="text-white font-semibold text-xs uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <span className="text-orange-400">🛒</span> Buy-intent keywords
                  </h3>
                  <div className="space-y-1">
                    {detail.buyKeywords.slice(0, 10).map(kw => (
                      <div key={kw.keyword}
                        className="flex items-center justify-between bg-gray-900 rounded-lg px-3 py-2 hover:bg-gray-800 transition group">
                        <span className="text-xs text-white">{kw.keyword}</span>
                        <div className="flex items-center gap-3">
                          {kw.search_volume != null && (
                            <span className="text-xs text-gray-400">{kw.search_volume.toLocaleString()}</span>
                          )}
                          <button
                            onClick={() => onCreateContent(game, kw.keyword)}
                            className="text-[10px] text-red-400 hover:text-red-300 opacity-0 group-hover:opacity-100 transition"
                          >
                            Create →
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Info/game keywords */}
              {detail.gameKeywords.length > 0 && (
                <div>
                  <h3 className="text-white font-semibold text-xs uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <span className="text-blue-400">💡</span> Informational keywords
                  </h3>
                  <div className="space-y-1">
                    {detail.gameKeywords.slice(0, 10).map(kw => (
                      <div key={kw.keyword}
                        className="flex items-center justify-between bg-gray-900 rounded-lg px-3 py-2 hover:bg-gray-800 transition group">
                        <span className="text-xs text-white">{kw.keyword}</span>
                        <div className="flex items-center gap-3">
                          {kw.search_volume != null && (
                            <span className="text-xs text-gray-400">{kw.search_volume.toLocaleString()}</span>
                          )}
                          <button
                            onClick={() => onCreateContent(game, kw.keyword)}
                            className="text-[10px] text-red-400 hover:text-red-300 opacity-0 group-hover:opacity-100 transition"
                          >
                            Create →
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-gray-500 text-sm text-center py-8">Could not load keyword data.</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function GameTrendsPage() {
  const router = useRouter()
  const [games,      setGames]      = useState<GameTrend[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)
  const [source,     setSource]     = useState<'cache' | 'fresh' | null>(null)
  const [selected,   setSelected]   = useState<GameTrend | null>(null)
  const [search,     setSearch]     = useState('')
  const [filter,     setFilter]     = useState<'all' | 'recommended' | 'free'>('all')
  const [sortBy,     setSortBy]     = useState<'players' | 'search' | 'buy'>('players')

  useEffect(() => { fetchGames() }, [])

  async function fetchGames(refresh = false) {
    setLoading(true); setError(null)
    try {
      const res  = await fetch(`/api/trends/games${refresh ? '?refresh=true' : ''}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setGames(json.games ?? [])
      setSource(json.source)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  function handleCreateContent(game: GameTrend, keyword?: string) {
    const params = new URLSearchParams({
      source:  'trend',
      game:    game.name,
      appid:   String(game.steam_appid),
      vol:     String(game.search_volume),
      ...(keyword ? { keyword } : {}),
    })
    router.push(`/content/studio?${params}`)
  }

  const filtered = useMemo(() => {
    let list = games
    if (search.trim()) list = list.filter(g => g.name.toLowerCase().includes(search.trim().toLowerCase()))
    if (filter === 'recommended') list = list.filter(g => g.g2g_recommended)
    if (filter === 'free') list = list.filter(g => g.price === 0)
    return [...list].sort((a, b) => {
      if (sortBy === 'players') return (b.players_2weeks ?? 0) - (a.players_2weeks ?? 0)
      if (sortBy === 'search')  return (b.search_volume ?? 0) - (a.search_volume ?? 0)
      if (sortBy === 'buy')     return (b.buy_search_volume ?? 0) - (a.buy_search_volume ?? 0)
      return 0
    })
  }, [games, search, filter, sortBy])

  const recommendedCount = games.filter(g => g.g2g_recommended).length

  return (
    <div className="p-8">
      {selected && (
        <DetailPanel
          game={selected}
          onClose={() => setSelected(null)}
          onCreateContent={(game, kw) => { setSelected(null); handleCreateContent(game, kw) }}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">🎮 Game Trends</h1>
          <p className="text-gray-400 text-sm mt-1">
            Trending games from Steam + search interest · Find content opportunities for G2G
          </p>
        </div>
        <div className="flex items-center gap-3">
          {source && (
            <span className="text-xs text-gray-600">
              {source === 'cache' ? '📦 Cached data' : '🔄 Just refreshed'}
            </span>
          )}
          <button
            onClick={() => fetchGames(true)}
            disabled={loading}
            className="text-xs px-4 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition disabled:opacity-40"
          >
            🔄 Refresh
          </button>
          <button
            onClick={() => router.push('/content/studio')}
            className="text-xs bg-red-700 hover:bg-red-600 text-white font-semibold px-4 py-2 rounded-lg transition"
          >
            ✍️ Content Studio
          </button>
        </div>
      </div>

      {/* Stats row */}
      {!loading && games.length > 0 && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-white">{games.length}</p>
            <p className="text-xs text-gray-500 mt-1">Trending games</p>
          </div>
          <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-green-400">{recommendedCount}</p>
            <p className="text-xs text-gray-500 mt-1">G2G sells</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-white">
              {(games.reduce((s, g) => s + g.search_volume, 0) / 1000).toFixed(0)}K
            </p>
            <p className="text-xs text-gray-500 mt-1">Total search vol</p>
          </div>
          <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-orange-400">
              {(games.reduce((s, g) => s + g.buy_search_volume, 0) / 1000).toFixed(0)}K
            </p>
            <p className="text-xs text-gray-500 mt-1">Total buy intent vol</p>
          </div>
        </div>
      )}

      {/* Filters */}
      {!loading && games.length > 0 && (
        <div className="flex items-center gap-3 mb-5 flex-wrap">
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search game…"
            className="flex-1 min-w-[180px] max-w-xs bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
          />
          {/* Filter pills */}
          <div className="flex rounded-lg overflow-hidden border border-gray-700">
            {(['all', 'recommended', 'free'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`text-xs px-3 py-2 capitalize transition ${filter === f ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
                {f === 'all' ? 'All' : f === 'recommended' ? '⭐ G2G Sells' : '🆓 Free'}
              </button>
            ))}
          </div>
          {/* Sort */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Sort:</span>
            <div className="flex rounded-lg overflow-hidden border border-gray-700">
              {([
                { key: 'players', label: '🎮 Players' },
                { key: 'search',  label: '🔍 Search' },
                { key: 'buy',     label: '🛒 Buy intent' },
              ] as const).map(s => (
                <button key={s.key} onClick={() => setSortBy(s.key)}
                  className={`text-xs px-3 py-2 transition ${sortBy === s.key ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <span className="text-xs text-gray-500 ml-auto">{filtered.length} games</span>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex justify-center py-20">
          <LottieLoader size={90} text="Fetching trending games from Steam + DataForSEO…" />
        </div>
      ) : error ? (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-6 text-red-400 text-sm">⚠️ {error}</div>
      ) : filtered.length === 0 ? (
        <p className="text-gray-500 text-center py-16">No games match your filters.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-4">
          {filtered.map(game => (
            <GameCard
              key={game.steam_appid}
              game={game}
              onSelect={setSelected}
              onCreateContent={handleCreateContent}
            />
          ))}
        </div>
      )}
    </div>
  )
}
