'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'

/**
 * /mimir/onpage-learn — Sprint MIMIR.ONPAGE
 *
 * Step 1: pick T1/T2 pages to learn from (multi-select)
 * Step 2: pick which on-page dimensions to extract (multi-select, default all)
 * Step 3: choose Replace vs Append
 * Step 4: kick off the job → poll progress per dimension → see results
 *
 * The actual extraction happens in a background after() — this page just
 * orchestrates: collects content, posts the job, polls for status.
 */

const DIMENSIONS = [
  { value: 'h1_pattern',          label: 'H1 / Title structure',     hint: 'Where keyword sits, length, format conventions' },
  { value: 'intro_pattern',       label: 'Lead paragraph style',     hint: 'Hook style, length, time-to-keyword' },
  { value: 'h2_cadence',          label: 'Section cadence (H2)',     hint: 'Number of H2s + recurring themes' },
  { value: 'trust_signal_usage',  label: 'Trust signal placement',   hint: 'Where GamerProtect / ISO / payment refs appear' },
  { value: 'cta_pattern',         label: 'Call-to-action style',     hint: 'Imperative vs benefit-led; frequency' },
  { value: 'internal_link_style', label: 'Internal linking style',   hint: 'Anchor text + link density patterns' },
] as const

type Dimension = typeof DIMENSIONS[number]['value']

interface TierProduct {
  id:               string
  product_name:     string
  url:              string | null
  tier:             1 | 2
  category:         string | null
  restriction_type: string | null
}

interface JobStatus {
  id:                string
  status:            'pending' | 'running' | 'completed' | 'failed'
  page_count:        number
  total_steps:       number
  completed_steps:   number
  current_dimension: string | null
  progress_pct:      number
  total_inserted:    number
  total_deleted:     number
  per_dimension:     Array<{
    dimension: string
    patterns:  string[]
    examples:  string[]
    inserted:  number
    deleted:   number
    error?:    string
  }> | null
  error_message:     string | null
  completed_at:      string | null
}

export default function MimirOnpageLearnPage() {
  const siteSlug = useSiteSlug()

  // ── State ──────────────────────────────────────────────────────────────────
  const [products, setProducts]    = useState<TierProduct[]>([])
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [selected, setSelected]    = useState<Set<string>>(new Set())
  const [tierFilter, setTierFilter]  = useState<'all' | '1' | '2'>('all')
  const [dimensions, setDimensions]= useState<Set<Dimension>>(new Set(DIMENSIONS.map(d => d.value)))
  const [replace, setReplace]      = useState(false)
  const [submitting, setSubmitting]= useState(false)
  const [job, setJob]              = useState<JobStatus | null>(null)
  const [fetchErrors, setFetchErrors] = useState<string[]>([])

  // ── Load T1/T2 products with URLs ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLoadingProducts(true)
    fetch('/api/product-tiers')
      .then(r => r.json())
      .then((data: { items?: TierProduct[] }) => {
        if (cancelled) return
        setProducts((data.items ?? []).filter(p => !!p.url))
      })
      .finally(() => { if (!cancelled) setLoadingProducts(false) })
    return () => { cancelled = true }
  }, [siteSlug])

  const visible = useMemo(() => {
    return products.filter(p => tierFilter === 'all' || String(p.tier) === tierFilter)
  }, [products, tierFilter])

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleDimension(d: Dimension) {
    setDimensions(prev => {
      const next = new Set(prev)
      if (next.has(d)) next.delete(d); else next.add(d)
      return next
    })
  }

  function selectAllVisible() {
    setSelected(prev => {
      const next = new Set(prev)
      for (const p of visible) next.add(p.id)
      return next
    })
  }
  function clearSelection() { setSelected(new Set()) }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function startJob() {
    setSubmitting(true)
    setFetchErrors([])
    try {
      // Fetch the live HTML of each selected page (best-effort).
      // For pages we can't fetch, we skip them with a warning.
      const picked = products.filter(p => selected.has(p.id) && p.url)
      const fetches = await Promise.all(picked.map(async p => {
        try {
          const res = await fetch(`/api/tools/fetch-page-text?url=${encodeURIComponent(p.url!)}`)
          if (!res.ok) return { url: p.url!, content: '', productName: p.product_name, error: `HTTP ${res.status}` }
          const body = await res.json() as { text?: string }
          return { url: p.url!, content: String(body.text ?? ''), productName: p.product_name }
        } catch (e) {
          return { url: p.url!, content: '', productName: p.product_name, error: e instanceof Error ? e.message : String(e) }
        }
      }))

      const usable = fetches.filter(f => f.content && f.content.trim().length >= 50)
      const failed = fetches.filter(f => !f.content || f.content.trim().length < 50)
      if (failed.length > 0) {
        setFetchErrors(failed.map(f => `${f.url}: ${'error' in f ? f.error : 'empty / too short'}`))
      }
      if (usable.length < 2) {
        alert('Need at least 2 pages with fetchable content. Check the errors below.')
        setSubmitting(false)
        return
      }

      const res = await fetch('/api/mimir/onpage/learn', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          pages:      usable.map(u => ({ url: u.url, content: u.content, productName: u.productName })),
          dimensions: Array.from(dimensions),
          replace,
        }),
      })
      const data = await res.json() as { job_id?: string; error?: string }
      if (!res.ok || !data.job_id) {
        alert(`Failed to start: ${data.error ?? res.status}`)
        return
      }
      // Start polling
      pollJob(data.job_id)
    } finally {
      setSubmitting(false)
    }
  }

  function pollJob(jobId: string) {
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      try {
        const res = await fetch(`/api/mimir/onpage/learn/${jobId}`)
        if (res.ok) {
          const data = await res.json() as JobStatus
          setJob(data)
          if (data.status === 'completed' || data.status === 'failed') return
        }
      } catch { /* network blip, retry */ }
      setTimeout(tick, 2000)
    }
    tick()
    return () => { cancelled = true }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto">
      <Link href="/mimir/memories" className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 mb-2">
        ← Mimir memories
      </Link>
      <h1 className="text-2xl font-bold text-white mb-1">🧠 On-page Pattern Learner</h1>
      <p className="text-sm text-gray-400 mb-6">
        Teach Mimir what good on-page SEO looks like by feeding it your best-performing T1/T2 pages.
        It extracts patterns across 6 dimensions and writes them as <em>rule</em>-type memories scoped to <strong className="text-white">{siteSlug.toUpperCase()}</strong>.
      </p>

      {/* STEP 1 — Page picker */}
      <Section title="1 · Pick pages to learn from" hint={`${selected.size} selected`}>
        <div className="flex items-center gap-2 mb-3 text-xs">
          <span className="text-gray-500">Tier filter:</span>
          {(['all', '1', '2'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTierFilter(t)}
              className={`px-2 py-1 rounded border ${tierFilter === t ? 'bg-blue-500/15 border-blue-500/40 text-blue-300' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}
            >
              {t === 'all' ? 'All' : `Tier ${t}`}
            </button>
          ))}
          <span className="text-gray-700 mx-2">·</span>
          <button onClick={selectAllVisible} className="px-2 py-1 rounded border bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700">Select all visible</button>
          <button onClick={clearSelection}   className="px-2 py-1 rounded border bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700">Clear</button>
        </div>
        {loadingProducts ? (
          <p className="text-sm text-gray-500">Loading products…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-gray-500">No T1/T2 products with URLs found. Set product URLs in /settings/product-tiers first.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-96 overflow-y-auto pr-2">
            {visible.map(p => {
              const isOn = selected.has(p.id)
              return (
                <label
                  key={p.id}
                  className={`flex items-start gap-2 p-2 rounded border cursor-pointer transition ${
                    isOn ? 'bg-blue-500/10 border-blue-500/40' : 'bg-gray-900 border-gray-800 hover:bg-gray-800/50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isOn}
                    onChange={() => toggle(p.id)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                        p.tier === 1 ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                      }`}>T{p.tier}</span>
                      <span className="text-sm text-white truncate">{p.product_name}</span>
                      {p.restriction_type && (
                        <span className="text-[9px] font-bold text-red-300 bg-red-500/15 px-1 rounded border border-red-500/30" title={`${p.restriction_type} restricted`}>
                          {p.restriction_type === 'DMCA' ? '🚫' : '⚠️'}
                        </span>
                      )}
                    </div>
                    {p.url && <p className="text-[10px] text-gray-500 truncate">{p.url}</p>}
                  </div>
                </label>
              )
            })}
          </div>
        )}
      </Section>

      {/* STEP 2 — Dimensions */}
      <Section title="2 · Pick dimensions to learn" hint={`${dimensions.size} of ${DIMENSIONS.length}`}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {DIMENSIONS.map(d => {
            const on = dimensions.has(d.value)
            return (
              <label
                key={d.value}
                className={`flex items-start gap-2 p-2.5 rounded border cursor-pointer transition ${
                  on ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-gray-900 border-gray-800 hover:bg-gray-800/50'
                }`}
              >
                <input type="checkbox" checked={on} onChange={() => toggleDimension(d.value)} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white">{d.label}</p>
                  <p className="text-[10px] text-gray-500">{d.hint}</p>
                </div>
              </label>
            )
          })}
        </div>
      </Section>

      {/* STEP 3 — Strategy + Run */}
      <Section title="3 · Strategy + Run">
        <label className="flex items-start gap-2 text-sm text-gray-200 mb-3 cursor-pointer">
          <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} className="mt-0.5" />
          <span>
            <strong className="text-white">Replace existing on-page memories</strong> for the selected dimensions
            (overwrite old patterns instead of appending).
            <br />
            <span className="text-[11px] text-gray-500">Recommended after a brand voice update; otherwise leave off.</span>
          </span>
        </label>

        <button
          onClick={startJob}
          disabled={submitting || selected.size < 2 || dimensions.size === 0 || (job?.status === 'running' || job?.status === 'pending')}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition"
        >
          {submitting ? 'Submitting…' : `🧠 Learn from ${selected.size} page${selected.size !== 1 ? 's' : ''} × ${dimensions.size} dimension${dimensions.size !== 1 ? 's' : ''}`}
        </button>

        {fetchErrors.length > 0 && (
          <div className="mt-3 bg-amber-900/20 border border-amber-700/30 rounded-lg p-3 text-xs text-amber-200 space-y-1">
            <p className="font-semibold">⚠️ Some pages couldn&apos;t be fetched (skipped):</p>
            {fetchErrors.map((e, i) => <p key={i} className="font-mono text-[11px] truncate">• {e}</p>)}
          </div>
        )}
      </Section>

      {/* PROGRESS / RESULTS */}
      {job && (
        <section className="mt-6 bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-white">
              {job.status === 'completed' ? '✅ Done' : job.status === 'failed' ? '❌ Failed' : '⏳ Running'} — Job {job.id.slice(0, 8)}
            </h2>
            <span className="text-xs text-gray-400">{job.completed_steps}/{job.total_steps} dimensions · {job.progress_pct}%</span>
          </div>
          <div className="h-2 bg-gray-800 rounded-full overflow-hidden mb-4">
            <div
              className="h-full transition-all"
              style={{ width: `${job.progress_pct}%`, backgroundColor: job.status === 'failed' ? '#ef4444' : '#3b82f6' }}
            />
          </div>
          {job.current_dimension && job.status === 'running' && (
            <p className="text-xs text-gray-400 mb-3">Now analyzing: <code className="text-amber-300">{job.current_dimension}</code></p>
          )}

          {job.error_message && (
            <p className="text-xs text-red-400 mb-3">Error: {job.error_message}</p>
          )}

          {job.per_dimension && job.per_dimension.length > 0 && (
            <div className="space-y-3 mt-4">
              {job.per_dimension.map((d, i) => (
                <div key={i} className="bg-gray-950/40 border border-gray-800 rounded-lg p-3">
                  <div className="flex items-baseline justify-between mb-2">
                    <h3 className="text-sm font-semibold text-white">{d.dimension}</h3>
                    <span className="text-[10px] text-gray-500">
                      {d.deleted > 0 && `🗑 ${d.deleted} deleted · `}
                      {d.inserted > 0 ? <span className="text-emerald-400">+{d.inserted} memories</span> : <span className="text-gray-500">no patterns</span>}
                    </span>
                  </div>
                  {d.error ? (
                    <p className="text-xs text-red-400 italic">Error: {d.error}</p>
                  ) : d.patterns.length === 0 ? (
                    <p className="text-xs text-gray-500 italic">No recurring patterns found in this dimension.</p>
                  ) : (
                    <ul className="space-y-1 text-xs text-gray-200">
                      {d.patterns.map((p, j) => <li key={j} className="flex gap-1.5"><span className="text-gray-600">▸</span><span>{p}</span></li>)}
                    </ul>
                  )}
                </div>
              ))}
              <div className="bg-emerald-900/15 border border-emerald-700/40 rounded-lg p-3 mt-3 text-xs">
                <p className="text-emerald-200">
                  <strong>Summary:</strong> {job.total_inserted} new pattern{job.total_inserted !== 1 ? 's' : ''} saved as Mimir memories
                  {job.total_deleted > 0 && `, ${job.total_deleted} old memories replaced`}.
                  Mimir will use these the next time Bragi generates a brief for this site.
                </p>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-bold text-white">{title}</h2>
        {hint && <span className="text-[11px] text-gray-500">{hint}</span>}
      </div>
      {children}
    </section>
  )
}
