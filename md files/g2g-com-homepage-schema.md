# g2g.com — Homepage Schema Specification

**For:** DEV team
**Domain:** `https://www.g2g.com`
**Scope:** Homepage (`/`) only — other page types covered separately
**Owner:** SEO (Galih)
**Last updated:** 2026-05-21

---

## 1. How to read this spec

The g2g.com homepage emits **one** JSON-LD block containing an `@graph` array of all relevant schemas. Same pattern as the services.g2g.com spec — keeps HTML clean, eliminates duplicate `@context`, lets schemas cross-reference via `@id`.

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [ ... ]
}
</script>
```

Treat all `@id` values as **stable IRIs** — never change them after launch.

**Critical cross-domain rule (from SEO checklist):** g2g.com is a **separate entity** from services.g2g.com. Schemas on g2g.com must not reference services.g2g.com Organization, logo, sameAs, or any of its entities. Use a different `@id` namespace, different name, different description, different logo.

---

## 2. 🔵 Configurable values — DEV adjusts, SEO is notified

| Field | Example shown | What DEV can change | Notify SEO? |
|---|---|---|---|
| Homepage canonical URL | `https://www.g2g.com` | Confirm www. vs root, trailing slash policy | Yes |
| `Organization.name` | `G2G` | Branding may prefer `G2G.com` or `G2G Marketplace` | Yes |
| `Organization.alternateName` | `["G2G.com", "G2G Marketplace"]` | Add/remove aliases per official brand book | Yes |
| `Organization.logo.url` | `/assets/logo-g2g.png` | Final logo asset path | Yes |
| `Organization.sameAs` | Real G2G socials (FB, X, IG, LinkedIn) | Verify each URL resolves to claimed profile — see §3.1 | Yes |
| `Organization.contactPoint.url` | `/help` or `/support` | Confirm actual customer support URL | Optional |
| `WebSite.urlTemplate` | `/search?q={search_term_string}` | Match the actual internal search URL | Yes |
| `inLanguage` array | `["en", "id"]` | Add languages as g2g.com expands official support | Yes |
| `availableLanguage` in `contactPoint` | `["English", "Indonesian"]` | Match actual customer support coverage | Yes |
| Category slugs / URLs in `ItemList` (Phase 2) | `/categories/game-top-up`, etc. | Match actual production category URLs | Yes |

---

## 3. Homepage (`/`) — `@graph` bundle

**Phase 1 (launch).** Just `Organization` + `WebSite` — homepage doesn't render a visible "Browse Categories" block or FAQ section yet, so we don't emit `ItemList` or `FAQPage` schemas. Google requires schema content to match what's actually rendered on the page; emitting these without on-page parity is a quality risk.

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://www.g2g.com/#organization",
      "name": "G2G",
      "alternateName": ["G2G.com", "G2G Marketplace"],
      "url": "https://www.g2g.com",
      "logo": {
        "@type": "ImageObject",
        "url": "https://www.g2g.com/assets/logo-g2g.png",
        "width": 512,
        "height": 512
      },
      "description": "The world's most secure gaming marketplace. G2G provides a safe, escrow-protected platform for buying and selling digital assets, secured by the GamerProtect.",
      "sameAs": [
        "https://www.facebook.com/G2Gdotcom",
        "https://x.com/G2Gdotcom",
        "https://www.instagram.com/g2g_global",
        "https://www.linkedin.com/company/gamer2gamer"
      ],
      "contactPoint": {
        "@type": "ContactPoint",
        "contactType": "customer support",
        "url": "https://www.g2g.com/help",
        "availableLanguage": ["English", "Indonesian"]
      }
    },
    {
      "@type": "WebSite",
      "@id": "https://www.g2g.com/#website",
      "url": "https://www.g2g.com",
      "name": "G2G",
      "description": "Buy game top-ups, gift cards, in-game items, and game accounts on the world's leading digital marketplace.",
      "publisher": { "@id": "https://www.g2g.com/#organization" },
      "inLanguage": ["en", "id"],
      "potentialAction": {
        "@type": "SearchAction",
        "target": {
          "@type": "EntryPoint",
          "urlTemplate": "https://www.g2g.com/search?q={search_term_string}"
        },
        "query-input": "required name=search_term_string"
      }
    }
  ]
}
</script>
```

**Configurable in this example (per §2):** `Organization.alternateName`, `description`, `sameAs`, `contactPoint.url`, `WebSite.urlTemplate`, `inLanguage`, `availableLanguage`.

**When to add the next two nodes:**
- **`ItemList`** — add when the homepage UI has a visible "Browse Categories" section. See §3.3 for the Phase 2 template.
- **`FAQPage`** — add when the homepage has a visible FAQ section. See §3.4.

---

### 3.1 `sameAs` — verify before launch

The example uses real-looking handles (`G2Gdotcom`, `g2g_global`, `gamer2gamer`). Before launch, DEV must confirm each URL by:

1. Opening it — must resolve to an **official, claimed** G2G profile (not a fan page or impersonator)
2. Confirming the profile is active
3. Confirming the profile's bio/about section links back to `g2g.com` (Google uses this signal for entity validation)

If a profile doesn't exist or can't be verified, **remove** that entry from the `sameAs` array. Missing `sameAs` is fine. Wrong `sameAs` is a knowledge graph integrity risk.

---

### 3.2 Multi-language considerations

Initial launch: `inLanguage` is set to `["en", "id"]` only, matching current confirmed coverage on customer support and content. When g2g.com expands official language support (e.g. Chinese, Spanish, Portuguese, etc.), add those locales to both:

- `Organization.contactPoint.availableLanguage`
- `WebSite.inLanguage`

For language-prefixed homepages (`/en/`, `/id/`):
- Emit the **same** `Organization` + `WebSite` schema with the **same** `@id` values across all language URLs
- Use `hreflang` tags in `<link>` (separate from schema) to wire up alternate language versions

---

### 3.3 ItemList — add when UI is ready (Phase 2)

When the homepage gains a visible "Browse Categories" section, add this node to the `@graph` array:

```json
{
  "@type": "ItemList",
  "@id": "https://www.g2g.com/#category-list",
  "name": "G2G Marketplace Categories",
  "itemListOrder": "https://schema.org/ItemListOrderAscending",
  "numberOfItems": 8,
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "url": "https://www.g2g.com/categories/game-top-up", "name": "Game Top Up & Gift Cards" },
    { "@type": "ListItem", "position": 2, "url": "https://www.g2g.com/categories/game-items", "name": "Game Items" },
    { "@type": "ListItem", "position": 3, "url": "https://www.g2g.com/categories/game-skins", "name": "Game Skins" },
    { "@type": "ListItem", "position": 4, "url": "https://www.g2g.com/categories/game-coins", "name": "Game Coins" },
    { "@type": "ListItem", "position": 5, "url": "https://www.g2g.com/categories/game-boosting", "name": "Game Boosting" },
    { "@type": "ListItem", "position": 6, "url": "https://www.g2g.com/categories/game-accounts", "name": "Game Accounts" },
    { "@type": "ListItem", "position": 7, "url": "https://www.g2g.com/categories/mobile-credits", "name": "Mobile Credits & eSim" },
    { "@type": "ListItem", "position": 8, "url": "https://www.g2g.com/categories/software-apps", "name": "Software & Apps" }
  ]
}
```

**Rules:**
- Listed categories must match what's visually rendered on the page — no schema-only categories
- Final slugs and category names must be confirmed by SEO before launch
- `numberOfItems` should equal the count of `itemListElement` entries — keep them in sync

---

### 3.4 FAQPage — add when UI is ready

If the homepage has (or gains) a visible FAQ section, add this node to the `@graph` array:

```json
{
  "@type": "FAQPage",
  "@id": "https://www.g2g.com/#faq",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Is G2G safe to buy from?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "[must match on-page FAQ copy exactly]"
      }
    }
    // ...minimum 4 Q&As recommended for rich result eligibility
  ]
}
```

**Rule:** only emit `FAQPage` if the homepage actually renders a visible FAQ section. Q&A `text` must match the on-page copy exactly — Google validates parity.

---

## 4. Implementation notes for DEV

### 4.1 Where to render
- Server-side render the JSON-LD into the response HTML. Do not inject client-side.
- Place in `<head>` (preferred) or just before `</body>`.
- One `<script type="application/ld+json">` block containing the whole `@graph`.

### 4.2 @id pattern
- Use stable, full-URL `@id` values (`https://www.g2g.com/#organization`).
- Reference other entities in the same graph via `{ "@id": "..." }` instead of re-inlining.
- Never change `@id` values after launch.

### 4.3 What NOT to do
- ❌ Do not reference `services.g2g.com` Organization, logo, or `sameAs` anywhere in g2g.com schemas
- ❌ Do not put a `Link: <services.g2g.com>; rel="canonical"` header anywhere
- ❌ Do not include `services.g2g.com` URLs in g2g.com's `ItemList`
- ❌ Do not emit a `FAQPage` or `ItemList` block without a corresponding visible UI section on the page
- ❌ Do not emit unverified `sameAs` URLs — confirm each handle before launch (see §3.1)
- ❌ Do not emit multiple `<script type="application/ld+json">` blocks per page — single `@graph` only

---

## 5. Validation checklist

Before merging to main:

- [ ] `@graph` validates in [Google Rich Results Test](https://search.google.com/test/rich-results) — zero errors
- [ ] `@graph` validates in [Schema.org validator](https://validator.schema.org/) — zero errors
- [ ] All `sameAs` URLs resolve to verified G2G profiles
- [ ] No reference to `services.g2g.com` anywhere in the rendered schema (grep view-source)
- [ ] Server-side rendered (view-source confirms it's in the response HTML)
- [ ] `inLanguage` matches the languages g2g.com actually serves
- [ ] No `ItemList` or `FAQPage` emitted unless the corresponding UI section is visible on the page (Phase 2 only)
- [ ] Lighthouse SEO audit on homepage = 100

Sign-off required from: SEO lead (Galih) + senior DEV.

---

**Questions / changes:** ping Galih (SEO).
**Cross-domain comparison vs services.g2g.com:** see `g2g-vs-services-comparison.md`.
