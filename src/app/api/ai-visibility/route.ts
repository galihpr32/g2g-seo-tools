import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * GET /api/ai-visibility
 *
 * Returns AI visibility data for the current workspace:
 *   - Latest weekly snapshots (overall + per-topic)
 *   - Active prompts list
 *   - Recent findings (last 7 days)
 *   - Trend (last 8 weeks of overall snapshot)
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const siteSlug = 'g2g'

  const eightWeeksAgo = new Date(Date.now() - 8 * 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const sevenDaysAgo  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [snapshotsRes, promptsRes, findingsRes, trendRes] = await Promise.all([
    db.from('ai_visibility_snapshots')
      .select('*')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .gte('week_starting', eightWeeksAgo)
      .order('week_starting', { ascending: false })
      .order('topic_slug',    { ascending: true }),

    db.from('ai_visibility_prompts')
      .select('id, prompt_text, category, topic_slug, auto_topic_slug, active, updated_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .order('category', { ascending: true })
      .order('updated_at', { ascending: false }),

    db.from('ai_visibility_findings')
      .select('id, prompt_id, llm_platform, brand_mentioned, brand_position, sentiment, competitors, parser_notes, observed_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .gte('observed_at', sevenDaysAgo)
      .order('observed_at', { ascending: false })
      .limit(200),

    db.from('ai_visibility_snapshots')
      .select('week_starting, visibility_score, mention_rate, avg_sentiment')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .is('topic_slug', null)
      .gte('week_starting', eightWeeksAgo)
      .order('week_starting', { ascending: true }),
  ])

  return NextResponse.json({
    snapshots: snapshotsRes.data ?? [],
    prompts:   promptsRes.data   ?? [],
    findings:  findingsRes.data  ?? [],
    trend:     trendRes.data     ?? [],
  })
}
