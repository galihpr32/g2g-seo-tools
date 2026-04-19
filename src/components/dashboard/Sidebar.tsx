'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useState, useEffect } from 'react'

const navItems = [
  {
    group: 'Overview',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: '▦' },
      { label: 'Campaigns', href: '/campaigns', icon: '🗂️' },
      { label: 'Team Performance', href: '/team-performance', icon: '👥' },
      { label: 'Notifications', href: '/notifications', icon: '🔔' },
      { label: 'Settings & Connections', href: '/settings', icon: '⚙️' },
    ],
  },
  {
    group: 'Daily — GSC',
    items: [
      { label: 'Clicks Drop Alert', href: '/gsc/ranking-drop', icon: '📉' },
      { label: 'Product Rankings', href: '/gsc/product-rankings', icon: '🎯' },
      { label: 'Action Items', href: '/gsc/action-items', icon: '🎯' },
      { label: 'Index Coverage', href: '/gsc/index-coverage', icon: '🔍' },
      { label: 'Core Web Vitals', href: '/gsc/core-web-vitals', icon: '⚡' },
    ],
  },
  {
    group: 'Weekly — GA4',
    items: [
      { label: 'Organic Traffic', href: '/ga4/organic-traffic', icon: '📈' },
      { label: 'Content Performance', href: '/ga4/content-performance', icon: '📄' },
    ],
  },
  {
    group: 'Weekly — Content',
    items: [
      { label: 'Content Briefs', href: '/content/briefs', icon: '✍️' },
      { label: 'Knowledge Base', href: '/knowledge-base', icon: '🧠' },
      { label: 'Meta Generator', href: '/content/meta', icon: '🏷️' },
    ],
  },
  {
    group: 'Weekly — SEMrush',
    items: [
      { label: 'Keyword Rankings', href: '/semrush/rankings', icon: '🎯' },
      { label: 'Keyword Clustering', href: '/semrush/clustering', icon: '🗂️' },
      { label: 'Site Audit Digest', href: '/semrush/site-audit', icon: '🔧' },
      { label: 'Competitor Tracking', href: '/semrush/competitors', icon: '👁️' },
    ],
  },
  {
    group: 'Tools',
    items: [
      { label: 'URL Analysis', href: '/tools/url-analysis', icon: '🔍' },
      { label: 'Backlink Tracker', href: '/backlinks', icon: '🔗' },
      { label: 'API Cost Tracker', href: '/tools/api-costs', icon: '💰' },
    ],
  },
  {
    group: 'Monthly',
    items: [
      { label: 'SEO Report', href: '/reports/monthly', icon: '📊' },
      { label: 'Backlink Audit', href: '/reports/backlinks', icon: '🔗' },
      { label: 'SERP Features', href: '/reports/serp-features', icon: '⭐' },
    ],
  },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router   = useRouter()
  const supabase = createClient()
  const [notifCount, setNotifCount] = useState(0)

  useEffect(() => {
    async function fetchCount() {
      try {
        const res = await fetch('/api/notifications/count')
        if (res.ok) {
          const data = await res.json()
          setNotifCount(data.count ?? 0)
        }
      } catch { /* silent */ }
    }
    fetchCount()
    const interval = setInterval(fetchCount, 5 * 60 * 1000) // refresh every 5 min
    return () => clearInterval(interval)
  }, [])

  // Clear badge when user navigates to notifications
  useEffect(() => {
    if (pathname === '/notifications') setNotifCount(0)
  }, [pathname])

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className="w-60 min-h-screen bg-gray-900 border-r border-gray-800 flex flex-col">
      {/* Brand */}
      <div className="px-5 py-5 border-b border-gray-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-red-700 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <div>
            <p className="text-white font-semibold text-sm leading-tight">G2G SEO Tools</p>
            <p className="text-gray-500 text-xs">Marketing · SEO</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {navItems.map(group => (
          <div key={group.group}>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-2 mb-1.5">
              {group.group}
            </p>
            <ul className="space-y-0.5">
              {group.items.map(item => {
                const active = pathname === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm transition ${
                        active
                          ? 'bg-red-700 text-white font-medium'
                          : 'text-gray-400 hover:text-white hover:bg-gray-800'
                      }`}
                    >
                      <span className="text-base leading-none">{item.icon}</span>
                      <span className="flex-1">{item.label}</span>
                      {item.href === '/notifications' && notifCount > 0 && (
                        <span className="ml-auto text-[10px] font-bold bg-red-600 text-white rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                          {notifCount > 99 ? '99+' : notifCount}
                        </span>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Sign out */}
      <div className="px-3 py-4 border-t border-gray-800">
        <button
          onClick={handleSignOut}
          className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-800 transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          Sign out
        </button>
      </div>
    </aside>
  )
}
