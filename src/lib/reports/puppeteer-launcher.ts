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

// @sparticuz/chromium v123+ doesn't ship the binary in the npm package (too
// big for Vercel's 50MB function budget). We have to pull the matching brotli
// tarball from the sparticuz GitHub releases at cold-start time. Version
// MUST match the installed @sparticuz/chromium version (see package.json).
//
// Upgraded 131→141 because v131.0.1 had no matching GitHub release (npm
// published without a release tag → broken pack URL).
//
// v137+ removed `setHeadlessMode` and `setGraphicsMode` — caller must specify
// `headless` and viewport directly on puppeteer.launch().
//
// Override via env CHROMIUM_PACK_URL if you want to self-host the tarball
// (e.g. on Vercel Blob / R2) for faster cold starts.
const CHROMIUM_PACK_URL = process.env.CHROMIUM_PACK_URL
  ?? 'https://github.com/Sparticuz/chromium/releases/download/v141.0.0/chromium-v141.0.0-pack.x64.tar'

export async function launchBrowser(): Promise<Browser> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core')

  if (IS_LAMBDA) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@sparticuz/chromium')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chromium = (mod.default ?? mod) as any
    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 1800, deviceScaleFactor: 2 },
      // Pass the pack URL — sparticuz downloads, extracts to /tmp, and sets
      // LD_LIBRARY_PATH so the binary can find libnss3.so + friends.
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
      // v141 uses 'shell' for puppeteer (per upstream README)
      headless: 'shell',
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
    // puppeteer-core v24 dropped 'networkidle0' — use 'load' which still
    // waits for Chart.js CDN script to download before continuing.
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 })
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
