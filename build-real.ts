import { buildMonthlyReportPptx } from './src/lib/reports/pptx-builder'
import { writeFileSync, readFileSync } from 'node:fs'

const sample = JSON.parse(readFileSync('/sessions/nifty-gracious-mayer/mnt/outputs/april-2026-real.json', 'utf-8'))

;(async () => {
  const buf = await buildMonthlyReportPptx(sample)
  const out = '/sessions/nifty-gracious-mayer/mnt/g2g-seo-tools/G2G-Monthly-Report-April-2026.pptx'
  writeFileSync(out, buf)
  console.log('OK', buf.length, 'bytes →', out)
})().catch(e => { console.error('FAIL:', e); process.exit(1) })
