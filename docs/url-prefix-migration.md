# URL Prefix Routing — Migration Notes

Sprint 11 introduced URL-prefix routing: every page is now reachable via
`/<site>/<path>` (e.g. `/g2g/competitive/keyword-gap`,
`/offgamers/clusters`) in addition to the legacy un-prefixed paths. This
file captures what changed, what's intentionally backwards-compatible,
and what to migrate over time.

## What's live

- **Middleware rewrite** (`src/middleware.ts`)
  Reads the first path segment. If it's `g2g` or `offgamers`, the path
  is internally rewritten to the un-prefixed equivalent and the
  `active-site` cookie is set to the prefix. Auth gating still runs on
  the rewritten path. Cookies get carried through.

- **SiteSwitcher** (`src/components/dashboard/SiteSwitcher.tsx`)
  Switching site now does `router.push('/<newSite>/<currentPath>')`
  instead of writing only a cookie. The URL becomes the source of truth
  for "which brand am I looking at", which makes shared links respect
  brand context for the recipient.

- **`<SiteLink>` wrapper** (`src/components/SiteLink.tsx`)
  Drop-in replacement for `next/link` that auto-prefixes absolute paths
  with the active site slug. External / already-prefixed URLs pass
  through unchanged.

## Backwards compatibility

Plain un-prefixed paths still work. Middleware doesn't force-redirect
them. Cookies still drive `useSiteSlug()` for any page that's loaded via
the un-prefixed route. This means:

- Every existing bookmark and saved link keeps working.
- Existing `<Link>` / `<a>` usages don't need to be migrated for the app
  to function — they just won't propagate site context as cleanly when
  shared externally.
- API routes that rely on `resolveSiteSlugFromRequest` see the same
  cookie they always did; nothing changes for them.

## What to migrate over time

Replace `next/link` imports with `SiteLink` from
`@/components/SiteLink` in the following order, highest leverage first:

1. **Sidebar nav** — already auth-walled; site context survives reloads
   if the URL itself owns it.
2. **Breadcrumb / detail-page back-links** — same reason.
3. **Inline links in dashboards** (e.g. `<Link href="/clusters/[id]">`).
4. **Notification / report links** — Slack messages and PPTX export
   should always link to `/<site>/<path>` so recipients land in the
   right brand without depending on cookies they may not have.

Codemod hint:

```bash
# Find every next/link usage that doesn't already use SiteLink.
rg "from 'next/link'" --files-with-matches
```

## What did NOT change

- **Public-facing canonical tags**: this codebase is the internal SEO
  tool — it's not crawled by Google. The marketplace pages it monitors
  (g2g.com, offgamers.com) are managed separately, so we did not add
  hreflang / canonical helpers here.
- **sitemap.xml**: similar reason — there's no public sitemap to emit.
  If we ever add a public-facing surface, this is the place to start.
- **Database**: nothing changed. `site_slug` column meaning is identical.

## How auth still works under the rewrite

Middleware preserves Supabase auth cookies through the rewrite. The
auth-page redirect (`/login` ↔ `/dashboard`) now respects the prefix:

- Hitting `/g2g/dashboard` while logged out → redirects to `/g2g/login`
- Hitting `/offgamers/login` while logged in → redirects to
  `/offgamers/dashboard`

So a user pasted a `/offgamers/...` link and forced through login lands
back in OffGamers context, not their default cookie context.

## Rollback

If the prefix routing causes issues:

1. Revert `src/middleware.ts` to the prior version (single-purpose auth
   gate).
2. Revert `src/components/dashboard/SiteSwitcher.tsx` to push to
   `base` instead of `/${slug}${base}` for non-site-aware paths.

`<SiteLink>` and the underlying middleware rewrite are isolated; the
codebase still functions if either is reverted in isolation. There's no
schema migration to undo — `site_configs.slug` already encoded which
brand a row belongs to.
