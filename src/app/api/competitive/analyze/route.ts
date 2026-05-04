import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { smartScrape } from '@/lib/firecrawl/client'

export const maxDuration = 30

// ── HTML parsing helpers ──────────────────────────────────────────────────────
function extractTag(html: string, tag: string): string {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i'))
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : ''
}

function extractMeta(html: string, name: string): string {
  const m = html.match(new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'
  )) || html.match(new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, 'i'
  ))
  return m ? m[1].trim() : ''
}

function extractAllTags(html: string, tag: string): string[] {
  const results: string[] = []
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim()
    if (text) results.push(text)
  }
  return results
}

function extractLinks(html: string, baseUrl: string): { internal: string[]; external: string[] } {
  const internal: string[] = []
  const external: string[] = []
  const re = /<a[^>]+href=["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  let base: string
  try { base = new URL(baseUrl).hostname } catch { base = '' }

  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim()
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue
    try {
      const resolved = new URL(href, baseUrl)
      if (resolved.hostname === base) {
        internal.push(resolved.href)
      } else {
        external.push(resolved.href)
      }
    } catch { /* invalid URL */ }
  }
  return { internal, external }
}

function extractImages(html: string): { total: number; withAlt: number; withoutAlt: number } {
  const tags = (html.match(/<img[^>]+>/gi) ?? [])
  const withAlt = tags.filter(t => /alt=["'][^"']+["']/i.test(t)).length
  return { total: tags.length, withAlt, withoutAlt: tags.length - withAlt }
}

function countWords(html: string): number {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return text ? text.split(' ').filter(w => w.length > 1).length : 0
}

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from',
  'is','was','are','were','be','been','being','have','has','had','do','does','did',
  'will','would','could','should','may','might','shall','can','this','that','these',
  'those','it','its','as','so','if','then','than','when','where','which','who','what',
  'how','all','any','both','each','few','more','most','other','some','such','no','not',
  'only','own','same','too','very','just','because','about','after','before','between',
  'into','through','during','above','below','up','down','out','off','over','under',
])

function topKeywords(html: string, n = 20): { word: string; count: number }[] {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9 ]/gi, ' ').toLowerCase()
  const words = text.split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w))
  const freq = new Map<string, number>()
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1)
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([word, count]) => ({ word, count }))
}

function extractCanonical(html: string): string {
  const m = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)
  return m ? m[1].trim() : ''
}

function extractRobots(html: string): string {
  return extractMeta(html, 'robots') || extractMeta(html, 'googlebot') || 'index, follow'
}

// ── Structured data detection (JSON-LD) ───────────────────────────────────────
// Modern SEO heavily relies on structured data. Extract Schema.org @type values
// to give user a quick summary of what schemas the page declares.
function extractStructuredData(html: string): { count: number; types: string[]; raw: string[] } {
  const blocks: string[] = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[1].trim())
  }

  const types = new Set<string>()
  for (const block of blocks) {
    try {
      const json = JSON.parse(block)
      // Schema can be a single object, array, or have @graph
      const items = Array.isArray(json) ? json
                  : json['@graph'] ? json['@graph']
                  : [json]
      for (const item of items) {
        if (item && typeof item === 'object' && '@type' in item) {
          const t = item['@type']
          if (Array.isArray(t)) t.forEach((x: string) => types.add(x))
          else if (typeof t === 'string') types.add(t)
        }
      }
    } catch { /* malformed JSON-LD */ }
  }

  return {
    count: blocks.length,
    types: Array.from(types),
    raw:   blocks.slice(0, 3),   // cap to first 3 for response size
  }
}

// ── Hreflang detection (international SEO) ────────────────────────────────────
function extractHreflang(html: string): { count: number; languages: string[] } {
  const re = /<link[^>]+rel=["']alternate["'][^>]+hreflang=["']([^"']+)["']/gi
  const langs = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    langs.add(m[1].trim().toLowerCase())
  }
  return { count: langs.size, languages: Array.from(langs).slice(0, 20) }
}

// ── Open Graph completeness check ─────────────────────────────────────────────
function extractOgCompleteness(html: string): {
  has_title: boolean; has_description: boolean; has_image: boolean; has_url: boolean; has_type: boolean
} {
  return {
    has_title:       !!extractMeta(html, 'og:title'),
    has_description: !!extractMeta(html, 'og:description'),
    has_image:       !!extractMeta(html, 'og:image'),
    has_url:         !!extractMeta(html, 'og:url'),
    has_type:        !!extractMeta(html, 'og:type'),
  }
}

// POST /api/competitive/analyze — analyze on-page SEO signals for a URL
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const { url } = body as { url?: string }
  if (!url?.trim()) return NextResponse.json({ error: 'url is required' }, { status: 400 })

  // Normalize URL
  let normalized = url.trim()
  if (!normalized.startsWith('http')) normalized = `https://${normalized}`

  try {
    new URL(normalized) // validate
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  try {
    // Two parallel fetches:
    //   1. Raw HTML — for meta tags, structured data, hreflang (FireCrawl
    //      strips <head> details we want to inspect)
    //   2. FireCrawl smartScrape — clean main-content extraction for accurate
    //      keyword analysis (no nav/footer pollution, handles JS-rendered)
    const [rawRes, firecrawlData] = await Promise.all([
      fetch(normalized, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; G2G-SEO-Bot/1.0)' },
        signal:  AbortSignal.timeout(12_000),
      }).catch(() => null),
      smartScrape(normalized).catch(() => null),
    ])

    if (!rawRes || !rawRes.ok) {
      return NextResponse.json({ error: `Fetch failed: ${rawRes ? `HTTP ${rawRes.status}` : 'network error'}` }, { status: 422 })
    }

    const contentType = rawRes.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html')) {
      return NextResponse.json({ error: 'URL does not return HTML' }, { status: 422 })
    }

    const html = await rawRes.text()

    // Extract head section for efficiency
    const headMatch = html.match(/<head[\s\S]*?<\/head>/i)
    const head = headMatch ? headMatch[0] : html.slice(0, 5000)

    const title        = extractTag(head, 'title')
    const metaDesc     = extractMeta(head, 'description') || extractMeta(head, 'og:description')
    const metaKeywords = extractMeta(head, 'keywords')
    const canonical    = extractCanonical(head)
    const robots       = extractRobots(head)
    const ogTitle      = extractMeta(head, 'og:title')
    const ogImage      = extractMeta(head, 'og:image')

    const h1s = extractAllTags(html, 'h1')
    const h2s = extractAllTags(html, 'h2')
    const h3s = extractAllTags(html, 'h3')

    const { internal, external } = extractLinks(html, normalized)
    const images   = extractImages(html)
    const structuredData = extractStructuredData(html)
    const hreflang       = extractHreflang(html)
    const ogComplete     = extractOgCompleteness(html)

    // Word count & keywords: prefer FireCrawl's clean main content if available.
    // FireCrawl strips nav/footer/ads → much more accurate keyword density.
    let wordCount: number
    let keywords:  { word: string; count: number }[]
    let usedFirecrawl = false

    if (firecrawlData?.markdown && firecrawlData.markdown.length > 200) {
      // FireCrawl gave us clean content. Use it for keyword analysis.
      usedFirecrawl = true
      const cleanText = firecrawlData.markdown
      wordCount = cleanText.split(/\s+/).filter(Boolean).length
      keywords  = topKeywords(cleanText)   // topKeywords also strips HTML, safe to feed markdown
    } else {
      // Fallback: HTML-based parsing (legacy behaviour)
      wordCount = countWords(html)
      keywords  = topKeywords(html)
    }

    return NextResponse.json({
      url: normalized,
      title,
      metaDescription: metaDesc,
      metaKeywords,
      canonical,
      robots,
      ogTitle,
      ogImage,
      h1s,
      h2s,
      h3s,
      wordCount,
      topKeywords: keywords,
      links: {
        internalCount:  internal.length,
        externalCount:  external.length,
        internalSample: internal.slice(0, 10),
        externalSample: external.slice(0, 10),
      },
      images,
      // ── New fields surfaced by FireCrawl integration ──────────────────────
      structuredData,
      hreflang,
      ogCompleteness:    ogComplete,
      analyzed_with:     usedFirecrawl ? 'firecrawl' : 'fallback',
      firecrawl_content_word_count: firecrawlData?.markdown
        ? firecrawlData.markdown.split(/\s+/).filter(Boolean).length
        : null,
      scores: {
        hasTitle:      !!title,
        titleLength:   title.length,
        hasMetaDesc:   !!metaDesc,
        metaDescLength: metaDesc.length,
        hasH1:         h1s.length > 0,
        hasCanonical:  !!canonical,
        robotsIndexed: !robots.includes('noindex'),
        hasStructuredData: structuredData.count > 0,
        hasHreflang:       hreflang.count > 0,
        ogComplete:        ogComplete.has_title && ogComplete.has_description && ogComplete.has_image,
      },
    })
  } catch (e) {
    const msg = String(e)
    if (msg.includes('timeout') || msg.includes('abort')) {
      return NextResponse.json({ error: 'Request timed out — the page took too long to respond.' }, { status: 408 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
