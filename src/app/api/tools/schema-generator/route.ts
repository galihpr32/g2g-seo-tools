/**
 * /api/tools/schema-generator
 *
 * Sprint: SKILL.SCHEMA.1
 * Skill:  searchfit-seo:schema-markup
 *
 * POST — fetch page content (via hybrid fetch-sample layers), pass to
 *        Claude Haiku using the schema-markup skill methodology, return
 *        JSON-LD schema objects detected for the page.
 *
 * No DB storage — one-shot on-demand tool.
 *
 * Kill switch: SKILL_SCHEMA_GEN_ENABLED (default true).
 *
 * Design rules (universal constraints):
 *   - Retry + 25 s timeout per attempt (max 3 attempts).
 *   - Attribution string embedded in every response.
 *   - No regeneration caching needed (tool is stateless).
 *   - Page content fetched via same 3-layer hybrid as fetch-sample.
 */

import { NextRequest, NextResponse } from 'next/server'
import Anthropic                     from '@anthropic-ai/sdk'
import { createClient }              from '@/lib/supabase/server'
import { fetchPageTextViaDataForSEO } from '@/lib/dataforseo/content-parsing'

export const maxDuration = 60

// ── Constants ─────────────────────────────────────────────────────────────────

const SKILL_NAME      = 'searchfit-seo:schema-markup'
const MODEL           = 'claude-haiku-4-5-20251001'
const MAX_TOKENS      = 2000
const TIMEOUT_MS      = 25_000
const MAX_ATTEMPTS    = 3
const BASE_BACKOFF_MS = 700

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SchemaItem {
  type:        string   // e.g. "Product", "FAQPage", "BreadcrumbList"
  description: string   // 1 sentence: why this schema was chosen
  json_ld:     Record<string, unknown>
}

export interface SchemaGeneratorResponse {
  ok:          true
  skill:       string
  url:         string
  source:      string
  schemas:     SchemaItem[]
  attribution: string
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(url: string, pageText: string, pageType: string | null): string {
  const typeHint = pageType
    ? `\nPage type hint from user: ${pageType}. Prioritise this type but also add complementary schemas.`
    : ''

  // G2G marketplace context
  const siteContext = url.includes('g2g.com')
    ? 'This is a page on G2G (g2g.com), a peer-to-peer gaming marketplace for buying/selling game accounts, in-game items, currency, and carry services.'
    : url.includes('offgamers.com')
      ? 'This is a page on OffGamers (offgamers.com), a digital goods marketplace for gaming gift cards and top-ups.'
      : 'This is a gaming-related web page.'

  return `You are a structured data expert. Analyse the page content below and generate valid JSON-LD schema markup.

${siteContext}${typeHint}

URL: ${url}

PAGE CONTENT (truncated to 8000 chars):
${pageText.slice(0, 8000)}

TASK: Generate the most appropriate JSON-LD schemas for this page. Most pages benefit from 2–4 schemas (e.g. Product + BreadcrumbList + FAQPage, or Article + Organization + BreadcrumbList).

RULES:
1. Only generate schemas that are SUPPORTED by actual content on this page — never fabricate data
2. Omit optional fields that have no supporting content (leave them out entirely; do NOT use empty strings)
3. All URLs must be absolute (include https://)
4. Dates in ISO 8601 format (YYYY-MM-DD)
5. For gaming marketplace pages: Product schema should reference game name as brand, use "https://schema.org/InStock" for availability
6. For category/listing pages: use ItemList schema with the top items visible in content
7. Always include BreadcrumbList if the page URL has 2+ path segments
8. For G2G product pages (e.g. /buy/[game]): include both Product and FAQPage if FAQs are present

Return ONLY a raw JSON array — no markdown, no code fences, no explanation:
[
  {
    "type": "Product",
    "description": "One sentence: why this schema applies to this page",
    "json_ld": {
      "@context": "https://schema.org",
      "@type": "Product",
      ...
    }
  }
]

Valid @type values: Organization, Article, BlogPosting, Product, FAQPage, HowTo, BreadcrumbList, ItemList, WebPage, Service, SoftwareApplication, VideoObject, Review`
}

// ── Live fetch fallback (mirrors fetch-sample layer 3) ────────────────────────

async function liveFetchFallback(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: {
        'User-Agent':    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept':        'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    if (!res.ok) return ''
    const html = await res.text()
    return extractBasicText(html)
  } catch {
    return ''
  }
}

function extractBasicText(html: string): string {
  const parts: string[] = []
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (title?.[1]) parts.push(title[1].trim())
  const desc = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
  if (desc?.[1]) parts.push(desc[1].trim())
  // Extract JSON-LD blocks
  const ldBlocks = html.matchAll(/<script\b[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  for (const m of ldBlocks) {
    try { parts.push(JSON.stringify(JSON.parse(m[1].trim()))) } catch { /* ignore */ }
  }
  return parts.join('\n\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// POST handler
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Kill switch
  if (process.env.SKILL_SCHEMA_GEN_ENABLED === 'false') {
    return NextResponse.json({
      ok:       false,
      disabled: true,
      skill:    SKILL_NAME,
      error:    'Skill disabled via SKILL_SCHEMA_GEN_ENABLED',
    }, { status: 503 })
  }

  // Auth
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  // Parse body
  const body = await req.json().catch(() => ({})) as {
    url?:       string
    page_type?: string
  }
  const rawUrl   = body.url?.trim()
  const pageType = body.page_type?.trim() || null

  if (!rawUrl) {
    return NextResponse.json({ ok: false, error: 'Missing url' }, { status: 400 })
  }

  let parsedUrl: URL
  try { parsedUrl = new URL(rawUrl) } catch {
    return NextResponse.json({ ok: false, error: 'Invalid URL' }, { status: 400 })
  }
  const url = parsedUrl.toString()

  // ── Fetch page content (same 3-layer as fetch-sample, simplified) ──────────
  let pageText = ''
  let source   = 'none'

  // Layer 1: DataForSEO JS render (primary, handles SPAs like G2G).
  // Accept content even when meaningful=false — DataForSEO may return text
  // without strong heading structure (common for SPA shells), but any page
  // text is sufficient for schema inference.
  const dfs = await fetchPageTextViaDataForSEO(url, { timeoutMs: 40_000 })
  if (dfs.ok && dfs.text && dfs.text.trim().length >= 50) {
    pageText = dfs.text.slice(0, 30_000)
    source   = dfs.meaningful ? 'dataforseo' : 'dataforseo_partial'
  }

  // Layer 2: Live fetch + meta extraction fallback
  if (!pageText || pageText.length < 50) {
    const fallback = await liveFetchFallback(url)
    if (fallback.length >= 50) {
      pageText = fallback.slice(0, 30_000)
      source   = 'live_fallback'
    }
  }

  if (!pageText || pageText.length < 50) {
    return NextResponse.json({
      ok:    false,
      skill: SKILL_NAME,
      error: `Could not retrieve page content from ${url}. The page may be unreachable or require JavaScript rendering.`,
    }, { status: 502 })
  }

  // ── Build prompt + call Claude Haiku ──────────────────────────────────────
  const prompt = buildPrompt(url, pageText, pageType)

  let rawOutput: string | null = null
  let lastError: string        = 'Unknown error'

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, BASE_BACKOFF_MS * attempt))
    }
    try {
      const resp = await anthropic.messages.create(
        {
          model:      MODEL,
          max_tokens: MAX_TOKENS,
          system:     'You are a structured data expert. Output ONLY valid JSON as instructed — no markdown, no preamble, no code fences.',
          messages:   [{ role: 'user', content: prompt }],
        },
        { timeout: TIMEOUT_MS },
      )
      const text = resp.content.find(c => c.type === 'text')?.text ?? ''
      if (text.trim()) { rawOutput = text; break }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }

  if (!rawOutput) {
    return NextResponse.json({
      ok:    false,
      skill: SKILL_NAME,
      error: `Claude call failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}`,
    }, { status: 500 })
  }

  // ── Parse + validate ───────────────────────────────────────────────────────
  let schemas: SchemaItem[]
  try {
    const cleaned = rawOutput
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()

    const parsed = JSON.parse(cleaned) as unknown
    if (!Array.isArray(parsed)) throw new Error('Expected JSON array at root')

    schemas = (parsed as unknown[]).filter((item): item is SchemaItem => {
      if (!item || typeof item !== 'object') return false
      const s = item as Record<string, unknown>
      return (
        typeof s.type    === 'string' && s.type.trim().length > 0 &&
        typeof s.json_ld === 'object' && s.json_ld !== null
      )
    })

    if (schemas.length === 0) throw new Error('No valid schema objects found in output')
  } catch (e) {
    return NextResponse.json({
      ok:    false,
      skill: SKILL_NAME,
      error: `Failed to parse schema output: ${e instanceof Error ? e.message : String(e)}`,
      raw:   rawOutput.slice(0, 300),
    }, { status: 500 })
  }

  const response: SchemaGeneratorResponse = {
    ok:          true,
    skill:       SKILL_NAME,
    url,
    source,
    schemas,
    attribution: `Generated via Anthropic skill: ${SKILL_NAME} · Model: ${MODEL.replace('-20251001', '')}`,
  }

  return NextResponse.json(response)
}
