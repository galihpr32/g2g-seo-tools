# Handoff to OG Migration Chat — 2026-05-06

This doc lists every file the **Hermod v2 / PPTX export** chat session
touched, so the parallel **OffGamers multi-brand migration** chat can
avoid overwriting work and merge cleanly.

Read this first. Look for ⚠️ markers — those are the conflict zones.

---

## TL;DR — three workstreams shipped this session

1. **Hermod v2** — outreach replaced SEMrush with DataForSEO + FireCrawl
   + Haiku evaluator. New table, new evaluator module, rewritten discover
   route, rebuilt Discovery UI with score columns + Brief mode toggle.
2. **Google Sheets/Drive auth hardening** — `getAuth()` now strips
   surrounding quotes, normalizes `\n`, fail-fast if private key markers
   missing. Replaces the cryptic OpenSSL `DECODER routines::unsupported`
   error with an actionable diagnostic.
3. **Monthly Report PPTX export** — new pptxgenjs-based builder, Drive
   upload, "Export PPTX" button on `/reports/monthly`. Builder supports
   an optional structured-card mode for executive audiences (used in the
   manual April 2026 deck).

---

## New files

| File | Purpose |
|---|---|
| `src/lib/agents/hermod-domain-eval.ts` | Hermod v2 domain evaluator. Skip-list, FireCrawl 7d cache reuse, Haiku 5-dim scoring tool_use, email regex with no-reply filter, three named thresholds (strict/balanced/loose) |
| `src/lib/reports/pptx-builder.ts` | Pure data → PPTX builder. 9 slide builders. Supports optional `narrativeHighlights[]` + `actionItems[]` overrides for exec-card style, falls back to prose/list otherwise |
| `src/app/api/reports/monthly/export-pptx/route.ts` | POST endpoint: load report → build PPTX → upload to Drive → return share link |
| `supabase/migrations/add_outreach_domain_scores.sql` | Hermod v2 cache table + `outreach_prospects` brief-mode columns |
| `supabase/migrations/add_monthly_report_pptx_columns.sql` | Persists Drive link on monthly_reports row |
| `SESSION_PROGRESS_2026-05-06.md` | Earlier session checkpoint (Hermod v2 era) |

## Modified files

| File | What changed |
|---|---|
| `src/app/api/outreach/discover/route.ts` | **Rewritten.** DataForSEO SERP top-10 → auto-skip filter → parallel evaluator → threshold filter. Removed all SEMrush calls. New query params: `threshold`, `locationCode`, `languageCode`, `includeBelow` |
| `src/app/(dashboard)/outreach/page.tsx` | DiscoveryPanel rewritten: new region selector, threshold dropdown, Brief mode toggle, score column with breakdown tooltip, outreach angle column, ✍️/📧 signal column. `Candidate` type + `handleAddToTracker` signature updated to carry score data |
| `src/app/api/outreach/prospects/route.ts` | POST accepts `approval_required` + `score_breakdown`. Brief-mode rows get `approved_for_send_at = null` |
| `src/lib/google/sheets.ts` | `getAuth()` defensive cleanup — strip quotes, normalize `\n`, fail-fast on missing BEGIN/END markers |
| `src/lib/google/drive.ts` | Same `getAuth()` hardening **+ NEW export** `uploadFileToDrive(buffer, filename, mimeType, opts)` |
| `src/app/(dashboard)/reports/monthly/page.tsx` | Added `📊 Export PPTX` button + `exportingPptx`, `pptxUrl`, `pptxError` state. Switches to `📊 View PPTX` once generated |
| `package.json` | **Added** `pptxgenjs ^4.0.1`. Don't drop on merge |

---

## Migrations — status

| Migration | Adds | Run in Supabase? |
|---|---|---|
| `add_outreach_domain_scores.sql` | `outreach_domain_scores` table + `outreach_prospects.approval_required` etc. | ❓ Probably not yet — Galih should run |
| `add_monthly_report_pptx_columns.sql` | `pptx_drive_id`, `pptx_drive_url`, `pptx_generated_at` on `monthly_reports` | ❓ Probably not yet — Galih should run |
| `add_offgamers_phase1.sql` (yours) | `site_slug` on 7 tables + monthly_reports unique constraint + OG ga4_property_id | ✅ Ran today |

---

## ⚠️ Conflict zones for the OG migration chat

### 1. `outreach_domain_scores` table

I created the table without a `site_slug` column. Phase 1 migration
adds `site_slug text NOT NULL DEFAULT 'g2g'` to it. **Both migrations
use `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`** so they work in
either order — but my evaluator (`hermod-domain-eval.ts`) doesn't
write `site_slug` yet. **Action needed in your chat:** thread
`siteSlug` through `evaluateDomain()` and the upsert payload.

Specifically in `src/lib/agents/hermod-domain-eval.ts`:
- `evaluateDomain(db, ownerId, domain, sourceKeyword, opts)` → add `siteSlug` param
- `getCachedScore(db, ownerId, domain)` → add `siteSlug` param + filter
- `persistEvaluation(...)` → include `site_slug` in row

And in `src/app/api/outreach/discover/route.ts` POST handler — pass
`siteSlug` from query param into `evaluateDomain`.

### 2. `outreach_prospects` — both touched

Your Phase 1 added `site_slug`. My migration added
`approval_required`, `approved_for_send_at`, `approved_for_send_by`.
No conflict — different columns. But the POST handler
`src/app/api/outreach/prospects/route.ts` writes brief-mode fields
without `site_slug`. **Action needed:** add `site_slug` to the upsert
payload (default to `'g2g'` for now, derive from request body when
multi-brand picker is wired in).

### 3. `package.json` — new dep

I added `pptxgenjs ^4.0.1`. If your branch also touched package.json,
make sure that line survives the merge.

### 4. `src/lib/google/drive.ts` — new export

I added `uploadFileToDrive(buffer, filename, mimeType, opts)`. The
`opts.folderId` defaults to `process.env.GOOGLE_DRIVE_FOLDER_ID`. For
multi-brand, you'll want to thread `site_configs.drive_folder_id` (per
brand) instead — change call sites in
`src/app/api/reports/monthly/export-pptx/route.ts`.

Also: `src/lib/google/sheets.ts` + `drive.ts` `getAuth()` now has
defensive cleanup. **Don't roll this back** — without it, malformed
private keys give the cryptic OpenSSL DECODER error.

### 5. `src/app/api/reports/monthly/route.ts`

I did NOT touch this file in this session. Your chat updated it for
multi-site filtering (now filters GET by `?site=g2g`, POST takes
`{ site }`). My `export-pptx` route reads from `monthly_reports` by
`id` only and trusts the row's stored `report_data` — no site
awareness needed there.

### 6. `src/app/(dashboard)/reports/monthly/page.tsx`

Both chats touched this file. My adds:
- Three pieces of state (`exportingPptx`, `pptxUrl`, `pptxError`)
- `exportPptx()` function
- Two new buttons (`📊 Export PPTX` / `📊 View PPTX`) in the header
- Inline error block below the existing `error` block

Yours added the site picker. Probably no conflict — different sections
of the file.

### 7. PPTX builder uses `monthLabel` heading "G2G Monthly Report"

Hard-coded in `src/lib/reports/pptx-builder.ts`:
- `pres.title  = \`G2G Monthly Report — ${r.monthLabel}\``
- `drawFooter` writes `'G2G Monthly Report'`
- Cover slide writes `'Prepared by G2G SEO Tools'`

When OG generates PPTX, these need to use `r.siteName` instead of
hardcoded "G2G". Quick edit in 3 places.

---

## Test/build artifacts to delete from repo

These were created during PPTX QA in the sandbox and got left behind
because the Linux container can't unlink across the macOS bind mount.
Galih should `rm` them:

```bash
rm "test-pptx.ts" "test-pptx.cts" "build-real.ts" "build-cards.ts" "build-cards.ts.bak" "G2G-Monthly-Report-April-2026.pptx"
```

(The PPTX is the manually-built April 2026 deck for stakeholder review;
keep it if useful, delete if not. The `.ts`/`.cts` files are sandbox
test scripts — definitely delete.)

---

## What's already deployed/live

- Hermod v2 code is pushed (commits before today's pull)
- Sheet/Drive auth hardening pushed
- Monthly PPTX export code pushed
- Migration `add_offgamers_phase1.sql` ran in Supabase today
- Vercel env: `GOOGLE_DRIVE_FOLDER_ID` updated, Drive API enabled in
  Google Cloud Console for project `549736826085`
- Folder shared with service account email — ⚠️ **verify this is
  actually done** before declaring PPTX export working

## What's NOT deployed yet

- `add_outreach_domain_scores.sql` migration — needs to run in Supabase
- `add_monthly_report_pptx_columns.sql` migration — needs to run in
  Supabase (optional but recommended; non-fatal if skipped)

---

## Open API contract changes the OG chat should know

**Hermod v2 API:** `GET /api/outreach/discover?keyword=X&threshold=balanced&locationCode=2840&languageCode=en` returns:
```ts
{
  candidates: Array<{
    domain, rankingUrl, position,
    overallScore, nicheScore, qualityScore, outreachScore, audienceScore, trustScore,
    outreachAngle, hasWriteForUs, contactEmail, notes, cached, evaluatedAt,
    organicTraffic, organicKeywords, authorityScore,  // legacy, all 0
    inTracker, trackerStatus, belowThreshold,
  }>,
  threshold, thresholdValue, total, autoSkipped, belowThreshold,
  locationCode, languageCode,
}
```

**PPTX export API:** `POST /api/reports/monthly/export-pptx` with body
`{ id: string }` returns:
```ts
{ ok: true, fileId, url, filename, sizeBytes }
```

**PPTX builder input shape (lib API):**
```ts
buildMonthlyReportPptx({
  reportData,        // monthly_reports.report_data
  aiNarrative,       // monthly_reports.ai_narrative
  aiActionPlan,      // monthly_reports.ai_action_plan
  narrativeHighlights?,  // optional — exec card style
  actionItems?,          // optional — exec card style
})
```

When `narrativeHighlights` is supplied, slide 3 renders 6 insight cards
in a 2×3 grid instead of prose. When `actionItems` is supplied, the
final slide renders priority cards in a 2×4 grid. **Future
enhancement:** have the AI narrative prompt produce these structured
arrays directly so generated reports match the manual stakeholder deck.

---

_End of handoff. Ping the previous chat session if anything is unclear._
