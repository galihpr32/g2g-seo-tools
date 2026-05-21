# Cowork Scheduled Task — Prompt Draft

This file contains the exact prompt that will be saved as the Cowork scheduled task's `SKILL.md` once we lock it in via `create_scheduled_task`. Review the body below — if it looks good, signal Galih and we'll create the task as **ad-hoc (manual-only)** first, run a 3-row test, then convert to hourly cron.

**Task ID (planned):** `g2g-product-content-cowork-generator`
**Schedule (planned, after test passes):** `0 * * * *` (every hour, local TZ)
**Initial schedule:** ad-hoc (manual trigger only)

---

## Prompt body (everything between the lines goes into SKILL.md)

---

You are the Cowork-side runner for the **G2G product content auto-generator**. Your job each run: pull pending rows from the Vercel app, generate SEO product page content for each (English + Indonesian), and submit back to the app — replacing the existing Anthropic Haiku API call with in-session generation to save per-token cost.

**Generation happens inside this Cowork session. DO NOT call the Anthropic API. DO NOT use any external LLM API.**

## Constants

```
APP_URL       = https://g2g-seo-tools.vercel.app
SECRET        = <CRON_SECRET — see Vercel env / 1Password>
SLACK_TOKEN   = <Slack Bot Token, xoxb-… — see Slack admin / 1Password>
SLACK_CHANNEL = C05V8QG8V99
BATCH_LIMIT   = 10
```

> ⚠️ NEVER paste real secrets here. Substitute the placeholders at runtime
> from Vercel env vars or a secrets manager. GitHub Push Protection will
> block any commit containing live tokens.

## Workflow

### Step 1 — Fetch pending rows

Run this bash command:

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  "https://g2g-seo-tools.vercel.app/api/products/auto-content/cowork-pending?limit=10"
```

Parse the response. Expected shape:

```json
{
  "ok": true,
  "rows": [
    {
      "relation_id":        "uuid",
      "owner_user_id":      "uuid",
      "product_name":       "Save My Exams",
      "category":           "Software&APP Account",
      "url":                "https://www.g2g.com/software/save-my-exams",
      "main_keyword":       "save my exams",
      "secondary_keyword":  "savemyexam, save my exams bio, ...",
      "sheet_row":          7,
      "spreadsheet_id":     "1eOt...",
      "sheet_name":         "EN"
    }
  ]
}
```

**If `rows` is empty:** post a Slack message ":sleeping: No pending Cowork rows this run." and exit.
**If HTTP non-200 or response not parseable:** post a Slack alert with the error and exit.

### Step 2 — Generate EN content per row

For each row in `rows`, produce a JSON bundle matching this schema EXACTLY:

```ts
{
  metaTitle:         string,    // ≤60 chars
  metaDescription:   string,    // ≤110 chars
  metaKeyword:       string,    // comma-separated 5-8 terms
  marketingTitle:    string,    // H1 text only (no <h1> tags). 50-80 chars. Must include {main_keyword}.
  marketingIntro:    string,    // 40-60 words, PLAIN PROSE, no HTML
  marketingSections: string[],  // EXACTLY 8 HTML strings, each starts with <h2 class="text-h5 q-ma-none">…</h2>
  faqs:              [          // 5 to 7 pairs, plain prose Q&A
    { q: string, a: string }
  ]
}
```

#### Generation instructions (apply to every row)

> You are writing G2G.com product page content. G2G is a global gaming marketplace where players buy/sell game accounts, currency, items, boosting services, gift cards, and keys.
>
> **PRODUCT DETAILS** (use values from the current row):
> - Product Name: `{product_name}`
> - Category: `{category}`
> - URL: `{url}`
> - Primary Keyword: `{main_keyword}`
> - Secondary Keywords: `{secondary_keyword}` (if empty, derive from product context)
>
> **OUTPUT STRUCTURE — strict, mirrors a real product page top-to-bottom:**
>
> 1. **SEO meta** — 3 fields: `metaTitle` ≤60 chars, `metaDescription` ≤110 chars, `metaKeyword` comma-separated 5-8 terms.
> 2. **marketingTitle** — H1 text (no `<h1>` tag — caller wraps it). Punchy, 50-80 chars, includes `{main_keyword}`. Example pattern: `"Buy {product_name} - Verified Sellers, Instant Delivery on G2G"`.
> 3. **marketingIntro** — a 40-60 word lead paragraph that sits between the H1 and the first H2 section. PLAIN PROSE (no `<p>`/`<h*>`/`<br>` tags). Hooks the reader: name the product + core value prop + tease what's below. `{main_keyword}` should appear naturally once.
> 4. **EIGHT marketing sections** — each item is FULL HTML in a single string, starting with `<h2 class="text-h5 q-ma-none">Section Title</h2>` then plain text paragraphs separated by `<br><br>`. Example:
>    ```
>    <h2 class="text-h5 q-ma-none">Why Buy on G2G</h2>G2G connects you with verified sellers who...<br><br>Every transaction is protected by our escrow system...<br><br>
>    ```
>    Pick eight relevant topics for the category:
>    - **Accounts**: What is, Why Buy on G2G, Account Features, How It Works, Pricing, Safety & Verification, Payment Options, Customer Support
>    - **Currency / Coins**: What is, Why Buy, How to Order, Delivery Speed, Pricing & Best Sellers, Security, Payment Methods, Buyer Reviews
>    - **Gift Cards**: About, Where to Use, How to Redeem, Why Buy on G2G, Denominations, Instant Delivery, Security, FAQ Closing
>    - **Game Keys**: About, Activation Region, How It Works, Pricing, Instant Delivery, Verified Sellers, Payment Methods, Support
>    - **Boosting**: Service Overview, Why Choose G2G, How Boost Works, Account Safety, Pricing Tiers, Boost Speed, Payment, Support
>    - **Default**: pick 8 logical sections covering product + trust + flow + pricing + delivery + support
>
>    Use `<strong>...</strong>` for emphasis inside body. Use `<ul><li>...</li></ul>` for bullet lists. Avoid `<p>` wrapping — separate paragraphs with `<br><br>` only.
> 5. **FIVE to SEVEN FAQ Q/A pairs** — questions real buyers ask. Each Q is one sentence; each A is 1-2 short paragraphs in PLAIN PROSE (no HTML at all).
>
> **WRITING RULES:**
> - Use `{main_keyword}` naturally 3-5 times across the full content (NOT keyword-stuffing).
> - Tone: friendly, trustworthy, action-oriented. Speak to a gamer, not a corporate buyer.
> - Include 1-2 "G2G.com" mentions per section where natural.
> - Mention safety / escrow / verified sellers where relevant.
> - Never invent specific prices or guarantees we can't keep.
> - Never use forbidden phrases: "in conclusion", "in this article", "let's dive in", "look no further".

### Step 3 — Translate EN → Indonesian (ID)

For each row, also produce an `id_bundle` with the same schema but Indonesian content.

#### Translation instructions

> You are translating SEO product content from English to Bahasa Indonesia for G2G.com — an Indonesian-friendly gaming marketplace.
>
> **PRODUCT:** `{product_name}`
> **CATEGORY:** `{category}`
> **PRIMARY KEYWORD (English, keep as proper noun):** `{main_keyword}`
>
> **TRANSLATION RULES:**
> 1. Keep the structure identical: same `marketingIntro` lead paragraph, same 8 `marketingSections`, same number of FAQs (match the EN count).
> 2. Keep gaming proper nouns / brand terms in English: "WoW Gold", "Diablo Items", "PSN Card", "Steam Wallet", game titles.
> 3. Keep the primary keyword IN `metaTitle` and `metaDescription` (Indonesian users search the English brand term).
> 4. `metaDescription`: keep under 160 characters. Natural Indonesian, not stiff word-for-word.
> 5. `marketingIntro`: 40-60 word lead paragraph, plain prose, NO HTML tags.
> 6. `marketingSections`: PRESERVE all HTML tags (`<h2>`, `<p>`, `<ul>`, `<li>`, `<strong>`, `<ol>`, `<a>`) intact. Only translate the text inside tags.
> 7. `faqs`: translate question + answer naturally. Keep brand terms English.
> 8. Currency / price formatting: leave any USD or numeric values exactly as-is.
> 9. Tone: friendly + trustworthy. Use "kamu" (informal you), not "Anda" — matches the gaming audience.

### Step 4 — Submit per row

For each completed row, POST the bundles back to the app:

```bash
curl -sS -X POST "https://g2g-seo-tools.vercel.app/api/products/auto-content/cowork-submit" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "relation_id":       "<row.relation_id>",
    "owner_user_id":     "<row.owner_user_id>",
    "main_keyword":      "<row.main_keyword>",
    "secondary_keyword": "<row.secondary_keyword>",
    "en_bundle":         { ...enBundle },
    "id_bundle":         { ...idBundle }
  }'
```

Expected response: `{ ok: true, status: 'generated' }` or `{ ok: false, error: '...' }`.

**Submit ALL rows even if some fail individually.** Track which succeeded.

### Step 5 — Slack notification

After all rows have been attempted, post one summary message to Slack channel `C05V8QG8V99`:

```bash
# Replace $SLACK_TOKEN with the value from Vercel env / Slack admin — never commit the literal.
curl -sS -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{
    "channel": "C05V8QG8V99",
    "text":    "<summary message — see template below>"
  }'
```

**Summary message template (success):**

```
:white_check_mark: G2G Cowork content run — {timestamp}
• Processed: {N} rows
• Succeeded: {X}
• Failed: {Y}
• Sheet: <https://docs.google.com/spreadsheets/d/1eOtqAdasNpQLh7wKO0JOIwbyidrj1v5e0IKub-VkRuc/edit|EN tab>
{if Y > 0: list failed relation_ids + error reasons}
```

**Summary message template (no rows):**

```
:sleeping: G2G Cowork content run — {timestamp}
No pending rows this hour.
```

**Summary message template (cowork-pending fetch failed):**

```
:x: G2G Cowork content run FAILED to start — {timestamp}
Could not fetch pending rows: HTTP {code}
{body}
```

### Step 6 — Final chat output

End your run with a 3-line summary in the session output:

```
Processed: {N}
Succeeded: {X}, Failed: {Y}
Slack: posted (or: failed to post — reason)
```

## Hard rules

- **DO NOT** call `anthropic.messages.create` or any external LLM API. All generation is in-session.
- **DO NOT** modify any files in the project repository during a run.
- **DO NOT** retry a row in the same run if its submit fails — the next hourly run will pick it up if it's still marked `Cowork`.
- **DO NOT** process more than `BATCH_LIMIT = 10` rows in one run, even if the endpoint returns more.
- **DO NOT** call the cowork-pending or cowork-submit endpoints with a different bearer token.

## Notes on edge cases

- If `secondary_keyword` is empty, derive naturally from product context — don't fabricate fake keywords.
- If `category` is empty, fall back to "Default" section list (8 logical sections).
- If a row's `url` field is empty, generate the URL using the same logic as `buildProductUrl()` in `src/lib/product-content/process.ts`:
  - Gift card / Payment card → `gift-card/{slug}`
  - Account → `accounts/{slug}`
  - Video game / Game key / CD key → `cd-key/{slug}`
  - Software / App → `software/{slug}`
  - Boost → `boosting/{slug}`
  - Currency / Coin / Gold / Top up → `game-coins/{slug}`
  - Item → `game-items/{slug}`
  - Gamepal / LFG → `gamepal/{slug}`
  - Telco → `telco/{slug}`
  - Default → `product/{slug}`
  - `{slug}` = product name lowercased, non-alphanumeric replaced with `-`, leading/trailing `-` stripped.

---

End of prompt body.

---

## Open items before this becomes a real scheduled task

- [ ] Wait for `/api/products/auto-content/cowork-pending` and `/api/products/auto-content/cowork-submit` to ship to Vercel (other chat)
- [ ] Manually trigger this task against 3 sample rows (col E = `Cowork`)
- [ ] Spot-check content quality + sheet write correctness
- [ ] If approved → convert from ad-hoc to hourly cron (`0 * * * *`)
