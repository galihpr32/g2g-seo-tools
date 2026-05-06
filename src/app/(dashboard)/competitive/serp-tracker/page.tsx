'use client'

import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { SERP_COUNTRIES } from '@/lib/country-config'
import { LottieLoader } from '@/components/ui/LottieLoader'

const G2G_DOMAIN = 'g2g.com'

// Strip www. prefix for domain comparison (DataForSEO returns www.g2g.com)
function normalizeDomain(d: string) { return d.replace(/^www\./, '') }

// CTR curve (same as backend)
const CTR_CURVE: Record<number, number> = {
  1: 0.284, 2: 0.146, 3: 0.099, 4: 0.073, 5: 0.057,
  6: 0.045, 7: 0.036, 8: 0.030, 9: 0.025, 10: 0.022,
}

interface SerpResult   { domain: string; position: number; url: string; title: string }
interface Snapshot     { keyword: string; results: SerpResult[]; search_volume?: number; error?: string }
interface SovEntry     { sov_pct: number; keywords_in_top10: number; est_clicks: number }

interface TrackedProduct { id: string; name: string; keywords: string[]; market: string }
interface Competitor     { id: string; domain: string; name: string; active: boolean }

// ── Position badge ────────────────────────────────────────────────────────────
function PosBadge({ pos, domain }: { pos: number | null; domain: string }) {
  if (pos === null) return <span className="text-gray-700 text-xs">—</span>
  const isG2G  = normalizeDomain(domain) === G2G_DOMAIN
  const color  = pos === 1 ? 'bg-green-500/20 text-green-400' : pos <= 3 ? 'bg-green-500/10 text-green-500' :
                 pos <= 10 ? 'bg-yellow-500/10 text-yellow-400' : 'bg-gray-800 text-gray-400'
  return (
    <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg text-xs font-bold ${color} ${isG2G ? 'ring-1 ring-red-500/40' : ''}`}>
      {pos}
    </span>
  )
}

// ── SoV bar ───────────────────────────────────────────────────────────────────
function SovBar({ pct, domain }: { pct: number; domain: string }) {
  const isG2G  = normalizeDomain(domain) === G2G_DOMAIN
  const color  = isG2G ? 'bg-red-600' : 'bg-blue-600'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className={`text-xs font-semibold w-10 text-right ${isG2G ? 'text-red-400' : 'text-gray-300'}`}>
        {pct.toFixed(1)}%
      </span>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SerpTrackerPage() {
  const searchParams = useSearchParams()
  // Pre-fill keywords from `?keywords=foo,bar,baz` — used by Hermod's
  // "SERP snapshots missing" action item link, so users land here with
  // the missing keywords already in the input.
  const initialKeywords = searchParams.get('keywords') ?? ''

  const [competitors, setCompetitors]         = useState<Competitor[]>([])
  const [trackedProducts, setTrackedProducts] = useState<TrackedProduct[]>([])
  const [countryCode, setCountryCode]         = useState('us')
  const [customKeywords, setCustomKeywords]   = useState(
    // Convert comma-separated to newline-separated (the textarea expects one keyword per line)
    initialKeywords ? initialKeywords.split(',').map(k => k.trim()).filter(Boolean).join('\n') : ''
  )
  const [selectedSource, setSource]           = useState<'custom' | 'products'>('custom')
  const [selectedProductId, setProductId]     = useState('')
  const [loading, setLoading]                 = useState(false)
  const [initialLoading, setInitialLoading]   = useState(true)
  const [snapshots, setSnapshots]             = useState<Snapshot[]>([])
  const [sov, setSov]                         = useState<Record<string, SovEntry>>({})
  const [lastDate, setLastDate]               = useState('')
  const [error, setError]                     = useState<string | null>(null)
  const [expandedKw, setExpandedKw]           = useState<string | null>(null)
  // Honor `?tab=history` query param so deep links from monthly/weekly
  // reports land directly on the history view.
  const initialTab = searchParams.get('tab') === 'history' ? 'history' : 'sov'
  const [activeView, setActiveView]           = useState<'sov' | 'serp' | 'history'>(initialTab)

  // ── History tab state ─────────────────────────────────────────────────────
  interface HistoryDay {
    snapshot_date:  string
    keyword_count:  number
    total_sv:       number
    top_domains:    Array<{ domain: string; sov_pct: number; keywords_in_top10: number }>
    keywords:       Array<{ keyword: string; search_volume: number | null }>
  }
  const [historyDays,  setHistoryDays]  = useState<HistoryDay[]>([])
  const [historyTotal, setHistoryTotal] = useState({ runs: 0, dates: 0, keywords: 0 })
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyDays_window, setHistoryDays_window] = useState<30 | 90 | 180 | 365>(90)
  const [expandedDate, setExpandedDate] = useState<string | null>(null)

  // ── SERP-recommend state ─────────────────────────────────────────────────
  // ContentIdea shape mirrors the server response from /api/competitive/serp-recommend
  interface ContentIdea {
    id:                   string
    type:                 'title_pattern' | 'content_depth' | 'new_keyword' | 'quick_win'
    title:                string
    body:                 string
    target_keyword:       string
    target_url:           string | null
    suggested_brief_type: 'optimize_existing' | 'new_page' | 'category_page' | 'blog_post'
    evidence:             string
  }
  // Map: snapshot_date → {recommendation_id, ideas, diagnostics, pushedIds}
  const [recBySnapDate, setRecBySnapDate] = useState<Record<string, {
    id:           string
    ideas:        ContentIdea[]
    diagnostics?: { keywords_analysed: number; urls_scraped: number; cache_hits: number; cache_misses: number; cost_usd: number; remaining_today: number }
    pushedIds:    Set<string>
  } | null>>({})
  const [recLoadingDate, setRecLoadingDate] = useState<string | null>(null)
  const [recError,       setRecError]       = useState<string | null>(null)
  const [pushingIdeaId,  setPushingIdeaId]  = useState<string | null>(null)
  const [pushSuccessIds, setPushSuccessIds] = useState<Set<string>>(new Set())

  async function fetchOrGenerateIdeas(snapshotDate: string) {
    setRecError(null)
    setRecLoadingDate(snapshotDate)
    try {
      // Try existing run first (free) — also defensively parse to avoid
      // SyntaxError when the response is plain-text (e.g. Vercel timeout).
      const existingRes = await fetch(`/api/competitive/serp-recommend?date=${snapshotDate}`)
      const existingRaw = existingRes.ok ? await existingRes.text() : ''
      let existing: { runs?: Array<{ id: string; ideas: ContentIdea[]; pushed_links: Array<{ idea_id: string }> }> } = {}
      if (existingRaw) { try { existing = JSON.parse(existingRaw) } catch { /* ignore */ } }
      if (existing.runs && existing.runs.length > 0) {
        const latest = existing.runs[0]
        setRecBySnapDate(prev => ({
          ...prev,
          [snapshotDate]: {
            id:        latest.id,
            ideas:     latest.ideas ?? [],
            pushedIds: new Set((latest.pushed_links ?? []).map(p => p.idea_id)),
          },
        }))
        return
      }

      // Generate fresh — costs Sonnet + FireCrawl
      const res = await fetch('/api/competitive/serp-recommend', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ snapshot_date: snapshotDate }),
      })
      const raw = await res.text()
      let data: {
        ok?: boolean; id?: string; ideas?: ContentIdea[]
        diagnostics?: { keywords_analysed: number; urls_scraped: number; cache_hits: number; cache_misses: number; cost_usd: number; remaining_today: number }
        error?: string
      } = {}
      try { data = raw ? JSON.parse(raw) : {} }
      catch {
        if (res.status === 504 || res.status === 502 || /^An error/i.test(raw)) {
          setRecError(
            'Server timed out (Vercel 60s) generating ideas. Retry in a moment — Sonnet calls can be slow when FireCrawl scrapes are uncached.',
          )
        } else {
          setRecError(`Server returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`)
        }
        return
      }
      if (!res.ok || !data.ok) {
        setRecError(data.error ?? `HTTP ${res.status}`)
        return
      }
      setRecBySnapDate(prev => ({
        ...prev,
        [snapshotDate]: {
          id:          data.id ?? '',
          ideas:       data.ideas ?? [],
          diagnostics: data.diagnostics,
          pushedIds:   new Set(),
        },
      }))
    } catch (err) {
      setRecError(err instanceof Error ? err.message : 'Failed to load ideas')
    } finally {
      setRecLoadingDate(null)
    }
  }

  async function pushIdeaToBragi(snapshotDate: string, idea: ContentIdea) {
    const rec = recBySnapDate[snapshotDate]
    if (!rec) return
    setPushingIdeaId(idea.id)
    try {
      const res = await fetch('/api/competitive/serp-recommend/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recommendation_id:    rec.id,
          idea_id:              idea.id,
          primary_keyword:      idea.target_keyword,
          target_url:           idea.target_url,
          suggested_brief_type: idea.suggested_brief_type,
        }),
      })
      const data = await res.json() as { ok?: boolean; opp_id?: string; error?: string; already_pushed?: boolean }
      if (!res.ok || !data.ok) {
        setRecError(data.error ?? `HTTP ${res.status}`)
        return
      }
      setPushSuccessIds(prev => new Set(prev).add(idea.id))
      setRecBySnapDate(prev => {
        const r = prev[snapshotDate]
        if (!r) return prev
        return { ...prev, [snapshotDate]: { ...r, pushedIds: new Set([...r.pushedIds, idea.id]) } }
      })
    } catch (err) {
      setRecError(err instanceof Error ? err.message : 'Push failed')
    } finally {
      setPushingIdeaId(null)
    }
  }

  // Multi-select state — domains user wants to add to Competitor List in bulk.
  // Excludes G2G + already-tracked competitors (they get auto-skipped server-side).
  const [selectedDomains, setSelectedDomains]   = useState<Set<string>>(new Set())
  const [bulkAdding, setBulkAdding]             = useState(false)
  const [bulkResult, setBulkResult]             = useState<{ added: number; skipped: number; lastDomains: string[] } | null>(null)

  function toggleSelectDomain(domain: string) {
    const norm = normalizeDomain(domain)
    setSelectedDomains(prev => {
      const next = new Set(prev)
      if (next.has(norm)) next.delete(norm)
      else next.add(norm)
      return next
    })
  }

  function clearSelection() {
    setSelectedDomains(new Set())
  }

  async function bulkAddSelected() {
    if (selectedDomains.size === 0) return
    setBulkAdding(true)
    setBulkResult(null)
    try {
      const payload = {
        competitors: Array.from(selectedDomains).map(domain => ({ domain })),
      }
      const res = await fetch('/api/competitors/bulk', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        setBulkResult({ added: 0, skipped: 0, lastDomains: [] })
        alert(`Failed: ${data.error ?? 'Unknown error'}`)
      } else {
        setBulkResult({
          added:       data.summary?.added_count   ?? 0,
          skipped:     data.summary?.skipped_count ?? 0,
          lastDomains: Array.from(selectedDomains),
        })
        // Refresh competitors list so newly added show as "in list" highlighted
        const compRes = await fetch('/api/competitors')
        if (compRes.ok) {
          const { competitors } = await compRes.json()
          setCompetitors(competitors.filter((c: Competitor) => c.active))
        }
        clearSelection()
      }
    } finally {
      setBulkAdding(false)
    }
  }

  // Load competitors + tracked products + today's existing snapshots
  useEffect(() => {
    async function init() {
      try {
        const [compRes, prodRes, snapRes] = await Promise.all([
          fetch('/api/competitors'),
          fetch('/api/products'),
          fetch(`/api/competitive/serp-track?country_code=${countryCode}`),
        ])
        if (compRes.ok) {
          const { competitors } = await compRes.json()
          setCompetitors(competitors.filter((c: Competitor) => c.active))
        }
        if (prodRes.ok) {
          const { products } = await prodRes.json()
          const activeProds = products.filter((p: TrackedProduct & { active: boolean }) => p.active)
          setTrackedProducts(activeProds)
          if (activeProds.length > 0) setProductId(activeProds[0].id)
        }
        if (snapRes.ok) {
          const data = await snapRes.json()
          if (data.snapshots?.length) {
            setSnapshots(data.snapshots.map((s: any) => ({
              keyword: s.keyword, results: s.results, search_volume: s.search_volume
            })))
            setSov(data.sov ?? {})
            setLastDate(data.date)
          }
        }
      } catch { /* silent */ }
      finally { setInitialLoading(false) }
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Lazy-load history when tab opened (or window changes). Avoids hitting
  // the endpoint until the user actually opens the History tab.
  useEffect(() => {
    if (activeView !== 'history') return
    setHistoryLoading(true)
    fetch(`/api/competitive/serp-history?days=${historyDays_window}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return
        setHistoryDays(d.days ?? [])
        setHistoryTotal({
          runs:     d.total_runs        ?? 0,
          dates:    d.distinct_dates    ?? 0,
          keywords: d.distinct_keywords ?? 0,
        })
      })
      .catch(() => { /* silent */ })
      .finally(() => setHistoryLoading(false))
  }, [activeView, historyDays_window])

  // Keywords to track (derived)
  const keywordsToTrack = useMemo(() => {
    if (selectedSource === 'custom') {
      return customKeywords.split('\n').map(k => k.trim()).filter(Boolean).slice(0, 20)
    }
    const product = trackedProducts.find(p => p.id === selectedProductId)
    return product?.keywords.slice(0, 20) ?? []
  }, [selectedSource, customKeywords, selectedProductId, trackedProducts])

  // Sorted SoV entries
  const sovSorted = useMemo(() =>
    Object.entries(sov).sort((a, b) => b[1].sov_pct - a[1].sov_pct),
    [sov]
  )

  // Domains to highlight in SERP view (G2G + active competitors)
  // Normalized domain set for comparison (strip www.)
  const trackedDomains = useMemo(() => {
    return new Set([G2G_DOMAIN, ...competitors.map(c => normalizeDomain(c.domain))])
  }, [competitors])

  async function runTracking() {
    if (keywordsToTrack.length === 0) return
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/competitive/serp-track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: keywordsToTrack, country_code: countryCode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setSnapshots(data.snapshots)
      setSov(data.sov)
      setLastDate(data.date)
      setActiveView('sov')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  if (initialLoading) {
    return <div className="flex justify-center py-16"><LottieLoader size={80} text="Loading…" /></div>
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">📊 SERP & Share of Voice</h1>
        <p className="text-gray-400 text-sm mt-1">
          Track keyword SERP positions and estimate Share of Voice for G2G vs competitors.
        </p>
      </div>

      {/* Config */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6 space-y-4">
        <div className="flex items-center gap-4 flex-wrap">
          {/* Source toggle */}
          <div className="flex rounded-lg overflow-hidden border border-gray-700">
            <button onClick={() => setSource('custom')}
              className={`text-xs px-3 py-2 transition ${selectedSource === 'custom' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
              Custom keywords
            </button>
            <button onClick={() => setSource('products')}
              className={`text-xs px-3 py-2 transition ${selectedSource === 'products' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
              From tracked products
            </button>
          </div>

          {/* Country */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400">Market:</label>
            <select value={countryCode} onChange={e => setCountryCode(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
              {SERP_COUNTRIES.map(c => (
                <option key={c.code} value={c.code}>{c.flag} {c.label}</option>
              ))}
            </select>
          </div>

          <button onClick={runTracking} disabled={loading || keywordsToTrack.length === 0}
            className="ml-auto bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition">
            {loading ? '⏳ Fetching SERPs…' : '▶ Run tracking'}
          </button>
        </div>

        {/* Keyword input */}
        {selectedSource === 'custom' ? (
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">
              Keywords <span className="text-gray-600">(one per line, max 20)</span>
            </label>
            <textarea
              value={customKeywords}
              onChange={e => setCustomKeywords(e.target.value)}
              placeholder={"buy lol accounts\nlol boosting service\nleague of legends accounts for sale"}
              rows={5}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 resize-none font-mono"
            />
            <p className="text-xs text-gray-600 mt-1">{keywordsToTrack.length}/20 keywords</p>
          </div>
        ) : (
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Select tracked product</label>
            {trackedProducts.length === 0 ? (
              <p className="text-gray-500 text-sm">
                No tracked products yet. <a href="/gsc/product-rankings" className="text-red-400 hover:text-red-300">Add products →</a>
              </p>
            ) : (
              <select value={selectedProductId} onChange={e => setProductId(e.target.value)}
                className="w-full max-w-sm bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
                {trackedProducts.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.keywords.length} keywords)</option>
                ))}
              </select>
            )}
            {keywordsToTrack.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {keywordsToTrack.map(kw => (
                  <span key={kw} className="text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded-full">{kw}</span>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-gray-600">
          Uses DataForSEO SERP Live API — each keyword costs ~1 API unit. Results are saved and reused for the same day.
          {' '}
          <span className="text-yellow-500/80">
            ⓘ Snapshots are stamped with TODAY&apos;s date; they appear in this week&apos;s Weekly Pulse and the current month&apos;s Monthly SEO report.
            Past months show only data captured during that month — older monthly reports stay frozen.
          </span>
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-red-400 text-sm">⚠️ {error}</div>
      )}

      {loading && (
        <div className="flex justify-center py-16">
          <LottieLoader size={90} text="Fetching SERP data…" />
        </div>
      )}

      {/* View toggle — History tab is always accessible (independent of
          whether the user just ran a tracking cycle in this session). */}
      {!loading && (
        <div className="flex items-center gap-3 mb-5 flex-wrap">
          <div className="flex rounded-lg overflow-hidden border border-gray-800">
            <button onClick={() => setActiveView('sov')}
              disabled={snapshots.length === 0}
              className={`text-xs px-4 py-2 transition disabled:opacity-40 disabled:cursor-not-allowed ${activeView === 'sov' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
              📊 Share of Voice
            </button>
            <button onClick={() => setActiveView('serp')}
              disabled={snapshots.length === 0}
              className={`text-xs px-4 py-2 transition disabled:opacity-40 disabled:cursor-not-allowed ${activeView === 'serp' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
              🔍 SERP Breakdown
            </button>
            <button onClick={() => setActiveView('history')}
              className={`text-xs px-4 py-2 transition ${activeView === 'history' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
              📚 History
            </button>
          </div>
          {lastDate && activeView !== 'history' && <span className="text-xs text-gray-600">Snapshot: {lastDate}</span>}
          {activeView === 'history' && historyTotal.runs > 0 && (
            <span className="text-xs text-gray-500">
              {historyTotal.runs} runs · {historyTotal.dates} day{historyTotal.dates !== 1 ? 's' : ''} · {historyTotal.keywords} keywords
            </span>
          )}
          {snapshots.length > 0 && activeView !== 'history' && (
            <span className="text-xs text-gray-600 ml-auto">{snapshots.length} keywords tracked</span>
          )}
        </div>
      )}

      {!loading && snapshots.length > 0 && (
        <>

          {/* SoV view */}
          {activeView === 'sov' && (
            <div className="space-y-4">
              {/* SoV chart */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <h2 className="text-white font-semibold text-sm mb-4">Share of Voice — top 10 results</h2>
                <div className="space-y-3">
                  {sovSorted.slice(0, 15).map(([domain, entry]) => (
                    <div key={domain} className="grid grid-cols-[1fr,2fr,80px,80px] items-center gap-4">
                      <div className="flex items-center gap-2 min-w-0">
                        <img src={`https://www.google.com/s2/favicons?sz=16&domain_url=${domain}`} alt="" className="w-4 h-4 flex-shrink-0" />
                        <span className={`text-xs font-medium truncate ${normalizeDomain(domain) === G2G_DOMAIN ? 'text-red-400' : trackedDomains.has(normalizeDomain(domain)) ? 'text-blue-400' : 'text-gray-400'}`}>
                          {domain}
                          {normalizeDomain(domain) === G2G_DOMAIN && <span className="ml-1 text-[10px] text-red-600">(us)</span>}
                        </span>
                      </div>
                      <SovBar pct={entry.sov_pct} domain={domain} />
                      <span className="text-xs text-gray-500 text-center">{entry.keywords_in_top10} kw</span>
                      <span className="text-xs text-gray-500 text-right">{entry.est_clicks.toLocaleString()} est.</span>
                    </div>
                  ))}
                </div>
                <div className="mt-4 pt-4 border-t border-gray-800 grid grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs text-gray-500 mb-1">G2G SoV</p>
                    <p className="text-xl font-bold text-red-400">{sov[G2G_DOMAIN]?.sov_pct.toFixed(1) ?? '0.0'}%</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">G2G keywords in top 10</p>
                    <p className="text-xl font-bold text-white">{sov[G2G_DOMAIN]?.keywords_in_top10 ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">G2G est. clicks/mo</p>
                    <p className="text-xl font-bold text-white">{(sov[G2G_DOMAIN]?.est_clicks ?? 0).toLocaleString()}</p>
                  </div>
                </div>
              </div>

              {/* Competitor comparison grid */}
              {competitors.length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h2 className="text-white font-semibold text-sm mb-4">Tracked competitor comparison</h2>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-800">
                          <th className="text-left text-xs text-gray-500 font-medium py-2 pr-4">Domain</th>
                          <th className="text-right text-xs text-gray-500 font-medium py-2 px-3">SoV</th>
                          <th className="text-right text-xs text-gray-500 font-medium py-2 px-3">Top-10 kw</th>
                          <th className="text-right text-xs text-gray-500 font-medium py-2 px-3">Est. clicks/mo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[G2G_DOMAIN, ...competitors.map(c => c.domain)].map(domain => {
                          const entry = sov[domain]
                          const isG2G = domain === G2G_DOMAIN
                          return (
                            <tr key={domain} className={`border-b border-gray-800 ${isG2G ? 'bg-red-500/5' : ''}`}>
                              <td className="py-2.5 pr-4">
                                <div className="flex items-center gap-2">
                                  <img src={`https://www.google.com/s2/favicons?sz=16&domain_url=${domain}`} alt="" className="w-4 h-4" />
                                  <span className={`text-xs font-medium ${isG2G ? 'text-red-400' : 'text-gray-300'}`}>{domain}</span>
                                  {isG2G && <span className="text-[10px] bg-red-700/30 text-red-400 px-1.5 rounded">G2G</span>}
                                </div>
                              </td>
                              <td className="py-2.5 px-3 text-right">
                                <span className={`text-xs font-bold ${entry ? (isG2G ? 'text-red-400' : 'text-white') : 'text-gray-700'}`}>
                                  {entry ? `${entry.sov_pct.toFixed(1)}%` : '—'}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-right text-xs text-gray-400">{entry?.keywords_in_top10 ?? '—'}</td>
                              <td className="py-2.5 px-3 text-right text-xs text-gray-400">
                                {entry ? entry.est_clicks.toLocaleString() : '—'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SERP Breakdown view */}
          {activeView === 'serp' && (
            <div className="space-y-2">
              {/* Multi-select action bar — appears when user has selections */}
              {selectedDomains.size > 0 && (
                <div className="sticky top-2 z-10 bg-purple-500/10 border border-purple-500/40 rounded-xl px-4 py-2.5 flex items-center justify-between mb-3 backdrop-blur">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-purple-300 font-medium">
                      {selectedDomains.size} domain{selectedDomains.size !== 1 ? 's' : ''} selected
                    </span>
                    <button onClick={clearSelection} className="text-[11px] text-gray-400 hover:text-gray-200 transition">
                      Clear
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={bulkAddSelected}
                      disabled={bulkAdding}
                      className="text-xs bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium px-3 py-1.5 rounded-lg transition"
                    >
                      {bulkAdding ? '⏳ Adding…' : `+ Add as competitors`}
                    </button>
                  </div>
                </div>
              )}

              {/* Result toast — shown after bulk add */}
              {bulkResult && (
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-2.5 mb-3 flex items-center justify-between">
                  <div className="text-xs text-emerald-300">
                    ✓ <span className="font-semibold">{bulkResult.added} added</span>
                    {bulkResult.skipped > 0 && <span className="text-gray-400"> · {bulkResult.skipped} already in list</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {bulkResult.added > 0 && bulkResult.lastDomains.length > 0 && (
                      <a
                        href={`/competitive/keyword-gap?competitors=${encodeURIComponent(bulkResult.lastDomains.join(','))}`}
                        className="text-[11px] text-blue-400 hover:text-blue-300 transition border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 rounded-lg"
                      >
                        Run keyword gap →
                      </a>
                    )}
                    <button onClick={() => setBulkResult(null)} className="text-gray-500 hover:text-gray-300 text-xs">✕</button>
                  </div>
                </div>
              )}

              {snapshots.map(snap => {
                const isExpanded = expandedKw === snap.keyword
                const g2gResult  = snap.results.find(r => normalizeDomain(r.domain) === G2G_DOMAIN)

                return (
                  <div key={snap.keyword} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpandedKw(prev => prev === snap.keyword ? null : snap.keyword)}
                      className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-gray-800/50 transition text-left"
                    >
                      <span className={`text-xs transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                      <span className="text-white text-sm font-medium flex-1">{snap.keyword}</span>
                      {snap.error ? (
                        <span className="text-red-400 text-xs">error</span>
                      ) : (
                        <>
                          <span className="text-xs text-gray-500">
                            G2G: {g2gResult ? <span className={`font-bold ${g2gResult.position <= 3 ? 'text-green-400' : g2gResult.position <= 10 ? 'text-yellow-400' : 'text-orange-400'}`}>#{g2gResult.position}</span> : <span className="text-gray-600">not ranking</span>}
                          </span>
                          <span className="text-xs text-gray-600">{snap.results.length} results</span>
                        </>
                      )}
                    </button>

                    {isExpanded && snap.results.length > 0 && (
                      <div className="border-t border-gray-800 px-5 py-3">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-gray-800">
                              <th className="text-left text-gray-500 font-medium py-1.5 w-6"></th>
                              <th className="text-left text-gray-500 font-medium py-1.5 w-8">#</th>
                              <th className="text-left text-gray-500 font-medium py-1.5">Domain</th>
                              <th className="text-left text-gray-500 font-medium py-1.5">Title / URL</th>
                            </tr>
                          </thead>
                          <tbody>
                            {snap.results.map((r, i) => {
                              const normDom  = normalizeDomain(r.domain)
                              const isG2G_   = normDom === G2G_DOMAIN
                              const isComp   = trackedDomains.has(normDom) && !isG2G_
                              // Disable checkbox for G2G itself + already-tracked competitors.
                              // Both would be no-ops server-side anyway.
                              const canSelect = !isG2G_ && !isComp
                              const isSelected = selectedDomains.has(normDom)
                              return (
                                <tr key={i} className={`border-b border-gray-800/50 ${isG2G_ ? 'bg-red-500/5' : isComp ? 'bg-blue-500/5' : isSelected ? 'bg-purple-500/5' : ''}`}>
                                  <td className="py-2 w-6">
                                    <input
                                      type="checkbox"
                                      checked={isSelected}
                                      disabled={!canSelect}
                                      onChange={() => toggleSelectDomain(r.domain)}
                                      title={!canSelect ? (isG2G_ ? 'This is G2G' : 'Already in competitor list') : 'Select to add as competitor'}
                                      className="w-3.5 h-3.5 rounded bg-gray-800 border-gray-700 text-purple-600 focus:ring-1 focus:ring-purple-500 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                                    />
                                  </td>
                                  <td className="py-2 w-8">
                                    <PosBadge pos={r.position} domain={r.domain} />
                                  </td>
                                  <td className="py-2 pr-4">
                                    <div className="flex items-center gap-1.5">
                                      <img src={`https://www.google.com/s2/favicons?sz=16&domain_url=${r.domain}`} alt="" className="w-3.5 h-3.5" />
                                      <span className={`font-medium ${isG2G_ ? 'text-red-400' : isComp ? 'text-blue-400' : 'text-gray-300'}`}>{r.domain}</span>
                                      {isComp && <span className="text-[9px] text-blue-500/60 ml-1">in list</span>}
                                    </div>
                                  </td>
                                  <td className="py-2">
                                    <p className="text-gray-300 truncate max-w-sm">{r.title}</p>
                                    <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-blue-400/60 hover:text-blue-400 truncate max-w-sm block transition">{r.url}</a>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {!loading && snapshots.length === 0 && activeView !== 'history' && (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">📊</p>
          <p className="text-white font-semibold mb-1">No SERP data yet</p>
          <p className="text-gray-400 text-sm">Enter keywords and click &quot;Run tracking&quot; to fetch live SERP data.</p>
          <p className="text-gray-500 text-xs mt-2">Or check the <button onClick={() => setActiveView('history')} className="text-blue-400 hover:text-blue-300 underline">📚 History</button> tab to see all past tracking runs.</p>
        </div>
      )}

      {/* ── History tab ─────────────────────────────────────────────────── */}
      {!loading && activeView === 'history' && (
        <div className="space-y-4">
          {/* Window selector */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500">Window:</span>
            {([30, 90, 180, 365] as const).map(d => (
              <button
                key={d}
                onClick={() => setHistoryDays_window(d)}
                className={`text-xs px-3 py-1 rounded-lg border transition ${
                  historyDays_window === d
                    ? 'bg-red-500/15 border-red-500/40 text-white'
                    : 'bg-gray-900 border-gray-800 text-gray-400 hover:border-gray-600 hover:text-white'
                }`}
              >
                {d === 30 ? '30 days' : d === 90 ? '90 days' : d === 180 ? '6 months' : '1 year'}
              </button>
            ))}
            <span className="text-[10px] text-gray-600 ml-auto">
              ⓘ Each row = one day of tracking. Click to see keywords + top domains for that day.
            </span>
          </div>

          {historyLoading ? (
            <div className="flex justify-center py-12">
              <LottieLoader size={70} text="Loading history…" />
            </div>
          ) : historyDays.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
              <p className="text-3xl mb-3">📚</p>
              <p className="text-white font-semibold mb-1">No tracking history yet</p>
              <p className="text-gray-400 text-sm">Run SERP tracking once and history starts collecting from that day onwards.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {historyDays.map(day => {
                const isOpen   = expandedDate === day.snapshot_date
                const g2gEntry = day.top_domains.find(t => t.domain === 'g2g.com')
                return (
                  <div key={day.snapshot_date} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setExpandedDate(isOpen ? null : day.snapshot_date)}
                      className="w-full px-4 py-3 flex items-center gap-4 hover:bg-gray-800/50 transition"
                    >
                      <div className="text-left flex-1 min-w-0">
                        <p className="text-white text-sm font-medium">{new Date(day.snapshot_date).toLocaleDateString('id-ID', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}</p>
                        <p className="text-[11px] text-gray-500 mt-0.5">
                          {day.keyword_count} keyword{day.keyword_count !== 1 ? 's' : ''} tracked · {day.total_sv.toLocaleString()} total SV
                        </p>
                      </div>
                      {g2gEntry && (
                        <div className="text-right flex-shrink-0">
                          <p className="text-[10px] text-gray-500">G2G SoV</p>
                          <p className="text-sm font-semibold text-red-400">{g2gEntry.sov_pct}%</p>
                        </div>
                      )}
                      {day.top_domains.length > 0 && !g2gEntry && (
                        <div className="text-right flex-shrink-0">
                          <p className="text-[10px] text-gray-500">Top: {day.top_domains[0].domain}</p>
                          <p className="text-sm font-semibold text-gray-300">{day.top_domains[0].sov_pct}%</p>
                        </div>
                      )}
                      <span className="text-gray-600 text-xs flex-shrink-0">{isOpen ? '▾' : '▸'}</span>
                    </button>

                    {isOpen && (
                      <div className="border-t border-gray-800 p-4 space-y-4">
                        {/* Top domains for this day */}
                        <div>
                          <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Top 5 domains by Share of Voice</p>
                          <div className="space-y-2">
                            {day.top_domains.map(td => (
                              <div key={td.domain} className="flex items-center gap-3">
                                <div className="flex items-center gap-1.5 w-40 flex-shrink-0">
                                  <img src={`https://www.google.com/s2/favicons?domain=${td.domain}&sz=16`} alt="" className="w-3 h-3 flex-shrink-0" />
                                  <span className={`text-xs truncate ${td.domain === 'g2g.com' ? 'text-red-400 font-semibold' : 'text-gray-300'}`}>{td.domain}</span>
                                </div>
                                <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full ${td.domain === 'g2g.com' ? 'bg-red-600' : 'bg-gray-600'}`}
                                    style={{ width: `${Math.min(100, td.sov_pct * 1.5)}%` }}
                                  />
                                </div>
                                <span className="text-xs text-gray-400 w-14 text-right flex-shrink-0">{td.sov_pct}%</span>
                                <span className="text-[10px] text-gray-600 w-12 text-right flex-shrink-0">{td.keywords_in_top10}/{day.keyword_count} kw</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        {/* Keyword list */}
                        <div>
                          <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Keywords tracked that day</p>
                          <div className="flex flex-wrap gap-1.5">
                            {day.keywords.map(kw => (
                              <span key={kw.keyword} className="bg-gray-800 border border-gray-700 px-2 py-0.5 rounded text-[11px] text-gray-300">
                                {kw.keyword}
                                {kw.search_volume != null && <span className="text-gray-500 ml-1">· {kw.search_volume.toLocaleString()}</span>}
                              </span>
                            ))}
                          </div>
                        </div>

                        {/* ── Get content ideas (Sonnet + FireCrawl) ────── */}
                        <div className="border-t border-gray-800 pt-4">
                          {!recBySnapDate[day.snapshot_date] && recLoadingDate !== day.snapshot_date && (
                            <button
                              onClick={() => fetchOrGenerateIdeas(day.snapshot_date)}
                              className="px-4 py-2 text-xs rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white transition shadow-lg"
                            >
                              💡 Get content ideas (Sonnet + FireCrawl, ~60s, ~$0.10)
                            </button>
                          )}
                          {recLoadingDate === day.snapshot_date && (
                            <div className="text-xs text-purple-300 animate-pulse">
                              ⏳ Sonnet analysing SERP + FireCrawl scraping top competitors… 30-60s
                            </div>
                          )}
                          {recError && recLoadingDate === null && expandedDate === day.snapshot_date && (
                            <p className="text-xs text-red-400 mt-2">⚠️ {recError}</p>
                          )}

                          {recBySnapDate[day.snapshot_date] && (() => {
                            const rec = recBySnapDate[day.snapshot_date]!
                            const groupBy = (t: ContentIdea['type']) => rec.ideas.filter(i => i.type === t)
                            const categories: Array<{ type: ContentIdea['type']; label: string; emoji: string; cls: string }> = [
                              { type: 'title_pattern', label: 'Title Patterns',     emoji: '📝', cls: 'border-purple-500/30 bg-purple-500/5' },
                              { type: 'content_depth', label: 'Content Depth Gaps', emoji: '📚', cls: 'border-blue-500/30 bg-blue-500/5'   },
                              { type: 'new_keyword',   label: 'New Keywords',       emoji: '🔑', cls: 'border-emerald-500/30 bg-emerald-500/5' },
                              { type: 'quick_win',     label: 'Quick-Win Positioning', emoji: '🎯', cls: 'border-amber-500/30 bg-amber-500/5' },
                            ]
                            return (
                              <div className="space-y-3">
                                <div className="flex items-center justify-between flex-wrap gap-2">
                                  <p className="text-xs text-purple-300 font-semibold uppercase tracking-wider">💡 {rec.ideas.length} content ideas</p>
                                  {rec.diagnostics && (
                                    <p className="text-[10px] text-gray-500 font-mono">
                                      {rec.diagnostics.urls_scraped} URLs scraped ({rec.diagnostics.cache_hits} cached) · ${rec.diagnostics.cost_usd.toFixed(3)} · {rec.diagnostics.remaining_today} left today
                                    </p>
                                  )}
                                </div>

                                {categories.map(cat => {
                                  const cIdeas = groupBy(cat.type)
                                  if (cIdeas.length === 0) return null
                                  return (
                                    <div key={cat.type} className={`border rounded-lg p-3 ${cat.cls}`}>
                                      <p className="text-xs font-semibold text-white mb-2">{cat.emoji} {cat.label} ({cIdeas.length})</p>
                                      <div className="space-y-2">
                                        {cIdeas.map(idea => {
                                          const isPushed  = rec.pushedIds.has(idea.id) || pushSuccessIds.has(idea.id)
                                          const isPushing = pushingIdeaId === idea.id
                                          return (
                                            <div key={idea.id} className="bg-gray-900/60 border border-gray-800 rounded-md p-3">
                                              <div className="flex items-start justify-between gap-3 mb-1.5">
                                                <p className="text-sm font-medium text-white flex-1">{idea.title}</p>
                                                {isPushed ? (
                                                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 flex-shrink-0">
                                                    ✓ Pushed
                                                  </span>
                                                ) : (
                                                  <button
                                                    onClick={() => pushIdeaToBragi(day.snapshot_date, idea)}
                                                    disabled={isPushing}
                                                    className="text-[10px] px-2 py-1 rounded-md bg-purple-600 hover:bg-purple-500 text-white transition disabled:opacity-50 flex-shrink-0"
                                                  >
                                                    {isPushing ? '…' : '🚀 Push to Bragi'}
                                                  </button>
                                                )}
                                              </div>
                                              <p className="text-xs text-gray-400 mb-2">{idea.body}</p>
                                              <div className="flex items-center gap-2 flex-wrap text-[10px] text-gray-500">
                                                <span className="bg-gray-800 px-1.5 py-0.5 rounded">kw: {idea.target_keyword}</span>
                                                {idea.target_url && (
                                                  <span className="bg-gray-800 px-1.5 py-0.5 rounded truncate max-w-xs">
                                                    {(() => { try { return new URL(idea.target_url).pathname } catch { return idea.target_url } })()}
                                                  </span>
                                                )}
                                                <span className="bg-gray-800 px-1.5 py-0.5 rounded">→ {idea.suggested_brief_type}</span>
                                              </div>
                                              <p className="text-[10px] text-gray-600 italic mt-1.5">📎 {idea.evidence}</p>
                                            </div>
                                          )
                                        })}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )
                          })()}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
