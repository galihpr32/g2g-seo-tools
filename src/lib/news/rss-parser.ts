/**
 * Tiny RSS / Atom parser — no external dependencies.
 *
 * Why bespoke instead of `rss-parser` lib:
 *   1. Zero deps — keeps Vercel bundle slim.
 *   2. We only need title, link, pubDate, description for Bifrost. The full
 *      lib supports media, enclosures, namespaces we don't care about.
 *   3. Supports both RSS 2.0 (<rss><channel><item>) and Atom (<feed><entry>).
 *
 * Uses regex extraction (not a real XML parser). RSS feeds are well-formed
 * enough in practice that this works reliably for the major gaming sites
 * (IGN, Polygon, PC Gamer, Eurogamer, Game Rant). If a feed introduces
 * exotic CDATA / nested namespaces, swap to fast-xml-parser.
 */

export interface RssItem {
  title:        string
  link:         string
  pubDate:      string | null   // ISO timestamp when parseable; null otherwise
  description:  string          // HTML stripped, capped at 600 chars
}

const HTML_TAG_RE = /<[^>]*>/g
const WHITESPACE_RE = /\s+/g

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
}

function stripCdata(s: string): string {
  return s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '')
}

function clean(s: string, maxLen = 600): string {
  return decodeEntities(stripCdata(s))
    .replace(HTML_TAG_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim()
    .slice(0, maxLen)
}

function parseDate(s: string | null): string | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Pull text content of the FIRST occurrence of <tag>...</tag> within `block`.
 * Tolerates attributes on the opening tag (<tag foo="bar">).
 * Returns the inner text (CDATA-stripped, entity-decoded), or null.
 */
function firstTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const m  = block.match(re)
  return m ? m[1] : null
}

/** Atom <link> uses an attribute-only form — extract href. */
function atomLink(block: string): string | null {
  // <link rel="alternate" href="..." /> or <link href="..." />
  const m = block.match(/<link\s+(?:[^>]*?)href=["']([^"']+)["']/i)
  return m ? m[1] : null
}

/** Pulls all <item> blocks (RSS 2.0) or <entry> blocks (Atom) from `xml`. */
function extractEntries(xml: string): { kind: 'rss' | 'atom'; blocks: string[] } {
  const itemBlocks  = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi)
  if (itemBlocks?.length) return { kind: 'rss', blocks: itemBlocks }
  const entryBlocks = xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi)
  if (entryBlocks?.length) return { kind: 'atom', blocks: entryBlocks }
  return { kind: 'rss', blocks: [] }
}

export function parseRss(xml: string, options: { max?: number } = {}): RssItem[] {
  const { max = 30 } = options
  const { kind, blocks } = extractEntries(xml)
  if (blocks.length === 0) return []

  const items: RssItem[] = []
  for (const block of blocks.slice(0, max)) {
    const title = clean(firstTag(block, 'title') ?? '', 300)
    if (!title) continue   // skip junk entries

    let link: string | null = null
    if (kind === 'rss') {
      link = clean(firstTag(block, 'link') ?? '', 1000) || null
    } else {
      link = atomLink(block)
    }
    if (!link) continue

    const pubRaw = firstTag(block, kind === 'rss' ? 'pubDate' : 'published')
                ?? firstTag(block, 'updated')
                ?? null
    const pubDate = parseDate(pubRaw)

    const descRaw = firstTag(block, 'description')
                 ?? firstTag(block, 'summary')
                 ?? firstTag(block, 'content')
                 ?? ''

    items.push({
      title,
      link:        link.trim(),
      pubDate,
      description: clean(descRaw, 600),
    })
  }

  return items
}

/**
 * Fetch + parse an RSS feed.
 * Returns null on network/parse error so callers can keep going.
 */
export async function fetchRssFeed(url: string, max = 30): Promise<RssItem[] | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'BifrostNewsBot/1.0 (+https://g2g-seo-tools.vercel.app)',
        'Accept':     'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn(`[rss] ${url} returned ${res.status}`)
      return null
    }
    const xml = await res.text()
    return parseRss(xml, { max })
  } catch (err) {
    console.warn(`[rss] fetch failed for ${url}:`, err instanceof Error ? err.message : err)
    return null
  }
}
