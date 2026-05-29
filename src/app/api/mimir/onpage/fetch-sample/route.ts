import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { fetchPageTextViaDataForSEO } from '@/lib/dataforseo/content-parsing'

export const maxDuration = 60   // SPA pages need 30-50s for full JS render via DataForSEO

/**
 * Sprint ONPAGE.FETCH.FIX — Hybrid fetch-sample for the on-page learner.
 *
 * Problem: G2G category pages are SPA-rendered. A naive HTTP fetch returns
 * the SSR shell with no body text, so the on-page pattern learner gets
 * "empty / too short" errors for every tier product.
 *
 * Solution — 3-layer fallback chain:
 *
 *   1. DB-first   — If we have a published brief for this product/URL with
 *                   final_content, use that. We wrote the canonical version
 *                   ourselves; no reason to re-scrape it. (Currently rarely
 *                   hits because T1 list is new. Self-improves as briefs
 *                   accumulate over the next 3 months.)
 *
 *   2. DataForSEO — JS-rendered fetch via /on_page/content_parsing/live.
 *                   ~$0.0006 per page, 5-15s latency, returns parsed text
 *                   with H1/H2/H3 structure preserved. Primary path right
 *                   now because empty DB.
 *
 *   3. Live + LD  — Plain HTTP fetch + extract from JSON-LD + <meta>. Last
 *                   resort when DataForSEO fails. Sparse content but better
 *                   than nothing for the learner.
 *
 * GET /api/mimir/onpage/fetch-sample?url=https://...&product_name=Blade%20%26%20Soul%20NEO
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const params = new URL(req.url).searchParams
  const url         = params.get('url')
  const productName = params.get('product_name') ?? ''
  if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400 })

  let parsed: URL
  try { parsed = new URL(url) } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  // ── Layer 1 — DB-first ─────────────────────────────────────────────────────
  // Match by exact URL OR by primary_keyword ~ product_name. Latest published
  // brief wins. final_content is the assembled article body so it's already
  // rich + matches what we want the learner to study.
  try {
    let q = db
      .from('seo_content_briefs')
      .select('id, final_content, primary_keyword, page, status, updated_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .not('final_content', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)

    // Prefer exact URL match; fall back to keyword match
    if (parsed.toString()) {
      q = q.or(`page.eq.${parsed.toString()},primary_keyword.ilike.${productName.replace(/[,()%]/g, ' ')}`)
    }

    const { data: brief } = await q.maybeSingle()
    if (brief && typeof brief.final_content === 'string' && brief.final_content.trim().length >= 200) {
      return NextResponse.json({
        url:        parsed.toString(),
        source:     'db_brief',
        source_id:  brief.id,
        text:       String(brief.final_content).slice(0, 30_000),
        bytes:      String(brief.final_content).length,
        meaningful: true,
      })
    }
  } catch (e) {
    console.warn('[fetch-sample] DB-first lookup failed (non-fatal):', e)
  }

  // ── Layer 2 — DataForSEO with JS render ────────────────────────────────────
  // 50s timeout — gives DFS most of the 60s lambda budget to finish render.
  // 5s reserved for live-fetch fallback if DFS fails.
  const dfs = await fetchPageTextViaDataForSEO(parsed.toString(), { timeoutMs: 50_000 })
  if (dfs.ok && dfs.meaningful) {
    return NextResponse.json({
      url:        parsed.toString(),
      source:     'dataforseo',
      text:       dfs.text.slice(0, 30_000),
      bytes:      dfs.text.length,
      meaningful: true,
    })
  }

  // ── Layer 3 — Live fetch + JSON-LD + meta extraction ──────────────────────
  // Last-resort: pull whatever we can from the SSR shell. Mostly useful when
  // DataForSEO returns an error or partial result.
  let liveHtml = ''
  try {
    const res = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        'sec-ch-ua':       '"Chromium";v="121", "Not A(Brand";v="99", "Google Chrome";v="121"',
        'sec-ch-ua-mobile':   '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest':  'document',
        'sec-fetch-mode':  'navigate',
        'sec-fetch-site':  'none',
        'sec-fetch-user':  '?1',
      },
    })
    if (res.ok) liveHtml = await res.text()
  } catch (e) {
    console.warn('[fetch-sample] live fetch failed:', e)
  }

  const extracted = extractFromShell(liveHtml)
  if (extracted.length >= 50) {
    return NextResponse.json({
      url:        parsed.toString(),
      source:     'jsonld_meta_fallback',
      text:       extracted.slice(0, 30_000),
      bytes:      extracted.length,
      meaningful: false,
      warning:    dfs.error
        ? `DataForSEO failed (${dfs.error}); used JSON-LD/meta fallback. Content quality limited.`
        : 'Live fetch + JSON-LD only — page is SPA-rendered. Consider running again after DataForSEO recovers.',
    })
  }

  // All layers exhausted — be explicit about what each layer returned so the
  // user can diagnose. Common case: DataForSEO returned 200 + body but our
  // meaningful-check failed (no headings + body < 500), so dfs.error is null.
  const dfsDiag = dfs.error
    ? `error: ${dfs.error}`
    : dfs.ok
      ? `returned ${dfs.text.length} chars without strong structure (meaningful=false)`
      : 'unknown failure'

  return NextResponse.json({
    url:        parsed.toString(),
    source:     'none',
    text:       '',
    bytes:      0,
    meaningful: false,
    error:      `All sources failed. DataForSEO ${dfsDiag}. Live fetch yielded ${extracted.length} chars.`,
  }, { status: 502 })
}

/**
 * Pull whatever signal we can from the SSR shell of an SPA:
 *   • <title> + <meta name="description">
 *   • JSON-LD blocks (FAQPage, BreadcrumbList, Product, etc.)
 *   • OG tags
 *
 * Returns markdown-flavoured text so downstream htmlToCleanText isn't needed.
 */
function extractFromShell(html: string): string {
  if (!html) return ''
  const parts: string[] = []

  // <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (titleMatch?.[1]) parts.push(`# ${decodeEntities(titleMatch[1].trim())}`)

  // <meta name="description">
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
    ?? html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i)
  if (descMatch?.[1]) parts.push(decodeEntities(descMatch[1].trim()))

  // <meta property="og:description">
  const ogMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)
  if (ogMatch?.[1] && ogMatch[1] !== descMatch?.[1]) parts.push(decodeEntities(ogMatch[1].trim()))

  // JSON-LD — extract any block, dig for useful fields (FAQ Q/A, Product description, etc.)
  const ldBlocks = html.matchAll(/<script\b[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  for (const m of ldBlocks) {
    try {
      const raw = m[1].trim()
      const json = JSON.parse(raw)
      collectLdText(json, parts)
    } catch {
      /* ignore malformed JSON-LD */
    }
  }

  // De-dup + join
  const seen = new Set<string>()
  const dedup: string[] = []
  for (const p of parts) {
    const norm = p.trim()
    if (norm.length === 0) continue
    if (seen.has(norm)) continue
    seen.add(norm)
    dedup.push(norm)
  }
  return dedup.join('\n\n')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectLdText(node: any, out: string[], depth = 0) {
  if (!node || depth > 6) return
  if (Array.isArray(node)) {
    for (const item of node) collectLdText(item, out, depth + 1)
    return
  }
  if (typeof node !== 'object') return

  const type = String(node['@type'] ?? '')

  if (type === 'FAQPage' && Array.isArray(node.mainEntity)) {
    out.push('## FAQ')
    for (const q of node.mainEntity) {
      if (q?.name)                          out.push(`**Q:** ${String(q.name).trim()}`)
      if (q?.acceptedAnswer?.text)          out.push(`A: ${String(q.acceptedAnswer.text).trim()}`)
    }
  } else if (type === 'Product' || type === 'Service') {
    if (node.name)        out.push(`# ${String(node.name).trim()}`)
    if (node.description) out.push(String(node.description).trim())
  } else if (type === 'BreadcrumbList' && Array.isArray(node.itemListElement)) {
    const trail = node.itemListElement
      .map((b: { name?: string }) => b.name)
      .filter(Boolean)
      .join(' › ')
    if (trail) out.push(trail)
  } else if (type === 'WebPage' || type === 'Article') {
    if (node.headline)    out.push(`# ${String(node.headline).trim()}`)
    if (node.description) out.push(String(node.description).trim())
  } else if (typeof node.description === 'string') {
    out.push(node.description.trim())
  }

  // Recurse into nested objects (some sites wrap everything in @graph)
  if (Array.isArray(node['@graph'])) collectLdText(node['@graph'], out, depth + 1)
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
}
