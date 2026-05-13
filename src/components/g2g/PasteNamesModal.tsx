'use client'

import { useState } from 'react'

// ─── Paste-Names → Match → Bulk Insert Modal ────────────────────────────────
// User pastes a list of product names (one per line). Tools fuzzy-match them
// to the canonical g2g_products catalog and lets the user confirm picks
// before bulk-inserting into the tier list — no manual relation_id or URL
// hunting required.
//
// Flow:
//   1. Paste names → click "Match against catalog"
//   2. Preview table:
//      - Exact match   → auto-accepted (green)
//      - Multiple      → dropdown to pick which service variant (Top Up vs Accounts vs …)
//      - Fuzzy ≥0.55   → suggested match shown with score; toggle on/off
//      - No match      → grey row, can't submit but visible for re-checking spelling
//   3. Pick Tier 1 or Tier 2 (or per-row if mixed)
//   4. Submit → POST to /api/product-tiers/bulk-from-catalog
//
// Catches:
//   - Same brand name can have multiple rows (Genshin Impact → Top Up + Accounts + Items).
//     Default behaviour for `multiple`: show dropdown so user picks ONE,
//     OR a "select all" checkbox to add every variant as a separate tier entry.

interface CatalogRow {
  relation_id:    string
  service_id:     string
  brand_id:       string
  service_name:   string
  brand_name:     string
  is_active:      boolean
  score?:         number
}

interface MatchResult {
  name_input:  string
  status:      'exact' | 'multiple' | 'fuzzy' | 'none'
  matches:     CatalogRow[]
  best_score?: number
}

interface MatchResponse {
  results:         MatchResult[]
  stats:           { total: number; exact: number; multiple: number; fuzzy: number; none: number }
  catalog_size:    number
  fuzzy_threshold: number
}

interface InsertResult {
  inserted: number
  updated:  number
  skipped:  { relation_id: string; reason: string }[]
}

interface Props {
  open:      boolean
  onClose:   () => void
  /** Caller refreshes its tier list after successful bulk insert. */
  onApplied: () => void
}

const SERVICE_PRESETS = [
  '', 'Accounts', 'Top Up', 'Items', 'Game coins', 'Gift Cards',
  'Platform Engagement', 'Game Coaching', 'GamePal', 'Activation Links',
]

export default function PasteNamesModal({ open, onClose, onApplied }: Props) {
  const [paste,   setPaste]   = useState('')
  const [service, setService] = useState('')   // optional category pre-filter
  const [tier,    setTier]    = useState<1 | 2>(1)
  const [matching, setMatching] = useState(false)
  const [results,  setResults]  = useState<MatchResult[]>([])
  const [stats,    setStats]    = useState<MatchResponse['stats'] | null>(null)
  const [picks,    setPicks]    = useState<Map<string, string>>(new Map())   // name_input → relation_id
  // For 'multiple' status: "all" mode adds every variant as separate tier entry
  const [allVariants, setAllVariants] = useState<Map<string, boolean>>(new Map())
  const [error,    setError]    = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [insertResult, setInsertResult] = useState<InsertResult | null>(null)

  async function runMatch() {
    const names = paste.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean)
    if (names.length === 0) {
      setError('Paste at least one product name (one per line).')
      return
    }
    setMatching(true)
    setError(null)
    setInsertResult(null)
    try {
      const res = await fetch('/api/product-tiers/match-names', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names, category: service || undefined }),
      })
      const data = await res.json() as MatchResponse & { error?: string }
      if (!res.ok || data.error) {
        setError(data.error ?? 'Match failed')
      } else {
        setResults(data.results)
        setStats(data.stats)
        // Auto-pre-pick: exact + fuzzy first match
        const initialPicks = new Map<string, string>()
        for (const r of data.results) {
          if (r.status === 'exact' && r.matches[0])  initialPicks.set(r.name_input, r.matches[0].relation_id)
          if (r.status === 'fuzzy' && r.matches[0])  initialPicks.set(r.name_input, r.matches[0].relation_id)
          // multiple → leave unset; user picks explicitly
        }
        setPicks(initialPicks)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setMatching(false)
  }

  function setPick(nameInput: string, relationId: string | null) {
    setPicks(prev => {
      const next = new Map(prev)
      if (relationId) next.set(nameInput, relationId)
      else            next.delete(nameInput)
      return next
    })
  }

  function toggleAllVariants(nameInput: string, on: boolean) {
    setAllVariants(prev => {
      const next = new Map(prev)
      if (on) next.set(nameInput, true)
      else    next.delete(nameInput)
      return next
    })
    if (on) {
      // Clear single-pick when "all variants" is on (we'll send every relation_id)
      setPick(nameInput, null)
    }
  }

  async function submitAccepted() {
    // Collect relation_ids: per row, either single pick OR all variants if toggle on
    const relIds = new Set<string>()
    for (const r of results) {
      if (allVariants.get(r.name_input)) {
        for (const m of r.matches) relIds.add(m.relation_id)
      } else {
        const picked = picks.get(r.name_input)
        if (picked) relIds.add(picked)
      }
    }
    if (relIds.size === 0) {
      setError('Pick at least one match before submitting.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/product-tiers/bulk-from-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, relation_ids: Array.from(relIds) }),
      })
      const data = await res.json() as InsertResult & { error?: string }
      if (!res.ok || data.error) {
        setError(data.error ?? 'Bulk insert failed')
      } else {
        setInsertResult(data)
        onApplied()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setSubmitting(false)
  }

  function close() {
    setPaste(''); setResults([]); setStats(null); setPicks(new Map())
    setAllVariants(new Map()); setError(null); setInsertResult(null); setService('')
    onClose()
  }

  if (!open) return null

  const acceptedCount = results.reduce((sum, r) => {
    if (allVariants.get(r.name_input)) return sum + r.matches.length
    if (picks.get(r.name_input))       return sum + 1
    return sum
  }, 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-white font-semibold">📝 Paste Names → Auto-Match Catalog</h2>
            <p className="text-xs text-gray-400 mt-0.5">Paste a list of product names, tools find their relation_id + URL from the canonical catalog automatically.</p>
          </div>
          <button onClick={close} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">
          {/* Step 1: paste names */}
          {results.length === 0 && !insertResult && (
            <>
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Product names — one per line. Brand names work best (e.g. <code className="text-blue-300">Path of Exile</code>, not <code className="text-blue-300">poe-currency</code>).
                </label>
                <textarea
                  rows={10}
                  value={paste}
                  onChange={e => setPaste(e.target.value)}
                  placeholder={'Path of Exile\nGenshin Impact\nValorant\nCounter-Strike 2\nDota 2\nFortnite'}
                  className="w-full bg-gray-950 border border-gray-700 rounded-md p-3 text-sm text-gray-200 font-mono focus:outline-none focus:border-blue-500"
                />
                <p className="text-[10px] text-gray-500 mt-1">
                  Up to 500 names per batch. Empty lines skipped.
                </p>
              </div>

              <div className="flex items-center gap-2 flex-wrap text-sm">
                <label className="text-gray-400">Optional category filter:</label>
                <select
                  value={service}
                  onChange={e => setService(e.target.value)}
                  className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200"
                >
                  {SERVICE_PRESETS.map(s => (
                    <option key={s} value={s}>{s || 'All categories'}</option>
                  ))}
                </select>
                <span className="text-[10px] text-gray-500">When set, only matches products in this category — useful when you want only Top Up variants, not Accounts.</span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={runMatch}
                  disabled={matching || !paste.trim()}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-md"
                >
                  {matching ? '⏳ Matching…' : '🔍 Match against catalog'}
                </button>
                {error && <span className="text-xs text-red-400">{error}</span>}
              </div>
            </>
          )}

          {/* Step 2: preview matches */}
          {results.length > 0 && !insertResult && (
            <>
              {stats && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <Pill tone="green">{stats.exact} exact</Pill>
                  <Pill tone="amber">{stats.multiple} multiple</Pill>
                  <Pill tone="blue">{stats.fuzzy} fuzzy</Pill>
                  <Pill tone="gray">{stats.none} no match</Pill>
                </div>
              )}

              <div className="rounded-lg border border-gray-800 bg-gray-950 max-h-[50vh] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="text-[10px] uppercase text-gray-500 border-b border-gray-800 sticky top-0 bg-gray-950">
                    <tr>
                      <th className="text-left px-2 py-1.5">Input</th>
                      <th className="text-left px-2 py-1.5">Status</th>
                      <th className="text-left px-2 py-1.5">Catalog Match</th>
                      <th className="text-left px-2 py-1.5">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r, idx) => {
                      const allOn = !!allVariants.get(r.name_input)
                      const pickedId = picks.get(r.name_input)
                      return (
                        <tr key={idx} className="border-b border-gray-800/40">
                          <td className="px-2 py-2 text-white align-top">{r.name_input}</td>
                          <td className="px-2 py-2 align-top">
                            <StatusBadge status={r.status} score={r.best_score} />
                          </td>
                          <td className="px-2 py-2 align-top">
                            {r.status === 'none' && <span className="text-gray-500 italic">no candidate</span>}
                            {r.status === 'exact' && (
                              <span className="text-gray-200">
                                <b>{r.matches[0].brand_name}</b>
                                <span className="text-gray-500"> · {r.matches[0].service_name}</span>
                              </span>
                            )}
                            {r.status === 'fuzzy' && (
                              <span className="text-gray-200">
                                <b>{r.matches[0].brand_name}</b>
                                <span className="text-gray-500"> · {r.matches[0].service_name} · {r.matches[0].score?.toFixed(2)}</span>
                              </span>
                            )}
                            {r.status === 'multiple' && (
                              <select
                                value={allOn ? '' : (pickedId ?? '')}
                                disabled={allOn}
                                onChange={e => setPick(r.name_input, e.target.value || null)}
                                className="bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-200 max-w-md"
                              >
                                <option value="">— pick service variant —</option>
                                {r.matches.map(m => (
                                  <option key={m.relation_id} value={m.relation_id}>{m.brand_name} · {m.service_name}</option>
                                ))}
                              </select>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top">
                            {r.status === 'multiple' && (
                              <label className="inline-flex items-center gap-1 text-[10px] text-gray-400">
                                <input
                                  type="checkbox"
                                  checked={allOn}
                                  onChange={e => toggleAllVariants(r.name_input, e.target.checked)}
                                />
                                Add all {r.matches.length} variants
                              </label>
                            )}
                            {(r.status === 'exact' || r.status === 'fuzzy') && (
                              <label className="inline-flex items-center gap-1 text-[10px] text-gray-400">
                                <input
                                  type="checkbox"
                                  checked={!!pickedId}
                                  onChange={e => setPick(r.name_input, e.target.checked ? r.matches[0].relation_id : null)}
                                />
                                Accept
                              </label>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <span className="text-sm text-gray-300">Add to:</span>
                {[1, 2].map(t => (
                  <button
                    key={t}
                    onClick={() => setTier(t as 1 | 2)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium border ${
                      tier === t
                        ? (t === 1 ? 'bg-amber-600 border-amber-500 text-white' : 'bg-blue-600 border-blue-500 text-white')
                        : 'border-gray-700 bg-gray-950 text-gray-300 hover:border-gray-500'
                    }`}
                  >
                    Tier {t}
                  </button>
                ))}
                <button
                  onClick={() => { setResults([]); setPicks(new Map()); setAllVariants(new Map()) }}
                  className="ml-auto text-xs text-gray-500 hover:text-gray-300"
                >
                  ← Edit list
                </button>
              </div>

              {error && <p className="text-xs text-red-400">❌ {error}</p>}
            </>
          )}

          {/* Step 3: result */}
          {insertResult && (
            <div className="rounded-md border border-green-700/40 bg-green-500/5 p-3 text-sm text-green-200 space-y-1">
              <p className="font-medium">✅ Done — added to Tier {tier}</p>
              <p>Inserted: <b>{insertResult.inserted}</b> · Updated: <b>{insertResult.updated}</b></p>
              {insertResult.skipped.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-amber-300 text-xs">⚠ {insertResult.skipped.length} skipped — why?</summary>
                  <ul className="mt-1 text-[10px] text-amber-200 list-disc pl-5">
                    {insertResult.skipped.slice(0, 20).map(s => (
                      <li key={s.relation_id}>{s.relation_id.slice(0, 8)}…: {s.reason}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-800 flex items-center justify-between shrink-0">
          <span className="text-xs text-gray-400">
            {results.length > 0 && !insertResult && (
              <>📌 <b className="text-white">{acceptedCount}</b> match{acceptedCount !== 1 ? 'es' : ''} accepted · adding to <b className={tier === 1 ? 'text-amber-300' : 'text-blue-300'}>Tier {tier}</b></>
            )}
          </span>
          <div className="flex gap-2">
            <button onClick={close} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-lg">
              {insertResult ? 'Done' : 'Cancel'}
            </button>
            {results.length > 0 && !insertResult && (
              <button
                onClick={submitAccepted}
                disabled={submitting || acceptedCount === 0}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg"
              >
                {submitting ? 'Saving…' : `Add ${acceptedCount} to Tier ${tier}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── UI bits ─────────────────────────────────────────────────────────────

function StatusBadge({ status, score }: { status: MatchResult['status']; score?: number }) {
  const map = {
    exact:    { color: 'bg-green-500/15 text-green-300 border-green-500/30', label: 'Exact' },
    multiple: { color: 'bg-amber-500/15 text-amber-300 border-amber-500/30', label: 'Multiple' },
    fuzzy:    { color: 'bg-blue-500/15  text-blue-300  border-blue-500/30',  label: `Fuzzy ${score?.toFixed(2) ?? ''}` },
    none:     { color: 'bg-gray-700/40  text-gray-400  border-gray-700',     label: 'No match' },
  }[status]
  return (
    <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${map.color}`}>{map.label}</span>
  )
}

function Pill({ tone, children }: { tone: 'green' | 'amber' | 'blue' | 'gray'; children: React.ReactNode }) {
  const c = {
    green: 'bg-green-500/15 text-green-300 border-green-500/30',
    amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    blue:  'bg-blue-500/15  text-blue-300  border-blue-500/30',
    gray:  'bg-gray-700/40  text-gray-300  border-gray-700',
  }[tone]
  return <span className={`inline-block px-2 py-0.5 rounded-full border ${c}`}>{children}</span>
}
