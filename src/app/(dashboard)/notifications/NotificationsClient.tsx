'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

const STALE_DAYS    = 7
const ETA_WARN_DAYS = 3
const DISMISS_KEY   = 'dismissed-notifications'

// ── Types ─────────────────────────────────────────────────────────────────────
export type ActionItem = {
  id: string; page: string; action_type: 'on_page' | 'off_page'
  status: string; notes: string | null; assigned_to: string | null
  created_at: string; snapshot_date: string
}

export type EtaPage = {
  id: string; page_url: string; notes: string | null; eta: string; status: string
  campaign_id: string; campaign_name: string; campaign_color: string
}

export type DmcaBriefHit = {
  briefId: string
  briefPage: string
  briefTitle: string | null
  actionItemId: string | null
  terms: Array<{ hitId: string; original: string; replacement: string; detectedAt: string }>
}

interface Props {
  staleItems:      ActionItem[]
  unassignedItems: ActionItem[]
  etaPages:        EtaPage[]
  dmcaBriefHits:   DmcaBriefHit[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pagePath(url: string) {
  try { return new URL(url).pathname } catch { return url }
}

function daysAgo(dateStr: string) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000)
}

function daysUntil(dateStr: string) {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000)
}

function initials(email: string) {
  const parts = email.split('@')[0].split(/[._-]/)
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || (email[0]?.toUpperCase() ?? '?')
}

// ── Sub-components ────────────────────────────────────────────────────────────
function NotifCard({
  item, badge, onDismiss,
}: {
  item: ActionItem
  badge: React.ReactNode
  onDismiss: () => void
}) {
  const path     = pagePath(item.page)
  const isOnPage = item.action_type === 'on_page'
  return (
    <div className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl px-4 py-3 flex items-center gap-4 transition">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${isOnPage ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' : 'text-purple-400 bg-purple-500/10 border-purple-500/20'}`}>
            {isOnPage ? '✏️ On-Page' : '📣 Off-Page'}
          </span>
          {badge}
          {item.assigned_to && (
            <span className="inline-flex items-center gap-1 text-xs text-gray-400 bg-gray-800 border border-gray-700 px-2 py-0.5 rounded-full">
              <span className="w-4 h-4 rounded-full bg-indigo-600 flex items-center justify-center text-[9px] font-bold text-white">
                {initials(item.assigned_to)}
              </span>
              {item.assigned_to.split('@')[0]}
            </span>
          )}
        </div>
        <p className="text-blue-400 text-sm font-medium truncate" title={item.page}>{path}</p>
        {item.notes && <p className="text-gray-500 text-xs mt-0.5 truncate">{item.notes}</p>}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <Link href={`/gsc/action-items/${item.id}`}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white transition">
          View →
        </Link>
        <button
          onClick={onDismiss}
          title="Dismiss"
          className="text-xs px-2 py-1.5 rounded-lg border border-gray-700 text-gray-600 hover:border-gray-500 hover:text-gray-300 transition"
        >
          ✓
        </button>
      </div>
    </div>
  )
}

function EtaCard({ page, onDismiss }: { page: EtaPage; onDismiss: () => void }) {
  const until  = daysUntil(page.eta)
  const overdue = until < 0
  const today   = until === 0
  const path    = pagePath(page.page_url)

  return (
    <div className={`bg-gray-900 border rounded-xl px-4 py-3 flex items-center gap-4 transition ${overdue ? 'border-red-800/50 hover:border-red-700/50' : 'border-gray-800 hover:border-gray-700'}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border border-gray-700 text-gray-300">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: page.campaign_color }} />
            {page.campaign_name}
          </span>
          {overdue ? (
            <span className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full">
              Overdue by {Math.abs(until)}d
            </span>
          ) : today ? (
            <span className="text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2 py-0.5 rounded-full">
              Due today
            </span>
          ) : (
            <span className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 rounded-full">
              Due in {until}d
            </span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded-full border ${
            page.status === 'in_progress'
              ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
              : 'text-gray-400 bg-gray-800 border-gray-700'
          }`}>
            {page.status === 'in_progress' ? 'In progress' : 'Not started'}
          </span>
        </div>
        <p className="text-blue-400 text-sm font-medium truncate" title={page.page_url}>{path}</p>
        {page.notes && <p className="text-gray-500 text-xs mt-0.5 truncate">{page.notes}</p>}
        <p className="text-gray-600 text-xs mt-0.5">ETA: {page.eta}</p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <Link href="/campaigns"
          className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white transition">
          View →
        </Link>
        <button
          onClick={onDismiss}
          title="Dismiss"
          className="text-xs px-2 py-1.5 rounded-lg border border-gray-700 text-gray-600 hover:border-gray-500 hover:text-gray-300 transition"
        >
          ✓
        </button>
      </div>
    </div>
  )
}

// ── Main client component ─────────────────────────────────────────────────────
export default function NotificationsClient({ staleItems, unassignedItems, etaPages, dmcaBriefHits }: Props) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  // Hydrate from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DISMISS_KEY)
      if (saved) setDismissed(new Set(JSON.parse(saved)))
    } catch { /* ignore */ }
  }, [])

  function dismiss(id: string) {
    setDismissed(prev => {
      const next = new Set(prev)
      next.add(id)
      try { localStorage.setItem(DISMISS_KEY, JSON.stringify(Array.from(next))) } catch { /* ignore */ }
      return next
    })
  }

  function dismissAll() {
    const allIds = [
      ...staleItems.map(i => `action-${i.id}`),
      ...unassignedItems.map(i => `action-${i.id}`),
      ...etaPages.map(p => `eta-${p.id}`),
      ...dmcaBriefHits.map(h => `dmca-${h.briefId}`),
    ]
    setDismissed(prev => {
      const next = new Set([...prev, ...allIds])
      try { localStorage.setItem(DISMISS_KEY, JSON.stringify(Array.from(next))) } catch { /* ignore */ }
      return next
    })
  }

  // De-duplicate stale + unassigned, then filter dismissed
  const staleIds       = new Set(staleItems.map(i => i.id))
  const unassignedOnly = unassignedItems.filter(i => !staleIds.has(i.id))

  const visibleStale     = staleItems.filter(i => !dismissed.has(`action-${i.id}`))
  const visibleUnassigned = unassignedOnly.filter(i => !dismissed.has(`action-${i.id}`))
  const visibleEta       = etaPages.filter(p => !dismissed.has(`eta-${p.id}`))
  const visibleDmca      = dmcaBriefHits.filter(h => !dismissed.has(`dmca-${h.briefId}`))

  const totalNotifs = visibleStale.length + visibleUnassigned.length + visibleEta.length + visibleDmca.length

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">🔔 Notifications</h1>
          {totalNotifs > 0 && (
            <span className="text-sm font-semibold bg-red-600 text-white rounded-full px-2.5 py-0.5">
              {totalNotifs}
            </span>
          )}
          {totalNotifs > 0 && (
            <button
              onClick={dismissAll}
              className="ml-auto text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white transition"
            >
              ✓ Mark all as read
            </button>
          )}
        </div>
        <p className="text-gray-400 text-sm mt-1">Tasks and campaign pages that need attention</p>
      </div>

      {totalNotifs === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-4xl mb-3">✅</p>
          <p className="text-white font-medium">All clear!</p>
          <p className="text-gray-500 text-sm mt-1">No items need attention right now.</p>
        </div>
      ) : (
        <div className="space-y-8">

          {/* ── ETA overdue / upcoming ─────────────────────────────── */}
          {visibleEta.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-orange-400 text-lg">📅</span>
                <h2 className="text-white font-semibold">
                  Campaign ETAs
                  <span className="ml-2 text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2 py-0.5 rounded-full font-normal">
                    {visibleEta.length}
                  </span>
                </h2>
              </div>
              <p className="text-gray-500 text-xs mb-3">
                Campaign pages that are overdue or due within {ETA_WARN_DAYS} days.
              </p>
              <div className="space-y-2">
                {visibleEta.map(p => (
                  <EtaCard key={p.id} page={p} onDismiss={() => dismiss(`eta-${p.id}`)} />
                ))}
              </div>
            </section>
          )}

          {/* ── DMCA hits ─────────────────────────────────────────── */}
          {visibleDmca.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-red-400 text-lg">🚫</span>
                <h2 className="text-white font-semibold">
                  DMCA Terms in Published Briefs
                  <span className="ml-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full font-normal">
                    {visibleDmca.length}
                  </span>
                </h2>
              </div>
              <p className="text-gray-500 text-xs mb-3">
                Published briefs containing restricted terms. Open the brief to edit and resolve.
              </p>
              <div className="space-y-2">
                {visibleDmca.map(hit => {
                  const path = (() => { try { return new URL(hit.briefPage).pathname } catch { return hit.briefPage } })()
                  return (
                    <div key={hit.briefId} className="bg-gray-900 border border-red-800/40 hover:border-red-700/60 rounded-xl px-4 py-3 flex items-center gap-4 transition">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full">
                            🚫 {hit.terms.length} restricted term{hit.terms.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                        <p className="text-blue-400 text-sm font-medium truncate" title={hit.briefPage}>{path}</p>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {hit.terms.map(t => (
                            <span key={t.hitId} className="text-xs font-mono bg-red-900/40 border border-red-700/50 text-red-300 px-1.5 py-0.5 rounded">
                              {t.original} → {t.replacement}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {hit.actionItemId && (
                          <Link href={`/gsc/action-items/${hit.actionItemId}`}
                            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white transition">
                            View Brief →
                          </Link>
                        )}
                        <button
                          onClick={() => dismiss(`dmca-${hit.briefId}`)}
                          title="Dismiss"
                          className="text-xs px-2 py-1.5 rounded-lg border border-gray-700 text-gray-600 hover:border-gray-500 hover:text-gray-300 transition"
                        >
                          ✓
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* ── Stale in-progress ────────────────────────────────────── */}
          {visibleStale.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-red-400 text-lg">⏰</span>
                <h2 className="text-white font-semibold">
                  Stale In Progress
                  <span className="ml-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full font-normal">
                    {visibleStale.length}
                  </span>
                </h2>
              </div>
              <p className="text-gray-500 text-xs mb-3">
                Items in progress for more than {STALE_DAYS} days.
              </p>
              <div className="space-y-2">
                {visibleStale.map(item => (
                  <NotifCard key={item.id} item={item} onDismiss={() => dismiss(`action-${item.id}`)} badge={
                    <span className="text-xs text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full">
                      {daysAgo(item.created_at)}d in progress
                    </span>
                  } />
                ))}
              </div>
            </section>
          )}

          {/* ── Unassigned in-progress ───────────────────────────────── */}
          {visibleUnassigned.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-yellow-400 text-lg">👤</span>
                <h2 className="text-white font-semibold">
                  Unassigned In Progress
                  <span className="ml-2 text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 rounded-full font-normal">
                    {visibleUnassigned.length}
                  </span>
                </h2>
              </div>
              <p className="text-gray-500 text-xs mb-3">
                Items in progress with no one assigned.
              </p>
              <div className="space-y-2">
                {visibleUnassigned.map(item => (
                  <NotifCard key={item.id} item={item} onDismiss={() => dismiss(`action-${item.id}`)} badge={
                    <span className="text-xs text-yellow-500 bg-yellow-500/10 px-2 py-0.5 rounded-full">Unassigned</span>
                  } />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
