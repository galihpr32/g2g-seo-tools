'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useState, useEffect } from 'react'
import SiteSwitcher from './SiteSwitcher'

const navItems = [
  {
    group: 'Overview',
    defaultOpen: true,
    items: [
      { label: 'Dashboard',           href: '/dashboard',       icon: '▦' },
      { label: 'Command Center',      href: '/command-center',  icon: '🧠' },
      { label: 'Campaigns',           href: '/campaigns',       icon: '🗂️' },
      { label: 'Team Performance',    href: '/team-performance', icon: '👥' },
      { label: 'Notifications',       href: '/notifications',   icon: '🔔' },
      { label: 'Settings',            href: '/settings',        icon: '⚙️' },
    ],
  },
  {
    group: 'GSC',
    defaultOpen: true,
    items: [
      { label: 'Clicks Drop Alert',   href: '/gsc/ranking-drop',     icon: '📉' },
      { label: 'Top Product Tracker', href: '/gsc/product-rankings', icon: '🎯' },
      { label: 'Action Items',        href: '/gsc/action-items',     icon: '✅' },
      { label: 'Index Coverage',      href: '/gsc/index-coverage',   icon: '🔍' },
      { label: 'Core Web Vitals',     href: '/gsc/core-web-vitals',  icon: '⚡' },
    ],
  },
  {
    group: 'Analytics',
    defaultOpen: false,
    items: [
      { label: 'Organic Traffic',     href: '/ga4/organic-traffic',     icon: '📈' },
      { label: 'Content Performance', href: '/ga4/content-performance', icon: '📄' },
    ],
  },
  {
    group: 'Content',
    defaultOpen: false,
    items: [
      { label: 'Game Trends',      href: '/content/trends',   icon: '🎮' },
      { label: 'Content Studio',  href: '/content/studio',   icon: '✍️' },
      { label: 'Product Content', href: '/content/products', icon: '📦' },
      { label: 'Knowledge Base',  href: '/knowledge-base',   icon: '🧠' },
    ],
  },
  {
    group: 'SEMrush',
    defaultOpen: false,
    items: [
      { label: 'Keyword Rankings',    href: '/semrush/rankings',    icon: '🎯' },
      { label: 'Site Audit',          href: '/semrush/site-audit',  icon: '🔧' },
      { label: 'Competitor Tracking', href: '/semrush/competitors', icon: '👁️' },
    ],
  },
  {
    group: 'Competitive',
    defaultOpen: false,
    items: [
      { label: 'Competitors',         href: '/competitive/competitors',  icon: '👁️' },
      { label: 'Keyword Gap',         href: '/competitive/keyword-gap',  icon: '🔍' },
      { label: 'Page Opportunities',  href: '/competitive/opportunities', icon: '🆕' },
      { label: 'SERP & Share of Voice', href: '/competitive/serp-tracker', icon: '📊' },
      { label: 'Page Analyzer',       href: '/competitive/page-analyzer', icon: '🔎' },
    ],
  },
  {
    group: 'Outreach',
    defaultOpen: false,
    items: [
      { label: 'Guestpost Outreach', href: '/outreach', icon: '🤝' },
    ],
  },
  {
    group: 'Tools',
    defaultOpen: false,
    items: [
      { label: 'URL Analysis',    href: '/tools/url-analysis', icon: '🔍' },
      { label: 'Backlink Tracker', href: '/backlinks',         icon: '🔗' },
      { label: 'API Cost Tracker', href: '/tools/api-costs',   icon: '💰' },
    ],
  },
  {
    group: 'Reports',
    defaultOpen: true,
    items: [
      { label: 'Weekly Pulse',   href: '/reports/weekly',       icon: '📊' },
      { label: 'Monthly SEO',    href: '/reports/monthly',      icon: '📅' },
      { label: 'Backlink Audit', href: '/reports/backlinks',    icon: '🔗' },
      { label: 'SERP Features',  href: '/reports/serp-features', icon: '⭐' },
    ],
  },
]

const KNOWN_SITE_SLUGS = ['g2g', 'offgamers']
const STORAGE_KEY = 'sidebar-collapsed-groups'

export default function Sidebar() {
  const pathname = usePathname()
  const router   = useRouter()
  const supabase = createClient()
  const [notifCount, setNotifCount]   = useState(0)
  const [isMember,   setIsMember]     = useState(false)
  // collapsed: Set of group names that are currently closed
  const [collapsed, setCollapsed]     = useState<Set<string>>(new Set())
  const [hydrated,  setHydrated]      = useState(false)

  // Detect current site from URL prefix
  const pathParts = pathname.split('/').filter(Boolean)
  const activeSite = pathParts.length > 0 && KNOWN_SITE_SLUGS.includes(pathParts[0])
    ? pathParts[0]
    : null

  // Hydrate collapsed state from localStorage (after mount to avoid SSR mismatch)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        setCollapsed(new Set(JSON.parse(saved)))
      } else {
        // First visit: collapse groups with defaultOpen=false
        const defaultCollapsed = navItems
          .filter(g => !g.defaultOpen)
          .map(g => g.group)
        setCollapsed(new Set(defaultCollapsed))
      }
    } catch { /* ignore */ }
    setHydrated(true)
  }, [])

  // Auto-expand the group containing the active page
  useEffect(() => {
    if (!hydrated) return
    const activeGroup = navItems.find(g =>
      g.items.some(item => pathname === item.href || pathname.startsWith(item.href + '/'))
    )
    if (activeGroup && collapsed.has(activeGroup.group)) {
      setCollapsed(prev => {
        const next = new Set(prev)
        next.delete(activeGroup.group)
        return next
      })
    }
  }, [pathname, hydrated]) // eslint-disable-line

  function toggleGroup(group: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(next))) } catch { /* ignore */ }
      return next
    })
  }

  // Fetch workspace role (to hide Settings from members)
  useEffect(() => {
    fetch('/api/workspace/role')
      .then(r => r.json())
      .then(d => setIsMember(d.isMember === true))
      .catch(() => {/* silent */})
  }, [])

  // Notifications count
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
    const interval = setInterval(fetchCount, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (pathname === '/notifications') setNotifCount(0)
  }, [pathname])

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const siteAwarePaths = ['/reports/weekly']

  return (
    <aside className="w-60 min-h-screen bg-gray-900 border-r border-gray-800 flex flex-col">
      {/* Brand */}
      <div className="px-5 pt-5 pb-3 border-b border-gray-800">
        <div className="flex items-center gap-2.5 mb-3">
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
        <SiteSwitcher />
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {navItems.map(group => {
          // Members don't see Settings
          const visibleItems = isMember
            ? group.items.filter(i => i.href !== '/settings')
            : group.items
          if (visibleItems.length === 0) return null
          const isCollapsed = hydrated && collapsed.has(group.group)
          const hasActiveItem = visibleItems.some(item => {
            const resolvedHref = activeSite && siteAwarePaths.includes(item.href)
              ? `/${activeSite}${item.href}`
              : item.href
            return pathname === item.href || pathname === resolvedHref
          })

          return (
            <div key={group.group} className="mb-1">
              {/* Group header — clickable to collapse */}
              <button
                onClick={() => toggleGroup(group.group)}
                className="w-full flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-gray-800/50 transition group"
              >
                <span className={`text-xs font-semibold uppercase tracking-wider transition ${
                  hasActiveItem ? 'text-gray-300' : 'text-gray-500 group-hover:text-gray-400'
                }`}>
                  {group.group}
                </span>
                <svg
                  className={`w-3 h-3 text-gray-600 flex-shrink-0 transition-transform duration-200 ${
                    isCollapsed ? '-rotate-90' : ''
                  }`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Group items */}
              {!isCollapsed && (
                <ul className="mt-0.5 mb-2 space-y-0.5">
                  {visibleItems.map(item => {
                    const resolvedHref = activeSite && siteAwarePaths.includes(item.href)
                      ? `/${activeSite}${item.href}`
                      : item.href
                    const active = pathname === item.href || pathname === resolvedHref

                    return (
                      <li key={item.href}>
                        <Link
                          href={resolvedHref}
                          className={`flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-sm transition ${
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
              )}
            </div>
          )
        })}
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
