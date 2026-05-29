# g2g.com vs services.g2g.com — Schema Comparison

**For:** DEV team, SEO team
**Purpose:** Side-by-side reference to ensure Google treats the two domains as **separate entities**. Catches accidental cross-references before they leak into production.
**Companion docs:**
- `g2g-com-homepage-schema.md`
- `services-g2g-schema-recommendations.md`

**Last updated:** 2026-05-21

---

## 1. Why two separate schemas

g2g.com and services.g2g.com serve completely different verticals — one is a gaming/digital products marketplace, the other is a rent-time services marketplace. If their schemas reference each other (shared Organization, shared sameAs, cross-domain canonicals, shared logo), Google's knowledge graph will merge them into one entity. That hurts both:

- Trust signals from gaming reviews leak into the services brand and vice versa
- Negative SEO risk multiplies (one domain's penalties affect the other)
- Knowledge panel branding becomes confused
- Rich result eligibility for each vertical's specific schema (e.g. `Service` on services pages) is diluted

The PDF checklist's core directive: **complete schema-level entity separation**. The two domains must look to crawlers like two different companies operating two different platforms — even though they're owned by the same business.

---

## 2. Quick-glance comparison

| Aspect | g2g.com | services.g2g.com |
|---|---|---|
| **Domain** | `www.g2g.com` | `services.g2g.com` |
| **Vertical** | Gaming + digital products marketplace | Rent-time services marketplace |
| **Primary keyword space** | "buy game items", "game top up", "gift cards" | "tarot reading online", "book tarot reader", "rent-time companion" |
| **Organization `@id`** | `https://www.g2g.com/#organization` | `https://services.g2g.com/#organization` |
| **Organization `name`** | `G2G` | `G2G Services` |
| **Organization `alternateName`** | `G2G.com` | `G2G Rent Time Services` |
| **Logo asset** | `/assets/logo-g2g.png` | `/assets/logo-services.png` |
| **`sameAs` (social profiles)** | Real G2G socials (Facebook, X, IG, YouTube, TikTok, LinkedIn) | **Empty** until services-specific socials launch |
| **`description` theme** | Gaming + digital products | Rent-time service providers |
| **`foundingDate`** | `2014` | Optional — services vertical is newer |
| **WebSite `@id`** | `https://www.g2g.com/#website` | `https://services.g2g.com/#website` |
| **SearchAction endpoint** | `https://www.g2g.com/search?q=...` | `https://services.g2g.com/search?q=...` |
| **`inLanguage`** | 8 languages (en, id, zh, es, pt, ru, vi, th) | 2 languages (en, id) initially |
| **ItemList categories** | Game Top Up, Gift Cards, Game Items, Game Coins, etc. | Tarot Reading, Astrology, Meditation, Companion services, etc. |
| **Per-listing schema** | `Product` / `Offer` (item listings) | `Service` (per category) + `Person` (per provider) |
| **Listing-page wrapper** | `ItemList` / `CollectionPage` | `CollectionPage` (PLP + Trending) |

---

## 3. Field-by-field deep dive

### 3.1 Organization

| Property | g2g.com value | services.g2g.com value | Must differ? |
|---|---|---|---|
| `@id` | `https://www.g2g.com/#organization` | `https://services.g2g.com/#organization` | ✅ Yes — entity identity |
| `name` | `G2G` | `G2G Services` | ✅ Yes — checklist rule |
| `alternateName` | `G2G.com` | `G2G Rent Time Services` | ✅ Yes — checklist rule |
| `url` | `https://www.g2g.com` | `https://services.g2g.com` | ✅ Yes — naturally |
| `logo.url` | `/assets/logo-g2g.png` | `/assets/logo-services.png` | ✅ Yes — checklist rule |
| `description` | Gaming + digital products copy | Rent-time services copy, **zero gaming references** | ✅ Yes — checklist rule |
| `sameAs` | Confirmed G2G socials | Omitted (no services-specific socials yet) | ⚠️ Must not overlap |
| `foundingDate` | `2014` | Omit or use later date | Recommended different |
| `contactPoint.url` | `https://www.g2g.com/help` | `https://services.g2g.com/help` or `support@services.g2g.com` | ✅ Yes — different domains |
| `contactPoint.availableLanguage` | 8 languages | 2 languages initially | Should differ — match actual support coverage |

### 3.2 WebSite

| Property | g2g.com value | services.g2g.com value | Must differ? |
|---|---|---|---|
| `@id` | `https://www.g2g.com/#website` | `https://services.g2g.com/#website` | ✅ Yes |
| `url` | `https://www.g2g.com` | `https://services.g2g.com` | ✅ Yes |
| `name` | `G2G` | `G2G Services` | ✅ Yes |
| `publisher.@id` | References g2g.com Organization | References services.g2g.com Organization | ✅ Yes — must reference own Organization |
| `SearchAction.urlTemplate` | `https://www.g2g.com/search?q={...}` | `https://services.g2g.com/search?q={...}` | ✅ Yes — different search endpoints |
| `inLanguage` | 8-language array | 2-language array initially | Should differ |

### 3.3 ItemList (categories)

These are **completely disjoint**. No category appears on both homepages.

| g2g.com categories (example top 8) | services.g2g.com categories (example top 18) |
|---|---|
| Game Top Up & Gift Cards | Tarot Reading |
| Game Items | Astrology |
| Game Skins | Meditation |
| Game Coins | Fengshui |
| Game Boosting | Animal Communicator |
| Game Accounts | Singing |
| Mobile Credits & eSim | Music Jam |
| Software & Apps | Dancing |
| | Live Streaming |
| | Music |
| | Social Apps |
| | Video |
| | Chat Companion |
| | Sleep Call |
| | Watch Together |
| | Gamepal *(RTS Gaming — see note below)* |
| | Game Coach *(RTS Gaming)* |
| | Game Jockey *(RTS Gaming)* |

**Note on RTS Gaming on services.g2g.com:** Gamepal, Game Coach, and Game Jockey are *rent-time* gaming services (you pay someone to play with you / coach you), not game items. They live on services.g2g.com because the deliverable is **a person's time**, not a digital good. The checklist still forbids gaming language on the services homepage hero/FAQ, but category pages under `/categories/gamepal` etc. are exempt because gaming **is** the service being sold.

### 3.4 Listing & profile schemas

| Schema type | g2g.com uses | services.g2g.com uses |
|---|---|---|
| Catalog listing page wrapper | `CollectionPage` + `ItemList` | `CollectionPage` + `ItemList` (same pattern) |
| Per-listing entity | `Product` / `Offer` (digital goods) | `Service` (rent-time service category) |
| Seller profile | `ProfilePage` + `Person` or `Organization` (if shop) | `ProfilePage` + `Person` |
| Reviews on seller | `AggregateRating` + `Review` on `Person` | `AggregateRating` + `Review` on `Person` |

The shape is similar (both are marketplaces with sellers and ratings). The semantic intent is what's different — products vs. services.

---

## 4. What's intentionally similar (and that's OK)

These overlaps are **fine** — they're industry-standard patterns, not entity merging:

- Both use `@graph` JSON-LD pattern with one `<script>` per page
- Both use `ContactPoint` for customer support
- Both use the same `SearchAction` schema shape (different endpoint URLs)
- Both use `ProfilePage` + `Person` + `AggregateRating` for seller profiles
- Both use `BreadcrumbList` for category-and-deeper hierarchies
- Both follow the same conditional emission rules (no schema for noindex pages, no empty `AggregateRating`, etc.)
- Both use the same `@id` IRI convention (full URL + fragment)

Google doesn't merge entities based on schema **shape** — only based on shared `@id` values, shared `sameAs`, shared `url`, or cross-canonical links.

---

## 5. ❌ Cross-domain anti-patterns

These are the patterns that **will** cause Google to merge the two entities. Any one of them is enough to break the separation. Audit before launch and at every major change.

| ❌ Anti-pattern | Why it's bad | How to catch |
|---|---|---|
| g2g.com Organization references a `sameAs` URL on `services.g2g.com` | Tells Google these are the same entity | grep rendered HTML for cross-domain in `sameAs` |
| services.g2g.com Organization references a `sameAs` URL on `g2g.com` | Same as above, reverse direction | grep rendered HTML |
| Either domain's schema uses the **same `@id`** as the other (e.g. both use `#organization`) | Two pages claiming to describe the same entity from different domains | Search for duplicate `@id` across both codebases |
| Shared logo asset path | Strong "same brand" signal | Confirm separate logo files in `/assets/` |
| g2g.com homepage `ItemList` includes a services.g2g.com category URL | Cross-links the catalogs | grep `ItemList` for cross-domain URLs |
| services.g2g.com `ItemList` includes a g2g.com category URL | Same, reverse | grep `ItemList` for cross-domain URLs |
| `<link rel="canonical" href="https://services.g2g.com/...">` on a g2g.com page (or vice versa) | Tells Google "this is actually the other page" — catastrophic | grep `rel="canonical"` |
| `Link:` HTTP header pointing to the other domain | Same as above at the header layer | curl -I and inspect headers |
| BreadcrumbList on services.g2g.com starts at `https://www.g2g.com` | Hierarchical entity merging | Audit breadcrumb `position: 1` items |
| Shared `publisher.@id` (e.g. services pages publisher references g2g.com Organization) | The whole point of separate Organizations is undone | grep `publisher` references |
| Same `Organization.name` value | Soft signal that compounds with other matches | Confirm names diverge per §3.1 |
| Reusing `Organization.description` between both | Looks like copy-paste of the same entity | Confirm descriptions diverge per §3.1 |

---

## 6. Pre-launch cross-domain QA checklist

Run this checklist **on both domains together** before launching services.g2g.com publicly.

### 6.1 Schema cross-check
- [ ] g2g.com homepage `@graph` validates with zero errors
- [ ] services.g2g.com homepage `@graph` validates with zero errors
- [ ] `@id` values across both domains are fully disjoint — no shared `@id`
- [ ] `Organization.name` values differ between the two
- [ ] `Organization.alternateName` values differ
- [ ] `Organization.description` values differ (and neither contains the other vertical's keywords)
- [ ] `Organization.logo.url` values point to different physical assets
- [ ] `Organization.sameAs` arrays do not overlap
- [ ] No cross-domain URLs anywhere in either `ItemList`
- [ ] No cross-domain `canonical`, `publisher`, or `breadcrumb` references

### 6.2 HTTP / link cross-check
- [ ] No `Link: rel="canonical"` header on either domain points to the other
- [ ] g2g.com → services.g2g.com links (if any in nav/footer) use `rel="nofollow noopener noreferrer"`
- [ ] services.g2g.com → g2g.com links (if any in nav/footer) use `rel="nofollow noopener noreferrer"`
- [ ] No hardcoded `<a href>` in shared component libraries leaks between domains
- [ ] Cross-domain account switching uses JavaScript redirect (not crawlable `<a>` tags)

### 6.3 Search Console cross-check
- [ ] Both domains have separate Google Search Console properties
- [ ] No coverage overlap reported in either property
- [ ] Separate sitemaps registered in each property
- [ ] Separate robots.txt files
- [ ] Separate Google Analytics (GA4) properties — no cross-domain tracking bleed

### 6.4 Knowledge Graph sanity check (post-launch)
- [ ] Search `"G2G"` on Google — knowledge panel shows g2g.com only
- [ ] Search `"G2G Services"` on Google (after indexing) — knowledge panel shows services.g2g.com, not g2g.com
- [ ] Neither knowledge panel pulls logo/description from the other entity

---

## 7. TL;DR for DEV

The two domains share infrastructure, ownership, and brand parentage. But to Google, they must look like two unrelated marketplaces:

1. **Different `@id` namespaces** (`https://www.g2g.com/#organization` vs `https://services.g2g.com/#organization`)
2. **Different Organization names, descriptions, and logos**
3. **Different `sameAs` arrays** (no overlapping social URLs)
4. **No cross-domain references** anywhere in either schema graph
5. **No cross-domain canonicals or Link headers** at the HTTP layer
6. **Different category catalogs** — disjoint `ItemList` entries
7. **Same schema *shape*** is fine — same `Organization` / `WebSite` / `ItemList` patterns are industry standard

If a code reviewer sees a g2g.com URL anywhere in a services.g2g.com schema (or vice versa), it's almost certainly a bug. Fix before merge.

---

**Questions / changes:** ping Galih (SEO).
