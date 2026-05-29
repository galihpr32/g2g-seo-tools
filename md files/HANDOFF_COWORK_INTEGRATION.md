# Handoff: Cowork Claude Integration for Product Content Auto-Generation

**Date:** 2026-05-15
**Status:** Design locked. Implementation **on hold** pending parallel feature work in another chat — do not start until Galih signals.
**Owner:** Galih (galih.priambodo@g2g.com)
**Originating chat:** Cowork session, 2026-05-15

---

## TL;DR

We are adding a **second processing path** to the product content auto-generation pipeline. The current path calls Anthropic Haiku via API for every row; the new path delegates generation to **Cowork Claude** (no per-token cost, since Cowork is included in the existing subscription).

Both paths share the same DataForSEO keyword fetch + Google Sheets write-back + G2G CMS upload code. They are routed by a new trigger value in column E of the EN tab.

**Why:**

- Haiku API cost scales linearly with backlog — at current volume this is non-trivial spend
- Cowork Claude generation is included in the Cowork subscription (zero marginal cost per row)
- Quality is expected to be higher (Sonnet-class > Haiku for nuance, brand voice, FAQ realism)

**Trade-off:** Cowork Claude is slower than Haiku in absolute throughput (sequential within one session vs. parallel API calls), so this is intended as the **primary path for ongoing backlog**, with `Yes` (Haiku) reserved for urgent / high-volume bursts.

---

## Trigger Routing — col E values

| Value | Processed By | Notes |
|---|---|---|
| `Yes` | Existing Anthropic Haiku cron (`/api/cron/product-content-auto`) | **Unchanged.** Fires every 5 min. |
| `Cowork` | **NEW** Cowork Claude scheduled task (hourly) | Set up in Cowork after Vercel changes deploy. |
| `Generated` | Nobody | Done. |
| `Error: ...` | Nobody | Failed; manual retry. |

User picks per-row which path to use by typing the appropriate value in col E.

---

## Code Changes Required (Vercel app — `g2g-seo-tools`)

### 1. `src/lib/product-content/run.ts`

Add a `trigger` parameter to `runPendingForOwner`:

```ts
export async function runPendingForOwner(
  db: SupabaseClient<any, any, any>,
  supabase: SupabaseClient<any, any, any>,
  ownerId: string,
  options: { limit?: number; trigger?: 'yes' | 'cowork' } = {},
): Promise<RunResult>
```

- Default `trigger = 'yes'` — keeps existing cron behavior with zero call-site changes
- Sheet scan filter compares col E (lowercased, trimmed) against `trigger`
- Cowork pending endpoint passes `'cowork'`

### 2. `src/lib/product-content/process.ts`

Refactor `processProductRow` to accept pre-generated content:

```ts
interface ProcessOptions {
  preGeneratedBundle?:   ProductContentBundle   // EN
  preGeneratedIdBundle?: ProductContentBundle   // ID
}

export async function processProductRow(
  row: QueueRow,
  db: SupabaseClient<any, any, any>,
  supabase: SupabaseClient<any, any, any>,
  sheet: SheetTarget | null,
  options?: ProcessOptions,
): Promise<ProcessResult>
```

Inside the function body:

- **Keyword fetch (DataForSEO)** — always runs (Cowork still benefits from real keyword data)
- **EN generation** — `options?.preGeneratedBundle ?? generateEnContent(...)`
- **ID translation** — `options?.preGeneratedIdBundle ?? translateProductContent(...)`
- **Everything else** (DB persist, sheet write via `writeProductRow`, `attemptCmsUpload`) — unchanged

The Haiku `anthropic.messages.create()` call inside `generateEnContent` is **skipped entirely** when a pre-generated bundle is provided. Same for the translation Haiku call.

### 3. NEW: `src/app/api/products/auto-content/cowork-pending/route.ts`

```
GET /api/products/auto-content/cowork-pending?limit=10
Auth: Bearer ${CRON_SECRET}

Response (200):
{
  ok: true,
  rows: [
    {
      relation_id:        string,
      owner_user_id:      string,
      product_name:       string,
      category:           string,
      url:                string,
      main_keyword:       string,
      secondary_keyword:  string,
      sheet_row:          number,
      spreadsheet_id:     string,
      sheet_name:         string,
    }
  ]
}
```

Implementation notes:

- Authenticate via the existing `isCronAuth(req)` helper pattern in `cron/product-content-auto/route.ts`
- For each owner with a `product_sheet_config` row, scan the EN sheet for col E = `Cowork` (case-insensitive)
- For the first N rows (across all owners, capped at `limit`), call `getKeywordSuggestions()` from `lib/dataforseo/client` and enrich the row
- Default `limit` = 10. Hard max = 25.
- DataForSEO keyword fetch failures should fall back to `mainKeyword = productName` (same behavior as `processProductRow`)

### 4. NEW: `src/app/api/products/auto-content/cowork-submit/route.ts`

```
POST /api/products/auto-content/cowork-submit
Auth: Bearer ${CRON_SECRET}

Request body:
{
  relation_id:        string,
  owner_user_id:      string,
  main_keyword:       string,
  secondary_keyword:  string,
  en_bundle: {
    metaTitle:         string,
    metaDescription:   string,
    metaKeyword:       string,
    marketingTitle:    string,
    marketingIntro:    string,
    marketingSections: string[],  // 8 items
    faqs:              { q: string; a: string }[],  // 5-7 items
  },
  id_bundle: { /* same shape, Indonesian content */ }
}

Response (200):
{ ok: true, status: 'generated' | 'failed', error?: string, warning?: string }
```

Implementation notes:

- Authenticate via `isCronAuth(req)`
- Look up the queue row by `relation_id` + `owner_user_id`
- Build a `QueueRow` from the looked-up row + a `SheetTarget` from `product_sheet_config`
- Call `processProductRow(row, db, supabase, sheet, { preGeneratedBundle: en_bundle, preGeneratedIdBundle: id_bundle })`
- Forward the result back to the caller

### 5. (Defensive, optional) `src/app/api/cron/product-content-auto/route.ts`

Explicitly pass `trigger: 'yes'` so the Anthropic path can never accidentally pick up a `Cowork` row, even if defaults change later:

```ts
const result = await runPendingForOwner(db, db, cfg.owner_user_id, {
  limit:   PER_OWNER_LIMIT,
  trigger: 'yes',
})
```

---

## Cowork-Side Implementation

**Handled in the Cowork session, NOT by this parallel chat.** Listed here only for full context.

Once the Vercel changes ship:

1. Cowork creates a scheduled task in Cowork mode (cron `0 * * * *` = hourly, local time)
2. Each run, the task:
   - `GET /api/products/auto-content/cowork-pending?limit=10` with the bearer token
   - For each returned row, generate content within the Cowork session itself, using the exact same prompt as `buildPrompt()` in `process.ts` (8 H2 sections, 5–7 FAQ, meta SEO, brand voice rules)
   - Generate the Indonesian translation in the same session (skipping the second Haiku call)
   - `POST /api/products/auto-content/cowork-submit` per row with the bundles
   - Aggregate results and post a Slack summary to channel `C05V8QG8V99`

No external Anthropic API key is used by the Cowork path — generation happens within the Cowork session.

---

## Out of Scope / Guards

- **DO NOT START** any of the changes in section 3-5 above until Galih signals the parallel feature work in the other chat has merged. Reason: avoid stacked diffs and merge conflicts.
- **DO NOT modify** `src/lib/g2g/auto-upload.ts` or `uploading tools/upload.js`. CMS upload path is unchanged for both flows.
- **DO NOT change** the existing `/api/cron/product-content-auto` cadence (5 min). It keeps serving the `Yes` flow as-is.
- **DO NOT rename** `Yes` or `Generated` trigger values — both flows depend on them.

---

## Test Plan (after the Vercel changes ship)

1. Set col E = `Cowork` on **3 sample rows** in the EN tab of "G2G | AI Content Production May - 2026" (sheet ID `1eOtqAdasNpQLh7wKO0JOIwbyidrj1v5e0IKub-VkRuc`)
2. Cowork chat manually triggers the scheduled task once (no auto-loop yet)
3. Verify, for each of the 3 rows:
   - Columns F–AG filled correctly on EN tab
   - Matching row in ID tab also filled
   - Col E flipped to `Generated`
   - `product_content_queue` row in Supabase shows `status = 'generated'`, both `marketing_sections` and `id_marketing_sections` populated
   - `cms_*` columns reflect CMS upload outcome
4. Spot-check content quality on the 3 rows (brand voice, keyword usage, FAQ realism)
5. If all 3 pass — Cowork chat enables the hourly schedule and Slack notifications

---

## Decisions Already Locked (no re-litigation needed)

- Trigger value: `Cowork`
- Batch size: **10 rows per Cowork run**
- Cadence: **hourly** (`0 * * * *`)
- Notifications: **Slack to `C05V8QG8V99`** after each run
- Quality gate: **3-row manual approval before auto-loop activates**
- Keyword research: **keep DataForSEO** (real creds in Vercel env, not `.env.local`)
- Sheet write mechanism: **reuse `writeProductRow` via the new endpoints** (no third-party Sheets MCP)

---

## References

- Current pipeline: `src/lib/product-content/process.ts` (header comment lines 17-29 summarizes the per-row flow)
- Current cron entry point: `src/app/api/cron/product-content-auto/route.ts`
- Sheet column layout: `uploading tools/Handoff.md` (columns A through AH documented in detail)
- Production sheet: https://docs.google.com/spreadsheets/d/1eOtqAdasNpQLh7wKO0JOIwbyidrj1v5e0IKub-VkRuc/edit
- Vercel deploy: https://g2g-seo-tools.vercel.app
- `CRON_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` already present in `.env.local` and (presumably) in Vercel env vars
