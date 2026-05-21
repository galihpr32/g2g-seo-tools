# G2G SEO Agents — Audit Report
**Tanggal:** 2026-04-26
**Mode:** Static analysis (kode + schema). Belum ada live run / DB inspection.
**Scope:** 5 agents (Bragi, Heimdall, Hermod, Loki, Odin) + executor + brief-generator + API routes + scheduler.

---

## TL;DR — Kenapa kinerjanya jelek

Agent-nya **bukan bug-free, tapi yang lebih besar adalah masalah desain**. Tiga akar masalah yang bikin kerjaan keliatan dangkal & sering "berhasil tapi 0 hasil":

1. **Silent failure di mana-mana.** External API (DataForSEO, Steam, GSC) di-`try/catch` lalu di-`console.warn`. Run tetap dilaporkan `success` walaupun data gagal di-fetch — user lihat "Loki sukses, 0 actions" dan ngira ga ada gap, padahal API-nya error.
2. **Heuristik dasar bocor.** Heimdall pakai `midpoint split` dari array bukan dari tanggal — kalau snapshot tidak rata (gap weekend, double-snapshot), perbandingan minggu lalu vs minggu ini *jadi ngawur*. Loki & Odin punya magic number tanpa konteks.
3. **LLM output ga grounded.** Brief-generator pakai regex JSON extraction, fallback ke template kosong kalau Claude balikin format beda. Action descriptions Bragi & Loki bersifat string concat tanpa data signal — "competitive content review" tanpa keyword/page spesifik.

Plus dua **infra-level issues** yang memperparah:

4. **Cron-nya cuma 1x sehari** (`vercel.json` → `0 2 * * *`). Comment di route bilang "every 15 minutes" — mismatch. Jadwal user di luar jam 02:00 UTC praktis ga akurat.
5. **Outer route catch ga update `agent_runs`.** Kalau agent throw *sebelum* masuk try-block-nya sendiri (mis. error di `createServiceClient`), run nyangkut di `running` selamanya.

---

## Per-Agent Findings

### 🔴 Heimdall (Watchdog) — BUG STRUKTURAL
**Apa: deteksi ranking drop dari GSC, queue action items.**

Yang rusak (line numbers refer to `src/lib/agents/heimdall.ts`):

- **Line 87 — midpoint split berdasarkan row count, bukan tanggal.**
  ```ts
  const mid = Math.floor(drops.length / 2)
  const firstWeek = drops.slice(0, mid)
  const lastWeek = drops.slice(mid)
  ```
  Kalau ada 18 baris (gap weekend), "minggu lalu" punya 9 baris, "minggu ini" 9 — tapi tanggal-nya bisa overlap atau ga rata. Hari yang punya 2 snapshot dihitung dobel weight. **Severity: tinggi** — ini bikin deteksi drop salah arah.
- **Line 98, 118 — `pos_prev` / `pos_now` di-overwrite, bukan diaverage.** Page yang turun dari rank 3→8→2 cuma kerekam rank 2 di akhir. Description bilang "dropped from position -1" yang nonsense.
- **Line 144 vs 154 — beda kolom URL** (`seo_action_items.page` vs `seo_content_briefs.page_url`). Kalau format absolute vs relative beda, dedup gagal & double-queue.
- **Line 194 — silent insert failure.** `if (!insertErr) actionsQueued++` — kalau insert gagal, ga dilog, dan summary tetap bilang sukses sebagian.

**Fix prioritas:**
- Ganti midpoint dengan filter explicit `gte('snapshot_date', sevenDaysAgo)` & `lt(...)` → dua query atau dua filter pass.
- Average position, jangan overwrite. Atau pakai `min`/`max` dan tampilkan range.
- Normalize URL sebelum dedup.

---

### 🔴 Loki (Competitive) — KEHILANGAN DATA SECARA DIAM-DIAM
**Apa: keyword gap analysis via DataForSEO + SOV trend.**

- **Line ~117-119 dan ~201-202 — silent DataForSEO failure.** Try/catch yang `console.warn(...)` lalu lanjut. Run dilaporkan sukses dengan 0 actions. User ga tau API-nya errornya 403 / rate-limited / out-of-credits. **Ini bug terpenting di Loki.**
- **Line 41-53 — branded blocklist fragile.** `domain.split('.')[0]` ga handle `five-games.com`, `fivegames.net`, atau brand yang multi-word. Bisa overblock generic terms (`steam` dari `store.steampowered.com`) atau underblock brand variant.
- **Line 167 — SOV threshold absolute, bukan relatif.** `sovChange < -5` ngeflag drop 5 posisi sebagai high regardless of base. Domain dengan 40 ranks turun 5 (12.5%) sama priority dengan domain 20 ranks turun 5 (25%).
- **Line 125-137 — SOV date range overlap.** Snapshot di hari ke-30 muncul di `recentSnaps` *dan* `olderSnaps` → counted twice.
- **Output kualitas — action description vague.** "G2G's visibility dropped X positions... Recommend a competitive content review." → keyword mana? page mana? user ga punya arah.

**Fix prioritas:**
- DataForSEO error harus *throw*, bukan warn. Kalau mau graceful, simpan flag `partial: true` di run summary.
- SOV threshold pakai persentase relatif terhadap base.
- Action description harus include 3-5 keyword spesifik + competitor URL yang menang.

---

### 🟡 Odin (Trend Spotter) — OUTPUT TIPIS TANPA STEAM DATA
**Apa: cari trending games dari `game_trends_cache`, enrich dari Steam.**

- **Line 38, 44, 63 (lihat `fetchTrendReasons`) — silent timeout.** Steam API timeout ditangkap dengan `catch {}` dan `reasons` dibalikin kosong. Lalu line 169-180 bikin fallback description generic ("Trending on Steam") tanpa konteks. **~50% action besar kemungkinan dapat description hampa kalau Steam lagi lambat.**
- **Line 158-161 — priority formula ngawur.** `totalScore = search_volume + players_2weeks / 100`. Mencampur unit beda (search query vs concurrent player) dengan addition tanpa normalisasi. 10K SV + 100K players sama dengan 11K SV + 0 players — sinyal beda total tapi score sama.
- **Line 84-88 — cache freshness ga dicek.** `game_trends_cache` bisa basi 7 hari, Odin tetap pakai.
- **Line 98-106 — `.single()` instead of `.maybeSingle()`** → throw kalau game ga punya GSC ranking.

**Fix prioritas:**
- Retry Steam API sekali sebelum giving up; kalau tetap gagal, *skip* game tsb (jangan queue action tanpa konteks).
- Priority pakai AND logic atau weighted normalized score.
- Reject cache > 24h, force refresh.

---

### 🟡 Hermod (Outreach) — TEMPLATE EMAIL TANPA PERSONAL TOUCH
**Apa: cari prospek backlink dari SERP, generate pitch email.**

- **Line 90-96 — fallback "manual research needed"** kalau ga ada SERP data. Action ini ga actionable — user terima notif "find prospects manually" tanpa data sama sekali.
- **Line 100 — magic number `position <= 15` lalu `slice(0, 10)`** tanpa penjelasan. Inconsistent.
- **Line 219-260 — email template generic.** 3 hardcoded template (buy/guide/partnership), zero personalisasi. Padahal Claude bisa diminta refer ke artikel spesifik domain target. Hasilnya email yang spammy.
- **Dependency stale data dari Loki** — kalau Loki ga jalan 20 hari, Hermod bekerja dengan intel basi. Ga ada freshness check.

**Fix prioritas:**
- Hentikan queue "manual research" — kalau no SERP, log dan exit.
- Email body harus include 1-2 fakta spesifik tentang domain target (article title, audience size, latest post topic) dari fetch ringan.
- Pre-flight check: kalau Loki gap > 14 hari, throw warning "rerun Loki first".

---

### 🟡 Bragi (Brief Drafter) — DESCRIPTION HAMPA, URL HARDCODED
**Apa: queue draft brief untuk keyword yang udah di-approve.**

- **Line 31, 108 — URL pattern hardcoded** `https://g2g.com/categories/{keyword}`. Subkategori atau format URL beda → broken link. Executor insert orphan record.
- **Line 73 — `twoDaysAgo` hardcoded** untuk filter approvals. Kalau Bragi jalan weekly (sesuai schedule UI), dia missed approval >48h. **Ini langsung patah dengan cron config-nya yang daily.**
- **Line 146-171 — silent insert.** Sama dengan Heimdall.
- **Line 155 — description tanpa data signal.** "Based on approved {action_type} for {keyword}" — ga ada SV, ga ada priority reason, ga ada competitor reference.

**Fix prioritas:**
- URL ambil dari payload upstream (Loki / Heimdall) atau resolve via existing `seo_content_briefs` mapping.
- Window filter pakai `last_run_at` dari agent record, bukan hardcoded 2-day.
- Description include: search volume, source agent, why this keyword (top-N gap, sov drop, etc).

---

### 🟠 Brief-Generator — JSON PARSING RAPUH, FALLBACK GENERIK
**Apa: panggil Claude buat generate outline + meta dari brief draft.**

- **Line 65 — single API call, no retry.** Claude timeout / rate limit → brief stuck di `generating`.
- **Line ~239 — regex JSON extraction.** Kalau Claude balikin markdown fence (```json ... ```) atau partial JSON, regex fail → fallback. Ga pakai structured output / JSON mode.
- **Line 143-160 — KB matching by substring** (`urlSlug.includes(kb.name.toLowerCase())`). `/categories/buy-wow-gold` ga match KB "WoW Items". Brand voice user ilang.
- **Line 272-287 — fallback hardcoded template** identik untuk semua keyword. Brief untuk "Minecraft sword" dan "CS2 skins" output struktur sama, beda cuma keyword.

**Fix prioritas:**
- Pakai `tool_use` / structured output schema (Zod), bukan regex.
- Retry 2x dengan exponential backoff sebelum fallback.
- KB match pakai semantic similarity atau slug-mapping table eksplisit.

---

### 🟠 Executor — FIRE-AND-FORGET, SITE URL HARDCODED
**Apa: dispatch approved actions ke target tables.**

- **Line ~150-160 — `generateAgentBrief(...).catch()` tanpa await.** Action ditandai `executed` tapi brief generation gagal silent → brief nyangkut `draft` selamanya. User ngira sukses.
- **Line 66, 71, 122, 133 — `https://g2g.com` hardcoded** di 3 action types. Kalau site_slug user beda, executor diam-diam insert dengan URL salah.
- **Line ~194-208 — handoff cuma Bragi.** Loki/Heimdall handoff balikin "pending_implementation". Tapi *response* tetap ok=true → user ngira handoff jalan.

**Fix prioritas:**
- Await brief generation, atau tandai action `pending_brief_gen` & retry queue.
- siteUrl baca dari `site_configs.site_url` by slug.
- Implement remaining handoffs atau return 400 explicit.

---

## Cross-Cutting Issues (Affect All Agents)

### 1. Silent failure pattern
Setiap agent wrap external call di `try { ... } catch (e) { console.warn(e); continue }`. Konsekuensinya:
- Run dilaporkan `success` walau data ga lengkap.
- User ga punya signal kapan API rusak vs data emang kosong.
- **Fix:** introduce status `partial` di `agent_runs` + `error_message` walau status `success`. Atau threshold: kalau >50% data gagal di-fetch, mark `error`.

### 2. Magic numbers jadi config-bound
- Heimdall: `minClicksDrop=5, minPctDrop=20`
- Loki: `sovChange < -5, top-3 gaps`
- Odin: `totalScore > 10000 → high`

Sudah ada `agents.config jsonb` column tapi underutilized. Pindahin semua threshold ke sini, expose di settings UI.

### 3. Schedule misalignment
`vercel.json` cuma jalan `0 2 * * *` (1x/hari, 02:00 UTC). Tapi:
- Schedule UI biarin user pilih `hour` 0-23 di timezone mereka.
- Comment di `agents-scheduler/route.ts` line 41 bilang "Runs every 15 minutes."

Akibatnya: user set jam 14:00 WIB, agent jalannya tetap kira-kira 09:00 WIB (02:00 UTC). **Fix:** ubah cron ke `*/30 * * * *` minimal, atau separate cron per timezone.

### 4. LLM grounding
- Bragi/Loki/Heimdall action descriptions = string concatenation. Tidak ada call ke LLM untuk merangkum *why this matters*.
- Brief-generator yang pakai LLM justru pakai regex parse, ga structured.
- **Fix:** tambahkan tool-use / JSON mode di setiap LLM call. Action descriptions yang penting (high-priority) di-LLM-rephrase dengan data signal sebagai input.

### 5. Outer route catch tidak update run record
`/api/agents/[key]/run/route.ts` line 116-119:
```ts
} catch (err) {
  return NextResponse.json({ error: errorMessage }, { status: 500 })
}
```
Kalau agent throw *sebelum* enter try-block-nya sendiri, `agent_runs` row nyangkut di `running`. Fix: outer catch juga update run dengan `status: 'error'`.

---

## Rekomendasi Action Items (Priority Order)

| # | Apa | Severity | Effort |
|---|-----|----------|--------|
| 1 | Heimdall: ganti midpoint split → date-range filter explicit | 🔴 High | M |
| 2 | Loki: DataForSEO error harus visible, bukan silent warn | 🔴 High | S |
| 3 | Brief-generator: pakai Claude structured output (JSON mode/tool use) + retry | 🔴 High | M |
| 4 | Bragi/Heimdall/Loki: action description include data signal (SV, % drop, competitor URL) | 🟡 Med | M |
| 5 | Cron schedule: minimal `*/30 * * * *` di `vercel.json` agar schedule UI bermakna | 🟡 Med | S |
| 6 | Executor: stop hardcode g2g.com → ambil dari `site_configs` | 🟡 Med | S |
| 7 | Odin: retry Steam API + reject empty `trendReasons` | 🟡 Med | S |
| 8 | Hermod: pre-flight Loki freshness check + LLM personalize email | 🟢 Low | M |
| 9 | All agents: introduce `partial` run status + populate `error_message` even on success | 🟢 Low | M |
| 10 | KB match (brief-generator) pakai explicit slug map, bukan substring | 🟢 Low | S |

---

## Catatan untuk live verification (next step)

Untuk konfirmasi temuan ini, idealnya cek di Supabase:
- `select count(*), status from agent_runs group by status` — berapa banyak yang nyangkut `running`?
- `select agent_key, count(*), avg(actions_queued) from agent_runs where status='success' group by agent_key` — berapa banyak run "sukses tapi 0 actions"?
- `select error_message from agent_runs where status='error' order by started_at desc limit 20` — pattern error yang berulang?
- `select count(*) from agent_actions where status='executed' and action_type='draft_brief' and id not in (select id from seo_content_briefs where status != 'draft')` — brief stuck akibat fire-and-forget executor.

Tinggal trigger via SQL editor di Supabase atau gw bisa bantu run via /api endpoint kalau lu kasih akses prod.
