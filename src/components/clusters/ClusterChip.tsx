'use client'

/**
 * ClusterChip — surface the brand→sub-product cluster a page or keyword
 * belongs to, anywhere in the app.
 *
 * Usage:
 *   <ClusterChip pageUrl="https://www.g2g.com/categories/wow-gold" />
 *   <ClusterChip keyword="buy wow gold" />
 *
 * Lazy-loads from /api/clusters/lookup. Renders nothing while loading or
 * if no match (so it's safe to drop into table cells without layout
 * shift). Each chip is a Link to /clusters/[id] for full drill-down.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface MatchedCluster {
  id:         string
  topic:      string
  topic_slug: string
  brand:      { id: string; topic: string; topic_slug: string } | null
}

interface Props {
  pageUrl?: string
  keyword?: string
  /** Compact mode hides the brand prefix (just shows sub-product) */
  compact?: boolean
}

export default function ClusterChip({ pageUrl, keyword, compact = false }: Props) {
  const [clusters, setClusters] = useState<MatchedCluster[] | null>(null)

  useEffect(() => {
    if (!pageUrl && !keyword) return
    const ctrl = new AbortController()
    const params = new URLSearchParams()
    if (pageUrl) params.set('page_url', pageUrl)
    if (keyword) params.set('keyword', keyword)
    fetch(`/api/clusters/lookup?${params.toString()}`, { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : { clusters: [] })
      .then((d: { clusters?: MatchedCluster[] }) => setClusters(d.clusters ?? []))
      .catch(() => setClusters([]))
    return () => ctrl.abort()
  }, [pageUrl, keyword])

  if (!clusters || clusters.length === 0) return null

  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {clusters.map(c => (
        <Link
          key={c.id}
          href={`/clusters/${c.id}`}
          onClick={e => e.stopPropagation()}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-purple-900/30 text-purple-300 border border-purple-800/60 hover:border-purple-500 hover:bg-purple-900/50 transition"
          title={c.brand ? `${c.brand.topic} → ${c.topic}` : c.topic}
        >
          {!compact && c.brand && (
            <span className="text-purple-400/70">{c.brand.topic}</span>
          )}
          {!compact && c.brand && <span className="text-purple-700">›</span>}
          <span>{c.topic}</span>
        </Link>
      ))}
    </span>
  )
}
