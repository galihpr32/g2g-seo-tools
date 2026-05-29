# Session notes — 2026-05-08

## Galih's confirmations (waiting to execute pending #8 discussion)

1. **Logo branding** → text logo OK, no PNG/SVG needed
2. **Channel breakdown slide** → table-only + mini sparkline per row
3. **Action plan card count** → dynamic (whatever AI generates)
4. **Slide order** → keep current v2 order
5. **In-tools monthly viewer page** → "semua yang gw report di pptx, harus appear juga di in-tools page" — replicate every PPTX section as page section
6. **Export error UI** → show actual error message (not generic "Failed to export PPTX")

## Bugs to fix

- **Mimir Council cross-site contamination** → on G2G domain, Mimir cites OffGamers data. `loadMimirCouncilContext` likely missing `site_slug` filter on one of: monthly_reports / weekly_reports / keyword_ranking_history / experiments / tracked_products lookups.

## Open discussion

- **#8 — strategic outcomes mapping** → see thread; **STILL IN DISCUSSION**, jangan finalize. Galih lagi explore gimana split workflow ke 4 PIC.

## Backlog (not yet to-do, decisions made but holding)

- **Sprint label** (`sprint_id` column di `seo_content_briefs`) — APPROVED to build, but **don't run yet**. Galih akan kasih sinyal kapan eksekusi.
- **WIP limit per writer** — REJECTED, ga jadi build.
- **PIC assignment column di briefs/action items** — REJECTED, ga jadi build.
- **Sprint approval gate dari Asst Manager** — REJECTED. Specialist 1 self-approve sprint mereka karena Loki+Odin+Tyr udah filter upstream.
- **Mimir Level C** (universal companion + memory + executable actions) — phase 2 setelah arch ready

## Pending action user (post-Sprint-1)

- Run migration `add_kb_rule_proposals_and_bug_reports.sql` di Supabase.
- Set env var `FEEDBACK_ADMINS` di Vercel = Galih's user ID (so /feedback admin view works for Head).
- Optional: set `SLACK_WEBHOOK_URL` so new bug reports notify Slack. ✅ done
- Add `kb-rule-extraction.yml` GitHub Action's `APP_URL` + `CRON_SECRET` (already configured for other crons).
- First proposal extraction will run 5th of next month, OR click "⚡ Run extractor now" at /knowledge-base/proposals manually.

## Pending action user (post-Sprint-2)

- Run migration `add_mimir_page_context.sql` di Supabase (small column add).
- GitHub Action `experiment-metric-update.yml` will activate Monday 06:00 UTC (uses existing APP_URL + CRON_SECRET).
- First Mimir Level B test: open /reports/monthly, select a report, click "🪶 Ask Mimir" — page-aware chat opens.
- First Pre-Meeting Prep test: go to /experiments → click "🪶 Pre-Meeting Prep" → Sonnet analyzes all active experiments, returns continue/stop/inconclusive recommendation per row.

## Pending action user (post-Sprint-3)

- No new migrations — Sprint 3 is all UI + behavior changes.
- Test Tyr auto-suggest: open any borderline brief (Tyr 60-79) → suggestion panel appears at top of Tyr review with action button.
- Test per-section regenerate: click "Section Regenerate — FAQ Suggestions" on a brief where Tyr called out FAQ quality.
- Test Ranking Impact classifier: visit /reports/ranking-impact → see new "Class" column + filter strip (LANDED/LANDING/STALLED/FAILED).
- Test Generate retro draft: visit /team-performance → click "🪶 Generate retro draft" → pick weekly/monthly → Mimir drafts a candid retro you can edit + copy.
- Test Opportunities dedup: visit /command-center/opportunities — opportunities matching past briefs/actions in last 90d show "↺ Already shipped" or "⚠ In progress" badge. Expand row to see past work list.

## Pending action user (post-Sprint-6) — FINAL CYCLE

### Test surfaces:
- /reports/monthly — see new "Key Takeaways" card grid (mirrors PPTX slide 4) + new "Recommended Action Plan" card grid (mirrors PPTX slide 8) above the existing Executive Summary prose
- Re-export PPTX from any monthly report — cover now has G2G/OG text logo top-right, channel breakdown is full table (no chart), search trend is LINE chart with endpoint % deltas, top pages is side-by-side March|April with diff% column
- /site-health — overview page with "🪶 Generate Tech Health Summary" button (Sonnet)
- /site-health/schema — schema_health_snapshots table sorted broken-first
- /site-health/psi — Lighthouse + CWV scores per page
- Slack channel — daily 09:00 WIB tech-escalation digest (only fires when stale >14d items exist)

### Workflows auto-active:
- `tech-escalation.yml` — daily 02:00 UTC

---

## Pending action user (post-Sprint-4 + Sprint-5)

### New migrations to run:
- `add_backlinks_verification_columns.sql` (Sprint 4.1)
- `add_outreach_replies.sql` (Sprint 4.3)
- `add_schema_health_snapshots.sql` (Sprint 5.3)
- `add_psi_snapshots.sql` (Sprint 5.4)

### New env vars:
- `PSI_API_KEY` — Google PageSpeed Insights API key (Google Cloud Console → APIs → Pagespeed Insights API → create API key). Optional; cron skips gracefully if missing.

### New GitHub Action workflows (will auto-activate on push, use existing APP_URL+CRON_SECRET):
- `backlinks-verify.yml` — daily 03:00 UTC, daily auto-verify pending → active/broken
- `schema-health.yml` — Sundays 04:00 UTC, weekly schema validation
- `psi-monthly.yml` — 1st of month 05:00 UTC, monthly PSI check

### Test surfaces:
- /backlinks — see new Portfolio Dashboard at top (cost-per-position, anchor mix, monthly cost, status breakdown)
- /outreach — see new OutreachFunnel at top (Discovered → Sent → Replied → Agreed → Live), plus "📧 Log reply" button per prospect row
- /competitive/backlink-gap — NEW page; click "🚀 Run on tracked competitors" → DFS pulls competitors' refs, diffs against ours, returns outreach gold list
- /outreach prospect detail → "Generate Opener" modal — new toggle: opener-only vs full-email mode
- /content/broken-urls — colored classification badge per row (HIGH-IMPACT 404 / SERVER ERROR / etc.) + "✅ Create Action Item" button on expand
- /semrush/site-audit — backed by `/api/semrush/site-audit/classify` for context-aware severity (lib in place; UI integration incremental)

## Workflow automation roadmap — Galih's confirmed decisions (2026-05-08)

Format: ✅ approved to build, 🐛 bug to fix, ❓ needs clarification.

### Specialist 1 (On-Page) — confirmed builds

| Ref | Build item | Notes |
|---|---|---|
| 1.1 | ✅ Auto-snooze opportunities aged >21d | "stale opportunity" archive |
| 1.2a | ✅ Inline shortcuts dari opportunity card → keyword-gap / keyword-map source | one-click cross-tool nav |
| 1.2b | ✅ AI score transparency (show breakdown: volume, intent, DA gap, etc.) | |
| 1.2c | ✅ **Dedup detection** — kalau opportunity/clicks-drop muncul 2-3 kali dalam 90D, kasih notes "previously worked on" + link ke historical action item/brief | prevent rework |
| 1.3 | ✅ Unify keyword-gap entries → single Opportunities queue dengan source tag | reduce data source friction |
| 1.4 | ✅ Saga = authoritative cluster source. Semua tools harus integrate ke keyword-map. Yang ga ke-auto-cluster: collect ke "needs manual triage" list. | |
| 1.5 | ❌ NO sprint approval gate | Specialist 1 self-approves |
| 1.6 | ⚠️ Catatan: Bragi monitoring jangan overlap sama tools lain di pipeline | check existing UIs |
| 1.7 | ✅ Tyr verdict per dimension (max 2-3 lines, expandable) | scannable |
| 1.9a | ✅ Tyr override auto-suggest based on dimension failure pattern | |
| 1.9b | ✅ **Per-section regenerate** — rewrite specific section instead of full brief regen | |
| 1.10 | ✅ Add `blocker` status di brief | writer can flag stuck |
| 1.11a | 🔄 Reassign Ranking Impact daily check ke Asst Manager / Head | not Specialist 1 |
| 1.11b | ✅ Auto-classifier: landed / landing / stalled / failed | Haiku rule |
| 1.12a | 🔄 Reassign retro writing ke Asst Manager / Head | not Specialist 1 |
| 1.12b | ✅ "Generate retro draft" button di /team-performance | Haiku |
| 1.13 | ✅ "Promote to KB" button di brief detail page | critical for KB feedback loop |
| 1.15a | ✅ Auto KB rule extraction monthly cron — winners + losers → Sonnet → propose rules → user accept | **highest leverage automation** |
| 1.15b | ✅ **NEW: in-app bug/scratch report tool** — siapapun bisa input dari any page, terima oleh Head untuk fix | replaces external tracking |
| 1.16 | ✅ Cannib history timeline (snapshot weekly, surface "first detected" date + trend) | |
| 1.17 | ✅ Monthly report draft mode — manajemen bisa preview & kasih commentary inline | |

### Specialist 2 (Off-Page) — confirmed builds

| Ref | Build item | Notes |
|---|---|---|
| 2.1 | ✅ Start with "Log reply" manual button (paste email content). Gmail OAuth later. | phased |
| 2.2 | ✅ Backlinks auto-verify cron (pending → active/broken via cURL + anchor match) | |
| 2.3 | ✅ Outreach follow-up reminders + Slack notif | |
| 2.4 | 🐛 **Hermod outreach exclusion bug** — currently returns competitors/marketplaces (g2g.com, overgear, playerauctions, eldorado, OffGamers) as prospects. **Fix exclusion logic.** | HIGH PRIORITY |
| 2.5 | ❓ Question dari Galih: gimana evaluation reasoning Hermod kalau SEMrush limited? **Clarify — kita udah switch ke DataForSEO, DR diambil dari DFS** | see chat |
| 2.6 | ✅ Outreach email gen — toggle: generate opener / generate full email | optional |
| 2.7 | ✅ Surface acquired links impact ke target page position | |
| 2.8 | ✅ In-app cost-per-position widget di /reports/backlinks | |
| 2.9 | ✅ Backlink portfolio dashboard (DR distribution, anchor mix, follow/nofollow ratio) | |
| 2.10 | ✅ Outreach funnel chart (Sent→Replied→Agreed→Live) | |
| 2.11 | ✅ Competitor backlink gap via DataForSEO backlinks API | |

### Asst Manager (Technical) — confirmed builds

| Ref | Build item | Notes |
|---|---|---|
| 3.1 | ✅ Index Coverage "new since yesterday" delta highlight | |
| 3.3 | ✅ Broken URLs auto-classify + auto-create action item untuk high-traffic 404 | |
| 3.5 | ✅ Site Audit findings auto-classify severity | rule lib + Haiku |
| 3.6 | ✅ In-app schema validity tracking (cron weekly fetch JSON-LD per top page, validate) | |
| 3.7 | ✅ Auto-escalation cron via existing Slack channel (no new channel) | |
| 3.8 | ✅ Monthly tech summary auto-gen narrative | for dev/leadership |
| 3.9 | ✅ PSI API integration cron monthly | |
| 3.10 | ❌ NO Slack-based approvals (aligned dengan removal of sprint approval) | |

### Head (Experiments + Strategic) — confirmed builds

| Ref | Build item | Notes |
|---|---|---|
| 4.1 | ✅ **"Mimir Everywhere" Level B** — Mimir mini-panel embedded di key pages dengan page-specific data + actions. (Level C — universal companion + memory + executable actions — di backlog buat phase 2 setelah arch ready) | confirmed Level B |
| 4.2 | ✅ Weekly cron auto-update experiment `current_value` from `keyword_ranking_history` | |
| 4.3 | ✅ Auto-flag stagnant experiments (current_value unchanged 14d) | |
| 4.4 | ✅ Mimir pre-meeting prep — auto-summarize evidence + recommendation per experiment | |
| 4.5 | ✅✅ **"Promote to KB" everywhere** — universal pattern across briefs, experiments, KB exclusions. Anywhere user has insight, button to feed back. | architectural pattern |
| 4.6 | ✅ Mimir hard-block duplicate proposals (>70% fuzzy match to active/past experiments) | |
| 4.7 | ✅ Monthly report inline commentary system | aligned with 1.17 |

### Bugs (fix before further builds)

| Ref | Bug | Severity |
|---|---|---|
| 4.1-bug | Mimir Council site_slug filter missing → cross-site data contamination | HIGH |
| 2.4 | Hermod outreach prospect exclusion ga reject competitors/marketplaces | HIGH |
| (PPTX) | Generic "Failed to export PPTX" message — surface real error | MEDIUM |
| (claude_review_reviewed_at typo) | Already fixed in this session ✅ | DONE |
