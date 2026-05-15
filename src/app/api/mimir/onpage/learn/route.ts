import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import {
  learnOnpagePatterns,
  ONPAGE_DIMENSIONS,
  type OnpageDimension,
  type PageSample,
} from '@/lib/agents/mimir-onpage-learner'

export const maxDuration = 60

/**
 * POST /api/mimir/onpage/learn
 *
 * Sprint MIMIR.ONPAGE — Start an on-page pattern extraction job.
 *
 * Body:
 *   {
 *     pages:      Array<{ url, content, productName? }>   // 2–20 pages
 *     dimensions: OnpageDimension[]                       // optional; default = all 6
 *     replace:    boolean                                  // default false (append)
 *   }
 *
 * Returns the job_id immediately. The learner runs in after() so the lambda
 * doesn't block the HTTP response. Poll GET /api/mimir/onpage/learn/[id]
 * every 2s to watch progress.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  let body: { pages?: PageSample[]; dimensions?: OnpageDimension[]; replace?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const pages = Array.isArray(body.pages) ? body.pages.filter(p => p && typeof p.url === 'string' && typeof p.content === 'string' && p.content.trim().length > 50) : []
  if (pages.length < 2) {
    return NextResponse.json({ error: 'At least 2 pages with content (≥50 chars each) are required' }, { status: 400 })
  }
  if (pages.length > 20) {
    return NextResponse.json({ error: 'Max 20 pages per job — pick the top performers' }, { status: 400 })
  }

  const dimensions: OnpageDimension[] = Array.isArray(body.dimensions) && body.dimensions.length > 0
    ? body.dimensions.filter((d): d is OnpageDimension => (ONPAGE_DIMENSIONS as readonly string[]).includes(d))
    : [...ONPAGE_DIMENSIONS]

  const replace = Boolean(body.replace)

  // ── 1. Insert tracking row ────────────────────────────────────────────────
  const { data: job, error: insErr } = await db
    .from('mimir_onpage_jobs')
    .insert({
      owner_user_id:     ownerId,
      site_slug:         siteSlug,
      status:            'pending',
      page_count:        pages.length,
      dimensions,
      replace_strategy:  replace,
      total_steps:       dimensions.length,
      completed_steps:   0,
    })
    .select('id')
    .single()
  if (insErr || !job) {
    return NextResponse.json({ error: insErr?.message ?? 'Failed to create job' }, { status: 500 })
  }

  const jobId = String(job.id)

  // ── 2. Kick off async processing ──────────────────────────────────────────
  after(async () => {
    try {
      await db.from('mimir_onpage_jobs').update({
        status:     'running',
        started_at: new Date().toISOString(),
      }).eq('id', jobId)

      const result = await learnOnpagePatterns(db, {
        pages, dimensions, siteSlug, ownerId, replace,
      }, async (done, total, current) => {
        // Per-dimension progress callback — best effort, don't block on failure
        try {
          await db.from('mimir_onpage_jobs').update({
            completed_steps:   done,
            current_dimension: current,
          }).eq('id', jobId)
        } catch (e) {
          console.warn(`[mimir-onpage] progress update for job ${jobId} failed:`, e)
        }
      })

      await db.from('mimir_onpage_jobs').update({
        status:            result.ok ? 'completed' : 'failed',
        completed_steps:   dimensions.length,
        current_dimension: null,
        total_inserted:    result.total_inserted,
        total_deleted:     result.total_deleted,
        per_dimension:     result.per_dimension,
        completed_at:      new Date().toISOString(),
      }).eq('id', jobId)
    } catch (err) {
      await db.from('mimir_onpage_jobs').update({
        status:        'failed',
        error_message: err instanceof Error ? err.message : String(err),
        completed_at:  new Date().toISOString(),
      }).eq('id', jobId)
    }
  })

  return NextResponse.json({
    ok:           true,
    job_id:       jobId,
    page_count:   pages.length,
    dimensions,
    replace,
    poll_url:     `/api/mimir/onpage/learn/${jobId}`,
  })
}
