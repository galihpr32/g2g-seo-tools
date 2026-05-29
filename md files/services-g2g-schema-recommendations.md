# services.g2g.com — Schema Markup Specification

**For:** DEV team
**Domain:** `https://services.g2g.com`
**Owner:** SEO (Galih)
**Last updated:** 2026-05-21
**Status:** Pre-launch — implement before public release

---

## 1. How to read this spec

Every page type on `services.g2g.com` gets **one** JSON-LD block per page. All schemas for a page live inside a single `@graph` array. This keeps HTML clean, eliminates duplicate `@context`, and lets schemas cross-reference via `@id` within the same graph.

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { ...schema 1 },
    { ...schema 2 },
    { ...schema 3 }
  ]
}
</script>
```

Treat all `@id` values as **stable IRIs** — never change them after launch.

Two non-negotiable rules from the SEO checklist:

1. **services.g2g.com is a separate entity from g2g.com.** No schema on services.g2g.com may reference `g2g.com`, its Organization, its sameAs, its logo, or any of its entities. Use a different `name`, `description`, `logo`, and `@id` namespace.
2. **All schemas must validate** in [Google Rich Results Test](https://search.google.com/test/rich-results) and [Schema.org validator](https://validator.schema.org/) before merging to main.

---

## 1.5 🔵 Configurable values — DEV adjusts, SEO is notified

The example JSON throughout this spec uses **placeholder values** that DEV can adjust as the product evolves. **Notify SEO (Galih) before changing any of the following**, so we keep `@id` stability and on-page/schema parity:

| Field | Example shown | What DEV can change | Impact if changed |
|---|---|---|---|
| Category URL slug | `tarot-reading`, `astrology`, etc. | Replace with final SEO-approved slug per category | All `@id`, `url`, `item`, breadcrumb, and serviceUrl values referencing that category must update in lockstep |
| Category URL pattern | `/categories/{slug}` | Adjust if routing changes (e.g. `/services/{slug}`) | All PLP URLs and `ItemList` entries on the homepage |
| Trending URL pattern | `/trending/{slug}` | Adjust if routing changes | All trending page URLs |
| Seller URL pattern | `/seller/{slug}` | Adjust if routing changes (e.g. `/u/{handle}`) | All seller profile and breadcrumb URLs |
| Example seller slug | `mystic-luna` | Replaced per real seller at render time | Per-seller, dynamic |
| `Organization.name` | `G2G Services` | Confirm with branding before launch | All publisher references |
| `Organization.alternateName` | `G2G Rent Time Services` | Adjust if positioning copy shifts | Cosmetic — no rich-result impact |
| `Organization.logo.url` | `/assets/logo-services.png` | Update to final logo asset path | Knowledge panel logo |
| `Service.name` / `serviceType` / `description` | See §7 table | Adjust copy with SEO sign-off | Category page rich result relevance |
| Price ranges in `hasOfferCatalog` | `$5–$120` per length | Derive dynamically from live seller offers | Should always be live data, never hardcoded |
| `inLanguage` | `en`, `id` | Add languages as they launch | hreflang and language targeting |

---

## 2. Page type → schema bundle matrix

| Page type | URL pattern | Schemas in `@graph` |
|---|---|---|
| Homepage | `/` | `Organization`, `WebSite` (with `SearchAction`) — `ItemList` + `FAQPage` added when UI is ready |
| Category PLP | `/categories/{slug}` | `CollectionPage`, `Service`, `BreadcrumbList`, `ItemList` (sellers) |
| Trending page | `/trending/{slug}` | `CollectionPage`, `Service`, `BreadcrumbList`, `ItemList` (trending sellers) |
| Seller profile | `/seller/{slug}` | `ProfilePage`, `Person` (with `AggregateRating`, `Review`, `makesOffer`), `BreadcrumbList` |
| Editorial / blog | `/guide/{slug}` | `Article`, `BreadcrumbList` |
| Search / listing | `/search?q=...` | None (noindex per checklist) |
| Login / dashboard | `/login`, `/dashboard` | None (noindex per checklist) |

---

## 3. Homepage (`/`) — `@graph` bundle

**Phase 1 (launch).** Just `Organization` + `WebSite` for now — homepage has no visible FAQ section and no live category list block yet, so we don't emit `ItemList` or `FAQPage` schemas. Google requires schema content to match what's actually rendered on the page; emitting these without on-page parity is a quality risk.

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://services.g2g.com/#organization",
      "name": "G2G Services",
      "alternateName": "G2G Rent Time Services",
      "url": "https://services.g2g.com",
      "logo": {
        "@type": "ImageObject",
        "url": "https://services.g2g.com/assets/logo-services.png",
        "width": 512,
        "height": 512
      },
      "description": "G2G Services is a global marketplace for rent-time services — book sessions with tarot readers, astrologers, meditation guides, singers, dance partners, companions, and more.",
      "contactPoint": {
        "@type": "ContactPoint",
        "contactType": "customer support",
        "email": "support@services.g2g.com",
        "availableLanguage": ["English", "Indonesian"]
      }
    },
    {
      "@type": "WebSite",
      "@id": "https://services.g2g.com/#website",
      "url": "https://services.g2g.com",
      "name": "G2G Services",
      "description": "Book trusted rent-time service providers worldwide.",
      "publisher": { "@id": "https://services.g2g.com/#organization" },
      "inLanguage": ["en", "id"],
      "potentialAction": {
        "@type": "SearchAction",
        "target": {
          "@type": "EntryPoint",
          "urlTemplate": "https://services.g2g.com/search?q={search_term_string}"
        },
        "query-input": "required name=search_term_string"
      }
    }
  ]
}
</script>
```

**Configurable in this example (per §1.5):** `Organization.name`, `alternateName`, `logo.url`, `description`, `contactPoint.email`, `WebSite.urlTemplate`, `inLanguage`.

**When to add the next two nodes:**
- **`ItemList`** — add when the homepage UI has a visible "Browse Categories" section or similar. The schema must list the same categories that are visually rendered (see Phase 2 example below).
- **`FAQPage`** — add when the homepage has a visible FAQ section. Q&A `text` must match the on-page copy exactly.

### 3.1 Phase 2 add-ons (when UI is ready)

When the homepage gets a visible categories block, add this node to the `@graph` array:

```json
{
  "@type": "ItemList",
  "@id": "https://services.g2g.com/#category-list",
  "name": "Service Categories",
  "itemListOrder": "https://schema.org/ItemListOrderAscending",
  "numberOfItems": 18,
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "url": "https://services.g2g.com/categories/tarot-reading", "name": "Tarot Reading" },
    { "@type": "ListItem", "position": 2, "url": "https://services.g2g.com/categories/astrology", "name": "Astrology" }
    // ...etc — see §7 for the full 18-category mapping
  ]
}
```

When the homepage gets a visible FAQ section, add this node to the `@graph` array:

```json
{
  "@type": "FAQPage",
  "@id": "https://services.g2g.com/#faq",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is G2G Services?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "[must match on-page FAQ answer exactly]"
      }
    }
    // ...more Q&As, minimum 4 recommended for rich result eligibility
  ]
}
```

**Notes for DEV:**
- `Organization.logo` must be a **services-only** logo asset — do not reuse the g2g.com logo file.
- `Organization.description` must NOT contain "gaming", "game marketplace", "game boosting", or any G2G core-product language. When FAQPage is added later, same rule applies to all Q&As.
- `sameAs` is intentionally omitted — services.g2g.com social profiles don't exist yet. When they launch (Instagram, TikTok, X, etc.), add a `sameAs` array to the `Organization` node.
- `WebSite.urlTemplate` must match the **actual** internal search URL. If the route differs from `/search?q=`, update it.

---

## 4. Category PLP (`/categories/{slug}`) — `@graph` bundle

Example uses slug `tarot-reading`. Replicate per category with values from §7.

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "CollectionPage",
      "@id": "https://services.g2g.com/categories/tarot-reading/#webpage",
      "url": "https://services.g2g.com/categories/tarot-reading",
      "name": "Tarot Reading | services.g2g.com",
      "description": "Browse verified online tarot readers. Compare ratings, reviews, and session prices. Book a live tarot reading from $5.",
      "isPartOf": { "@id": "https://services.g2g.com/#website" },
      "about": { "@id": "https://services.g2g.com/categories/tarot-reading/#service" },
      "breadcrumb": { "@id": "https://services.g2g.com/categories/tarot-reading/#breadcrumb" },
      "mainEntity": { "@id": "https://services.g2g.com/categories/tarot-reading/#seller-list" },
      "inLanguage": "en"
    },
    {
      "@type": "Service",
      "@id": "https://services.g2g.com/categories/tarot-reading/#service",
      "name": "Online Tarot Reading Sessions",
      "serviceType": "Tarot Reading",
      "description": "Book a live online tarot reading with verified tarot readers. Sessions cover love, career, finance, spiritual guidance, and yes/no questions.",
      "provider": { "@id": "https://services.g2g.com/#organization" },
      "areaServed": { "@type": "Place", "name": "Worldwide" },
      "availableChannel": {
        "@type": "ServiceChannel",
        "serviceUrl": "https://services.g2g.com/categories/tarot-reading",
        "availableLanguage": ["English", "Indonesian"]
      },
      "category": "Spiritual & Wellness",
      "hasOfferCatalog": {
        "@type": "OfferCatalog",
        "name": "Tarot Reading Session Lengths",
        "itemListElement": [
          {
            "@type": "Offer",
            "name": "15-minute reading",
            "priceSpecification": {
              "@type": "PriceSpecification",
              "minPrice": "5.00",
              "maxPrice": "20.00",
              "priceCurrency": "USD"
            }
          },
          {
            "@type": "Offer",
            "name": "30-minute reading",
            "priceSpecification": {
              "@type": "PriceSpecification",
              "minPrice": "15.00",
              "maxPrice": "60.00",
              "priceCurrency": "USD"
            }
          },
          {
            "@type": "Offer",
            "name": "60-minute reading",
            "priceSpecification": {
              "@type": "PriceSpecification",
              "minPrice": "30.00",
              "maxPrice": "120.00",
              "priceCurrency": "USD"
            }
          }
        ]
      }
    },
    {
      "@type": "BreadcrumbList",
      "@id": "https://services.g2g.com/categories/tarot-reading/#breadcrumb",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://services.g2g.com" },
        { "@type": "ListItem", "position": 2, "name": "Tarot Reading", "item": "https://services.g2g.com/categories/tarot-reading" }
      ]
    },
    {
    }
  ]
}
</script>
```

**Configurable in this example (per §1.5):**
- Slug: `tarot-reading` → swap per category (see §7)
- `Service.name`, `serviceType`, `description`, `category` → from §7 table
- `CollectionPage.name` / `description` → SEO copy, adjust per category
- `hasOfferCatalog` prices → derive dynamically from live seller data, never hardcode
- `ItemList` seller list → dynamic per page render
- `BreadcrumbList` → skips an intermediate `Categories` node since `/categories/` likely has no indexable landing page. If it does, insert `{ position: 2, name: "Categories", item: ".../categories" }` and bump Tarot Reading to position 3.

**Notes for DEV:**
- `CollectionPage.about` references the `Service` entity in the same graph via `@id`.
- `CollectionPage.mainEntity` references the seller `ItemList` — signals the primary content of the page is the listing.
- `ItemList` should only include sellers **visible on the current page** (don't dump the whole DB). For paginated PLPs (`?page=2`), update the `ItemList` to that page's sellers.

---

## 5. Trending page (`/trending/{slug}`) — `@graph` bundle

Same shape as PLP, different listing curation. Example uses slug `tarot-reading`.

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "CollectionPage",
      "@id": "https://services.g2g.com/trending/tarot-reading/#webpage",
      "url": "https://services.g2g.com/trending/tarot-reading",
      "name": "Trending Tarot Readers | services.g2g.com",
      "description": "Discover the most-booked tarot readers this week. Live availability, verified ratings, prices from $5.",
      "isPartOf": { "@id": "https://services.g2g.com/#website" },
      "about": { "@id": "https://services.g2g.com/trending/tarot-reading/#service" },
      "breadcrumb": { "@id": "https://services.g2g.com/trending/tarot-reading/#breadcrumb" },
      "mainEntity": { "@id": "https://services.g2g.com/trending/tarot-reading/#trending-list" },
      "inLanguage": "en"
    },
    {
      "@type": "Service",
      "@id": "https://services.g2g.com/trending/tarot-reading/#service",
      "name": "Online Tarot Reading Sessions",
      "serviceType": "Tarot Reading",
      "description": "Book a live online tarot reading with verified tarot readers. Sessions cover love, career, finance, spiritual guidance, and yes/no questions.",
      "provider": { "@id": "https://services.g2g.com/#organization" },
      "areaServed": { "@type": "Place", "name": "Worldwide" },
      "availableChannel": {
        "@type": "ServiceChannel",
        "serviceUrl": "https://services.g2g.com/categories/tarot-reading",
        "availableLanguage": ["English", "Indonesian"]
      },
      "category": "Spiritual & Wellness"
    },
    {
      "@type": "BreadcrumbList",
      "@id": "https://services.g2g.com/trending/tarot-reading/#breadcrumb",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://services.g2g.com" },
        { "@type": "ListItem", "position": 2, "name": "Trending", "item": "https://services.g2g.com/trending" },
        { "@type": "ListItem", "position": 3, "name": "Tarot Reading", "item": "https://services.g2g.com/trending/tarot-reading" }
      ]
    },
    {
      "@type": "ItemList",
      "@id": "https://services.g2g.com/trending/tarot-reading/#trending-list",
      "name": "Trending Tarot Readers",
      "numberOfItems": 12,
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "url": "https://services.g2g.com/seller/mystic-luna" },
        { "@type": "ListItem", "position": 2, "url": "https://services.g2g.com/seller/oracle-jay" }
      ]
    }
  ]
}
</script>
```

**Configurable in this example (per §1.5):**
- Slug: `tarot-reading` → swap per category (see §7)
- `Service.availableChannel.serviceUrl` → always point to the **PLP canonical** (`/categories/{slug}`), not the trending page itself
- `CollectionPage.name` / `description` → must be **distinct** from PLP copy (different angle: "trending this week" vs. "browse all"). If identical, set this page to canonical → PLP instead of self-canonical.
- `ItemList` → trending sellers only, refresh cadence (daily / weekly) decided with SEO
- `BreadcrumbList` middle node `Trending` → drop it if `/trending/` has no indexable landing page (on-page breadcrumb must mirror this)

**Notes for DEV:**
- `Service.hasOfferCatalog` is **omitted** here on purpose — pricing block lives on the PLP. Keep trending lean.
- Trending pages are time-sensitive — consider adding `dateModified` to `CollectionPage` if the curation refresh has a regular cadence.

---

## 6. Seller profile (`/seller/{slug}`) — `@graph` bundle

> Per checklist: seller profiles with bios **under 150 words** must be `noindex` and **must NOT emit `AggregateRating` / `Review`** — they're not eligible for rich results, and emitting them on thin profiles is a quality risk.

Example uses slug `mystic-luna`.

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "ProfilePage",
      "@id": "https://services.g2g.com/seller/mystic-luna/#webpage",
      "url": "https://services.g2g.com/seller/mystic-luna",
      "dateCreated": "2024-03-12T00:00:00+00:00",
      "dateModified": "2026-05-18T00:00:00+00:00",
      "isPartOf": { "@id": "https://services.g2g.com/#website" },
      "breadcrumb": { "@id": "https://services.g2g.com/seller/mystic-luna/#breadcrumb" },
      "mainEntity": { "@id": "https://services.g2g.com/seller/mystic-luna/#person" },
      "inLanguage": "en"
    },
    {
      "@type": "Person",
      "@id": "https://services.g2g.com/seller/mystic-luna/#person",
      "name": "Mystic Luna",
      "alternateName": "@mysticluna",
      "url": "https://services.g2g.com/seller/mystic-luna",
      "image": "https://services.g2g.com/seller/mystic-luna/avatar.jpg",
      "description": "Certified tarot reader with 8 years of experience. Specializing in love readings, career guidance, and shadow work. Sessions available in English and Bahasa Indonesia.",
      "jobTitle": "Tarot Reader",
      "knowsLanguage": ["English", "Indonesian"],
      "makesOffer": [
        {
          "@type": "Offer",
          "itemOffered": {
            "@type": "Service",
            "name": "30-minute Tarot Reading",
            "serviceType": "Tarot Reading",
            "provider": { "@id": "https://services.g2g.com/seller/mystic-luna/#person" }
          },
          "price": "25.00",
          "priceCurrency": "USD",
          "availability": "https://schema.org/InStock",
          "url": "https://services.g2g.com/seller/mystic-luna"
        }
      ],
      "aggregateRating": {
        "@type": "AggregateRating",
        "ratingValue": "4.9",
        "reviewCount": "287",
        "bestRating": "5",
        "worstRating": "1"
      },
      "review": [
        {
          "@type": "Review",
          "author": { "@type": "Person", "name": "Sarah K." },
          "datePublished": "2026-05-10",
          "reviewRating": { "@type": "Rating", "ratingValue": "5", "bestRating": "5" },
          "reviewBody": "Luna was incredibly insightful — the reading helped me see my situation more clearly. Will definitely book again."
        },
        {
          "@type": "Review",
          "author": { "@type": "Person", "name": "Andre P." },
          "datePublished": "2026-05-04",
          "reviewRating": { "@type": "Rating", "ratingValue": "5", "bestRating": "5" },
          "reviewBody": "Very accurate and compassionate. Worth every dollar."
        }
      ]
    },
    {
      "@type": "BreadcrumbList",
      "@id": "https://services.g2g.com/seller/mystic-luna/#breadcrumb",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://services.g2g.com" },
        { "@type": "ListItem", "position": 2, "name": "Tarot Reading", "item": "https://services.g2g.com/categories/tarot-reading" },
        { "@type": "ListItem", "position": 3, "name": "Mystic Luna", "item": "https://services.g2g.com/seller/mystic-luna" }
      ]
    }
  ]
}
</script>
```

**Configurable in this example (per §1.5):**
- Seller slug: `mystic-luna` → dynamic per render
- All `Person.*` fields → from seller profile DB
- Category breadcrumb crumb: `Tarot Reading` / `tarot-reading` → from seller's primary category
- `aggregateRating` and `review` → dynamic; **omit both** if zero reviews
- `makesOffer` → array of all live offers from this seller

**Notes for DEV:**
- Emit only the **3–5 most recent published reviews** in `Person.review`. Don't dump all 287 — JSON-LD bloat slows the page.
- `aggregateRating.reviewCount` = **total** reviews ever (not just the ones in JSON), so it stays accurate.
- If the seller has **zero** reviews, **omit** `aggregateRating` and `review` entirely. Don't emit `ratingValue: "0"` or empty arrays — those fail Rich Results.
- `Person.jobTitle` → primary category for multi-category sellers, pick the highest-revenue one.
- Sanitize all user-generated text (`description`, `reviewBody`): strip HTML, escape quotes/backslashes/control chars, cap `reviewBody` at ~500 chars.

---

## 7. Per-category Service schema reference

Use this table to populate `name`, `serviceType`, `description`, and `category` for each `Service` node. Pricing in `hasOfferCatalog` is derived dynamically from live seller data.

**🔵 All URL slugs below are configurable** — final slugs must be confirmed with SEO before launch.

| URL slug (PLP) | `name` | `serviceType` | `category` | `description` seed copy |
|---|---|---|---|---|
| `/categories/tarot-reading` | Online Tarot Reading Sessions | Tarot Reading | Spiritual & Wellness | Book a live online tarot reading with verified readers. Sessions cover love, career, finance, and spiritual guidance. |
| `/categories/astrology` | Astrology Readings & Birth Chart Analysis | Astrology | Spiritual & Wellness | Get a personalized astrology session — birth chart, transit readings, compatibility analysis, and yearly forecasts. |
| `/categories/meditation` | Guided Meditation Sessions | Meditation Coaching | Spiritual & Wellness | Live one-on-one guided meditation with certified instructors. Sessions for stress, sleep, focus, and grounding. |
| `/categories/fengshui` | Fengshui Consultation | Fengshui Consultation | Spiritual & Wellness | Book a feng shui consultation for your home, office, or business. Layout, energy flow, and date selection guidance. |
| `/categories/animal-communicator` | Animal Communicator Sessions | Animal Communication | Spiritual & Wellness | Connect with verified animal communicators to understand your pet's behavior, emotions, and well-being. |
| `/categories/singing` | Live Singing Performances | Singing Performance | Interactive Entertainment | Book a live singing session — solo performances, song requests, karaoke duets, and birthday surprises. |
| `/categories/music-jam` | Live Music Jam Sessions | Music Jam | Interactive Entertainment | Join a live music jam with verified musicians. Acoustic, electronic, instrumental, and collaborative play. |
| `/categories/dancing` | Live Dance Performances & Lessons | Dance Performance | Interactive Entertainment | Book a live dance session — performances, lessons, and choreography from verified dancers worldwide. |
| `/categories/live-streaming` | Live Streaming Companion | Live Streaming Companion | Engagement | Book a live streamer for co-streaming, viewer engagement, and interactive entertainment. |
| `/categories/music` | Music Listening & DJ Sessions | Music & DJ Companion | Engagement | Spend rent-time with verified DJs and music curators — listening parties, mood sessions, and music discovery. |
| `/categories/social-apps` | Social App Companions | Social App Companion | Engagement | Pair with a verified companion across your favorite social apps for chat, voice, and shared activity time. |
| `/categories/video` | Video Call Companion | Video Call Companion | Engagement | Book a video call companion for casual conversation, virtual hangouts, and connection time. |
| `/categories/chat` | Text Chat Companion | Chat Companion | Socials & Companionship | Text chat with a verified companion — daily check-ins, emotional support, and conversation buddies. |
| `/categories/sleep-call` | Sleep Call Companion | Sleep Call Companion | Socials & Companionship | Fall asleep with a soothing voice on the line. Book a verified sleep call companion for nightly comfort. |
| `/categories/watch-together` | Watch Together Sessions | Watch Together Companion | Socials & Companionship | Watch movies, shows, or streams together with a verified companion in real time. |
| `/categories/gamepal` | Gamepal Companion | Gamepal | RTS Gaming | Book a verified gamepal for co-op play, ranked matches, and casual gaming sessions across platforms. |
| `/categories/game-coach` | Game Coaching Sessions | Game Coaching | RTS Gaming | Improve your gameplay with verified coaches — strategy, mechanics review, and personalized training plans. |
| `/categories/game-jockey` | Game Jockey Service | Game Jockey | RTS Gaming | Hire a verified game jockey to play on your behalf — rank push, completion runs, and progression help. |

The trending URL pattern uses the **same slugs** — just swap `/categories/` for `/trending/`.

> **Heads up:** The PDF checklist explicitly forbids gaming language in the **homepage** hero, FAQ, and metadata. Category pages under `RTS Gaming` (`/categories/gamepal`, etc.) are exempt because gaming **is** the service on those pages. Confirm with SEO before launch whether RTS Gaming categories ship in wave-1 or are held back.

---

## 8. Implementation notes for DEV

### 8.1 Where to render
- Server-side render the JSON-LD into the response HTML. **Do not** inject client-side via JavaScript — Googlebot renders JS but it's slower, more error-prone, and risks the schema being missed on first crawl.
- Place the JSON-LD `<script>` in `<head>` (preferred) or just before `</body>`. Both are valid.
- **One `<script type="application/ld+json">` block per page** containing the entire `@graph`.

### 8.2 @id pattern
- Use stable, full-URL `@id` values like `https://services.g2g.com/#organization`. Never relative paths, never random UUIDs.
- Within the same `@graph`, reference entities via `{ "@id": "..." }` instead of re-inlining nested objects.
- `@id` values should never change after launch — they're the durable identity of the entity.

### 8.3 Dynamic data sources
| Schema field | Source |
|---|---|
| `Service.hasOfferCatalog` price min/max | Aggregate min/max of active offers in the category |
| `ItemList.numberOfItems` | Count of visible-on-page items |
| `Person.aggregateRating` | Aggregate of all completed sessions with ratings |
| `Person.review` | 3–5 most recent published reviews |
| `ProfilePage.dateModified` | Seller's last profile edit timestamp (ISO 8601) |

### 8.4 Conditional emission rules
- **Seller profile with <150 word bio:** Omit `aggregateRating`, `review`. Add `<meta name="robots" content="noindex">` and `X-Robots-Tag: noindex` header.
- **Seller profile with zero reviews:** Omit `aggregateRating` and `review`. Still emit `ProfilePage` + `Person`.
- **Category PLP with zero active sellers:** Omit the seller `ItemList` node from the graph. Keep `CollectionPage`, `Service`, `BreadcrumbList`.
- **Trending page with zero trending items:** Don't render the trending page at all — serve 404 or redirect to PLP.
- **Paginated PLPs (`?page=2`):** Emit the same graph. Update `ItemList` to that page's sellers. Per checklist, use `rel="next" / rel="prev"` or canonical to page 1.
- **Homepage FAQ / category list:** Only emit `FAQPage` / `ItemList` when the corresponding UI section is rendered on the page (see §3.1).

### 8.5 Sanitizing user-generated content
Reviews and seller bios are user input. Before embedding in JSON-LD:
- Strip HTML tags
- Escape `"`, `\`, and control characters
- Trim `reviewBody` to ≤500 chars
- Reject reviews with profanity or PII before they reach the schema layer

### 8.6 What NOT to do
- ❌ Do not reference `g2g.com` Organization, logo, or sameAs anywhere in services.g2g.com schemas
- ❌ Do not emit `Organization` schema on any page other than the homepage (use `@id` reference instead)
- ❌ Do not emit `SearchAction` on any page other than the homepage
- ❌ Do not include gaming language in homepage `Organization.description`
- ❌ Do not emit `AggregateRating` with `ratingValue: 0` or `reviewCount: 0` — omit the block
- ❌ Do not emit `FAQPage` or `ItemList` without a corresponding visible UI section on the page
- ❌ Do not emit schema on noindex pages (login, dashboard, checkout, filter URLs)
- ❌ Do not emit multiple `<script type="application/ld+json">` blocks per page — use the single `@graph` pattern

---

## 9. Validation & sign-off checklist

Before merging schema changes to main, DEV must confirm:

- [ ] Every page type's `@graph` validates in [Google Rich Results Test](https://search.google.com/test/rich-results) — zero errors, warnings reviewed
- [ ] Every page type validates in [Schema.org validator](https://validator.schema.org/) — zero errors
- [ ] JSON-LD is server-side rendered (view-source confirms it's in the HTML response, not injected via JS)
- [ ] Spot-check 3 PLPs, 3 trending pages, 3 seller profiles, and the homepage with Rich Results Test
- [ ] Lighthouse SEO audit on homepage = 100
- [ ] No schema entity on `services.g2g.com` references `g2g.com` (grep the rendered HTML)
- [ ] `@id` values are stable IRIs, not random UUIDs, and reused via `@id` references within each graph
- [ ] All `url`, `item`, and `target.urlTemplate` values point to `services.g2g.com` (no accidental `g2g.com` fallbacks)
- [ ] Conditional emission rules in §8.4 are enforced in code (unit-tested)
- [ ] Only **one** `<script type="application/ld+json">` block per page (grep view-source)

Sign-off required from: SEO lead (Galih) + senior DEV before going live.

---

## 10. Quick reference — schema by file location

If your codebase uses page-component-based routing (Next.js, Nuxt, etc.):

| Component / template | `@graph` owner |
|---|---|
| `app/layout.tsx` or `_app.tsx` | None (don't put schema in the shared layout — too easy to leak across pages) |
| `app/page.tsx` (homepage) | Homepage `@graph` (Organization, WebSite — ItemList + FAQPage added in phase 2) |
| `app/categories/[slug]/page.tsx` | PLP `@graph` (CollectionPage, Service, BreadcrumbList, ItemList) |
| `app/trending/[slug]/page.tsx` | Trending `@graph` (CollectionPage, Service, BreadcrumbList, ItemList) |
| `app/seller/[slug]/page.tsx` | Seller profile `@graph` (ProfilePage, Person, BreadcrumbList) |
| `app/guide/[slug]/page.tsx` | Article `@graph` (Article, BreadcrumbList) |

A shared `<JsonLd graph={[...]} />` helper component is recommended — single source of truth for the `<script type="application/ld+json">` rendering, takes a graph array as input.

---

**Questions / changes:** ping Galih (SEO).
