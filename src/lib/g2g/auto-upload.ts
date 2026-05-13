// ─── Auto-upload glue: bundle → CMS API ─────────────────────────────────────
// Imported from processProductRow right after a successful sheet write-back.
// Self-contained: loads JWT, calls uploadProductToG2G, persists outcome,
// throttle-Slacks on JWT expiry. Returns a small status object purely for
// logging in the caller — the real source of truth is the
// product_content_queue.cms_upload_status column we set here.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  uploadProductToG2G,
  type CmsBundle,
  type UploadResult,
} from './cms-api'

// Currently only G2G product CMS exists. If OffGamers ever ships a similar
// admin we'd plumb site_slug down from the queue row, but today it's hardcoded.
const SITE_SLUG = 'g2g'

// Max 1 Slack alert per (owner × site × alert_type) every N hours. Without
// this the cron would spam every 5 minutes while the JWT is dead.
const ALERT_THROTTLE_HOURS = 6

export interface AutoUploadOutcome {
  attempted:    boolean
  ok?:          boolean
  status?:      'uploaded' | 'awaiting_token' | 'failed' | 'skipped_no_token'
  jwt_expired?: boolean
  error?:       string
}

interface ProductContentForUpload {
  relation_id:         string
  owner_user_id:       string
  // EN
  meta_title:          string | null
  meta_description:    string | null
  meta_keywords:       string | null
  marketing_title:     string | null
  marketing_intro:     string | null
  marketing_sections:  string[] | null
  faqs:                Array<{ q: string; a: string }> | null
  // ID
  id_meta_title:        string | null
  id_meta_description:  string | null
  id_meta_keywords:     string | null
  id_marketing_title:   string | null
  id_marketing_intro:   string | null
  id_marketing_sections: string[] | null
  id_faqs:               Array<{ q: string; a: string }> | null
  // Cached
  g2g_brand_id:        string | null
  g2g_service_id:      string | null
}

/**
 * Try the auto-upload after a successful generation. Wrapped in a giant
 * try/catch so it can NEVER break the upstream content flow — if upload fails
 * for any reason the row still keeps status='generated' and the sheet shows
 * "Generated"; only the cms_upload_* columns reflect the upload state.
 */
export async function attemptCmsUpload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:      SupabaseClient<any, any, any>,
  ownerId: string,
  product: ProductContentForUpload,
): Promise<AutoUploadOutcome> {
  try {
    // ── 1. Load JWT ────────────────────────────────────────────────────────
    const { data: tokenRow } = await db
      .from('cms_tokens')
      .select('token, expires_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', SITE_SLUG)
      .maybeSingle()

    if (!tokenRow?.token) {
      await markQueueState(db, ownerId, product.relation_id, {
        cms_upload_status: 'awaiting_token',
        cms_upload_error:  'No CMS token saved — paste one at /settings/cms-token.',
      })
      return { attempted: true, ok: false, status: 'skipped_no_token' }
    }

    const expMs = tokenRow.expires_at ? new Date(tokenRow.expires_at).getTime() : null
    if (expMs != null && expMs < Date.now()) {
      await markQueueState(db, ownerId, product.relation_id, {
        cms_upload_status: 'awaiting_token',
        cms_upload_error:  `Saved CMS token expired ${new Date(expMs).toISOString()} — refresh at /settings/cms-token.`,
      })
      await maybeFireJwtExpiredAlert(db, ownerId, SITE_SLUG, 'token expired (local check)')
      return { attempted: true, ok: false, status: 'awaiting_token', jwt_expired: true }
    }

    // ── 2. Build bundles ───────────────────────────────────────────────────
    const en = bundleFromRow(product, 'en')
    if (!en) {
      await markQueueState(db, ownerId, product.relation_id, {
        cms_upload_status: 'failed',
        cms_upload_error:  'EN bundle missing required fields (marketing_title / sections / faqs).',
      })
      return { attempted: true, ok: false, status: 'failed', error: 'EN bundle missing fields' }
    }
    const id = bundleFromRow(product, 'id')  // may be null when translation failed

    // ── 2b. Hydrate brand_id + service_id from canonical catalog ───────────
    // If the queue row's g2g_brand_id/g2g_service_id is missing but the
    // canonical catalog (g2g_products) has them, copy them in. This skips the
    // discovery GET on the very first upload after the CSV import landed.
    let cachedBrandId   = product.g2g_brand_id
    let cachedServiceId = product.g2g_service_id
    if (!cachedBrandId || !cachedServiceId) {
      const { data: catalogRow } = await db
        .from('g2g_products')
        .select('brand_id, service_id, is_active')
        .eq('relation_id', product.relation_id)
        .maybeSingle()
      if (catalogRow?.brand_id && catalogRow?.service_id) {
        cachedBrandId   = catalogRow.brand_id
        cachedServiceId = catalogRow.service_id
        // Persist immediately so the next attempt skips the lookup entirely.
        await markQueueState(db, ownerId, product.relation_id, {
          g2g_brand_id:   cachedBrandId,
          g2g_service_id: cachedServiceId,
        })
      }
    }

    // ── 3. Mark row as uploading (best-effort optimistic lock) ─────────────
    await markQueueState(db, ownerId, product.relation_id, {
      cms_upload_status: 'uploading',
      cms_upload_error:  null,
    })

    // ── 4. Call the API ────────────────────────────────────────────────────
    const result: UploadResult = await uploadProductToG2G({
      relationId:        product.relation_id,
      en,
      id,
      cached_brand_id:   cachedBrandId,
      cached_service_id: cachedServiceId,
    }, tokenRow.token)

    // ── 5. Persist outcome ─────────────────────────────────────────────────
    if (result.ok) {
      await markQueueState(db, ownerId, product.relation_id, {
        cms_upload_status: 'uploaded',
        cms_uploaded_at:   new Date().toISOString(),
        cms_upload_error:  null,
        g2g_brand_id:      result.brand_id   ?? product.g2g_brand_id,
        g2g_service_id:    result.service_id ?? product.g2g_service_id,
      })
      return { attempted: true, ok: true, status: 'uploaded' }
    }

    // Failure path — distinguish JWT-expired from other API errors so the
    // caller (and Slack) can react differently.
    if (result.jwt_expired) {
      await markQueueState(db, ownerId, product.relation_id, {
        cms_upload_status: 'awaiting_token',
        cms_upload_error:  result.error ?? '401/403 from CMS — token rejected.',
        g2g_brand_id:      result.brand_id   ?? product.g2g_brand_id,
        g2g_service_id:    result.service_id ?? product.g2g_service_id,
      })
      await maybeFireJwtExpiredAlert(db, ownerId, SITE_SLUG, result.error ?? 'CMS rejected JWT')
      return { attempted: true, ok: false, status: 'awaiting_token', jwt_expired: true, error: result.error }
    }

    await markQueueState(db, ownerId, product.relation_id, {
      cms_upload_status: 'failed',
      cms_upload_error:  result.error ?? `Failed at ${result.stage}`,
      g2g_brand_id:      result.brand_id   ?? product.g2g_brand_id,
      g2g_service_id:    result.service_id ?? product.g2g_service_id,
    })
    return { attempted: true, ok: false, status: 'failed', error: result.error }

  } catch (e) {
    // Last-resort safety net — never let this break the content flow.
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[g2g/auto-upload] unexpected exception:', e)
    try {
      await markQueueState(db, ownerId, product.relation_id, {
        cms_upload_status: 'failed',
        cms_upload_error:  `[auto_upload_exception] ${msg}`,
      })
    } catch { /* swallow */ }
    return { attempted: true, ok: false, status: 'failed', error: msg }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function bundleFromRow(p: ProductContentForUpload, lang: 'en' | 'id'): CmsBundle | null {
  if (lang === 'en') {
    if (!p.marketing_title || !p.marketing_sections?.length || !p.faqs?.length) return null
    return {
      marketingTitle:    p.marketing_title,
      marketingIntro:    p.marketing_intro    ?? '',
      marketingSections: p.marketing_sections ?? [],
      metaTitle:         p.meta_title         ?? '',
      metaDescription:   p.meta_description   ?? '',
      metaKeyword:       p.meta_keywords      ?? '',
      faqs:              p.faqs               ?? [],
    }
  }
  if (!p.id_marketing_title || !p.id_marketing_sections?.length || !p.id_faqs?.length) return null
  return {
    marketingTitle:    p.id_marketing_title,
    marketingIntro:    p.id_marketing_intro    ?? '',
    marketingSections: p.id_marketing_sections ?? [],
    metaTitle:         p.id_meta_title         ?? '',
    metaDescription:   p.id_meta_description   ?? '',
    metaKeyword:       p.id_meta_keywords      ?? '',
    faqs:              p.id_faqs               ?? [],
  }
}

async function markQueueState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any, any, any>,
  ownerId:   string,
  relationId: string,
  patch:     Record<string, unknown>,
): Promise<void> {
  await db
    .from('product_content_queue')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('owner_user_id', ownerId)
    .eq('relation_id', relationId)
}

// ─── JWT-expired Slack alert (throttled) ────────────────────────────────────
// Posts a single message per (owner × site) per ALERT_THROTTLE_HOURS so the
// user is told ONCE that the token died — not 12 times an hour while the
// cron loops over pending rows.

async function maybeFireJwtExpiredAlert(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
  reason:   string,
): Promise<void> {
  try {
    const since = new Date(Date.now() - ALERT_THROTTLE_HOURS * 3600 * 1000).toISOString()
    const { data: recent } = await db
      .from('cms_alert_history')
      .select('id')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .eq('alert_type', 'jwt_expired')
      .gt('alerted_at', since)
      .limit(1)
      .maybeSingle()

    if (recent) return  // we already shouted within the throttle window

    const webhookUrl = process.env.SLACK_WEBHOOK_URL
    if (!webhookUrl) return

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')
    const settingsUrl = `${appUrl}/settings/cms-token`

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🚫 G2G CMS upload paused — token expired`, emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*Brand:* ${siteSlug}`,
            `*Reason:* ${reason}`,
            ``,
            `Auto-uploads are now parked as \`awaiting_token\`. They'll resume automatically once you paste a fresh JWT.`,
          ].join('\n'),
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text:  { type: 'plain_text', text: '🔐 Refresh JWT' },
            url:   settingsUrl,
            style: 'primary',
          },
        ],
      },
    ]

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ blocks }),
    })
    // Log the alert regardless of webhook outcome — we still want throttling
    // to kick in even if the Slack post fails (otherwise we'd retry every tick).
    await db.from('cms_alert_history').insert({
      owner_user_id: ownerId,
      site_slug:     siteSlug,
      alert_type:    'jwt_expired',
    })

    if (!res.ok) {
      console.warn(`[g2g/auto-upload] Slack JWT alert post failed: ${res.status}`)
    }
  } catch (e) {
    console.error('[g2g/auto-upload] maybeFireJwtExpiredAlert exception:', e)
  }
}
