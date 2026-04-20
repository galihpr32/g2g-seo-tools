'use client'

import { useState, useEffect, useCallback } from 'react'
import { IntentBadge, IntentFilter, type Intent } from '@/components/ui/IntentBadge'

interface Keyword {
  keyword: string
  position: number
  previousPosition: number
  positionDiff: number
  searchVolume: number
  cpc: number
  trafficPercent: number
  url: string
}

interface Overview {
  organicKeywords: number
  organicTraffic: number
}

// ── Category tag badge + picker ───────────────────────────────────────────────

const BADGE_COLORS: Record<string, string> = {
  default: 'bg-gray-700 text-gray-300 border-gray-600',
  0: 'bg-blue-900/40 text-blue-300 border-blue-700/50',
  1: 'bg-purple-900/40 text-purple-300 border-purple-700/50',
  2: 'bg-green-900/40 text-green-300 border-green-700/50',
  3: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
  4: 'bg-pink-900/40 text-pink-300 border-pink-700/50',
  5: 'bg-cyan-900/40 text-cyan-300 border-cyan-700/50',
}

function categoryColor(categories: string[], name: string) {
  const idx = categories.indexOf(name)
  return BADGE_COLORS[idx] ?? BADGE_COLORS.default
}

function TagCell({
  keyword,
  categories,
  currentTag,
  onTag,
}: {
  keyword: string
  categories: string[]
  currentTag: string | null
  onTag: (keyword: string, category: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  async function handleSelect(cat: string | null) {
    setSaving(true)
    setOpen(false)
    await onTag(keyword, cat)
    setSaving(false)
  }

  if (categories.length === 0) return null

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        className={`text-[11px] px-2 py-0.5 rounded border transition font-medium ${
          currentTag
            ? categoryColor(categories, currentTag)
            : 'text-gray-600 border-gray-800 hover:border-gray-600 hover:text-gray-400'
        } ${saving ? 'opacity-50' : ''}`}
      >
        {saving ? '…' : currentTag ?? '+ tag'}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-36">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => handleSelect(cat)}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-800 transition flex items-center gap-2 ${
                currentTag === cat ? 'text-white font-semibold' : 'text-gray-300'
              }`}
            >
              <span className={`w-2 h-2 rounded-full inline-block ${categoryColor(categories, cat).split(' ')[0]}`} />
              {cat}
              {currentTag === cat && <span className="ml-auto text-gray-500">✓</span>}
            </button>
          ))}
          {currentTag && (
            <>
              <div className="border-t border-gray-800 my-1" />
              <button
                onClick={() => handleSelect(null)}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:text-red-400 hover:bg-gray-800 transition"
              >
                ✕ Remove tag
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function KeywordRankingsPage() {
  const [keywords, setKeywords]   = useState<Keyword[]>([])
  const [overview, setOverview]   = useState<Overview | null>(null)
  const [tags, setTags]           = useState<Record<string, string>>({})
  const [categories, setCategories] = useState<string[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [filter, setFilter]       = useState<string>('all')
  const [search, setSearch]       = useState('')
  const [intents, setIntents]     = useState<Record<string, Intent>>({})
  const [intentsLoading, setIntentsLoading] = useState(false)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [kwRes, tagRes, catRes] = await Promise.all([
        fetch('/api/semrush/keywords'),
        fetch('/api/keyword-tags'),
        fetch('/api/knowledge-base'),
      ])
      if (kwRes.ok) {
        const d = await kwRes.json()
        const kws: Keyword[] = d.keywords ?? []
        setKeywords(kws)
        setOverview(d.overview ?? null)
        if (d.error) setError(d.error)

        // Fetch intents non-blocking after keywords load
        if (kws.length > 0) {
          setIntentsLoading(true)
          fetch('/api/keywords/intent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keywords: kws.map(k => k.keyword) }),
          })
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (d?.intents) setIntents(d.intents) })
            .catch(() => {})
            .finally(() => setIntentsLoading(false))
        }
      }
      if (tagRes.ok) {
        const d = await tagRes.json()
        setTags(d.tags ?? {})
      }
      if (catRes.ok) {
        const d = await catRes.json()
        const cats = (d.items ?? [])
          .filter((i: { category: string }) => i.category === 'category')
          .map((i: { name: string }) => i.name)
        setCategories(cats)
      }
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  async function handleTag(keyword: string, category: string | null) {
    if (category) {
      await fetch('/api/keyword-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, category_name: category }),
      })
      setTags(prev => ({ ...prev, [keyword]: category }))
    } else {
      await fetch('/api/keyword-tags', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword }),
      })
      setTags(prev => { const n = { ...prev }; delete n[keyword]; return n })
    }
  }

  const improved = keywords.filter(k => k.positionDiff < 0).length
  const declined = keywords.filter(k => k.positionDiff > 0).length
  const top10    = keywords.filter(k => k.position <= 10).length

  const intentFilters: Intent[] = ['I', 'N', 'C', 'T']

  const filtered = keywords.filter(kw => {
    const matchSearch = !search || kw.keyword.toLowerCase().includes(search.toLowerCase())
    const matchFilter =
      filter === 'all'                    ? true :
      filter === 'top3'                   ? kw.position <= 3 :
      filter === 'top10'                  ? kw.position <= 10 :
      filter === 'improved'               ? kw.positionDiff < 0 :
      filter === 'declined'               ? kw.positionDiff > 0 :
      intentFilters.includes(filter as Intent) ? intents[kw.keyword] === filter :
      /* category filter */                tags[kw.keyword] === filter
    return matchSearch && matchFilter
  })

  const taggedCount   = Object.keys(tags).length
  const untaggedCount = keywords.filter(k => !tags[k.keyword]).length

  return (
    <div className="p-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">🎯 Keyword Rankings</h1>
          <p className="text-gray-400 text-sm mt-1">
            Organic positions for <span className="text-white font-medium">g2g.com</span>
            {taggedCount > 0 && (
              <span className="ml-2 text-gray-500">· {taggedCount} tagged · {untaggedCount} untagged</span>
            )}
          </p>
        </div>
        <button onClick={loadAll} className="text-xs text-gray-500 hover:text-white border border-gray-700 px-3 py-1.5 rounded-lg transition">
          ↻ Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-red-400 text-sm">⚠️ {error}</div>
      )}

      {/* Domain Overview */}
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-3xl font-bold text-white">{overview.organicKeywords.toLocaleString()}</p>
            <p className="text-gray-400 text-sm mt-1">Organic keywords</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-3xl font-bold text-white">{overview.organicTraffic.toLocaleString()}</p>
            <p className="text-gray-400 text-sm mt-1">Est. traffic/mo</p>
          </div>
          <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4">
            <p className="text-3xl font-bold text-green-400">{improved}</p>
            <p className="text-gray-400 text-sm mt-1">Improved (↑)</p>
          </div>
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
            <p className="text-3xl font-bold text-red-400">{declined}</p>
            <p className="text-gray-400 text-sm mt-1">Declined (↓)</p>
          </div>
        </div>
      )}

      {/* Filters */}
      {keywords.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search keywords…"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 w-48"
          />
          {[
            { key: 'all',      label: `All (${keywords.length})` },
            { key: 'top3',     label: `Top 3 (${keywords.filter(k => k.position <= 3).length})` },
            { key: 'top10',    label: `Top 10 (${top10})` },
            { key: 'improved', label: `↑ Rising (${improved})` },
            { key: 'declined', label: `↓ Falling (${declined})` },
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                filter === f.key
                  ? 'bg-red-700 border-red-600 text-white'
                  : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
          {/* Intent filters */}
          {intentFilters.map(intent => {
            const count = keywords.filter(k => intents[k.keyword] === intent).length
            if (count === 0) return null
            return (
              <IntentFilter
                key={intent}
                intent={intent}
                active={filter === intent}
                count={count}
                onClick={() => setFilter(filter === intent ? 'all' : intent)}
              />
            )
          })}
          {/* Category filters */}
          {categories.map((cat, idx) => {
            const count = keywords.filter(k => tags[k.keyword] === cat).length
            if (count === 0) return null
            return (
              <button
                key={cat}
                onClick={() => setFilter(filter === cat ? 'all' : cat)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                  filter === cat
                    ? `${BADGE_COLORS[idx] ?? BADGE_COLORS.default} border-opacity-100`
                    : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
                }`}
              >
                {cat} ({count})
              </button>
            )
          })}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="text-center py-16 text-gray-500">Loading keyword data…</div>
      ) : filtered.length > 0 ? (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left text-gray-500 font-medium px-4 py-3">Keyword</th>
                <th className="text-center text-gray-500 font-medium px-2 py-3 w-10" title="Search Intent">Int.</th>
                {categories.length > 0 && (
                  <th className="text-left text-gray-500 font-medium px-3 py-3 w-28">Category</th>
                )}
                <th className="text-right text-gray-500 font-medium px-4 py-3">Pos.</th>
                <th className="text-right text-gray-500 font-medium px-4 py-3">Prev</th>
                <th className="text-right text-gray-500 font-medium px-4 py-3">Δ</th>
                <th className="text-right text-gray-500 font-medium px-4 py-3">Vol/mo</th>
                <th className="text-right text-gray-500 font-medium px-4 py-3">CPC</th>
                <th className="text-right text-gray-500 font-medium px-4 py-3">Traffic %</th>
                <th className="text-left text-gray-500 font-medium px-4 py-3">Landing Page</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.map((kw, i) => {
                let pathname = kw.url
                try { pathname = new URL(kw.url).pathname } catch { /* keep */ }
                const tag = tags[kw.keyword] ?? null
                return (
                  <tr key={i} className="hover:bg-gray-800/40 transition">
                    <td className="px-4 py-2.5 text-white font-medium max-w-xs">
                      <span className="block truncate" title={kw.keyword}>{kw.keyword}</span>
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      <IntentBadge
                        intent={intents[kw.keyword]}
                        loading={intentsLoading && !intents[kw.keyword]}
                      />
                    </td>
                    {categories.length > 0 && (
                      <td className="px-3 py-2.5">
                        <TagCell
                          keyword={kw.keyword}
                          categories={categories}
                          currentTag={tag}
                          onTag={handleTag}
                        />
                      </td>
                    )}
                    <td className="px-4 py-2.5 text-right">
                      <span className={`font-bold ${kw.position <= 3 ? 'text-green-400' : kw.position <= 10 ? 'text-blue-400' : kw.position <= 20 ? 'text-yellow-400' : 'text-gray-400'}`}>
                        {kw.position}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-400">{kw.previousPosition || '—'}</td>
                    <td className="px-4 py-2.5 text-right font-semibold">
                      {kw.positionDiff === 0 ? (
                        <span className="text-gray-500">—</span>
                      ) : kw.positionDiff < 0 ? (
                        <span className="text-green-400">▲{Math.abs(kw.positionDiff)}</span>
                      ) : (
                        <span className="text-red-400">▼{kw.positionDiff}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-300">{kw.searchVolume.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-right text-gray-400">${kw.cpc.toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-right text-gray-400">{kw.trafficPercent.toFixed(2)}%</td>
                    <td className="px-4 py-2.5 max-w-xs">
                      <a href={kw.url} target="_blank" rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 text-xs truncate block" title={kw.url}>
                        {pathname}
                      </a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
          <p className="text-gray-400">{keywords.length === 0 ? 'No keyword data — SEMrush API key not configured or no data.' : 'No keywords match the current filter.'}</p>
        </div>
      )}
    </div>
  )
}
