'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'

// ─── Off-Page Command Center ────────────────────────────────────────────────
// Dedicated panel for everything outreach-related — equivalent to Pipeline
// Journey but filtered to off-page / outreach work. Surfaces Hermod findings
// (referring-domain gaps, outreach prospects) inline so the SEO team has a
// single place to manage link-building campaigns.

interface OutreachOpportunity {
  id:                string
  topic:             string
  topicSlug:         string | null
  outputType:        string | null
  signalCount:       number
  totalSv:           number
  status:            string
  briefId:           string | null
  matchedRelationId: string | null
  matchedBrandName:  string | null
  lastSignalAt:      string | null
  createdAt:         string
}

interface BacklinkGapRow {
  domain:    string
  rank:      number
  backlinks: number
  competitor: string
}

interface OutreachProspect {
  id:           string
  domain:       string
  contact_email: string | null
  status:       string
  topic:        string | null
  updated_at:   string
}

export default function OffPagePage() {
  const siteSlug = useSiteSlug()
  const [tab, setTab] = useState<'opportunities' | 'gaps' | 'prospects'>('opportunities')

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">🔗 Off-Page Command Center</h1>
          <p className="text-sm text-gray-400 mt-1">
            Outreach pipeline for <strong className="text-white">{siteSlug.toUpperCase()}</strong> —
            link-building opportunities, competitor referring-domain gaps from Hermod,
            and active outreach prospects in one panel.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/command-center/pipeline" className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition border border-gray-700">
            📍 On-page Pipeline →
          </Link>
          <Link href="/competitive/backlink-gap" className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition border border-gray-700">
            🔍 Backlink Gap →
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-gray-800">
        {([
          { key: 'opportunities', label: '🎯 Outreach Opportunities', desc: 'Opportunities with output_type=outreach' },
          { key: 'gaps',          label: '📈 Hermod Gaps',           desc: "Competitor referring domains we don't have" },
          { key: 'prospects',     label: '💬 Active Prospects',      desc: 'Contacted, awaiting reply' },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            title={t.desc}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
              tab === t.key
                ? 'border-blue-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'opportunities' && <OpportunitiesTab siteSlug={siteSlug} />}
      {tab === 'gaps'          && <GapsTab          siteSlug={siteSlug} />}
      {tab === 'prospects'     && <ProspectsTab     siteSlug={siteSlug} />}
    </div>
  )
}

// ─── Opportunities tab (output_type='outreach') ────────────────────────────

function OpportunitiesTab({ siteSlug }: { siteSlug: string }) {
  const [items,   setItems]   = useState<OutreachOpportunity[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const res = await fetch(`/api/pipeline-journey?output_type=outreach&site=${siteSlug}&limit=200`)
        const data = await res.json() as { items?: OutreachOpportunity[] }
        if (!cancelled) setItems(data.items ?? [])
      } catch {
        if (!cancelled) setItems([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [siteSlug])

  if (loading) return <div className="text-center py-12 text-gray-500">Loading…</div>
  if (!items.length) {
    return (
      <div className="rounded-lg border border-dashed border-gray-800 p-8 text-center text-gray-500">
        No outreach opportunities yet. Run Loki/Hermod to surface keyword gaps with linkable competitor angles.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {items.map(item => (
        <div key={item.id} className="rounded-lg border border-gray-800 bg-gray-900 p-3 hover:border-blue-700/40 transition">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <Link href={`/content/topics/${item.topicSlug ?? item.id}`} className="text-sm font-medium text-white hover:text-blue-300">
                {item.topic}
              </Link>
              <p className="text-xs text-gray-500 mt-0.5">
                {item.signalCount} signal{item.signalCount !== 1 ? 's' : ''}
                {item.totalSv > 0 && <> · {item.totalSv.toLocaleString()} total SV</>}
                {item.matchedBrandName && <> · → <span className="text-emerald-300">{item.matchedBrandName}</span></>}
              </p>
            </div>
            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
              item.status === 'brief_ready'  ? 'border-green-700  text-green-300 bg-green-500/10'  :
              item.status === 'brief_queued' ? 'border-blue-700   text-blue-300  bg-blue-500/10'   :
              item.status === 'in_review'    ? 'border-amber-700  text-amber-300 bg-amber-500/10'  :
                                               'border-gray-700   text-gray-400  bg-gray-800/50'
            }`}>
              {item.status.replace('_', ' ')}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Hermod gaps tab (Backlink Gap snapshot) ───────────────────────────────

function GapsTab({ siteSlug }: { siteSlug: string }) {
  const [rows,    setRows]    = useState<BacklinkGapRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await fetch(`/api/competitive/backlink-gap?site=${siteSlug}`)
        const data = await res.json() as { error?: string; ourDomain?: string; competitors?: Array<{ competitor: string; gaps: BacklinkGapRow[]; note?: string }> }
        if (data.error) {
          if (!cancelled) setError(`${data.error}`)
        } else {
          const flat = (data.competitors ?? []).flatMap(c => c.gaps.map(g => ({ ...g, competitor: c.competitor })))
          if (!cancelled) setRows(flat)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [siteSlug])

  if (loading) return <div className="text-center py-12 text-gray-500">Querying DataForSEO…</div>
  if (error)   return <div className="rounded-lg border border-red-700/40 bg-red-500/5 p-4 text-sm text-red-300">⚠ {error}</div>
  if (!rows.length) {
    return (
      <div className="rounded-lg border border-dashed border-gray-800 p-8 text-center text-gray-500">
        No referring-domain gaps detected. Add tracked competitors at <Link href="/competitive" className="text-blue-400 underline">/competitive</Link>.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase text-gray-500 border-b border-gray-800 bg-gray-900/60">
          <tr>
            <th className="text-left px-3 py-2">Domain</th>
            <th className="text-left px-3 py-2">Rank</th>
            <th className="text-left px-3 py-2">Backlinks</th>
            <th className="text-left px-3 py-2">From competitor</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map(r => (
            <tr key={`${r.competitor}-${r.domain}`} className="border-b border-gray-800/40">
              <td className="px-3 py-2 text-white">{r.domain}</td>
              <td className="px-3 py-2 text-amber-300">{r.rank}</td>
              <td className="px-3 py-2 text-gray-300">{r.backlinks.toLocaleString()}</td>
              <td className="px-3 py-2 text-gray-400 text-xs">{r.competitor}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Prospects tab ──────────────────────────────────────────────────────────

function ProspectsTab({ siteSlug }: { siteSlug: string }) {
  const [items,   setItems]   = useState<OutreachProspect[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const res = await fetch(`/api/outreach/prospects?site=${siteSlug}&status=contacted`)
        const data = await res.json() as { prospects?: OutreachProspect[]; items?: OutreachProspect[] }
        if (!cancelled) setItems(data.prospects ?? data.items ?? [])
      } catch {
        if (!cancelled) setItems([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [siteSlug])

  const grouped = useMemo(() => {
    const map = new Map<string, OutreachProspect[]>()
    for (const p of items) {
      const k = p.status
      map.set(k, [...(map.get(k) ?? []), p])
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length)
  }, [items])

  if (loading) return <div className="text-center py-12 text-gray-500">Loading prospects…</div>
  if (!items.length) {
    return (
      <div className="rounded-lg border border-dashed border-gray-800 p-8 text-center text-gray-500">
        No prospects yet. Discover at <Link href="/outreach" className="text-blue-400 underline">/outreach</Link>.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {grouped.map(([status, prospects]) => (
        <details key={status} className="rounded-lg border border-gray-800 bg-gray-900">
          <summary className="cursor-pointer px-3 py-2 text-sm text-white font-medium">
            {status} <span className="text-gray-500">({prospects.length})</span>
          </summary>
          <div className="border-t border-gray-800">
            {prospects.map(p => (
              <div key={p.id} className="px-3 py-2 border-b border-gray-800/40 last:border-0 flex items-center justify-between text-sm">
                <Link href={`/outreach`} className="text-white hover:text-blue-300">{p.domain}</Link>
                <span className="text-xs text-gray-500">{p.contact_email ?? '—'}</span>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  )
}
