# `/reports/`

Auto-generated artifacts from the Cowork-scheduled automation tasks
(see Phase 2-4 in HANDOFF / commit history).

## File naming convention

```
YYYY-MM-DD-briefing.md          ← Daily morning briefing (Task 1)
YYYY-MM-DD-watchdog-{HHmm}.md   ← Watchdog alerts (Task 2; only when issues)
YYYY-MM-DD-review-{briefId}.md  ← Claude brief independent review (Task 3)
YYYY-WW-weekly.md               ← Weekly synthesis (future)
```

## Git policy

The folder itself is committed (with this README). Output files are
**gitignored** — they regenerate every run and would otherwise pollute
diffs. If you want to archive a specific report, copy it elsewhere or
manually add to git.

## Read pattern

Output files are written by Cowork-scheduled tasks running on the
project owner's machine. They are NOT served by the Vercel app. Tooling
that needs to display them in the dashboard reads from the
`automation_briefings` table in Supabase instead (populated by the
same scheduled tasks via Supabase REST).

## Manually trigger a task

From the Cowork session:
- "Run the daily briefing manually for today"
- "Check the watchdog one time and report"
- "Review brief [briefId] now"

The scheduled-task prompt is invoked the same way as scheduled runs.
