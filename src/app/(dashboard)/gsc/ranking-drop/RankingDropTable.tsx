'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'

export type PageDropWithQueries = {
  page: string
  currentClicks: number
  previousClicks: number
  clicksDrop: number
  currentImpressions: number
  previousImpressions: number
  impressionsDrop: number
  currentPosition: number
  previousPosition: number
  positionChange: number
  queries: {
    query: string
    clicks: number
    impressions: number
    ctr: number
    position: number
  }[]
}

type SortKey = 'currentClicks' | 'previousClicks' | 'clicksDrop' | 'impressionsDrop' | 'currentPosition' | 'positionChange'
type SortDir = 'asc' | 'desc'
type ActionType = 'on_page' | 'off_page'
type PageSize = 20 | 50 | 100

// ── Region detection ──────────────────────────────────────────────────────────
// G2G category URLs: /categories/[slug]/[cc]/ where [cc] is a 2-letter country code.
// Pages without a country suffix are 'global'.
const KNOWN_REGIONS = new Set([
  'id','my','sg','ph','th','vn','us','gb','au','br','de','fr','tr','kr',
  'cn','tw','jp','hk','sa','ae','mx','ca','it','es','nl','ru','in','pk',
])

const REGION_META: Record<string, { flag: string; label: string }> = {
  id: { flag: '🇮🇩', label: 'ID' },
  my: { flag: '🇲🇾', label: 'MY' },
  sg: { flag: '🇸🇬', label: 'SG' },
  ph: { flag: '🇵🇭', label: 'PH' },
  th: { flag: '🇹🇭', label: 'TH' },
  vn: { flag: '🇻🇳', label: 'VN' },
  us: { flag: '🇺🇸', label: 'US' },
  gb: { flag: '🇬🇧', label: 'GB' },
  au: { flag: '🇦🇺', label: 'AU' },
  br: { flag: '🇧🇷', label: 'BR' },
  de: { flag: '🇩🇪', label: 'DE' },
  fr: { flag: '🇫🇷', label: 'FR' },
  tr: { flag: '🇹🇷', label: 'TR' },
  kr: { flag: '🇰🇷', label: 'KR' },
  cn: { flag: '🇨🇳', label: 'CN' },
  tw: { flag: '🇹🇼', label: 'TW' },
  jp: { flag: '🇯🇵', label: 'JP' },
  hk: { flag: '🇭🇰', label: 'HK' },
  sa: { flag: '🇸🇦', label: 'SA' },
  ae: { flag: '🇦🇪', label: 'AE' },
  mx: { flag: '🇲🇽', label: 'MX' },
  ca: { flag: '🇨🇦', label: 'CA' },
  it: { flag: '🇮🇹', label: 'IT' },
  es: { flag: '🇪🇸', label: 'ES' },
  ru: { flag: '🇷🇺', label: 'RU' },
  in: { flag: '🇮🇳', label: 'IN' },
}

function detectRegion(url: string): string {
  try {
    const pathname = new URL(url).pathname
    // Match trailing /xx/ or /xx at end of path
    const m = pathname.match(/\/([a-z]{2})\/?$/)
    if (m && KNOWN_REGIONS.has(m[1])) return m[1]
  } catch { /* keep */ }
  return 'global'
}

// ── Assign Modal ───────────────────────────────────────────────────────────────
function AssignModal({
  selectedCount,
  onConfirm,
  onCancel,
  loading,
}: {
  selectedCount: number
  onConfirm: (actionType: ActionType, notes: string) => void
  onCancel: () => void
  loading: boolean
}) {
  const [actionType, setActionType] = useState<ActionType>('on_page')
  const [notes, setNotes] = useState('')

  const ACTION_OPTIONS: { value: ActionType; label: string; desc: string; icon: string }[] = [
    {
      value: 'on_page',
      label: 'On-Page Optimization',
      desc: 'Update content, add keywords, long-tail, FAQ, internal links',
      icon: '✏️',
    },
    {
      value: 'off_page',
      label: 'Off-Page Content',
      desc: 'Create supporting blog posts, landing pages, link-building ideas',
      icon: '📣',
    },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h2 className="text-white font-bold text-lg mb-1">Assign Next Action</h2>
        <p className="text-gray-400 text-sm mb-5">
          {selectedCount} page{selectedCount !== 1 ? 's' : ''} selected
        </p>

        <div className="space-y-3 mb-5">
          {ACTION_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setActionType(opt.value)}
              className={`w-full text-left rounded-xl border p-4 transition ${
                actionType === opt.value
                  ? 'border-red-500/50 bg-red-500/10'
                  : 'border-gray-700 bg-gray-800 hover:border-gray-600'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="text-xl">{opt.icon}</span>
                <div>
                  <p className={`font-semibold text-sm ${actionType === opt.value ? 'text-white' : 'text-gray-300'}`}>
                    {opt.label}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                </div>
                <span className={`ml-auto w-4 h-4 rounded-full border-2 flex-shrink-0 ${
                  actionType === opt.value ? 'border-red-500 bg-red-500' : 'border-gray-600'
                }`} />
              </div>
            </button>
          ))}
        </div>

        <div className="mb-5">
          <label className="text-xs text-gray-500 mb-1.5 block">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Focus on long-tail buyer keywords, competitor gap analysis..."
            rows={3}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
          />
        </div>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 py-2.5 rounded-lg border border-gray-700 text-gray-300 text-sm font-medium hover:border-gray-500 transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(actionType, notes)}
            disabled={loading}
            className="flex-1 py-2.5 rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm font-semibold transition disabled:opacity-50"
          >
            {loading ? 'Saving…' : `Assign to ${selectedCount} page${selectedCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sort icon ─────────────────────────────────────────────────────────────────
function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) return <span className="text-gray-700 ml-1">↕</span>
  return <span className="text-red-400 ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  drops: PageDropWithQueries[]
  totalTracked: number
  alerts: { id: string; created_at: string; title: string; severity: string }[]
  snapshotDate: string
  siteUrl: string
}

// ── Main component ─────────────────────────────────────────────────────────────
export function RankingDropTable({ drops: initialDrops, totalTracked, alerts, snapshotDate, siteUrl }: Props) {

  // ── Date state ───────────────────────────────────────────────────────────────
  const [activeDate, setActiveDate]       = useState(snapshotDate)
  const [availableDates, setAvailableDates] = useState<string[]>([snapshotDate])
  const [currentDrops, setCurrentDrops]   = useState<PageDropWithQueries[]>(initialDrops)
  const [loadingDrops, setLoadingDrops]   = useState(false)

  // ── Country tab state ────────────────────────────────────────────────────────
  // 'all' | 'global' | cc (e.g. 'id', 'cn')
  const [countryTab, setCountryTab]         = useState<string>('all')
  const [countryFilter, setCountryFilter]   = useState<Set<string>>(new Set())

  // ── Pagination ───────────────────────────────────────────────────────────────
  const [pageSize, setPageSize]   = useState<PageSize>(20)
  const [currentPage, setCurrentPage] = useState(1)

  // ── URL / query filters ──────────────────────────────────────────────────────
  const [includePages, setIncludePages]     = useState('/categories/')
  const [excludePages, setExcludePages]     = useState('/offer/')
  const [excludeQueries, setExcludeQueries] = useState('')

  // ── Table state ──────────────────────────────────────────────────────────────
  const [expandedPage, setExpandedPage] = useState<string | null>(null)
  const [sortKey, setSortKey]           = useState<SortKey>('clicksDrop')
  const [sortDir, setSortDir]           = useState<SortDir>('desc')

  // ── Selection state ──────────────────────────────────────────────────────────
  const [selected, setSelected]         = useState<Set<string>>(new Set())
  const [showModal, setShowModal]       = useState(false)
  const [assigning, setAssigning]       = useState(false)
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null)

  // ── Load available dates on mount ────────────────────────────────────────────
  useEffect(() => {
    async function fetchDates() {
      try {
        const res = await fetch(`/api/gsc/drops?site_url=${encodeURIComponent(siteUrl)}&list_dates=true`)
        if (res.ok) {
          const { dates } = await res.json()
          if (Array.isArray(dates) && dates.length > 0) setAvailableDates(dates)
        }
      } catch { /* silent */ }
    }
    fetchDates()
  }, [siteUrl])

  // ── Fetch drops for a different date ────────────────────────────────────────
  async function changeDate(date: string) {
    if (date === activeDate) return
    setLoadingDrops(true)
    setCurrentPage(1)
    setSelected(new Set())
    setExpandedPage(null)
    try {
      const res = await fetch(`/api/gsc/drops?site_url=${encodeURIComponent(siteUrl)}&date=${date}`)
      if (res.ok) {
        const { drops } = await res.json()
        setCurrentDrops(drops ?? [])
        setActiveDate(date)
      }
    } catch { /* silent */ }
    finally { setLoadingDrops(false) }
  }

  // ── Derived: drops annotated with region ────────────────────────────────────
  const dropsWithRegion = useMemo(
    () => currentDrops.map(d => ({ ...d, region: detectRegion(d.page) })),
    [currentDrops]
  )

  // ── Available country tabs (sorted by count desc) ────────────────────────────
  const availableRegions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of dropsWithRegion) {
      if (d.region !== 'global') counts.set(d.region, (counts.get(d.region) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([cc]) => cc)
  }, [dropsWithRegion])

  // ── Parsed filter lists ──────────────────────────────────────────────────────
  const pageInclusions = useMemo(
    () => includePages.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    [includePages]
  )
  const pageExclusions = useMemo(
    () => excludePages.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    [excludePages]
  )
  const queryExclusions = useMemo(
    () => excludeQueries.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    [excludeQueries]
  )

  // ── Filtered + sorted drops (full list, before pagination) ──────────────────
  const filtered = useMemo(() => {
    let list = dropsWithRegion.filter(d => {
      // Country tab filter
      if (countryTab === 'global' && d.region !== 'global') return false
      if (countryTab !== 'all' && countryTab !== 'global' && d.region !== countryTab) return false
      // "All" tab: multi-select country filter chips
      if (countryTab === 'all' && countryFilter.size > 0 && !countryFilter.has(d.region)) return false
      // URL include/exclude
      const pageLower = d.page.toLowerCase()
      if (pageInclusions.length > 0 && !pageInclusions.some(inc => pageLower.includes(inc))) return false
      if (pageExclusions.some(ex => pageLower.includes(ex))) return false
      return true
    })
    return [...list].sort((a, b) => {
      const va = a[sortKey]
      const vb = b[sortKey]
      return sortDir === 'asc' ? va - vb : vb - va
    })
  }, [dropsWithRegion, countryTab, countryFilter, pageInclusions, pageExclusions, sortKey, sortDir])

  // ── Paginated slice ──────────────────────────────────────────────────────────
  const totalPages  = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage    = Math.min(currentPage, totalPages)
  const paginated   = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  // Reset page when filters change
  function resetPage() { setCurrentPage(1) }

  // ── Sort handler ─────────────────────────────────────────────────────────────
  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
    resetPage()
  }

  // ── Selection helpers ────────────────────────────────────────────────────────
  const allPageSelected = paginated.length > 0 && paginated.every(d => selected.has(d.page))
  const someSelected    = selected.size > 0

  function toggleSelectAll() {
    const next = new Set(selected)
    if (allPageSelected) paginated.forEach(d => next.delete(d.page))
    else paginated.forEach(d => next.add(d.page))
    setSelected(next)
  }

  function toggleSelect(page: string, e: React.MouseEvent) {
    e.stopPropagation()
    const next = new Set(selected)
    if (next.has(page)) next.delete(page); else next.add(page)
    setSelected(next)
  }

  function clearSelection() { setSelected(new Set()); setAssignSuccess(null) }

  const handleAssignConfirm = useCallback(async (actionType: ActionType, notes: string) => {
    setAssigning(true)
    try {
      const selectedDrops = currentDrops.filter(d => selected.has(d.page))
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pages: selectedDrops.map(d => ({
            page: d.page,
            clicks_drop: d.clicksDrop,
            position_change: d.positionChange,
          })),
          action_type: actionType,
          notes: notes || null,
          snapshot_date: activeDate,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setShowModal(false)
      setAssignSuccess(`✅ ${data.created} action item${data.created !== 1 ? 's' : ''} created`)
      setSelected(new Set())
    } catch (err) {
      alert(`Error: ${err}`)
    } finally {
      setAssigning(false)
    }
  }, [currentDrops, selected, activeDate])

  function thProps(key: SortKey, label: string) {
    return (
      <th
        className="text-right text-gray-500 font-medium px-5 py-3 cursor-pointer hover:text-white select-none transition"
        onClick={() => handleSort(key)}
      >
        <span className="inline-flex items-center justify-end gap-0.5">
          {label}
          <SortIcon col={key} sortKey={sortKey} sortDir={sortDir} />
        </span>
      </th>
    )
  }

  // ── Country tab toggle helper ────────────────────────────────────────────────
  function setTab(tab: string) {
    setCountryTab(tab)
    setCountryFilter(new Set())
    setCurrentPage(1)
    setExpandedPage(null)
  }

  function toggleCountryChip(cc: string) {
    const next = new Set(countryFilter)
    if (next.has(cc)) next.delete(cc); else next.add(cc)
    setCountryFilter(next)
    setCurrentPage(1)
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <>
      {showModal && (
        <AssignModal
          selectedCount={selected.size}
          onConfirm={handleAssignConfirm}
          onCancel={() => setShowModal(false)}
          loading={assigning}
        />
      )}

      {/* ── Date picker ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 mb-5">
        <span className="text-xs text-gray-500 font-medium">Snapshot date:</span>
        <div className="flex flex-wrap gap-1.5">
          {availableDates.slice(0, 14).map(d => (
            <button
              key={d}
              onClick={() => changeDate(d)}
              disabled={loadingDrops}
              className={`text-xs px-3 py-1 rounded-full border transition disabled:opacity-40 ${
                d === activeDate
                  ? 'bg-red-700 border-red-600 text-white font-semibold'
                  : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white bg-gray-900'
              }`}
            >
              {d}
            </button>
          ))}
          {availableDates.length === 0 && (
            <span className="text-xs text-gray-600">Loading dates…</span>
          )}
        </div>
        {loadingDrops && <span className="text-xs text-gray-500 animate-pulse">Loading…</span>}
      </div>

      {/* ── Summary cards ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-4 mb-5">
        <div className={`${filtered.length > 0 ? 'bg-red-500/10 border-red-500/20' : 'bg-gray-900 border-gray-800'} border rounded-xl p-4`}>
          <p className={`text-3xl font-bold ${filtered.length > 0 ? 'text-red-400' : 'text-white'}`}>{filtered.length}</p>
          <p className="text-gray-400 text-sm mt-1">Pages flagged</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-3xl font-bold text-white">{totalTracked}</p>
          <p className="text-gray-400 text-sm mt-1">Total pages tracked</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-3xl font-bold text-yellow-400">{alerts.length}</p>
          <p className="text-gray-400 text-sm mt-1">Alerts sent (last 5)</p>
        </div>
      </div>

      {/* ── Success banner ───────────────────────────────────────────────── */}
      {assignSuccess && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3 mb-4 flex items-center justify-between">
          <p className="text-green-400 text-sm font-medium">{assignSuccess}</p>
          <div className="flex items-center gap-3">
            <a href="/gsc/action-items" className="text-xs text-green-300 underline underline-offset-2 hover:text-green-200">
              View Action Items →
            </a>
            <button onClick={() => setAssignSuccess(null)} className="text-gray-500 hover:text-white text-xs">✕</button>
          </div>
        </div>
      )}

      {/* ── Country tabs ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 mb-4 overflow-x-auto pb-1">
        {/* All */}
        <button
          onClick={() => setTab('all')}
          className={`flex-shrink-0 text-xs px-3 py-1.5 rounded-lg font-medium transition ${
            countryTab === 'all'
              ? 'bg-gray-700 text-white'
              : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
          }`}
        >
          All <span className="ml-1 text-gray-500 font-normal">{dropsWithRegion.length}</span>
        </button>
        {/* Global */}
        <button
          onClick={() => setTab('global')}
          className={`flex-shrink-0 text-xs px-3 py-1.5 rounded-lg font-medium transition ${
            countryTab === 'global'
              ? 'bg-gray-700 text-white'
              : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
          }`}
        >
          🌐 Global <span className="ml-1 text-gray-500 font-normal">
            {dropsWithRegion.filter(d => d.region === 'global').length}
          </span>
        </button>
        {/* Per-country tabs */}
        {availableRegions.map(cc => {
          const meta = REGION_META[cc]
          const count = dropsWithRegion.filter(d => d.region === cc).length
          return (
            <button
              key={cc}
              onClick={() => setTab(cc)}
              className={`flex-shrink-0 text-xs px-3 py-1.5 rounded-lg font-medium transition ${
                countryTab === cc
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              {meta ? `${meta.flag} ${meta.label}` : cc.toUpperCase()}
              <span className="ml-1 text-gray-500 font-normal">{count}</span>
            </button>
          )
        })}
      </div>

      {/* ── Multi-country filter chips (All tab only) ─────────────────────── */}
      {countryTab === 'all' && availableRegions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <span className="text-xs text-gray-600 mr-1">Filter:</span>
          {availableRegions.map(cc => {
            const meta = REGION_META[cc]
            const active = countryFilter.has(cc)
            return (
              <button
                key={cc}
                onClick={() => toggleCountryChip(cc)}
                className={`text-xs px-2.5 py-1 rounded-full border transition ${
                  active
                    ? 'bg-blue-600/30 border-blue-500/50 text-blue-300'
                    : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'
                }`}
              >
                {meta ? `${meta.flag} ${meta.label}` : cc.toUpperCase()}
              </button>
            )
          })}
          {countryFilter.size > 0 && (
            <button
              onClick={() => { setCountryFilter(new Set()); setCurrentPage(1) }}
              className="text-xs text-gray-600 hover:text-gray-300 ml-1 transition"
            >
              Clear
            </button>
          )}
          {/* Also show global chip if there are global pages */}
          {dropsWithRegion.some(d => d.region === 'global') && (
            <button
              onClick={() => toggleCountryChip('global')}
              className={`text-xs px-2.5 py-1 rounded-full border transition ${
                countryFilter.has('global')
                  ? 'bg-blue-600/30 border-blue-500/50 text-blue-300'
                  : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'
              }`}
            >
              🌐 Global
            </button>
          )}
        </div>
      )}

      {/* ── URL Filters ──────────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-5 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-white text-sm font-medium">🔽 URL Filters</p>
          <button
            onClick={() => { setIncludePages('/categories/'); setExcludePages('/offer/'); setExcludeQueries(''); resetPage() }}
            className="text-xs text-gray-500 hover:text-gray-300 transition"
          >
            Reset to default
          </button>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">
              Include URLs <span className="text-green-500">(must contain)</span>
            </label>
            <input
              type="text"
              value={includePages}
              onChange={e => { setIncludePages(e.target.value); resetPage() }}
              placeholder="e.g. /categories/"
              className="w-full bg-gray-800 border border-green-800/50 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-green-700 focus:border-transparent"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">
              Exclude URLs <span className="text-red-500">(must not contain)</span>
            </label>
            <input
              type="text"
              value={excludePages}
              onChange={e => { setExcludePages(e.target.value); resetPage() }}
              placeholder="e.g. /offer/, hydron"
              className="w-full bg-gray-800 border border-red-900/50 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Exclude queries (expanded view)</label>
            <input
              type="text"
              value={excludeQueries}
              onChange={e => setExcludeQueries(e.target.value)}
              placeholder="e.g. g2g, branded"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {pageInclusions.map(inc => (
            <span key={inc} className="text-xs bg-green-700/30 text-green-300 px-2 py-0.5 rounded-full">✓ {inc}</span>
          ))}
          {pageExclusions.map(ex => (
            <span key={ex} className="text-xs bg-red-700/30 text-red-300 px-2 py-0.5 rounded-full">✗ {ex}</span>
          ))}
          {queryExclusions.map(ex => (
            <span key={ex} className="text-xs bg-orange-700/30 text-orange-300 px-2 py-0.5 rounded-full">query: {ex}</span>
          ))}
          <span className="text-xs text-gray-600 ml-auto">
            {currentDrops.length - filtered.length > 0
              ? `${currentDrops.length - filtered.length} pages hidden by filters`
              : `${filtered.length} pages shown`}
          </span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-8 text-center">
          <p className="text-green-400 text-lg font-semibold">✅ No significant drops detected</p>
          <p className="text-gray-400 text-sm mt-1">
            {currentDrops.length > 0
              ? `${currentDrops.length} drop(s) hidden by your filters`
              : 'All tracked pages are within normal range for the past 7 days'}
          </p>
        </div>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          {/* Table header bar */}
          <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between gap-3">
            <p className="text-white font-medium text-sm">
              {filtered.length} page{filtered.length !== 1 ? 's' : ''} flagged
              {someSelected && <span className="ml-2 text-red-400">· {selected.size} selected</span>}
            </p>
            <div className="flex items-center gap-3">
              <span className="text-gray-600 text-xs hidden sm:inline">Click row to expand · Click header to sort</span>
              {/* Rows per page */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">Show:</span>
                {([20, 50, 100] as PageSize[]).map(n => (
                  <button
                    key={n}
                    onClick={() => { setPageSize(n); setCurrentPage(1) }}
                    className={`text-xs px-2 py-0.5 rounded transition ${
                      pageSize === n
                        ? 'bg-gray-700 text-white'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Table */}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleSelectAll}
                    title={allPageSelected ? 'Deselect all on page' : 'Select all on page'}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-red-500 cursor-pointer"
                  />
                </th>
                <th className="text-left text-gray-500 font-medium px-4 py-3">Page</th>
                {thProps('currentClicks', 'Clicks')}
                {thProps('previousClicks', 'Prev')}
                {thProps('clicksDrop', 'Drop %')}
                {thProps('impressionsDrop', 'Impr. drop')}
                {thProps('currentPosition', 'Position')}
                {thProps('positionChange', 'Pos Δ')}
                <th className="text-right text-gray-500 font-medium px-5 py-3">Queries</th>
              </tr>
            </thead>
            <tbody>
              {paginated.map(r => {
                let path = r.page
                try { path = new URL(r.page).pathname } catch { /* keep */ }
                const isExpanded = expandedPage === r.page
                const isSelected = selected.has(r.page)
                const visibleQueries = r.queries.filter(q =>
                  !queryExclusions.some(ex => q.query.toLowerCase().includes(ex))
                )
                const regionMeta = REGION_META[r.region]

                return (
                  <>
                    <tr
                      key={r.page}
                      onClick={() => setExpandedPage(prev => (prev === r.page ? null : r.page))}
                      className={`border-t border-gray-800 cursor-pointer transition ${
                        isSelected ? 'bg-red-500/10' : isExpanded ? 'bg-gray-800' : 'hover:bg-gray-800/50'
                      }`}
                    >
                      <td className="px-4 py-3" onClick={e => toggleSelect(r.page, e)}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-red-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                          <div className="min-w-0">
                            <a
                              href={r.page}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="text-blue-400 hover:text-blue-300 truncate block max-w-xs text-xs"
                              title={r.page}
                            >
                              {path}
                            </a>
                            {regionMeta && (
                              <span className="text-xs text-gray-600">{regionMeta.flag} {regionMeta.label}</span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className={`px-5 py-3 text-right font-medium ${sortKey === 'currentClicks' ? 'text-white' : 'text-gray-300'}`}>
                        {r.currentClicks.toLocaleString()}
                      </td>
                      <td className={`px-5 py-3 text-right ${sortKey === 'previousClicks' ? 'text-white' : 'text-gray-400'}`}>
                        {r.previousClicks.toLocaleString()}
                      </td>
                      <td className={`px-5 py-3 text-right font-semibold ${r.clicksDrop >= 0.15 ? 'text-red-400' : 'text-gray-400'}`}>
                        {r.clicksDrop > 0 ? `-${Math.round(r.clicksDrop * 100)}%` : '—'}
                      </td>
                      <td className={`px-5 py-3 text-right ${r.impressionsDrop >= 0.15 ? 'text-orange-400' : 'text-gray-400'}`}>
                        {r.impressionsDrop > 0 ? `-${Math.round(r.impressionsDrop * 100)}%` : '—'}
                      </td>
                      <td className={`px-5 py-3 text-right ${sortKey === 'currentPosition' ? 'text-white' : 'text-gray-300'}`}>
                        {r.currentPosition.toFixed(1)}
                      </td>
                      <td className={`px-5 py-3 text-right font-semibold ${r.positionChange >= 5 ? 'text-orange-400' : r.positionChange < 0 ? 'text-green-400' : 'text-gray-400'}`}>
                        {r.positionChange > 0 ? `+${r.positionChange.toFixed(1)}` : r.positionChange.toFixed(1)}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-500 text-xs">
                        {r.queries.length}
                      </td>
                    </tr>

                    {isExpanded && (
                      <tr key={`${r.page}-queries`} className="border-t border-gray-700">
                        <td colSpan={9} className="bg-gray-800/60 px-8 py-4">
                          <p className="text-xs text-gray-500 font-semibold uppercase tracking-wider mb-3">
                            Queries for this page (snapshot: {activeDate})
                            {queryExclusions.length > 0 && visibleQueries.length < r.queries.length && (
                              <span className="ml-2 text-orange-400 normal-case">
                                · {r.queries.length - visibleQueries.length} hidden by filter
                              </span>
                            )}
                          </p>
                          {visibleQueries.length === 0 ? (
                            <p className="text-gray-500 text-sm">No query data available.</p>
                          ) : (
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b border-gray-700">
                                  <th className="text-left text-gray-500 font-medium py-1.5 pr-4">Query</th>
                                  <th className="text-right text-gray-500 font-medium py-1.5 px-3">Clicks</th>
                                  <th className="text-right text-gray-500 font-medium py-1.5 px-3">Impressions</th>
                                  <th className="text-right text-gray-500 font-medium py-1.5 px-3">CTR</th>
                                  <th className="text-right text-gray-500 font-medium py-1.5 px-3">Position</th>
                                  <th className="w-8"></th>
                                </tr>
                              </thead>
                              <tbody>
                                {visibleQueries.map((q, i) => (
                                  <tr key={i} className="border-b border-gray-700/50 group">
                                    <td className="py-2 pr-4 text-gray-200 font-medium">{q.query}</td>
                                    <td className="py-2 px-3 text-right text-white">{q.clicks}</td>
                                    <td className="py-2 px-3 text-right text-gray-400">{q.impressions.toLocaleString()}</td>
                                    <td className="py-2 px-3 text-right text-gray-400">{(q.ctr * 100).toFixed(1)}%</td>
                                    <td className={`py-2 px-3 text-right font-medium ${q.position <= 10 ? 'text-green-400' : q.position <= 20 ? 'text-yellow-400' : 'text-gray-400'}`}>
                                      {q.position.toFixed(1)}
                                    </td>
                                    <td className="py-2 pl-1">
                                      <a
                                        href={`/content/keyword-map?add=${encodeURIComponent(q.query)}${q.impressions > 0 ? `&volume=${q.impressions}` : ''}`}
                                        title="Add to Keyword Map"
                                        className="opacity-0 group-hover:opacity-100 text-sm transition-opacity hover:scale-110 inline-block"
                                      >
                                        🗺️
                                      </a>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>

          {/* ── Pagination controls ───────────────────────────────────────── */}
          {totalPages > 1 && (
            <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-between">
              <span className="text-xs text-gray-500">
                Page {safePage} of {totalPages} · {filtered.length} results
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setCurrentPage(1)}
                  disabled={safePage === 1}
                  className="text-xs px-2 py-1 rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition"
                >
                  «
                </button>
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="text-xs px-2.5 py-1 rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition"
                >
                  ‹ Prev
                </button>
                {/* Page number pills */}
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  let page: number
                  if (totalPages <= 7) {
                    page = i + 1
                  } else if (safePage <= 4) {
                    page = i + 1
                  } else if (safePage >= totalPages - 3) {
                    page = totalPages - 6 + i
                  } else {
                    page = safePage - 3 + i
                  }
                  return (
                    <button
                      key={page}
                      onClick={() => setCurrentPage(page)}
                      className={`text-xs w-7 h-7 rounded transition ${
                        page === safePage
                          ? 'bg-red-700 text-white font-semibold'
                          : 'text-gray-400 hover:text-white hover:bg-gray-800'
                      }`}
                    >
                      {page}
                    </button>
                  )
                })}
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  className="text-xs px-2.5 py-1 rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition"
                >
                  Next ›
                </button>
                <button
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={safePage === totalPages}
                  className="text-xs px-2 py-1 rounded text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition"
                >
                  »
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Floating action bar ───────────────────────────────────────────── */}
      {someSelected && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4 bg-gray-900 border border-gray-600 rounded-2xl px-5 py-3 shadow-2xl shadow-black/40">
          <span className="text-white text-sm font-medium">
            {selected.size} page{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div className="w-px h-5 bg-gray-700" />
          <button
            onClick={() => setShowModal(true)}
            className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition"
          >
            Assign Next Action →
          </button>
          <button onClick={clearSelection} className="text-gray-400 hover:text-white text-sm transition">
            ✕ Clear
          </button>
        </div>
      )}

      {/* ── Recent alerts ────────────────────────────────────────────────── */}
      {alerts.length > 0 && (
        <div className="mt-8">
          <h2 className="text-white font-semibold mb-3">Recent Alerts</h2>
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.id} className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center justify-between">
                <p className="text-gray-300 text-sm">{a.title}</p>
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    a.severity === 'critical' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'
                  }`}>{a.severity}</span>
                  <span className="text-xs text-gray-500">{new Date(a.created_at).toLocaleDateString('id-ID')}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
