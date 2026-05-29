import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

export const maxDuration = 300

/**
 * GET /api/cron/schema-health
 *
 * Weekly cron — for each active site's top N tracked pages, fetch HTML,
 * extract JSON-LD blocks, validate basic schema.org structure, persist
 * snapshot.
 *
 * "Top pages" = tracked_products page_url + top 20 by clicks from
 * gsc_ranking_snapshots (most recent week). Together gives us the URLs
 * where schema markup matters most.
 *
 * Validation rules (v1, intentionally lightweight — no full schema.org
 * validator dependency):
 *   - JSON-LD block must parse as JSON (-30 if fails)
 *   - Must have @context (typically https://schema.org)        (-15 if missing)
 *   - Must have @type                                          (-25 if missing)
 *   - Required fields per type (e.g. Product needs name+image+offers) (-10 each)
 *
 * Auth: Bearer CRON_SECRET via GitHub Actions.
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

interface JsonLdBlock {
  raw: string
  parsed: Record<string, unknown> | null
}

interface ValidationResult {
  schema_types:      string[]
  validation_errors: string[]
  validity_score:    number      // 0-100
  has_jsonld:        boolean
  jsonld_count:      number
  raw_jsonld:        JsonLdBlock[]
}

/** Extract <script type="application/ld+json">…</script> blocks from HTML */
function extractJsonLdBlocks(html: string): JsonLdBlock[] {
  const blocks: JsonLdBlock[] = []
  // Match scripts tagged JSON-LD (case-insensitive on attributes)
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim()
    let parsed: Record<string, unknown> | null = null
    try {
      const obj = JSON.parse(raw)
      // Some sites wrap in array; flatten to object-or-array but keep raw
      parsed = obj
    } catch { /* keep parsed=null */ }
    blocks.push({ raw, parsed })
  }
  return blocks
}

const TYPE_REQUIREMENTS: Record<string, string[]> = {
  Product:        ['name', 'image', 'offers'],
  Article:        ['headline', 'author', 'datePublished'],
  BreadcrumbList: ['itemListElement'],
  FAQPage:        ['mainEntity'],
  Organization:   ['name', 'url'],
  WebPage:        ['name'],
  Review:         ['itemReviewed', 'reviewRating', 'author'],
  AggregateRating: ['ratingValue', 'reviewCount'],
}

function validateJsonLd(blocks: JsonLdBlock[]): ValidationResult {
  if (blocks.length === 0) {
    return {
      schema_types:      [],
      validation_errors: ['No JSON-LD blocks found on the page.'],
      validity_score:    0,
      has_jsonld:        false,
      jsonld_count:      0,
      raw_jsonld:        [],
    }
  }

  const errors: string[] = []
  const types: string[] = []
  let score = 100

  for (const [i, block] of blocks.entries()) {
    if (!block.parsed) {
      errors.push(`Block #${i + 1}: invalid JSON — fails to parse.`)
      score -= 30
      continue
    }
    // JSON-LD often wraps in array
    const items = Array.isArray(block.parsed) ? block.parsed : [block.parsed]
    for (const [j, item] of items.entries()) {
      if (typeof item !== 'object' || item === null) {
        errors.push(`Block #${i + 1}.${j + 1}: not an object.`)
        score -= 10
        continue
      }
      const obj = item as Record<string, unknown>
      const ctx = obj['@context']
      const typ = obj['@type']

      if (!ctx) { errors.push(`Block #${i + 1}.${j + 1}: missing @context.`); score -= 15 }
      if (!typ) {
        errors.push(`Block #${i + 1}.${j + 1}: missing @type.`)
        score -= 25
        continue
      }
      const typeStr = Array.isArray(typ) ? String(typ[0]) : String(typ)
      types.push(typeStr)

      // Required fields per known type
      const required = TYPE_REQUIREMENTS[typeStr]
      if (required) {
        for (const field of required) {
          if (!(field in obj)) {
            errors.push(`Block #${i + 1}.${j + 1} (${typeStr}): missing required field "${field}".`)
            score -= 10
          }
        }
      }
    }
  }

  return {
    schema_types:      Array.from(new Set(types)),
    validation_errors: errors,
    validity_score:    Math.max(0, Math.min(100, score)),
    has_jsonld:        true,
    jsonld_count:      blocks.length,
    raw_jsonld:        blocks,
  }
}

async function fetchPage(url: string): Promise<{ status: number; html: string } | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; G2G-SchemaCheck/1.0; +https://g2g-seo-tools.vercel.app)',
        'Accept':     'text/html',
      },
      signal:  ctrl.signal,
      redirect: 'follow',
    })
    clearTimeout(t)
    const html = await res.text()
    return { status: res.status, html }
  } catch {
    clearTimeout(t)
    return null
  }
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const today = new Date().toISOString().split('T')[0]

  const { data: sites } = await db
    .from('site_configs')
    .select('slug, favicon_domain, gsc_property')
    .eq('is_active', true)

  if (!sites || sites.length === 0) {
    return NextResponse.json({ error: 'No active sites' }, { status: 500 })
  }

  const stats = { sites: 0, pagesChecked: 0, blocksFound: 0, withErrors: 0, written: 0 }

  for (const site of sites) {
    stats.sites++
    const siteSlug = String(site.slug)
    const gscProperty = String(site.gsc_property ?? '')

    // Top URLs: tracked_products page_url + top 20 GSC clicks
    const { data: products } = await db
      .from('tracked_products')
      .select('page_url, owner_user_id')
      .eq('site_slug', siteSlug)
      .eq('active', true)
      .limit(20)

    const { data: gscTop } = gscProperty
      ? await db
          .from('gsc_ranking_snapshots')
          .select('page, clicks')
          .eq('site_url', gscProperty)
          .gte('snapshot_date', new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10))
          .order('clicks', { ascending: false })
          .limit(20)
      : { data: [] }

    // De-dupe URL list, group by owner
    const ownerToUrls = new Map<string, Set<string>>()
    for (const p of products ?? []) {
      const ownerId = String(p.owner_user_id)
      if (!ownerToUrls.has(ownerId)) ownerToUrls.set(ownerId, new Set())
      ownerToUrls.get(ownerId)!.add(String(p.page_url))
    }
    // GSC pages get attached to the FIRST owner from products (best-effort —
    // tracked_products tells us "who owns this site_slug")
    const firstOwner = Array.from(ownerToUrls.keys())[0]
    if (firstOwner) {
      for (const g of (gscTop ?? [])) {
        ownerToUrls.get(firstOwner)!.add(String(g.page))
      }
    }

    for (const [ownerId, urlSet] of ownerToUrls.entries()) {
      const urls = Array.from(urlSet).slice(0, 25)   // cap per owner per site
      for (const url of urls) {
        stats.pagesChecked++
        const fetched = await fetchPage(url)
        if (!fetched) continue

        const blocks = extractJsonLdBlocks(fetched.html)
        stats.blocksFound += blocks.length
        const validation = validateJsonLd(blocks)
        if (validation.validation_errors.length > 0) stats.withErrors++

        const { error } = await db
          .from('schema_health_snapshots')
          .upsert({
            owner_user_id:     ownerId,
            site_slug:         siteSlug,
            page_url:          url,
            snapshot_date:     today,
            has_jsonld:        validation.has_jsonld,
            jsonld_count:      validation.jsonld_count,
            schema_types:      validation.schema_types,
            validation_errors: validation.validation_errors,
            validity_score:    validation.validity_score,
            http_status:       fetched.status,
            raw_jsonld:        validation.raw_jsonld,
          }, { onConflict: 'owner_user_id,site_slug,page_url,snapshot_date' })

        if (!error) stats.written++
      }
    }
  }

  return NextResponse.json({
    ok:    true,
    when:  new Date().toISOString(),
    stats,
  })
}
