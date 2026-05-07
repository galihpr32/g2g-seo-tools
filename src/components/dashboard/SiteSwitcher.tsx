'use client'

import { useState, useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { getSiteSlugFromPath } from '@/lib/sites'

interface Site {
  slug: string
  label: string
  domain: string
  badge?: string   // optional 'beta' label
}

const SITES: Site[] = [
  { slug: 'g2g',       label: 'G2G',       domain: 'g2g.com' },
  { slug: 'offgamers', label: 'OffGamers', domain: 'offgamers.com' },
]

// Pages that support site switching (URL gets prefixed with /[site]/)
// Add more slugs here as pages are built out for each site
const SITE_AWARE_PATHS = ['/reports/weekly', '/reports/monthly']

export default function SiteSwitcher() {
  const pathname = usePathname()
  const router   = useRouter()
  const [open, setOpen] = useState(false)

  // Detect current site from URL (e.g. /offgamers/reports/weekly → offgamers)
  const currentSlug = getSiteSlugFromPath(pathname, SITES.map(s => s.slug))
  const currentSite = SITES.find(s => s.slug === currentSlug) ?? SITES[0]

  function switchSite(slug: string) {
    setOpen(false)
    if (slug === currentSlug) return

    // Persist active site so server-side (OAuth callback, API routes) knows which site
    // the user is working on. Both cookie (server-readable) and localStorage (client-readable).
    try {
      document.cookie = `active-site=${slug}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`
      localStorage.setItem('active-site', slug)
    } catch { /* ignore */ }

    // Strip the current site prefix if present so we can compute the
    // brand-agnostic path. e.g. `/g2g/reports/weekly` → `/reports/weekly`.
    let base = pathname
    const slugs = SITES.map(s => s.slug)
    const parts = pathname.split('/').filter(Boolean)
    if (parts.length > 0 && slugs.includes(parts[0])) {
      base = '/' + parts.slice(1).join('/')
    }

    // Two routing modes:
    //   1. Site-aware paths (`/reports/*`) have a `[site]/...` dynamic
    //      route — we re-prefix with the new slug so the new file/route
    //      handler loads.
    //   2. Every other page reads `useSiteSlug()` (cookie) on render —
    //      we stay on the SAME path and trigger a refresh so the new
    //      cookie value is picked up. Used to force-redirect users to
    //      `/reports/weekly` here, which lost their context every switch.
    const isSiteAware = SITE_AWARE_PATHS.some(p => base.startsWith(p) || base === p)
    if (isSiteAware) {
      router.push(`/${slug}${base}`)
    } else {
      // Same path, but force a re-render so server components see the new
      // active-site cookie. router.refresh() refetches RSC data; combined
      // with the cookie update above, the page renders for the new brand.
      router.push(base)
      router.refresh()
    }
  }

  // On mount: stamp the cookie so server-side always knows the active site
  // even when the user hasn't explicitly switched (first load, etc.)
  useEffect(() => {
    try {
      const stored = localStorage.getItem('active-site') ?? currentSite.slug
      document.cookie = `active-site=${stored}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`
    } catch { /* ignore */ }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative px-3 pb-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-750 border border-gray-700 transition group"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          <img
            src={`https://www.google.com/s2/favicons?domain=${currentSite.domain}&sz=16`}
            alt=""
            className="w-4 h-4 flex-shrink-0 rounded-sm"
          />
          <span className="text-sm font-medium text-white truncate">{currentSite.label}</span>
        </div>
        <svg
          className={`w-3.5 h-3.5 text-gray-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          {/* Dropdown */}
          <div className="absolute left-3 right-3 top-full mt-1 z-50 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Switch site</p>
            </div>
            <ul role="listbox" className="py-1">
              {SITES.map(site => {
                const active = site.slug === currentSlug
                return (
                  <li key={site.slug} role="option" aria-selected={active}>
                    <button
                      onClick={() => switchSite(site.slug)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition ${
                        active
                          ? 'bg-red-700/20 text-white'
                          : 'text-gray-300 hover:text-white hover:bg-gray-800'
                      }`}
                    >
                      <img
                        src={`https://www.google.com/s2/favicons?domain=${site.domain}&sz=16`}
                        alt=""
                        className="w-4 h-4 flex-shrink-0 rounded-sm"
                      />
                      <span className="flex-1 text-left font-medium">{site.label}</span>
                      <span className="text-[10px] text-gray-500">{site.domain}</span>
                      {active && (
                        <svg className="w-3.5 h-3.5 text-red-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
            <div className="px-3 py-2 border-t border-gray-800">
              <p className="text-[10px] text-gray-600">More tools coming for each site</p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
