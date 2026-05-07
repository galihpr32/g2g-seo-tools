'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { getSiteSlugFromPath } from '@/lib/sites'

const KNOWN_SLUGS = ['g2g', 'offgamers']

/**
 * Read the currently active site slug on the client.
 *
 * Resolution order (mirrors `resolveSiteSlugFromRequest` server-side):
 *   1. URL pathname prefix         — `/offgamers/...` → 'offgamers'
 *   2. `active-site` cookie        — set by SiteSwitcher
 *   3. localStorage `active-site`  — backup persistence
 *   4. Fallback `'g2g'`
 *
 * Use this in any client component that calls `/api/...` routes so the
 * server resolves the same site as the user is looking at. Pair with the
 * `?site=<slug>` query param when fetching:
 *
 *   const site = useSiteSlug()
 *   fetch(`/api/foo?site=${site}`)
 *
 * Reactive: re-renders when SiteSwitcher updates the cookie via a
 * 'storage' event (since switching also writes localStorage).
 */
export function useSiteSlug(): string {
  const pathname = usePathname() ?? ''

  // Initial read — try path first, then fall back to cookie/localStorage on mount.
  const [slug, setSlug] = useState<string>(() => {
    const fromPath = getSiteSlugFromPath(pathname, KNOWN_SLUGS)
    // If pathname doesn't have a site prefix, getSiteSlugFromPath returns 'g2g'
    // — but we want to prefer the cookie in that case. Only return path-resolved
    // value when the path has an explicit prefix.
    const parts = pathname.split('/').filter(Boolean)
    if (parts.length > 0 && KNOWN_SLUGS.includes(parts[0])) return fromPath
    return 'g2g'
  })

  useEffect(() => {
    function readSlug(): string {
      // Priority: explicit path prefix → cookie → localStorage → 'g2g'
      const parts = pathname.split('/').filter(Boolean)
      if (parts.length > 0 && KNOWN_SLUGS.includes(parts[0])) return parts[0]

      try {
        const cookieMatch = document.cookie.match(/(?:^|;\s*)active-site=([^;]+)/)
        if (cookieMatch && KNOWN_SLUGS.includes(cookieMatch[1])) return cookieMatch[1]
      } catch { /* cookies disabled */ }

      try {
        const stored = localStorage.getItem('active-site')
        if (stored && KNOWN_SLUGS.includes(stored)) return stored
      } catch { /* private mode */ }

      return 'g2g'
    }

    setSlug(readSlug())

    // Listen for cross-tab changes via localStorage 'storage' event.
    function onStorage(e: StorageEvent) {
      if (e.key === 'active-site') setSlug(readSlug())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [pathname])

  return slug
}
