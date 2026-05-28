import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { attemptCmsUpload } from '@/lib/g2g/auto-upload'

export const maxDuration = 300

/**
 * POST /api/products/auto-content/upload
 * Body: { relation_ids?: string[], upload_all?: boolean, include_uploaded?: boolean }
 *
 * Manual upload trigger. Pulls already-generated rows from
 * product_content_queue and pushes each one to the G2G CMS via the same
 * pipeline the cron uses (sls-bafj35gh.g2g.com — marketing + SEO + FAQ EN/ID
 * with X-Api-Key + Bearer JWT auth).
 *
 * Idempotent: rows already `cms_upload_status='uploaded'` are skipped silently
 * unless `include_uploaded=true` (force re-push — rare).
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    relation_ids?:     string[]
    upload_all?:       boolean
    include_uploaded?: boolean
  }

  // ── Fetch generated rows ───────────────────────────────────────────────
  let query = db
    .from('product_content_queue')
    .select(`
      relation_id, status, cms_upload_status,
      meta_title, meta_description, meta_keywords,
      marketing_title, marketing_intro, marketing_sections, faqs,
      id_meta_title, id_meta_description, id_meta_keywords,
      id_marketing_title, id_marketing_intro, id_marketing_sections, id_faqs,
      g2g_brand_id, g2g_service_id
    `)
    .eq('owner_user_id', ownerId)
    .eq('status', 'generated')

  if (!body.upload_all && body.relation_ids?.length) {
    query = query.in('relation_id', body.relation_ids)
  }

  if (!body.include_uploaded) {
    // Skip rows that already landed in CMS — manual button shouldn't double-push.
    query = query.or('cms_upload_status.is.null,cms_upload_status.neq.uploaded')
  }

  const { data: items, error } = await query.limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!items?.length) {
    return NextResponse.json({
      uploaded: 0,
      total:    0,
      message:  'No items to upload — either nothing is generated yet, or all selected rows are already uploaded.',
    })
  }

  // ── Upload each row via the same helper the cron uses ─────────────────
  // Sequential keeps Vercel timeouts + CMS rate-limit headroom predictable
  // and matches the cron flow exactly. attemptCmsUpload writes its own
  // cms_upload_* columns and fires the throttled JWT-expired Slack alert.
  let succeeded = 0, failed = 0, jwtExpired = false
  const perItem: Array<{ relation_id: string; ok: boolean; status?: string; error?: string }> = []

  for (const item of items) {
    const outcome = await attemptCmsUpload(db, ownerId, {
      relation_id:           item.relation_id,
      owner_user_id:         ownerId,
      meta_title:            item.meta_title,
      meta_description:      item.meta_description,
      meta_keywords:         item.meta_keywords,
      marketing_title:       item.marketing_title,
      marketing_intro:       item.marketing_intro,
      marketing_sections:    item.marketing_sections,
      faqs:                  item.faqs,
      id_meta_title:         item.id_meta_title,
      id_meta_description:   item.id_meta_description,
      id_meta_keywords:      item.id_meta_keywords,
      id_marketing_title:    item.id_marketing_title,
      id_marketing_intro:    item.id_marketing_intro,
      id_marketing_sections: item.id_marketing_sections,
      id_faqs:               item.id_faqs,
      g2g_brand_id:          item.g2g_brand_id,
      g2g_service_id:        item.g2g_service_id,
    })

    if (outcome.ok) {
      succeeded++
    } else {
      failed++
      if (outcome.jwt_expired) jwtExpired = true
    }
    perItem.push({
      relation_id: item.relation_id,
      ok:          !!outcome.ok,
      status:      outcome.status,
      error:       outcome.error,
    })

    // Short-circuit once we hit a JWT failure — every subsequent call will
    // also fail with the same auth error.
    if (outcome.jwt_expired) break
  }

  return NextResponse.json({
    uploaded:    succeeded,
    failed,
    total:       items.length,
    jwt_expired: jwtExpired,
    note: jwtExpired
      ? 'JWT rejected by CMS — aborted remaining uploads. Refresh token at /settings/cms-token.'
      : undefined,
    results: perItem,
  })
}
