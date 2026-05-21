// ── Puppeteer launcher (dev + serverless) ──────────────────────────────────
//
// Sprint FRIDAY.KPI.GRAPH.4 — single chokepoint for spinning up headless
// Chromium. On Vercel/Lambda we use @sparticuz/chromium which bundles a
// stripped binary that fits under the function-size budget. Locally we fall
// back to whatever Chrome the dev box has installed (env override available).
//
// Both code paths use puppeteer-core (NOT puppeteer) so no chromium binary
// is downloaded at install time.

import type { Browser } from 'puppeteer-core'

const IS_LAMBDA = !!process.env.AWS_LAMBDA_FUNCTION_VERSION || !!process.env.VERCEL

export async function launchBrowser(): Promise<Browser> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core')

  if (IS_LAMBDA) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@sparticuz/chromium')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chromium = (mod.default ?? mod) as any
    // Don't load custom fonts — keeps cold-start small. The HTML uses
    // system-ui which Chromium ships out of the box.
    chromium.setHeadlessMode = true
    chromium.setGraphicsMode  = false
    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 1800, deviceScaleFactor: 2 },
      executablePath: await chromium.executablePath(),
      headless: true,
    })
  }

  // Dev: use system Chrome. PUPPETEER_EXECUTABLE_PATH lets devs point at
  // their own browser (e.g. /Applications/Google Chrome.app/Contents/MacOS/Google Chrome).
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH
    ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  return puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1280, height: 1800, deviceScaleFactor: 2 },
    executablePath: execPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
}

/**
 * Wrap setContent + screenshot so callers can't forget to close the browser.
 * Returns a PNG buffer of the full page.
 */
export async function htmlToPng(html: string): Promise<Buffer> {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 })
    // Wait for the renderer to flag itself ready (Chart.js painted)
    await page.waitForFunction(() => (window as unknown as { kpiReady?: boolean }).kpiReady === true, {
      timeout: 10_000,
    }).catch(() => { /* render anyway if flag never fires */ })
    const png = await page.screenshot({ type: 'png', fullPage: true })
    return Buffer.from(png)
  } finally {
    await browser.close()
  }
}
