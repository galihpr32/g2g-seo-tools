# G2G SEO Tools — 15-Minute Walkthrough

**Format:** Live demo + narration. Keep tab open: `g2g-seo-tools.vercel.app/command-center/pipeline`

---

## Pre-presentation checklist (5 min before)

- [ ] Open `g2g-seo-tools.vercel.app` and login
- [ ] Buka tab di `Pipeline Journey` (main demo page)
- [ ] Buka second tab `Writer Inbox`
- [ ] Buka third tab `Team Performance`
- [ ] Open Slack `#writer-rangers` (untuk show Daily Briefing kalau udah jalan)
- [ ] Tutup tab lain biar gak distract pas screen-share
- [ ] Test screen-share + audio
- [ ] Cek nilai key di clipboard (60 opps, 48 Need Action, dll — biar gak fumble pas ngomong)

---

## Time budget

| Time | Section |
|---|---|
| 0:00 – 1:00 | Opening + agenda |
| 1:00 – 3:00 | The problem (why we built this) |
| 3:00 – 5:00 | System architecture (Norse agents) |
| 5:00 – 12:00 | Live walkthrough demo |
| 12:00 – 14:00 | What's next + expected outputs |
| 14:00 – 15:00 | Q&A buffer |

---

## 0:00 – 1:00 — Opening

> "Hari ini saya bakal walkthrough G2G SEO Tools — internal platform yang udah kita bangun beberapa minggu terakhir untuk otomatisasi end-to-end SEO workflow tim kita. 15 menit. Saya bakal cover: kenapa ini dibangun, gimana arsitekturnya, demo langsung, dan roadmap ke depannya. Pertanyaan tahan dulu sampe akhir."

**Tone:** Confident, brief, signal there's a lot to cover.

---

## 1:00 – 3:00 — The Problem (why this exists)

**Pain points sebelum platform ini ada:**

- **Detection reactive, bukan proactive.** Rank-drop ketauan dari laporan mingguan — kadang udah seminggu telat actionable.
- **Brief writing ad-hoc.** Setiap penulis mulai dari nol, kualitas inkonsisten, briefing process makan waktu SEO 30-60 menit per topik.
- **Prioritization gut-feel.** "Topic apa yang harus ditulis duluan?" jawabannya tergantung yang lagi paling vocal di meeting.
- **Outreach disconnected.** Tim outreach gak tau article mana yang baru dipublish dan butuh backlink. Article ranking sendiri tanpa boost.
- **Zero feedback loop.** Brief published → 30/60/90 hari kemudian — gak ada yang ngecek "did this brief actually rank?". Susah belajar dari hasil.
- **Tools fragmented.** SEMrush + GSC + Sheets + Notion + Slack — setiap stage di tool berbeda, data manual copy-paste.

**Yang kita target solve:**

> "End-to-end pipeline dari signal-detection sampai ranking-impact, dalam satu platform, dengan AI agents yang nge-handle repetitive work biar tim fokus ke decision + judgment, bukan pekerjaan manual."

**Numbers worth dropping:**
- Tim G2G punya thousands of category pages
- Manual triage: ~5-10 menit per opportunity × 50+ per minggu = 5-8 jam SEO time saved/week
- Brief quality jauh lebih konsisten karena structured + Tyr review

---

## 3:00 – 5:00 — System Architecture

**Slide opsional / sketsa di whiteboard:**
```
[Detection] → [Aggregation] → [Triage] → [Brief] → [Execute] → [Outreach] → [Measure]
   ↓             ↓               ↓          ↓           ↓             ↓             ↓
 Heimdall      Saga          You          Bragi      Writer      Hermod         Vor
 Loki                                     Tyr                                       (+30/60/90d)
 Odin                                     Claude
```

**Talking points:**

- **8 specialized AI agents**, bukan 1 mega-AI. Tiap agent satu fokus, predictable, debuggable.
- **Named after Norse mythology** — biar mudah ingat + fun. Gimmick, tapi memorable.

| Agent | Role |
|---|---|
| **Heimdall** | "Watchman" — monitor GSC, detect rank drops |
| **Loki** | "Trickster" — competitor analysis, gap finder |
| **Odin** | "Wise" — trending games spotter |
| **Saga** | "Storyteller" — clusters signals into topics, dedup |
| **Bragi** | "Poet" — generates content briefs |
| **Tyr** | "Justice" — 8-dimension brief QA review |
| **Hermod** | "Messenger" — finds outreach prospects |
| **Vor** | "Knower" — tracks ranking outcomes 30/60/90 days |

- **Plus AI gates:** Mimir chatbot (in-app Q&A), Claude independent reviewer (gate kedua brief setelah Tyr).

**Tech stack (mention briefly):**
- Next.js 16 + Supabase (Postgres) — web platform
- Anthropic Claude (Haiku for cost, Opus untuk yg complex) — agent intelligence
- DataForSEO + SEMrush + GSC + GA4 — data sources
- Vercel + GitHub Actions — hosting + scheduled runs
- Slack #writer-rangers — team notifications

---

## 5:00 – 12:00 — Live Walkthrough (7 min)

### Demo 1: Pipeline Journey (3 min) ⭐ Main showcase

**Buka:** `/command-center/pipeline`

**Narasi sambil ngeklik:**

> "Ini halaman pusatnya — Pipeline Journey. Setiap baris di sini adalah **opportunity** — keyword atau page yang punya potential. Saat ini ada 60 opps, 48 butuh action."

**Klik salah satu opp** (pilih yang udah expand-able, misal Arknights):

> "Tiap opp punya 7-stage pipeline. Lihat — Detection sudah done karena Heimdall detect 3 rank-drop signals di page ini. Saga clustering ke topic 'Arknights Account'. Triage approved — saya yang approve kemarin (tunjuk avatar). Brief stage: Bragi generate, Tyr score 83, Claude review-pass. Sekarang stage Execute — siap di-assign ke writer. Outreach + Measure terkunci sampai article published."

**Highlight features:**
- **Avatar di setiap stage** — nunjukin siapa yang ngerjain
- **Status badge** — done / running / need action / locked
- **Brief chips** — kalau ada multiple brief type per opp
- **Filter tabs** — All / Need Action / In Progress / Completed

**Kalau ada waktu, demo approve:**
> "Misal saya approve Diablo Immortal sebagai New Page — saya pilih type, klik generate, dan mulai dari sini Bragi otomatis tulis brief, Tyr review, Claude double-check, dalam 30-60 detik brief siap."

### Demo 2: Writer Inbox (1 min)

**Buka:** `/content/writer-inbox`

> "Untuk writer, mereka punya tampilan sendiri. Bersih dari jargon agent. Mereka cuma lihat: berapa brief siap ditulis, brief mana yang lagi in-progress, mana yang udah published. Klik salah satu brief — outline, FAQ, target keywords, semua sudah siap. Writer tinggal tulis."

### Demo 3: Team Performance (1 min)

**Buka:** `/team-performance` → scroll ke "🚦 Pipeline Activity"

> "Untuk manager, ini section terpenting. Tracking per-user activity di seluruh pipeline. Lihat: Galih kemarin approve 3 opp, publish 2 brief. Setiap action di pipeline ada attribution-nya. Today / 7d / 30d / all-time. Gak ada lagi 'siapa yang udah ngerjain apa' di Slack DM."

### Demo 4: Daily Briefing (1 min)

**Switch ke Slack #writer-rangers:**

> "Setiap hari kerja jam 7 pagi WIB, automation ngirim digest ke channel ini. Saya bacain bagian penting." 

**Baca cepat satu briefing** (kalau ada):
- Writer Queue: berapa brief siap
- SEO Pipeline state: counts + agent activity
- Team Activity: contributor recap

> "Tim baca ini sambil ngopi pagi, langsung tau prioritas hari ini. Gak perlu meeting."

### Demo 5: Closed-loop competitor → pipeline ⭐ (2 min) — wow moment

**Buka:** `/competitive/serp-tracker`

> "Ini contoh integrasi end-to-end yang baru deploy. Saya search keyword 'diablo 4 items', lihat hasil SERP — 10 domain ranking. Sekarang saya bisa multi-select."

**Klik 3 checkbox di domain yang menarik** (misal kinguin, fanatical, gameflip):

> "Saya pilih 3 domain yang belum ada di list kompetitor saya. Klik 'Add as competitors' — *click*. Toast nyala: 3 added. Sekarang ada CTA 'Run keyword gap →'."

**Klik CTA**:

> "Lompat ke Keyword Gap Finder dengan 3 kompetitor barusan pre-selected. Default sekarang fetch 10 keyword aja — hemat SEMrush quota. Klik Run analysis."

**Tunggu ~10 detik analysis** (atau klik existing snapshot kalau ada):

> "Hasilnya: gaps yang G2G belum rank tapi kompetitor rank. Lihat banner ungu — '[N] gaps auto-pushed to Pipeline'. Itu hybrid threshold: gap dengan SV ≥ 1000 otomatis dikirim ke pipeline. Saya juga bisa multi-select gap manual + 'Send to Pipeline' untuk push gap dengan SV lebih kecil tapi strategis."

**Switch ke Pipeline Journey**:

> "Saga aggregator pickup tiap 30 menit. Cek di sini — opp baru masuk dari workflow tadi. Closed loop tertutup: SERP discovery → competitor list → gap analysis → pipeline → brief → publish."

**Tagline:**
> "Itu yang saya maksud 'one platform' — dulu setiap stage di tool berbeda dengan copy-paste manual. Sekarang 4 klik, automated."

### Demo 6 (kalau masih ada waktu): Other features (1 min)

**Quick mention, jangan demo full** — show sidebar:
- Brief Library — semua brief
- Editorial Calendar — visual month view
- Keyword Map / Cannibalization / Broken URLs / Internal Links — analytical tools
- Knowledge Base — brand voice + product context untuk AI

> "Banyak modul lain — masing-masing untuk SEO health check, content audit. Detail bisa kita explore di session berikutnya."

---

## 12:00 – 14:00 — What's Next + Expected Outputs

### Roadmap (2-3 menit)

**Coming next 4-6 minggu:**

- **Watchdog automation** — Auto-detect & auto-fix stuck items (no human babysitting)
- **Hermod v2** — Outreach prospect finder yang work for commercial topics (sekarang masih limited buat editorial gaming)
- **Huginn & Muninn** — Weekly/monthly reporting agents yang bikin synthesis narrative dari data pipeline
- **Better cost tracking** — Per-action API spend, identify expensive ops
- **Multi-site support** — Currently G2G; OffGamers integration drafted

### Expected outputs (numbers untuk roadmap commitment)

**Per quarter target:**

| Metric | Target |
|---|---|
| New briefs generated | 60-100 |
| Briefs published | 30-50 (writer capacity bound) |
| Backlinks acquired via outreach | 5-15 |
| Time-to-content (signal → published) | < 14 days median |
| SEO time saved/week | 8-12 jam |
| Tracked topics yang ranking improve | 60%+ |

**Long-term (12 minggu+) yang bisa di-measure:**
- Organic traffic growth di G2G category pages yang masuk pipeline
- Brand mention growth dari outreach effort
- Cost-per-published-brief turun dari manual baseline

### Why platform-as-web-app (justification)

**Question yang akan ditanya:** "Kenapa gak pake Pitchbox / Surfer / Notion?"

**Jawaban:**
- **Custom workflow** — Pipeline kita unique (Heimdall→Loki→Odin→Saga→Bragi→Tyr stages). Off-the-shelf tools assume single workflow.
- **Direct DB integration** — Kita perlu read/write Supabase, GSC, GA4, DataForSEO native. SaaS gak ngasih akses level itu.
- **AI agent control** — Tyr's review prompt itu CALIBRATED to G2G voice + brand. Bragi's prompt include knowledge base. Generic AI tool gak bisa.
- **Cost** — 5+ SaaS subscription combined: $300-500/bulan. Hosting + Anthropic API kita: $40-80/bulan.
- **Per-user attribution** — Native Slack + workspace member integration. SaaS limited.
- **Customizable forever** — Tim grow → kita tambah feature 1-2 hari. SaaS minta feature, dijawab "in roadmap" 6 bulan.

---

## 14:00 – 15:00 — Q&A buffer

### Anticipated questions + jawaban siap

**Q: "Berapa biaya operasional bulanan?"**
A: ~$40-80/bulan saat ini. Vercel Hobby (free), Supabase free tier, Anthropic API based on usage (Haiku murah, Opus selective). Kalau scale, paling ke Pro plan ~$50 lagi. Total far below SaaS alternative.

**Q: "Apakah AI bisa salah generate brief?"**
A: Bisa. Makanya ada 2 gate: Tyr (8-dimension review, scoring 0-100, gagal di-regenerate dengan feedback), plus Claude independent review (focus brand voice + SERP fit). Plus 24-jam timeout fallback kalau AI gak respond. Plus writer tetap manusia — brief itu blueprint, bukan final article.

**Q: "Gimana kalau AI agent error / down?"**
A: Setiap stage punya fallback. Bragi gagal → process-briefs cron retry tiap 10 menit. Tyr error → brief tetap ke 'agent_generated', writer bisa baca tanpa skor. Claude review timeout → auto-skip setelah 24 jam. System resilient.

**Q: "Bisa diakses tim luar SEO?"**
A: Ya — workspace_members system. Manager kasih akses per-orang dengan role. Writer cuma lihat Writer Inbox, manager lihat Team Performance, SEO lihat semua.

**Q: "Apakah data G2G aman?"**
A: Semua data di Supabase kita sendiri (private project). Anthropic API call gak nyimpen prompt content (per privacy policy mereka). RLS enabled di Supabase per-row.

**Q: "Berapa lama development sampai production?"**
A: [Adjust based on real timeline] - 6-8 minggu untuk core architecture. Iterative — fitur baru rolling out tiap minggu.

**Q: "Gimana measure success-nya?"**
A: 3 angle:
1. Operational — pipeline throughput (briefs/week)
2. Quality — Tyr score average + Claude review pass rate
3. Outcome — ranking impact 30/60/90 days post-publish (Vor)

**Q: "Apa yg kalau saya stop pakai?"**
A: All data di Supabase kalian sendiri. Di-export apapun, gampang. No vendor lock-in.

---

## Closing line (kalau sempat)

> "Tools ini built bukan buat replace kerjaan tim — built supaya tim lebih banyak waktu untuk decision + creative work yang AI gak bisa. Repetitive triage, data aggregation, brief boilerplate — itu yang AI ambil. Strategy, judgment, voice — itu tetap kalian. Thanks, ada pertanyaan?"

---

## Numbers cheat sheet (referensi cepat saat presentasi)

```
Pipeline state (per [tanggal]):
  Total opps        : 60
  Need Action       : 48
  In Progress       : 12
  Completed         : 0
  Stuck briefs      : 1 (parking lot)

Agents:
  8 Norse-named     : Heimdall, Loki, Odin, Saga, Bragi, Tyr, Hermod, Vor
  Plus 2 gates      : Mimir (chatbot), Claude (independent review)
  Cron schedule     : Every 30 min via GitHub Actions

Stack:
  Frontend  : Next.js 16 + Tailwind
  Backend   : Vercel serverless + Supabase Postgres
  AI        : Anthropic Claude (Haiku + selective Opus)
  Data      : DataForSEO, SEMrush, GSC, GA4
  Notify    : Slack (#writer-rangers)

Cost:
  Hosting     : ~$0 (Vercel Hobby + Supabase free)
  API calls   : ~$40-80/month (Anthropic)
  External    : DataForSEO + SEMrush (existing budgets)
  vs SaaS     : Save $200-400/month
```

---

## Demo backup plan (kalau live demo bermasalah)

1. **Internet down / app down**: pakai screenshot di GitHub README atau handoff doc
2. **Approve flow lama**: skip demo Bragi generate, tunjuk brief yang udah ada
3. **Slack belum ada briefing**: tampilin sample markdown dari `reports/` folder atau simulasi
4. **Anthropic credit habis**: skip generate demo, fokus ke pipeline + tracking + reports

---

## Post-presentation follow-up

Kirim ke audience setelahnya:
- Link tool: `g2g-seo-tools.vercel.app`
- HANDOFF.md di repo (untuk yang technical curious)
- This presentation notes file
- Jadwalkan walkthrough mendalam per modul kalau diminta
