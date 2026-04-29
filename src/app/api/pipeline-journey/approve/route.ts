import { NextResponse }         from 'next/server'
import { createClient }         from '@/lib/supabase/server'
import { createServiceClient }  from '@/lib/supabase/service'
import { getEffectiveOwnerId }  from '@/lib/workspace'
import { generateAgentBrief }   from '@/lib/agents/brief-generator'
import { getSiteUrlForSlug, buildCategoryUrl } from '@/lib/agents/site-helpers'

/**
 * POST /api/pipeline-journey/approve
 *
 * Approves an opportunity for brief generation with one or more output types.
 * Creates one seo_content_briefs row per selected type, fires Bragi in the
 * background for each, and links the first brief back to opp.brief_id.
 *
 * Body: { oppId: string; outputTypes: string[] }
 * Valid types: 'new_page' | 'optimize_existing' | 'outreach' | 'blog_post'
 *
 * Returns: { briefIds: { [outputType]: briefId } }
 */

const VALID_OUTPUT_TYPES = ['new_page', 'optimize_existing', 'outreach', 'blog_post'] as const
type OutputType = typeof VALID_OUTPUT_TYPES[number]

function briefTypeFromOutputType(t: OutputType): string {
  if (t === 'optimize_existing') return 'on_page'
  if (t === 'outreach')          return 'outreach'
  if (t === 'blog_post')         return 'blog_post'
  return 'category_page'
}

function typeContext(t: OutputType, targetUrl: string): string {
  if (t === 'blog_post') {
    return (
      `Output type: blog_post. ` +
      `This brief is for an EXTERNAL BLOG POST / GUEST ARTICLE on a gaming editorial publication ` +
      `(e.g. GuruGamer, The Game Haus, Ten Ton Hammer, Teknoplay — NOT forums/Reddit/Kaskus). ` +
      `Format: full article 600-1200 words, written for a gaming audience that reads editorial content. ` +
      `Include a natural, contextual mention of and link to: ${targetUrl} ` +
      `using anchor text like "trusted marketplace", "buy from G2G", or similar — never promotional. ` +
      `The article must stand alone as genuinely useful gaming content. ` +
      `Use the Platforms KB entries for tone/format guidelines if available.`
    )
  }
  if (t === 'optimize_existing') {
    return `Output type: optimize_existing. Improve the existing page to recapture lost rankings. Focus on content gaps vs competitors, missing FAQs, and stronger commercial intent signals.`
  }
  if (t === 'outreach') {
    return `Output type: outreach. Brief for a concise link-building outreach pitch (not a full article). Surface the value proposition for a gaming site owner to naturally link to G2G.`
  }
  return `Output type: new_page. Create a new category/landing page targeting this keyword with strong commercial intent and gaming marketplace context.`
}

// ── Signal helpers ────────────────────────────────────────────────────────────

type HSignal = { page?: string; clicks_drop_pct?: number }
type LSignal = { keyword?: string; search_volume?: number; competitor_domain?: string }
type OSignal = { game_name?: string; search_volume?: number }

function pickKeyword(opp: { topic: string; loki_signals: LSignal[]; odin_signals: OSignal[] }): string {
  if (opp.loki_signals?.length) {
    const best = [...opp.loki_signals].sort((a, b) => (Number(b.search_volume) || 0) - (Number(a.search_volume) || 0))[0]
    if (best.keyword) return String(best.keyword)
  }
  if (opp.odin_signals?.length) {
    const best = [...opp.odin_signals].sort((a, b) => (Number(b.search_volume) || 0) - (Number(a.search_volume) || 0))[0]
    if (best.game_name) return String(best.game_name)
  }
  return opp.topic
}

function pickCompetitor(loki: LSignal[]): string | null {
  if (!loki?.length) return null
  const best = [...loki].sort((a, b) => (Number(b.search_volume) || 0) - (Number(a.search_volume) || 0))[0]
  return best.competitor_domain ? `https://${best.competitor_domain}` : null
}

function buildBaseContext(opp: {
  topic: string
  heimdall_signals: HSignal[]
  loki_signals:     LSignal[]
  odin_signals:     OSignal[]
}): string {
  const lines: (string | null)[] = [
    `Opportunity: "${opp.topic}"`,
    opp.heimdall_signals?.length
      ? `Heimdall drops: ${opp.heimdall_signals.slice(0, 3).map(s => `${s.page ?? '?'} (${s.clicks_drop_pct ? `-${Number(s.clicks_drop_pct).toFixed(0)}%` : 'drop'})`).join(', ')}`
      : null,
    opp.loki_signals?.length
      ? `Loki gaps: ${[...opp.loki_signals].sort((a, b) => (Number(b.search_volume)||0)-(Number(a.search_volume)||0)).slice(0, 5).map(s => `"${s.keyword}" (${Number(s.search_volume||0).toLocaleString()} SV)`).join('; ')}`
      : null,
    opp.odin_signals?.length
      ? `Odin trending: ${opp.odin_signals.slice(0, 3).map(s => `${s.game_name} (${Number(s.search_volume||0).toLocaleString()} SV)`).join(', ')}`
      : null,
  ]
  return lines.filter(Boolean).join('\n')
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await request.json() as { oppId?: string; outputTypes?: string[] }
  const { oppId, outputTypes } = body

  if (!oppId)   return NextResponse.json({ error: 'Missing oppId' }, { status: 400 })

  const validTypes = (outputTypes ?? [])
    .filter(t => VALID_OUTPUT_TYPES.includes(t as OutputType)) as OutputType[]
  if (!validTypes.length) return NextResponse.json({ error: 'No valid output types' }, { status: 400 })

  // ── Load opportunity ──────────────────────────────────────────────────────
  const { data: opp, error: oppErr } = await db
    .from('seo_opportunities')
    .select(`
      id, owner_user_id, site_slug, topic, topic_slug, target_url,
      output_type, status, total_sv,
      heimdall_signals, loki_signals, odin_signals
    `)
    .eq('id', oppId)
    .eq('owner_user_id', ownerId)
    .single()

  if (oppErr || !opp) return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 })

  const site          = await getSiteUrlForSlug(db, opp.site_slug ?? 'g2g')
  const keyword       = pickKeyword(opp as unknown as { topic: string; loki_signals: LSignal[]; odin_signals: OSignal[] })
  const basePageUrl   = opp.target_url ?? buildCategoryUrl(site.siteUrl, keyword)
  const competitorUrl = pickCompetitor((opp.loki_signals ?? []) as LSignal[])
  const baseCtx       = buildBaseContext(opp as unknown as { topic: string; heimdall_signals: HSignal[]; loki_signals: LSignal[]; odin_signals: OSignal[] })

  // ── Mark opp brief_queued with first output type ──────────────────────────
  await db
    .from('seo_opportunities')
    .update({
      status:      'brief_queued',
      output_type: validTypes[0],
      updated_at:  new Date().toISOString(),
    })
    .eq('id', oppId)

  // ── Create one brief per selected type ────────────────────────────────────
  const briefIds: Record<string, string> = {}

  for (const outputType of validTypes) {
    const briefType = briefTypeFromOutputType(outputType)
    const pageUrl   = outputType === 'optimize_existing' && opp.target_url
      ? opp.target_url
      : basePageUrl

    const notes = [
      baseCtx,
      competitorUrl ? `Top competitor reference: ${competitorUrl}` : null,
      typeContext(outputType, basePageUrl),
      // Tag for reverse-lookup in pipeline-journey route
      `Queued from Opportunity: "${opp.topic}" (${oppId})`,
    ].filter(Boolean).join('\n')

    const { data: newBrief, error: insertErr } = await db
      .from('seo_content_briefs')
      .insert({
        owner_user_id:   ownerId,
        site_url:        site.siteUrl,
        page:            pageUrl,
        brief_type:      briefType,
        primary_keyword: keyword,
        status:          'draft',
        notes,
      })
      .select('id')
      .single()

    if (insertErr || !newBrief) {
      console.error(`[pipeline/approve] insert failed for ${outputType}:`, insertErr)
      continue
    }

    briefIds[outputType] = newBrief.id
    const briefId = newBrief.id
    const isFirst = outputType === validTypes[0]

    // Link primary brief to opp
    if (isFirst) {
      await db
        .from('seo_opportunities')
        .update({ brief_id: briefId, updated_at: new Date().toISOString() })
        .eq('id', oppId)
    }

    // Fire generation in background — don't await
    generateAgentBrief({
      briefId,
      ownerId,
      keyword,
      pageUrl,
      briefType,
      searchVolume:  opp.total_sv || undefined,
      competitorUrl: competitorUrl ?? undefined,
      notes,
    })
      .then(() => {
        if (isFirst) {
          db.from('seo_opportunities')
            .update({ status: 'brief_ready', updated_at: new Date().toISOString() })
            .eq('id', oppId)
            .then(() => {})
        }
      })
      .catch(err => console.error(`[pipeline/approve] generation failed for ${outputType}:`, err))
  }

  return NextResponse.json({ briefIds })
}
