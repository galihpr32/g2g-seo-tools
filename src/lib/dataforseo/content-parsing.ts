// ─── DataForSEO Content Parsing wrapper ─────────────────────────────────────
// Sprint ONPAGE.FETCH.FIX — Get rendered page text for SPA pages.
//
// Why: G2G category pages are client-rendered. Plain fetch returns SSR shell
// with no body text, so the Onpage Pattern Learner gets "too short" errors.
// DataForSEO renders JS server-side and returns clean parsed text blocks.
//
// Endpoint: POST /v3/on_page/content_parsing/live
// Cost:     ~$0.0006 per page (very small)
// Latency:  5-15 seconds per page (JS render is slow)
// Docs:     https://docs.dataforseo.com/v3/on_page/content_parsing/live

const BASE = 'https://api.dataforseo.com/v3'

function authHeader(): string {
  const login = process.env.DATAFORSEO_LOGIN ?? ''
  const pass  = process.env.DATAFORSEO_PASSWORD ?? ''
  return 'Basic ' + Buffer.from(`${login}:${pass}`).toString('base64')
}

/** Loosely-typed shape — DataForSEO response is deep + nested + version-y.
 *  We pluck only the fields we know about and grace-fail on the rest. */
interface ContentParsingResponse {
  tasks?: Array<{
    status_code?: number
    status_message?: string
    result?: Array<{
      url?:           string
      items?:         Array<{
        page_content?: {
          header?:      { primary_topic?: Array<{ text?: string }> }
          main_topic?:  Array<{
            level?: number          // 1=h1, 2=h2, 3=h3
            h_title?: string
            primary_topic?: Array<{ text?: string }>
            secondary_topic?: Array<{ text?: string }>
            // Some response variants put text directly:
            text?: string
            headers?: Array<{ text?: string }>
          }>
          footer?:      { primary_topic?: Array<{ text?: string }> }
        }
      }>
    }>
  }>
}

export interface ContentParsingResult {
  ok:        boolean
  text:      string                // Cleaned markdown-flavoured text
  error?:    string
  raw_size?: number
  /** Whether the result has meaningful structure (≥1 heading + ≥200 chars text) */
  meaningful: boolean
}

/**
 * Fetch + parse a page via DataForSEO with JS rendering.
 *
 * Returns markdown-ish text preserving heading hierarchy so the on-page
 * pattern learner can recognize H1/H2/H3 structure.
 */
export async function fetchPageTextViaDataForSEO(
  url: string,
  opts: {
    /** Wait this many seconds AFTER initial render before extracting. Useful
     *  for SPA pages that finish hydrating async. Max 10. */
    loadWaitSec?: number
    timeoutMs?:   number
  } = {},
): Promise<ContentParsingResult> {
  if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) {
    return { ok: false, text: '', error: 'DataForSEO credentials not set', meaningful: false }
  }

  // /on_page/content_parsing/live valid fields per DataForSEO docs:
  //   url, custom_user_agent, browser_preset, browser_screen_width|height|scale_factor,
  //   store_raw_html, enable_javascript, enable_browser_rendering, enable_xhr,
  //   disable_cookie_popup, return_despite_timeout, custom_js, load_resources
  // (NOT accept_language — that's only valid on /on_page/instant_pages)
  const body = [{
    url,
    enable_javascript:        true,
    enable_browser_rendering: true,
    custom_user_agent:        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    load_resources:           false,        // don't fetch images/CSS, saves time
    return_despite_timeout:   true,         // return whatever was rendered
    disable_cookie_popup:     true,         // auto-close cookie banners that block content
  }]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25_000)

  let res: Response
  try {
    res = await fetch(`${BASE}/on_page/content_parsing/live`, {
      method:  'POST',
      headers: {
        Authorization:  authHeader(),
        'Content-Type': 'application/json',
      },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    return { ok: false, text: '', error: err instanceof Error ? err.message : String(err), meaningful: false }
  }
  clearTimeout(timer)

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, text: '', error: `DataForSEO HTTP ${res.status}: ${body.slice(0, 200)}`, meaningful: false }
  }

  let data: ContentParsingResponse
  try { data = await res.json() as ContentParsingResponse } catch (e) {
    return { ok: false, text: '', error: `JSON parse: ${e instanceof Error ? e.message : String(e)}`, meaningful: false }
  }

  const task   = data.tasks?.[0]
  const status = task?.status_code ?? 0
  if (status >= 40000) {
    return { ok: false, text: '', error: `DataForSEO task error ${status}: ${task?.status_message ?? '?'}`, meaningful: false }
  }

  const items = task?.result?.[0]?.items ?? []
  const pageContent = items[0]?.page_content
  if (!pageContent) {
    return { ok: false, text: '', error: 'No page_content in response', meaningful: false }
  }

  const lines: string[] = []

  // Header section (often contains the H1)
  const headerTopics = pageContent.header?.primary_topic ?? []
  for (const t of headerTopics) {
    if (t.text) lines.push(`# ${t.text.trim()}`)
  }

  // Main body
  const mainBlocks = pageContent.main_topic ?? []
  for (const block of mainBlocks) {
    if (block.h_title) {
      const level = Math.max(1, Math.min(6, block.level ?? 2))
      lines.push('\n' + '#'.repeat(level) + ' ' + block.h_title.trim())
    } else if (block.text) {
      lines.push(block.text.trim())
    }
    // Primary topic — body paragraphs under this heading
    for (const t of block.primary_topic ?? []) {
      if (t.text) lines.push(t.text.trim())
    }
    // Secondary topic — bullet items / sub-paragraphs
    for (const t of block.secondary_topic ?? []) {
      if (t.text) lines.push(`- ${t.text.trim()}`)
    }
  }

  // Footer (mostly nav, but sometimes has trust signals)
  const footerTopics = pageContent.footer?.primary_topic ?? []
  for (const t of footerTopics) {
    if (t.text) lines.push(t.text.trim())
  }

  const text = lines
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')

  // "Meaningful" = at least one heading AND meaningful body length.
  // Helps the fallback chain decide whether to also try other sources.
  const hasHeading = /^#{1,6}\s+\S/m.test(text)
  const meaningful = hasHeading && text.length >= 200

  return {
    ok:         true,
    text,
    raw_size:   text.length,
    meaningful,
  }
}
