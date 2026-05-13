const { buildMonthlyReportPptx } = require('./src/lib/reports/pptx-builder.ts') as typeof import('./src/lib/reports/pptx-builder')
const { writeFileSync } = require('node:fs')

const sampleReport = require('/sessions/nifty-gracious-mayer/mnt/outputs/sample-report.json')

;(async () => {
  const buf = await buildMonthlyReportPptx(sampleReport)
  writeFileSync('/tmp/test-monthly.pptx', buf)
  console.log(`OK — wrote ${buf.length} bytes to /tmp/test-monthly.pptx`)
})()
