import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 30

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

/**
 * POST /api/site-health/summary
 *
 * Compiles latest schema-health + PSI + technical action items + index
 * coverage into a single Sonnet narrative summary for the Asst Manager
 * (Workflow #3 step 3.8). Output: 2-3 paragraph monthly tech health
 * summary, ready to paste into the monthly report or share with dev.
 *
 * No persistence — generated on-demand. Cheap (~$0.02/call).
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const body     = await req.json().catch(() => ({}))
  const siteSlug = resolveSiteSlugFromRequest(req, body)
  const db       = createServiceClient()

  // Pull latest snapshots in parallel
  const [schemaRes, psiRes, actionsRes] = await Promise.all([
    db.from('schema_health_snapshots')
      .select('page_url, validity_score, has_jsonld, schema_types, validation_errors, snapshot_date')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .gte('snapshot_date', new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0])
      .order('snapshot_date', { ascending: false })
      .limit(60),
    db.from('psi_snapshots')
      .select('page_url, performance, accessibility, best_practices, seo, lcp_ms, inp_ms, cls, cwv_passed, top_issues, snapshot_date')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .gte('snapshot_date', new Date(Date.now() - 60 * 86400_000).toISOString().split('T')[0])
      .order('snapshot_date', { ascending: false })
      .limit(60),
    db.from('seo_action_items')
      .select('id, title, action_type, status, priority, created_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .ilike('action_type', '%fix%')                         // fuzzy match technical action types
      .neq('status', 'done')
      .order('created_at', { ascending: false })
      .limit(30),
  ])

  // Dedup snapshots: latest per page
  const latestSchema = new Map<string, NonNullable<typeof schemaRes.data>[number]>()
  for (const s of schemaRes.data ?? []) if (!latestSchema.has(String(s.page_url))) latestSchema.set(String(s.page_url), s)
  const latestPsi = new Map<string, NonNullable<typeof psiRes.data>[number]>()
  for (const s of psiRes.data ?? []) if (!latestPsi.has(String(s.page_url))) latestPsi.set(String(s.page_url), s)

  const schemaArr  = Array.from(latestSchema.values())
  const psiArr     = Array.from(latestPsi.values())
  const openTech   = actionsRes.data ?? []

  // Stats
  const schemaStats = {
    total:    schemaArr.length,
    broken:   schemaArr.filter(s => (s.validity_score ?? 100) < 70).length,
    no_jsonld: schemaArr.filter(s => !s.has_jsonld).length,
  }
  const psiStats = {
    total:        psiArr.length,
    cwv_pass:     psiArr.filter(s => s.cwv_passed === true).length,
    cwv_fail:     psiArr.filter(s => s.cwv_passed === false).length,
    median_perf:  psiArr.length > 0
      ? [...psiArr].map(s => s.performance ?? 0).sort((a, b) => a - b)[Math.floor(psiArr.length / 2)]
      : null,
  }
  const actionStats = {
    total_open: openTech.length,
    high:       openTech.filter(a => a.priority === 'high').length,
    aged_14d:   openTech.filter(a => (Date.now() - new Date(a.created_at).getTime()) / 86400_000 > 14).length,
  }

  // Build prompt
  const prompt = `You are MIMIR drafting a TECHNICAL SEO health summary for an Asst Manager + Head. The data:

SCHEMA HEALTH (last 30d, ${schemaStats.total} pages tracked):
- Pages with validity score <70: ${schemaStats.broken}
- Pages with no JSON-LD at all: ${schemaStats.no_jsonld}
- Top issues found: ${(schemaArr.flatMap(s => s.validation_errors ?? []).slice(0, 5)).join(' / ') || 'none recorded'}

PAGESPEED INSIGHTS (last 60d, ${psiStats.total} pages tested, mobile):
- Median performance score: ${psiStats.median_perf != null ? psiStats.median_perf + '/100' : 'n/a'}
- Core Web Vitals pass: ${psiStats.cwv_pass}, fail: ${psiStats.cwv_fail}
- Worst performers: ${psiArr.slice(0, 3).map(p => `${p.page_url.replace(/^https?:\/\/[^/]+/, '')} (perf ${p.performance}, LCP ${p.lcp_ms}ms)`).join(', ') || 'n/a'}

OPEN TECHNICAL ACTION ITEMS:
- Total open: ${actionStats.total_open}
- High priority: ${actionStats.high}
- Aged >14 days (stale): ${actionStats.aged_14d}

OUTPUT FORMAT — markdown, EXACTLY this shape:

**Technical SEO Health Summary**

📊 **Current state:**
[1 paragraph, 3-5 sentences. Cite specific numbers from above.]

🔥 **Most urgent:**
[bullet list — 2-4 specific items the dev team should ship this month, ordered by impact. Each cites a concrete page or pattern.]

🧰 **Maintenance items:**
[bullet list — 2-3 background items to keep moving but not urgent.]

RULES:
- Be specific. Cite numbers + page paths.
- DO NOT generic "improve performance" — name THE pages and THE metrics.
- If everything looks fine, say so plainly.
- Total length ~150-220 words.`

  try {
    const res = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 900,
      messages:   [{ role: 'user', content: prompt }],
    })
    const text = res.content[0]?.type === 'text' ? res.content[0].text.trim() : ''

    return NextResponse.json({
      ok:    true,
      summary: text,
      stats: { schema: schemaStats, psi: psiStats, actions: actionStats },
    })
  } catch (err) {
    return NextResponse.json({
      ok:    false,
      error: `Sonnet error: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 502 })
  }
}
