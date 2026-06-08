'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useState, useEffect } from 'react'
import SiteSwitcher from './SiteSwitcher'
import { useBrandTheme } from '@/lib/hooks/useBrandTheme'

const navItems = [
  {
    group: 'PIPELINE',
    defaultOpen: true,
    items: [
      { label: 'Dashboard',         href: '/dashboard',                    icon: '▦'  },
      { label: 'Priority Products', href: '/priority-products',            icon: '🎯' },
      { label: 'Keyword Master',    href: '/priority-products/keywords',   icon: '🔑' },
      { label: 'Opportunities',     href: '/command-center/opportunities', icon: '🔍' },
      { label: 'Pipeline Journey',  href: '/command-center/pipeline',      icon: '🗺️' },
      { label: 'Command Center',  href: '/command-center',                 icon: '🤖' },
      { label: 'Action Items',    href: '/gsc/action-items',               icon: '✅' },
      { label: 'Experiments',     href: '/experiments',                    icon: '🧪' },
      { label: 'Mimir Memory',    href: '/mimir/memories',                 icon: '🧠' },
      { label: 'Mimir Onpage Learn', href: '/mimir/onpage-learn',          icon: '📐' },
      // Sprint HUGIN.SIDEBAR — long-tail discovery
      { label: 'Hugin · Long-tail',  href: '/hugin',                       icon: '🪶' },
      { label: 'Off-Page Pipeline', href: '/command-center/off-page',      icon: '🔗' },
      { label: 'Notifications',   href: '/notifications',                  icon: '🔔' },
      { label: 'Feedback',        href: '/feedback',                       icon: '🐛' },
    ],
  },
  {
    group: 'CONTENT',
    defaultOpen: false,
    items: [
      { label: 'Brief Library',      href: '/content/briefs',          icon: '📚' },
      { label: 'Writer Inbox',       href: '/content/writer-inbox',    icon: '✍️' },
      { label: 'Editorial Calendar', href: '/content/calendar',        icon: '📅' },
      { label: 'Content Studio',     href: '/content/studio',          icon: '📝' },
      { label: 'Product Content',    href: '/content/products',        icon: '📦' },
      { label: 'Knowledge Base',     href: '/knowledge-base',          icon: '🧠' },
      { label: 'KB Proposals',       href: '/knowledge-base/proposals', icon: '💡' },
      { label: 'Game Trends',        href: '/content/trends',          icon: '🎮' },
      { label: 'News Signals',       href: '/content/news-signals',    icon: '📰' },
      { label: 'Keyword Map',        href: '/content/keyword-map',          icon: '🗺️' },
      { label: 'Clusters',           href: '/clusters',                     icon: '📚' },
      { label: 'Keyword Exclusions', href: '/content/keyword-exclusions',   icon: '🚫' },
      { label: 'Internal Links',     href: '/content/internal-links',       icon: '🔗' },
      { label: 'Cannibalization',    href: '/content/cannibalization',      icon: '🍖' },
      { label: 'Broken URLs',        href: '/content/broken-urls',          icon: '🔴' },
    ],
  },
  {
    group: 'COMPETITIVE',
    defaultOpen: false,
    items: [
      { label: 'Keyword Rankings',      href: '/semrush/rankings',          icon: '🏷️' },
      { label: 'Keyword Gap',           href: '/competitive/keyword-gap',   icon: '🔍' },
      { label: 'SERP & Share of Voice', href: '/competitive/serp-tracker',  icon: '📊' },
      { label: 'Competitors',           href: '/competitive/competitors',   icon: '👁️' },
      { label: 'Page Analyzer',         href: '/competitive/page-analyzer', icon: '🔎' },
      { label: 'Backlink Gap',          href: '/competitive/backlink-gap',  icon: '🕵️' },
    ],
  },
  {
    group: 'SITE HEALTH',
    defaultOpen: false,
    items: [
      { label: 'Clicks Drop Alert',   href: '/gsc/ranking-drop',        icon: '📉' },
      { label: 'Site Health Overview', href: '/site-health',            icon: '🛡️' },
      { label: 'Schema Health',       href: '/site-health/schema',      icon: '🧬' },
      { label: 'Broken Internal',    href: '/site-health/broken-internal', icon: '🔴' },
      { label: 'PageSpeed (PSI)',     href: '/site-health/psi',         icon: '⚡' },
      { label: 'Top Product Tracker', href: '/gsc/product-rankings',    icon: '🎯' },
      { label: 'Index Coverage',      href: '/gsc/index-coverage',      icon: '🔍' },
      { label: 'Core Web Vitals',     href: '/gsc/core-web-vitals',     icon: '⚡' },
      { label: 'Site Audit',          href: '/semrush/site-audit',      icon: '🔧' },
      { label: 'Organic Traffic',     href: '/ga4/organic-traffic',     icon: '📈' },
      { label: 'Content Performance', href: '/ga4/content-performance', icon: '📄' },
    ],
  },
  {
    group: 'ACQUISITION',
    defaultOpen: false,
    items: [
      { label: 'Guestpost Outreach', href: '/outreach',    icon: '🤝' },
      { label: 'Backlink Tracker',   href: '/backlinks',   icon: '🔗' },
      // Sprint FORSETI.SIDEBAR — community response tracker
      { label: 'Forseti · Reddit',   href: '/forseti',     icon: '⚖' },
    ],
  },
  {
    group: 'REPORTS',
    defaultOpen: true,
    items: [
      { label: 'Weekly Pulse',     href: '/reports/weekly',             icon: '📊' },
      { label: 'Friday KPI',       href: '/reports/friday-kpi',         icon: '🗓' },
      { label: 'Weekly Snapshot',  href: '/reports/friday-kpi/boss-view', icon: '📸' },
      { label: 'AI Visibility',    href: '/reports/ai-visibility',      icon: '🔮' },
      { label: 'Monthly SEO',      href: '/reports/monthly',            icon: '📅' },
      { label: 'Agent Performance', href: '/reports/agent-performance', icon: '🤖' },
      { label: 'Rollout Impact',    href: '/reports/rollout-impact',    icon: '📈' },
      { label: 'Content Economics', href: '/reports/content-economics', icon: '⏱' },
      { label: 'Learning Loop',     href: '/reports/learning-loop',     icon: '🎓' },
      { label: 'Mimir Learning',    href: '/reports/mimir-learning',    icon: '🧠' },
      { label: 'Multi-Market',   href: '/reports/multi-market',   icon: '🌍' },
      { label: 'Backlink Audit', href: '/reports/backlinks',      icon: '🔗' },
      { label: 'SERP Features',  href: '/reports/serp-features',  icon: '⭐' },
      { label: 'Content ROI',    href: '/reports/content-roi',    icon: '💰' },
      { label: 'Ranking Impact', href: '/reports/ranking-impact', icon: '📈' },
    ],
  },
  {
    group: 'SETTINGS',
    defaultOpen: false,
    items: [
      { label: 'Settings',          href: '/settings',                          icon: '⚙️' },
      { label: 'Team Performance',  href: '/team-performance',                  icon: '👥' },
      { label: 'Campaigns',         href: '/campaigns',                         icon: '🗂️' },
      { label: 'API Cost Tracker',  href: '/tools/api-costs',                   icon: '💰' },
      { label: 'URL Analysis',      href: '/tools/url-analysis',                icon: '🔬' },
      { label: 'Schema Generator',  href: '/tools/schema-generator',            icon: '🧬' },
      { label: 'KW Methodology',    href: '/methodology/competitive-keywords',  icon: '📐' },
    ],
  },
]

const KNOWN_SITE_SLUGS = ['g2g', 'offgamers']
const STORAGE_KEY = 'sidebar-collapsed-groups'

// ── Tour launcher with per-role shortcuts ────────────────────────────────────
const TOUR_ROLES = [
  { id: 'seo_manager', label: 'SEO Manager', icon: '🎯' },
  { id: 'writer',      label: 'Writer',       icon: '✍️' },
  { id: 'executive',   label: 'Executive',    icon: '📊' },
] as const

function TourLauncher() {
  const [open, setOpen] = useState(false)

  function launchAs(roleId: string) {
    localStorage.removeItem('onboarding-completed')
    localStorage.setItem('onboarding-role', roleId)
    setOpen(false)
    window.location.reload()
  }

  return (
    <div className="relative">
      {/* Role dropdown (opens above) */}
      {open && (
        <>
          {/* Backdrop to close */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-full left-0 right-0 mb-1 z-20 bg-gray-800 border border-gray-700 rounded-xl shadow-xl overflow-hidden">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500 px-3 pt-2.5 pb-1.5">
              Preview as role
            </p>
            {TOUR_ROLES.map(role => (
              <button
                key={role.id}
                onClick={() => launchAs(role.id)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-700/60 transition text-left"
              >
                <span className="text-base leading-none">{role.icon}</span>
                {role.label}
              </button>
            ))}
            <div className="border-t border-gray-700/50 mt-1">
              <button
                onClick={() => {
                  localStorage.removeItem('onboarding-completed')
                  localStorage.removeItem('onboarding-role')
                  setOpen(false)
                  window.location.reload()
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-700/40 transition text-left"
              >
                ↺ Reset role + restart
              </button>
            </div>
          </div>
        </>
      )}

      {/* Main button */}
      <button
        onClick={() => setOpen(prev => !prev)}
        className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm text-indigo-400 hover:text-indigo-200 hover:bg-indigo-900/30 border border-indigo-800/40 hover:border-indigo-600/50 transition"
      >
        <span className="text-base leading-none flex-shrink-0">🧭</span>
        <span className="flex-1 text-left font-medium">Wizard Guide</span>
        <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    </div>
  )
}

export default function Sidebar() {
  const pathname = usePathname()
  const router   = useRouter()
  const supabase = createClient()
  const theme    = useBrandTheme()   // Sprint THEME.BRAND
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

  // Keep this aligned with DYNAMIC_SITE_PATHS in src/middleware.ts.
  // These are the routes with an App Router `[site]/...` dynamic segment;
  // every other page reads the site via cookie / useSiteSlug() so the
  // un-prefixed path works fine.
  const siteAwarePaths = ['/reports/weekly', '/reports/monthly']

  return (
    <aside className="w-60 h-screen sticky top-0 bg-gray-900 border-r border-gray-800 flex flex-col overflow-hidden">
      {/* Brand — Sprint THEME.BRAND: workspace block adapts to active site */}
      <div className="px-5 pt-5 pb-3 border-b border-gray-800">
        <div className="flex items-center gap-2.5 mb-3">
          <div className={`w-8 h-8 rounded-lg ${theme.bgPrimary} flex items-center justify-center flex-shrink-0 text-base`}>
            <span aria-hidden>{theme.emoji}</span>
          </div>
          <div>
            <p className="text-white font-semibold text-sm leading-tight">{theme.name} SEO Tools</p>
            <p className="text-gray-500 text-xs">Marketing · SEO</p>
          </div>
        </div>
        <SiteSwitcher />
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {navItems.map(group => {
          // All users can see Settings (members can at least manage their own profile)
          const visibleItems = group.items
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
                              ? `${theme.bgPrimary} text-white font-medium`
                              : 'text-gray-400 hover:text-white hover:bg-gray-800'
                          }`}
                        >
                          <span className="text-base leading-none">{item.icon}</span>
                          <span className="flex-1">{item.label}</span>
                          {item.href === '/notifications' && notifCount > 0 && (
                            <span className={`ml-auto text-[10px] font-bold ${theme.badgeBg} text-white rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1`}>
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

      {/* Wizard + Sign out — always pinned at bottom */}
      <div className="px-3 py-3 border-t border-gray-800 space-y-1 flex-shrink-0">
        {/* Tour launcher — click main button OR pick a role directly */}
        <TourLauncher />
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
