'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

// ─── Forseti · Subreddit Configuration ─────────────────────────────────────
// List of monitored subreddits with add/edit/pause/remove + per-sub "Fetch now"
// button that triggers the manual scraper endpoint.

type Preset = 'small_sub' | 'big_sub' | 'custom'

interface Config {
  id:                  string
  site_slug:           string
  subreddit:           string
  enabled:             boolean
  keyword_filter:      string
  severity_preset:     Preset
  sev5_min_upvotes:    number | null
  sev4_min_upvotes:    number | null
  sev5_min_comments:   number | null
  sev4_min_comments:   number | null
  status:              string
  last_error:          string | null
  last_polled_at:      string | null
  last_polled_threads: number
  total_threads:       number
  created_at:          string
}

export default function ForsetiSettingsPage() {
  const [configs,    setConfigs]    = useState<Config[]>([])
  const [loading,    setLoading]    = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)
  const [showAdd,    setShowAdd]    = useState(false)
  const [fetchingId, setFetchingId] = useState<string | null>(null)
  const [fetchMsg,   setFetchMsg]   = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const res  = await fetch('/api/forseti/configs')
        const data = await res.json()
        if (!cancelled) setConfigs(data.configs ?? [])
      } catch { if (!cancelled) setConfigs([]) }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [refreshTick])

  async function patchConfig(id: string, patch: Partial<Config>) {
    const res = await fetch(`/api/forseti/configs?id=${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(patch),
    })
    if (res.ok) setRefreshTick(t => t + 1)
  }

  async function deleteConfig(id: string, subreddit: string) {
    if (!confirm(`Remove r/${subreddit} from Forseti monitoring? Existing threads stay in history.`)) return
    const res = await fetch(`/api/forseti/configs?id=${id}`, { method: 'DELETE' })
    if (res.ok) setRefreshTick(t => t + 1)
  }

  async function fetchNow(id: string, subreddit: string) {
    setFetchingId(id); setFetchMsg(null)
    try {
      const res = await fetch('/api/forseti/scraper/run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ subreddit }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFetchMsg(`❌ r/${subreddit}: ${data.error ?? 'Failed'}`)
      } else {
        const s = data.summary
        setFetchMsg(`✅ r/${subreddit}: ${s.inserted} new · ${s.updated} updated · ${s.filtered} filtered`)
        setRefreshTick(t => t + 1)
      }
    } catch (e) {
      setFetchMsg(`❌ r/${subreddit}: ${e instanceof Error ? e.message : String(e)}`)
    }
    setFetchingId(null)
  }

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">⚖ Forseti · Subreddit Configuration</h1>
          <p className="text-sm text-gray-400 mt-1">
            Configure which subreddits the community-response tracker monitors. Add a sub here,
            then it shows up on the triage queue at <Link href="/forseti" className="text-purple-400 hover:underline">/forseti</Link>.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(o => !o)}
          className="px-3 py-2 bg-purple-700 hover:bg-purple-600 text-white text-sm font-medium rounded-lg transition"
        >
          {showAdd ? 'Cancel' : '+ Add subreddit'}
        </button>
      </div>

      {fetchMsg && (
        <div className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-200">
          {fetchMsg}
        </div>
      )}

      {showAdd && <AddForm onSaved={() => { setShowAdd(false); setRefreshTick(t => t + 1) }} />}

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : configs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-800 p-8 text-center text-gray-500 space-y-2">
          <p>No subreddits configured yet.</p>
          <p className="text-xs">Click <strong>+ Add subreddit</strong> to start monitoring one.</p>
          <p className="text-xs text-gray-600">Common starting points: r/G2G_com (dedicated complaint sub), r/MMORPG (mention filter), r/offgamers (OG dedicated).</p>
        </div>
      ) : (
        <div className="space-y-2">
          {configs.map(c => (
            <ConfigCard
              key={c.id}
              c={c}
              onPatch={patch => patchConfig(c.id, patch)}
              onDelete={() => deleteConfig(c.id, c.subreddit)}
              onFetchNow={() => fetchNow(c.id, c.subreddit)}
              fetching={fetchingId === c.id}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ConfigCard({ c, onPatch, onDelete, onFetchNow, fetching }: {
  c: Config
  onPatch: (p: Partial<Config>) => void
  onDelete: () => void
  onFetchNow: () => void
  fetching: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  // Pin `now` to mount-time using lazy initial state. The "Last polled X min
  // ago" display drifts across navigations — acceptable for status info that
  // updates every cron tick (~hourly) anyway.
  const [now] = useState<number>(() => Date.now())
  const lastPolled = c.last_polled_at ? new Date(c.last_polled_at) : null
  const minutesAgo = lastPolled ? Math.round((now - lastPolled.getTime()) / 60000) : null
  const statusTone =
    c.status === 'error'  ? 'border-red-700/40    bg-red-500/5    text-red-300'
    : !c.enabled          ? 'border-gray-800       bg-gray-900     text-gray-500'
    :                       'border-emerald-700/40 bg-emerald-500/5 text-emerald-200'

  return (
    <div className={`rounded-lg border p-3 ${statusTone}`}>
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white">
            r/{c.subreddit}
            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-current uppercase tracking-wide">
              {c.site_slug}
            </span>
            {!c.enabled && <span className="ml-2 text-[10px] text-gray-500">paused</span>}
            {c.status === 'error' && <span className="ml-2 text-[10px] text-red-400">⚠ error</span>}
          </h3>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Preset: <code className="text-gray-300">{c.severity_preset}</code>
            {c.keyword_filter && <> · filter: <code className="text-gray-300">{c.keyword_filter}</code></>}
          </p>
          <p className="text-[10px] text-gray-500 mt-0.5">
            {lastPolled ? <>Last polled {minutesAgo}m ago · {c.last_polled_threads} threads fetched</> : 'Never polled yet'}
            {' · '}
            Total tracked: {c.total_threads}
          </p>
          {c.status === 'error' && c.last_error && (
            <p className="text-[11px] text-red-300 mt-1">{c.last_error}</p>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={onFetchNow}
            disabled={fetching}
            className="px-2 py-1 bg-purple-700/40 hover:bg-purple-700/60 disabled:opacity-50 border border-purple-600/50 rounded text-purple-100"
          >
            {fetching ? '⏳' : '🔄 Fetch now'}
          </button>
          <button
            onClick={() => onPatch({ enabled: !c.enabled })}
            className="px-2 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-200"
          >
            {c.enabled ? 'Pause' : 'Resume'}
          </button>
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-gray-400 hover:text-gray-200"
          >
            {expanded ? '▴ Less' : '▾ Edit'}
          </button>
          <button onClick={onDelete} className="text-red-400 hover:text-red-300">Remove</button>
        </div>
      </div>

      {expanded && (
        <ConfigEditPanel c={c} onPatch={onPatch} />
      )}
    </div>
  )
}

function ConfigEditPanel({ c, onPatch }: { c: Config; onPatch: (p: Partial<Config>) => void }) {
  const [filter,  setFilter]  = useState(c.keyword_filter)
  const [preset,  setPreset]  = useState<Preset>(c.severity_preset)
  const [siteVal, setSiteVal] = useState(c.site_slug)
  const [sev5u, setSev5u] = useState<string>(c.sev5_min_upvotes  != null ? String(c.sev5_min_upvotes)  : '')
  const [sev4u, setSev4u] = useState<string>(c.sev4_min_upvotes  != null ? String(c.sev4_min_upvotes)  : '')
  const [sev5c, setSev5c] = useState<string>(c.sev5_min_comments != null ? String(c.sev5_min_comments) : '')
  const [sev4c, setSev4c] = useState<string>(c.sev4_min_comments != null ? String(c.sev4_min_comments) : '')

  function save() {
    onPatch({
      keyword_filter:    filter,
      severity_preset:   preset,
      site_slug:         siteVal,
      sev5_min_upvotes:  preset === 'custom' ? (parseInt(sev5u, 10) || null) : null,
      sev4_min_upvotes:  preset === 'custom' ? (parseInt(sev4u, 10) || null) : null,
      sev5_min_comments: preset === 'custom' ? (parseInt(sev5c, 10) || null) : null,
      sev4_min_comments: preset === 'custom' ? (parseInt(sev4c, 10) || null) : null,
    })
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-800 space-y-2 text-xs">
      <div className="flex flex-wrap gap-3 items-center">
        <label className="flex items-center gap-1.5">
          <span className="text-gray-400 w-20">Site:</span>
          <select value={siteVal} onChange={e => setSiteVal(e.target.value)} className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200">
            <option value="g2g">G2G</option>
            <option value="offgamers">OffGamers</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-gray-400 w-24">Preset:</span>
          <select value={preset} onChange={e => setPreset(e.target.value as Preset)} className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200">
            <option value="small_sub">small_sub (sev5 at 20+up / 15+cmt)</option>
            <option value="big_sub">big_sub (sev5 at 50+up / 30+cmt)</option>
            <option value="custom">custom</option>
          </select>
        </label>
      </div>
      <label className="flex items-center gap-1.5">
        <span className="text-gray-400 w-24">Keyword filter:</span>
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder='e.g. "g2g, g2g.com" — leave empty for dedicated subs'
          className="flex-1 bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200 placeholder:text-gray-600"
        />
      </label>
      {preset === 'custom' && (
        <div className="flex flex-wrap gap-2 items-center">
          <label className="flex items-center gap-1">sev5 ≥ <input type="number" value={sev5u} onChange={e => setSev5u(e.target.value)} className="w-14 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200" /> up</label>
          <label className="flex items-center gap-1">or <input type="number" value={sev5c} onChange={e => setSev5c(e.target.value)} className="w-14 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200" /> cmt</label>
          <span className="text-gray-600">·</span>
          <label className="flex items-center gap-1">sev4 ≥ <input type="number" value={sev4u} onChange={e => setSev4u(e.target.value)} className="w-14 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200" /> up</label>
          <label className="flex items-center gap-1">or <input type="number" value={sev4c} onChange={e => setSev4c(e.target.value)} className="w-14 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-gray-200" /> cmt</label>
        </div>
      )}
      <button onClick={save} className="px-2.5 py-1 bg-purple-600 hover:bg-purple-500 rounded text-white">Save changes</button>
    </div>
  )
}

function AddForm({ onSaved }: { onSaved: () => void }) {
  const [subreddit, setSubreddit] = useState('')
  const [site,      setSite]      = useState('g2g')
  const [preset,    setPreset]    = useState<Preset>('small_sub')
  const [filter,    setFilter]    = useState('')
  const [busy,      setBusy]      = useState(false)
  const [err,       setErr]       = useState<string | null>(null)

  async function submit() {
    if (!subreddit.trim()) { setErr('Subreddit name required'); return }
    setBusy(true); setErr(null)
    try {
      const res = await fetch('/api/forseti/configs', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          subreddit:       subreddit.trim(),
          site_slug:       site,
          severity_preset: preset,
          keyword_filter:  filter.trim(),
          enabled:         true,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErr(data.error ?? 'Failed')
      } else {
        setSubreddit(''); setFilter('')
        onSaved()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  return (
    <div className="rounded-lg border border-purple-700/40 bg-purple-950/10 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-white">Add subreddit</h2>
      <div className="flex flex-wrap gap-2 items-center text-xs">
        <label className="flex items-center gap-1.5">
          <span className="text-gray-400">Subreddit:</span>
          <span className="text-gray-600">r/</span>
          <input
            type="text"
            value={subreddit}
            onChange={e => setSubreddit(e.target.value)}
            placeholder="G2G_com"
            className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200 w-48"
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-gray-400">Site:</span>
          <select value={site} onChange={e => setSite(e.target.value)} className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200">
            <option value="g2g">G2G</option>
            <option value="offgamers">OffGamers</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-gray-400">Preset:</span>
          <select value={preset} onChange={e => setPreset(e.target.value as Preset)} className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200">
            <option value="small_sub">small_sub</option>
            <option value="big_sub">big_sub</option>
          </select>
        </label>
      </div>
      <label className="flex items-center gap-1.5 text-xs">
        <span className="text-gray-400">Keyword filter:</span>
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder='Optional — comma list e.g. "g2g, g2g.com"'
          className="flex-1 bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200 placeholder:text-gray-600"
        />
      </label>
      <div className="flex items-center gap-2">
        <button onClick={submit} disabled={busy} className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm rounded">
          {busy ? 'Adding…' : 'Add'}
        </button>
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
    </div>
  )
}
