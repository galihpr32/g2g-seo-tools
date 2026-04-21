// ─── Crew-Vue CMS API client ──────────────────────────────────────────────────
// Endpoints:
//   SEO config:       https://crew-vue.g2g.com/offers/products/config/{id}/seo
//   Marketing config: https://crew-vue.g2g.com/offers/products/config/{id}/marketing
//
// Required env vars:
//   CREW_VUE_API_KEY   — API key/token (confirm auth method with dev team)
//   CREW_VUE_AUTH_TYPE — 'bearer' | 'apikey' | 'basic' (default: 'bearer')
//
// Field mapping:
//   SEO endpoint:       meta_title, meta_description, meta_keywords
//   Marketing endpoint: marketing_title, marketing_description (HTML)

const BASE = 'https://crew-vue.g2g.com/offers/products/config'

function authHeaders(): Record<string, string> {
  const key      = process.env.CREW_VUE_API_KEY ?? ''
  const authType = process.env.CREW_VUE_AUTH_TYPE ?? 'bearer'

  if (!key) {
    console.warn('[cms] CREW_VUE_API_KEY not configured')
    return {}
  }

  if (authType === 'bearer')  return { Authorization: `Bearer ${key}` }
  if (authType === 'apikey')  return { 'X-API-Key': key }
  if (authType === 'basic')   return { Authorization: `Basic ${Buffer.from(key).toString('base64')}` }
  return { Authorization: `Bearer ${key}` }
}

export interface SeoPayload {
  meta_title:       string
  meta_description: string
  meta_keywords:    string   // comma-separated keywords
}

export interface MarketingPayload {
  marketing_title:       string
  marketing_description: string   // HTML content
}

export interface CmsUploadResult {
  relationId: string
  seo:        { ok: boolean; status?: number; error?: string }
  marketing:  { ok: boolean; status?: number; error?: string }
}

async function patchEndpoint(
  url:     string,
  payload: object,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method:  'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: text.slice(0, 200) }
    }
    return { ok: true, status: res.status }
  } catch (e) {
    return { ok: false, status: 0, error: String(e) }
  }
}

// Upload SEO + Marketing content to CMS for a single product
export async function uploadProductContent(
  relationId:  string,
  seo:         SeoPayload,
  marketing:   MarketingPayload,
): Promise<CmsUploadResult> {
  const [seoResult, marketingResult] = await Promise.all([
    patchEndpoint(`${BASE}/${relationId}/seo`,       seo),
    patchEndpoint(`${BASE}/${relationId}/marketing`, marketing),
  ])

  return {
    relationId,
    seo:       seoResult,
    marketing: marketingResult,
  }
}

// Batch upload — returns results per product
export async function batchUploadContent(
  items: Array<{ relationId: string; seo: SeoPayload; marketing: MarketingPayload }>,
  concurrency = 3,
): Promise<CmsUploadResult[]> {
  const results: CmsUploadResult[] = []

  // Process in batches of `concurrency` to avoid hammering the CMS
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const batchResults = await Promise.all(
      batch.map(item => uploadProductContent(item.relationId, item.seo, item.marketing))
    )
    results.push(...batchResults)
  }

  return results
}
