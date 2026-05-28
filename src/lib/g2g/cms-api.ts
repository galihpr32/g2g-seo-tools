// ─── G2G CMS admin REST API client ──────────────────────────────────────────
// Backs the BDT auto-upload flow. After AI generates EN + ID content (and the
// row lands in the brief sheet with status="Generated"), the cron worker
// invokes `uploadProductToG2G()` to push the same content into the G2G admin
// CMS directly — no more local Firefox + cookie hack.
//
// API surface (3 endpoints, 4 calls per product):
//   GET  /offer/keyword_relation/{relation_id}         → discover brand_id + service_id
//   PUT  /offer/keyword_relation/{relation_id}         → marketing + SEO combined (1 call)
//   PUT  /offer/product_settings                        → FAQ EN (1 call)
//   PUT  /offer/product_settings                        → FAQ ID (1 call)
//
// Auth:
//   X-Api-Key:      static, set in env (G2G_CMS_API_KEY)
//   Authorization:  Bearer <JWT>, expires ~1 week, manually refreshed via
//                   /settings/cms-token (cms_tokens table).
//
// Languages: every text field is a 5-key object: {en, id, ko, 'zh-CN', 'zh-TW'}.
//   We only generate EN + ID, so the other 3 keys are left empty strings to
//   match the admin's "no overwrite if empty" behaviour. The FAQ endpoint
//   takes one language per call, so we send 2 PUTs (en, id).

const API_BASE = 'https://sls-bafj35gh.g2g.com'

// Two languages we actively manage. Other CMS languages (ko, zh-CN, zh-TW)
// remain whatever the BDT entered manually.
export const MANAGED_LANGUAGES = ['en', 'id'] as const
export type ManagedLanguage = (typeof MANAGED_LANGUAGES)[number]

// Full language-key shape the CMS expects on every multilingual field. Keys
// we don't manage get empty-string placeholders.
type AllLanguage = 'en' | 'id' | 'ko' | 'zh-CN' | 'zh-TW'

type MultiLangText = Record<AllLanguage, string>

function buildMultiLang(en: string, id: string): MultiLangText {
  return {
    'en':    en,
    'id':    id,
    'ko':    '',
    'zh-CN': '',
    'zh-TW': '',
  }
}

// ─── Public types ──────────────────────────────────────────────────────────

export interface CmsFaq { q: string; a: string }

export interface CmsBundle {
  marketingTitle:       string
  marketingIntro:       string         // HTML lead block <h1>…</h1>…<br><br>
  marketingSections:    string[]       // 8 HTML blocks <h2>…</h2>…<br><br>
  metaTitle:            string
  metaDescription:      string
  metaKeyword:          string         // comma-separated string per admin field
  faqs:                 CmsFaq[]
}

export interface UploadInput {
  relationId:           string
  en:                   CmsBundle
  id:                   CmsBundle | null   // ID may have failed translation; OK to skip
  // Optional cached IDs from a previous GET — saves a call if present.
  cached_brand_id?:     string | null
  cached_service_id?:   string | null
}

export interface UploadResult {
  ok:                   boolean
  stage?:               UploadStage
  status?:              number
  jwt_expired?:         boolean
  error?:               string
  brand_id?:            string
  service_id?:          string
  stages_done:          UploadStage[]
}

export type UploadStage =
  | 'get_relation'
  | 'put_keyword_relation'
  | 'put_faq_en'
  | 'put_faq_id'

// ─── HTTP plumbing ─────────────────────────────────────────────────────────

function authHeaders(jwt: string): Record<string, string> {
  const apiKey = process.env.G2G_CMS_API_KEY ?? ''
  if (!apiKey) console.warn('[g2g-cms] G2G_CMS_API_KEY env var not set')
  return {
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    'X-Api-Key':     apiKey,
    'Authorization': `Bearer ${jwt}`,
  }
}

interface CmsCallResult {
  ok:           boolean
  status:       number
  jwt_expired:  boolean
  data?:        unknown
  error?:       string
}

async function cmsCall(
  url:     string,
  method:  'GET' | 'PUT',
  jwt:     string,
  body?:   unknown,
): Promise<CmsCallResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: authHeaders(jwt),
      body:    body !== undefined ? JSON.stringify(body) : undefined,
      // G2G CMS occasionally slow on large product config writes.
      signal:  AbortSignal.timeout(20_000),
    })

    const text = await res.text().catch(() => '')
    let parsed: unknown = null
    if (text) { try { parsed = JSON.parse(text) } catch { /* keep as text */ } }

    // 401 / 403 are how the admin signals an expired or revoked JWT.
    // We bubble this up so the orchestrator can:
    //   1) mark the queue row cms_upload_status = 'awaiting_token'
    //   2) fire one Slack alert (throttled via cms_alert_history)
    const jwtExpired = res.status === 401 || res.status === 403

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        jwt_expired: jwtExpired,
        error: typeof parsed === 'object' && parsed
          ? JSON.stringify(parsed).slice(0, 400)
          : text.slice(0, 400) || `${method} ${url} → HTTP ${res.status}`,
      }
    }

    return { ok: true, status: res.status, jwt_expired: false, data: parsed ?? text }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      jwt_expired: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

// ─── 1. GET keyword_relation — discover brand_id + service_id ──────────────

interface GetRelationResult {
  ok:           boolean
  brand_id?:    string
  service_id?:  string
  jwt_expired?: boolean
  error?:       string
  status?:      number
}

export async function getKeywordRelation(
  relationId: string,
  jwt:        string,
): Promise<GetRelationResult> {
  const url = `${API_BASE}/offer/keyword_relation/${encodeURIComponent(relationId)}`
  const res = await cmsCall(url, 'GET', jwt)

  if (!res.ok) {
    return {
      ok: false,
      jwt_expired: res.jwt_expired,
      status: res.status,
      error: res.error,
    }
  }

  // Response shape (observed via DevTools):
  //   { payload: { brand_id, service_id, ... }, ... }
  //   — or sometimes the relation object at the top level.
  const data = (res.data ?? {}) as Record<string, unknown>
  const inner = (data.payload ?? data) as Record<string, unknown>

  const brand_id   = stringOrUndef(inner.brand_id)
  const service_id = stringOrUndef(inner.service_id)

  if (!brand_id || !service_id) {
    return {
      ok: false,
      status: res.status,
      error: `[get_relation] could not parse brand_id/service_id from response (keys: ${Object.keys(inner).join(',')})`,
    }
  }

  return { ok: true, brand_id, service_id, status: res.status }
}

function stringOrUndef(v: unknown): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s.length ? s : undefined
}

// ─── 2. PUT keyword_relation — marketing + SEO combined ────────────────────

/**
 * Build the marketing_description HTML block from intro + sections.
 * Format mirrors what the marketing endpoint expects (and what the friend's
 * auto-upload tool produced via UI fills):
 *   <h1>title</h1>intro<br><br>
 *   <h2>section heading</h2>section body<br><br>
 *   …
 * Sections already arrive wrapped (`<h2 class="text-h5 q-ma-none">…</h2>…<br><br>`).
 */
function composeMarketingDescription(b: CmsBundle): string {
  const intro    = b.marketingIntro?.trim() ?? ''
  const sections = (b.marketingSections ?? []).map(s => String(s ?? '').trim()).filter(Boolean)
  return [intro, ...sections].join('\n')
}

export async function updateKeywordRelation(
  relationId: string,
  en:         CmsBundle,
  id:         CmsBundle | null,
  jwt:        string,
): Promise<CmsCallResult & { stage: 'put_keyword_relation' }> {
  const url = `${API_BASE}/offer/keyword_relation/${encodeURIComponent(relationId)}`

  // Marketing — the {en, id, ko, zh-CN, zh-TW} multilingual envelope.
  const marketingTitle       = buildMultiLang(en.marketingTitle, id?.marketingTitle ?? '')
  const marketingDescription = buildMultiLang(
    composeMarketingDescription(en),
    id ? composeMarketingDescription(id) : '',
  )

  // SEO — flat keys (per DevTools capture). NB: the meta_keyword field is
  // singular in the API even though our DB column is `meta_keywords` plural.
  const body = {
    marketing_title:        marketingTitle,
    marketing_description:  marketingDescription,
    meta_title:             buildMultiLang(en.metaTitle,       id?.metaTitle       ?? ''),
    meta_description:       buildMultiLang(en.metaDescription, id?.metaDescription ?? ''),
    meta_keyword:           buildMultiLang(en.metaKeyword,     id?.metaKeyword     ?? ''),
  }

  const res = await cmsCall(url, 'PUT', jwt, body)
  return { ...res, stage: 'put_keyword_relation' as const }
}

// ─── 3. PUT product_settings — FAQ per language ────────────────────────────

/**
 * FAQ endpoint takes one language per call. Field names use capital Q/A
 * (verified via DevTools).
 *
 * Payload:
 *   {
 *     service_id:            "lgc_1_36382_…",
 *     brand_id:              "br_…",
 *     product_settings_type: "product_faq",
 *     product_settings: { language: "en", faq: [{Q, A}, …] }
 *   }
 */
export async function updateProductFaq(
  brandId:   string,
  serviceId: string,
  language:  ManagedLanguage,
  faqs:      CmsFaq[],
  jwt:       string,
): Promise<CmsCallResult & { stage: `put_faq_${ManagedLanguage}` }> {
  const url = `${API_BASE}/offer/product_settings`

  const body = {
    service_id:            serviceId,
    brand_id:              brandId,
    product_settings_type: 'product_faq',
    product_settings: {
      language,
      faq: faqs.map(f => ({ Q: f.q, A: f.a })),
    },
  }

  const res = await cmsCall(url, 'PUT', jwt, body)
  return { ...res, stage: `put_faq_${language}` as const }
}

// ─── 4. Orchestrator: full per-product upload ──────────────────────────────

/**
 * Runs the complete 4-call upload sequence for one product, short-circuiting
 * on JWT expiry. Returns a stage-tagged result so the caller can persist a
 * clear error and decide whether to fire the throttled Slack alert.
 *
 * Why stage tagging:
 *   When something fails on slide 3 of 4 (e.g. FAQ ID write), we don't want
 *   to silently retry the marketing PUT — that would clobber a successful
 *   write. The caller inspects `stages_done` to know what was already pushed
 *   and may decide to retry only the missing stages.
 */
export async function uploadProductToG2G(
  input: UploadInput,
  jwt:   string,
): Promise<UploadResult> {
  const stagesDone: UploadStage[] = []

  // ── Stage 1: resolve brand_id + service_id ─────────────────────────────
  let brandId   = input.cached_brand_id   ?? null
  let serviceId = input.cached_service_id ?? null

  if (!brandId || !serviceId) {
    const got = await getKeywordRelation(input.relationId, jwt)
    if (!got.ok) {
      return {
        ok: false,
        stage: 'get_relation',
        status: got.status,
        jwt_expired: got.jwt_expired,
        error: `[get_relation] ${got.error}`,
        stages_done: stagesDone,
      }
    }
    brandId   = got.brand_id!
    serviceId = got.service_id!
  }
  stagesDone.push('get_relation')

  // ── Stage 2: marketing + SEO (one PUT) ─────────────────────────────────
  const mkt = await updateKeywordRelation(input.relationId, input.en, input.id, jwt)
  if (!mkt.ok) {
    return {
      ok: false,
      stage: 'put_keyword_relation',
      status: mkt.status,
      jwt_expired: mkt.jwt_expired,
      error: `[put_keyword_relation] ${mkt.error}`,
      brand_id: brandId,
      service_id: serviceId,
      stages_done: stagesDone,
    }
  }
  stagesDone.push('put_keyword_relation')

  // ── Stage 3: FAQ EN ────────────────────────────────────────────────────
  const faqEn = await updateProductFaq(brandId, serviceId, 'en', input.en.faqs, jwt)
  if (!faqEn.ok) {
    return {
      ok: false,
      stage: 'put_faq_en',
      status: faqEn.status,
      jwt_expired: faqEn.jwt_expired,
      error: `[put_faq_en] ${faqEn.error}`,
      brand_id: brandId,
      service_id: serviceId,
      stages_done: stagesDone,
    }
  }
  stagesDone.push('put_faq_en')

  // ── Stage 4: FAQ ID (skipped if translation failed upstream) ──────────
  if (input.id && input.id.faqs?.length) {
    const faqId = await updateProductFaq(brandId, serviceId, 'id', input.id.faqs, jwt)
    if (!faqId.ok) {
      return {
        ok: false,
        stage: 'put_faq_id',
        status: faqId.status,
        jwt_expired: faqId.jwt_expired,
        error: `[put_faq_id] ${faqId.error}`,
        brand_id: brandId,
        service_id: serviceId,
        stages_done: stagesDone,
      }
    }
    stagesDone.push('put_faq_id')
  }

  return {
    ok: true,
    brand_id: brandId,
    service_id: serviceId,
    stages_done: stagesDone,
  }
}

// ─── JWT helpers (used by token storage API) ───────────────────────────────

/**
 * Decodes the JWT payload (NO signature verification — we trust whatever the
 * G2G admin issued, since the only purpose of this is to surface `exp` /
 * `sub` to the user, not to authorize them).
 */
export function decodeJwtPayload(jwt: string): { exp?: number; sub?: string; email?: string } | null {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const payload = JSON.parse(json) as Record<string, unknown>
    return {
      exp:   typeof payload.exp === 'number' ? payload.exp : undefined,
      sub:   typeof payload.sub === 'string' ? payload.sub : undefined,
      email: typeof payload.email === 'string' ? payload.email : undefined,
    }
  } catch {
    return null
  }
}

export function jwtExpiryDate(jwt: string): Date | null {
  const p = decodeJwtPayload(jwt)
  if (!p?.exp) return null
  return new Date(p.exp * 1000)
}
