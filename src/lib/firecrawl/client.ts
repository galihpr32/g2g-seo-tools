// ─── Firecrawl API Client ─────────────────────────────────────────────────────
// Docs: https://docs.firecrawl.dev/api-reference
// Env:  FIRECRAWL_API_KEY

const BASE = 'https://api.firecrawl.dev/v1'

function headers() {
  return {
    Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY ?? ''}`,
    'Content-Type': 'application/json',
  }
}

export interface CrawledPage {
  url: string
  title: string
  description: string    // meta description
  markdown: string       // clean page content as markdown
  html: string           // raw HTML (trimmed)
  h1: string[]
  h2: string[]
  wordCount: number
  links: { href: string; text: string }[]
}

// ── Scrape a single URL and return clean markdown content ─────────────────────
export async function scrapePage(url: string): Promise<CrawledPage | null> {
  if (!process.env.FIRECRAWL_API_KEY) return null

  try {
    const res = await fetch(`${BASE}/scrape`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        url,
        formats: ['markdown', 'html'],
        onlyMainContent: true,   // strips nav, footer, ads
        waitFor: 1000,
      }),
    })

    if (!res.ok) {
      console.error('Firecrawl scrape error:', res.status, await res.text())
      return null
    }

    const data = await res.json()
    if (!data.success) return null

    const md: string = data.data?.markdown ?? ''
    const html: string = (data.data?.html ?? '').slice(0, 5000) // cap HTML size
    const meta = data.data?.metadata ?? {}

    // Extract headings from markdown
    const h1 = [...md.matchAll(/^# (.+)$/gm)].map(m => m[1])
    const h2 = [...md.matchAll(/^## (.+)$/gm)].map(m => m[1])

    // Extract links
    const links: CrawledPage['links'] = []
    const linkRe = /\[([^\]]+)\]\((https?[^)]+)\)/g
    let m: RegExpExecArray | null
    while ((m = linkRe.exec(md)) !== null) {
      links.push({ text: m[1], href: m[2] })
    }

    // Word count (rough)
    const wordCount = md.split(/\s+/).filter(Boolean).length

    return {
      url,
      title: meta.title ?? h1[0] ?? '',
      description: meta.description ?? '',
      markdown: md,
      html,
      h1,
      h2,
      wordCount,
      links,
    }
  } catch (err) {
    console.error('Firecrawl error:', err)
    return null
  }
}

// ── Lightweight fallback: fetch + extract text without Firecrawl ──────────────
// Used when FIRECRAWL_API_KEY is not set
export async function scrapePageFallback(url: string): Promise<Partial<CrawledPage> | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Tools-Bot/1.0)' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const html = await res.text()

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = titleMatch?.[1]?.trim() ?? ''

    // Extract meta description
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    const description = descMatch?.[1]?.trim() ?? ''

    // Strip tags for rough text
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000) // cap at 8k chars

    return { url, title, description, markdown: text, wordCount: text.split(/\s+/).length }
  } catch {
    return null
  }
}

// ── Smart scrape: use Firecrawl if key present, fallback otherwise ─────────────
export async function smartScrape(url: string): Promise<Partial<CrawledPage> | null> {
  if (process.env.FIRECRAWL_API_KEY) {
    return await scrapePage(url)
  }
  return await scrapePageFallback(url)
}
