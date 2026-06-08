'use client'

/**
 * Sprint #373 — Public Boss View report page.
 *
 * Renders a published snapshot fetched from
 * GET /api/public/reports/friday-kpi/boss-view/[slug] — no auth, no sidebar.
 *
 * This page lives at /reports/[slug] (root-level, NOT inside the (dashboard)
 * group) so it does not inherit the admin layout/sidebar/auth-guard. The
 * Boss View visualization itself is rendered by the shared
 * <BossViewContent /> component.
 */

import { useEffect, useState } from 'react'
import { BossViewContent, type Payload, type BossViewCommentary } from '@/components/reports/BossViewContent'

// Sprint #374 — the publish endpoint injects commentary into the payload,
// so we just read it back here.
type PublicPayload = Payload & { commentary?: BossViewCommentary | null }

export default function PublicReportPage({ params }: { params: Promise<{ slug: string }> }) {
  const [payload, setPayload] = useState<PublicPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ generatedAt?: string; publishedAt?: string } | null>(null)

  useEffect(() => {
    (async () => {
      const { slug } = await params
      try {
        const res = await fetch(`/api/public/reports/friday-kpi/boss-view/${slug}`)
        const ct = res.headers.get('content-type') ?? ''
        if (!res.ok || !ct.includes('application/json')) {
          setError(`HTTP ${res.status}: Report not found`)
          return
        }
        const data = await res.json() as {
          slug?: string
          payload?: PublicPayload
          generatedAt?: string
          publishedAt?: string
          error?: string
        }
        if (data.error)    { setError(data.error); return }
        if (!data.payload) { setError('No payload returned'); return }
        setPayload(data.payload)
        setMeta({ generatedAt: data.generatedAt, publishedAt: data.publishedAt })
      } catch (e) {
        setError(String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [params])

  return (
    <div className="min-h-screen bg-black">
      <div className="px-6 py-6 max-w-7xl mx-auto">
        <header className="flex items-start justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              🔍 Weekly Boss View
              <span className="text-xs px-2 py-0.5 bg-emerald-700/30 text-emerald-300 rounded font-normal">Public</span>
            </h1>
            <p className="text-sm text-gray-400 mt-1">
              {payload?.weekLabel ?? (loading ? 'Loading…' : '')}
              {meta?.publishedAt && (
                <span className="text-gray-600 ml-2">
                  · published {new Date(meta.publishedAt).toLocaleString()}
                </span>
              )}
            </p>
          </div>
        </header>
        <BossViewContent
          payload={payload}
          loading={loading}
          error={error}
          commentary={payload?.commentary ?? null}
        />
      </div>
    </div>
  )
}
