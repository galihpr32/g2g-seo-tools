'use client'

import { useState, useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'

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

  // Source of truth = the same hook that every other client component uses
  // when calling APIs. Previously this read pathname only, which lied when
  // the user was on a non-prefixed page (e.g. /experiments) but cookie said
  // 'offgamers' — causing UI to display G2G while data layer pulled OffGamers.
  // Bug fix 2026-05-08 (Mimir cross-site contamination).
  const currentSlug = useSiteSlug()
  const currentSite = SITES.find(s => s.slug === currentSlug) ?? SITES[0]

  function switchSite(slug: string) {
    setOpen(false)
    if (slug === currentSlug) return

    // Sprint 11 / URL Prefix 3 — URL is now the source of truth.
    // We push to /<newSite>/<currentPath> and let the middleware:
    //   1. Strip the prefix and rewrite to the un-prefixed page
    //   2. Set the active-site cookie to the new value
    //   3. Pass through Supabase auth + page render
    //
    // We still write the cookie + localStorage + dispatch the same-tab
    // event eagerly, because the URL push is async and `useSiteSlug()`
    // consumers shouldn't show stale data even for the few ms between
    // click and route resolution.
    try {
      // eslint-disable-next-line react-hooks/immutability -- intentional browser global write
      document.cookie = `active-site=${slug}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`
      localStorage.setItem('active-site', slug)
      window.dispatchEvent(new CustomEvent('site-changed', { detail: { slug } }))
    } catch { /* ignore */ }

    // Strip the current site prefix if present so we can compute the
    // brand-agnostic path.
    let base = pathname
    const slugs = SITES.map(s => s.slug)
    const parts = pathname.split('/').filter(Boolean)
    if (parts.length > 0 && slugs.includes(parts[0])) {
      base = '/' + parts.slice(1).join('/')
    }

    // SITE_AWARE_PATHS retain the legacy `/[site]/...` App Router pattern,
    // so we need a hard prefix push. Every other path goes through the
    // middleware rewrite which still gets us the cookie + cookie-driven
    // hydration without needing a page-level [site] segment.
    const isSiteAware = SITE_AWARE_PATHS.some(p => base.startsWith(p) || base === p)
    if (isSiteAware) {
      router.push(`/${slug}${base}`)
    } else {
      // Push to the prefixed URL — middleware rewrites it back to `base`
      // internally and pins the cookie. This makes the URL itself the
      // source of truth, so a copy-paste of the URL respects the site
      // context for the recipient.
      router.push(`/${slug}${base}`)
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
