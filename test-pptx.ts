import { buildMonthlyReportPptx } from './src/lib/reports/pptx-builder'
import { writeFileSync, readFileSync } from 'node:fs'

const sample = JSON.parse(readFileSync('/sessions/nifty-gracious-mayer/mnt/outputs/sample-report.json', 'utf-8'))

;(async () => {
  const buf = await buildMonthlyReportPptx(sample)
  writeFileSync('/tmp/test-monthly.pptx', buf)
  console.log('OK — wrote', buf.length, 'bytes to /tmp/test-monthly.pptx')
})().catch(err => {
  console.error('FAIL:', err)
  process.exit(1)
})
