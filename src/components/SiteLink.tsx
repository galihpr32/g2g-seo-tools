'use client'

/**
 * SiteLink — drop-in replacement for next/link that auto-prefixes the
 * active site slug onto absolute paths.
 *
 *   <SiteLink href="/competitive/keyword-gap">Keyword gap</SiteLink>
 *
 * On G2G: renders `/g2g/competitive/keyword-gap`
 * On OG : renders `/offgamers/competitive/keyword-gap`
 *
 * Behavior:
 *   - Only prefixes if href starts with `/` AND first segment isn't already
 *     a known site slug (so links like `/g2g/...` pass through unchanged).
 *   - External `http(s)://...` URLs and protocol-relative URLs are passed
 *     through untouched.
 *   - Falls back to `next/link` behavior in every other respect.
 *
 * Why this exists: Sprint 11 / URL Prefix 2. Migrating gradually — start
 * with sidebar nav + high-traffic pages; rest can be codemodded later.
 * Works fine alongside un-migrated `<Link>` because the middleware also
 * reads cookies for plain paths.
 */

import Link, { type LinkProps } from 'next/link'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'
import type { ComponentProps } from 'react'

const KNOWN_SITES = new Set(['g2g', 'offgamers'])

type Props = LinkProps & ComponentProps<'a'> & {
  /** Override the slug — useful for cross-site links (rare) */
  forceSite?: string
}

export default function SiteLink({ href, forceSite, children, ...rest }: Props) {
  const activeSite = useSiteSlug()
  const slug = forceSite ?? activeSite

  let resolvedHref: string | object = href

  if (typeof href === 'string') {
    if (href.startsWith('/') && !href.startsWith('//')) {
      const firstSeg = href.split('/').filter(Boolean)[0]
      if (firstSeg && !KNOWN_SITES.has(firstSeg)) {
        resolvedHref = `/${slug}${href}`
      }
    }
  }

  return <Link href={resolvedHref} {...rest}>{children}</Link>
}
