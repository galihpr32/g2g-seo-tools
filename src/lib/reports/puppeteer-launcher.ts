// ── Puppeteer launcher (Coolify Docker + Vercel/Lambda + dev) ──────────────
//
// Sprint FRIDAY.KPI.GRAPH.4 + COOLIFY.PUPPETEER (346) — single chokepoint
// for spinning up headless Chromium. Three execution environments:
//
//   1. Coolify Docker (production target) — system chromium installed via
//      apt in the Dockerfile. `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`
//      is set at build time. Fastest startup, no tarball download.
//
//   2. Vercel/Lambda — @sparticuz/chromium pulls a stripped binary tarball
//      at cold-start time (the binary is too big to bundle in a 50MB
//      function package). 15-30s cold start cost.
//
//   3. Local dev — point at the installed Chrome browser via env var or
//      sensible macOS default. Useful for testing puppeteer changes
//      without spinning up Docker.
//
// All three paths use puppeteer-core (NOT puppeteer) so no chromium binary
// is downloaded at install time.

import type { Browser } from 'puppeteer-core'

// Coolify-Docker detection: the Dockerfile sets this env var to the system
// chromium path. If present, prefer it — it's the fastest path and avoids
// pulling a 100MB tarball at cold start. We don't trust `IS_LAMBDA` alone
// to gate this because we want local devs to be able to point at a Docker-
// like setup too (run `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npm run
// start` after `docker run`-ing the image locally).
const SYSTEM_CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH
const HAS_SYSTEM_CHROMIUM  = !!SYSTEM_CHROMIUM_PATH && SYSTEM_CHROMIUM_PATH.startsWith('/')

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

// Common viewport for the Friday KPI PNG.
const DEFAULT_VIEWPORT = { width: 1280, height: 1800, deviceScaleFactor: 2 }

// Sandbox flags that Chromium requires inside a Docker container (no user
// namespace by default). Safe to apply outside Docker too — they just
// disable extra hardening the OS would have provided anyway.
const DOCKER_SAFE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',  // /dev/shm in containers defaults to 64MB; Chromium hates that
  '--disable-gpu',
  '--no-zygote',
  '--single-process',         // helps on tiny containers; can drop if memory allows multi-process
  '--disable-features=VizDisplayCompositor',
]

export async function launchBrowser(): Promise<Browser> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core')

  // ── Path 1: Coolify Docker (and any host that pre-installed chromium) ──
  if (HAS_SYSTEM_CHROMIUM) {
    return puppeteer.launch({
      headless: true,
      defaultViewport: DEFAULT_VIEWPORT,
      executablePath: SYSTEM_CHROMIUM_PATH,
      args: DOCKER_SAFE_ARGS,
    })
  }

  // ── Path 2: Vercel/Lambda — sparticuz tarball ──
  if (IS_LAMBDA) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@sparticuz/chromium')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chromium = (mod.default ?? mod) as any
    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: DEFAULT_VIEWPORT,
      // Pass the pack URL — sparticuz downloads, extracts to /tmp, and sets
      // LD_LIBRARY_PATH so the binary can find libnss3.so + friends.
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
      // v141 uses 'shell' for puppeteer (per upstream README)
      headless: 'shell',
    })
  }

  // ── Path 3: Local dev — system Chrome at macOS default location ──
  const macChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  return puppeteer.launch({
    headless: true,
    defaultViewport: DEFAULT_VIEWPORT,
    executablePath: macChromePath,
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

// ── Sprint #380 BOSS.VIEW.PDF — server-side PDF rendering ──────────────────
//
// `htmlToPdf` is the PDF sibling of `htmlToPng`. Reuses the exact same
// browser launch path so we don't have to maintain two chromium configs.
// Differences vs the PNG path:
//   - `page.pdf()` (not screenshot) — natively rasterizes each A4 page
//     including @page CSS rules (running headers, margin boxes, page nums).
//   - `displayHeaderFooter: false` — Chrome's default print header/footer
//     prints the URL + date + page X/Y, which looks like a print-from-the-
//     browser screenshot. The HTML template supplies its own branded chrome
//     via @page margin boxes; we don't want Chrome's defaults stomping on
//     top.
//   - `printBackground: true` — without this Chrome strips body backgrounds
//     + custom div backgrounds, which would kill the branded red header
//     stripe and the KPI table shading.
//
// Caller is responsible for the HTML; this just plumbs the buffer back.

export interface HtmlToPdfOptions {
  /** Margins around the printable area. Header/footer rendered by the HTML's
   *  @page margin boxes will live INSIDE these — bigger = more room for
   *  branding. Defaults to 0.4in all around (matches the social team's
   *  reference PDF). */
  margin?: { top: string; bottom: string; left: string; right: string }
  /** Override page format. Defaults to 'A4' (matches reference). */
  format?: 'A4' | 'Letter'
  /** How long to wait for `window.kpiReady = true` before snapshotting
   *  anyway. Default 15s — charts take 1-2s each and the PDF has ~6 of
   *  them so we give some headroom. */
  readyTimeoutMs?: number
}

export async function htmlToPdf(html: string, opts: HtmlToPdfOptions = {}): Promise<Buffer> {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    // Switch to print media so any `@media print` rules in the HTML take
    // effect during pdf() generation (otherwise Chromium uses screen media).
    await page.emulateMediaType('print')
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 })
    // Wait for the renderer to flag charts painted. Re-using `window.kpiReady`
    // so the PDF template can copy the same ready-signal pattern as the
    // existing PNG renderer (one less thing to invent).
    await page
      .waitForFunction(() => (window as unknown as { kpiReady?: boolean }).kpiReady === true, {
        timeout: opts.readyTimeoutMs ?? 15_000,
      })
      .catch(() => { /* fall through — render whatever's painted */ })
    const pdf = await page.pdf({
      format:               opts.format ?? 'A4',
      printBackground:      true,
      displayHeaderFooter:  false,
      preferCSSPageSize:    true,    // honor @page size/margin from the HTML
      margin:               opts.margin ?? {
        top:    '0.4in',
        bottom: '0.4in',
        left:   '0.4in',
        right:  '0.4in',
      },
    })
    return Buffer.from(pdf)
  } finally {
    await browser.close()
  }
}
