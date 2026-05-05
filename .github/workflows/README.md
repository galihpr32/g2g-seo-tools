# GitHub Actions workflows

## `agents-scheduler.yml`

Triggers `/api/cron/agents-scheduler` every 30 minutes. Used in place of
Vercel cron because Vercel Hobby plan caps cron frequency at once per day.

### One-time setup

1. Buka repo di GitHub → **Settings** → **Secrets and variables** → **Actions**
2. Klik **New repository secret** dua kali:

   | Name          | Value                                     |
   | ------------- | ----------------------------------------- |
   | `APP_URL`     | `https://g2g-seo-tools.vercel.app`        |
   | `CRON_SECRET` | (same value as Vercel env var `CRON_SECRET`) |

3. Push the workflow file (already in repo). Workflow akan auto-aktif setelah
   push pertama. First run akan trigger di slot `*/30` berikutnya.

### Manual trigger

Untuk test: **Actions** tab → **Agents Scheduler** → **Run workflow** → branch
`main` → **Run workflow**. Logs muncul ~30 detik kemudian.

### Operational notes

- GitHub Actions cron is **best-effort** — bisa telat 5-15 menit saat traffic
  GitHub tinggi. Untuk SEO tools ini fine; ga butuh real-time.
- Workflow gagal kalau Vercel endpoint return 5xx atau 4xx. Bisa di-monitor
  dari Actions tab.
- `concurrency` block mencegah overlapping runs — kalau run sebelumnya masih
  jalan (misal scheduler ngeproses 5 agent), run baru ga akan menumpuk.
- Daily quota Hobby plan GitHub Actions: 2,000 menit/bulan. 30-min schedule =
  48 runs/hari × ~10 detik/run = ~4 menit/hari = ~120 menit/bulan. Aman.
