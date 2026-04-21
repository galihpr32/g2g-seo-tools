import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { batchUploadContent } from '@/lib/cms/client'

export const maxDuration = 60

// POST /api/products/auto-content/upload
// Body: { relation_ids?: string[], upload_all?: boolean }
// Takes generated content from product_content_queue and uploads to CMS
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    relation_ids?: string[]
    upload_all?:   boolean
  }

  // ── Fetch items to upload ──────────────────────────────────────────────────
  let query = db
    .from('product_content_queue')
    .select('relation_id, meta_title, meta_description, meta_keywords, marketing_title, marketing_description')
    .eq('owner_user_id', ownerId)
    .eq('status', 'generated')

  if (!body.upload_all && body.relation_ids?.length) {
    query = query.in('relation_id', body.relation_ids)
  }

  const { data: items, error } = await query.limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!items?.length) return NextResponse.json({ uploaded: 0, message: 'No generated items found to upload' })

  // ── Mark as uploading ──────────────────────────────────────────────────────
  await db
    .from('product_content_queue')
    .update({ status: 'uploading', updated_at: new Date().toISOString() })
    .eq('owner_user_id', ownerId)
    .in('relation_id', items.map(i => i.relation_id))

  // ── Upload to CMS ──────────────────────────────────────────────────────────
  const uploadItems = items.map(item => ({
    relationId: item.relation_id,
    seo: {
      meta_title:       item.meta_title       ?? '',
      meta_description: item.meta_description ?? '',
      meta_keywords:    item.meta_keywords    ?? '',
    },
    marketing: {
      marketing_title:       item.marketing_title       ?? '',
      marketing_description: item.marketing_description ?? '',
    },
  }))

  const results = await batchUploadContent(uploadItems, 3)

  // ── Update DB with results ─────────────────────────────────────────────────
  for (const r of results) {
    const seoOk = r.seo.ok
    const mktOk = r.marketing.ok
    const allOk = seoOk && mktOk

    await db
      .from('product_content_queue')
      .update({
        status:         allOk ? 'uploaded' : 'failed',
        cms_seo_status: seoOk ? 'ok' : 'error',
        cms_seo_error:  seoOk ? null : (r.seo.error ?? `HTTP ${r.seo.status}`),
        cms_mkt_status: mktOk ? 'ok' : 'error',
        cms_mkt_error:  mktOk ? null : (r.marketing.error ?? `HTTP ${r.marketing.status}`),
        uploaded_at:    allOk ? new Date().toISOString() : null,
        updated_at:     new Date().toISOString(),
      })
      .eq('owner_user_id', ownerId)
      .eq('relation_id', r.relationId)
  }

  const succeeded = results.filter(r => r.seo.ok && r.marketing.ok).length
  const failed    = results.length - succeeded

  return NextResponse.json({
    uploaded: succeeded,
    failed,
    total: results.length,
    results: results.map(r => ({
      relationId: r.relationId,
      seoOk:      r.seo.ok,
      marketingOk: r.marketing.ok,
      seoError:    r.seo.error,
      marketingError: r.marketing.error,
    })),
  })
}
