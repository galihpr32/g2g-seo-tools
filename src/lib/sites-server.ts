import 'server-only'
import { headers, cookies } from 'next/headers'

const KNOWN_SLUGS = ['g2g', 'offgamers']

/**
 * Resolve the active site slug INSIDE A SERVER COMPONENT or route handler
 * that has access to `next/headers` (RSC, API route).
 *
 * Reads the `x-active-site` header that middleware injects on every
 * request. Falls back to the `active-site` cookie when the header is
 * missing (e.g. during dev with no middleware), then to default.
 *
 * Use this in any RSC that needs to filter data by site:
 *
 *   import { getActiveSiteSlug } from '@/lib/sites-server'
 *   const slug = await getActiveSiteSlug()
 *   const { data: rows } = await db.from('foo').select('*').eq('site_slug', slug)
 *
 * For API routes that already have a Request object, prefer
 * `resolveSiteSlugFromRequest(req)` from `@/lib/sites` — it works without
 * `next/headers` and is bundled-safe for client+server modules that
 * happen to import it.
 *
 * Lives in its own module (not `sites.ts`) because client code imports
 * from `sites.ts` and Next.js fails the client build the moment a module
 * tree pulls in `next/headers`.
 */
export async function getActiveSiteSlug(): Promise<string> {
  const h = await headers()
  const headerSlug = h.get('x-active-site')
  if (headerSlug && KNOWN_SLUGS.includes(headerSlug)) return headerSlug

  const c = await cookies()
  const cookieSlug = c.get('active-site')?.value
  if (cookieSlug && KNOWN_SLUGS.includes(cookieSlug)) return cookieSlug

  return 'g2g'
}
