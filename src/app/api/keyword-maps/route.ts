import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getKeywordSuggestions, getBulkKeywordDifficulty } from '@/lib/dataforseo/client'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function getSiteSlug(req: Request): string {
  const url = new URL(req.url)
  const cookieSite = req.headers.get('cookie')?.match(/active-site=([^;]+)/)?.[1] ?? 'g2g'
  return url.searchParams.get('site') ?? cookieSite
}

// ── GET — list all maps for the active site ───────────────────────────────────
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = getSiteSlug(req)
  const db = createServiceClient()

  const { data: maps } = await db
    .from('keyword_maps')
    .select('*, keyword_map_clusters(count)')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('created_at', { ascending: false })

  return NextResponse.json({ maps: maps ?? [] })
}

// ── POST — create a new map + AI-generate clusters ───────────────────────────
// Body: { topic, market?, seed_keywords?, add_cluster?, site? }
// add_cluster: { keyword, volume?, source?, source_ref_id? }
//   → adds a single keyword to an existing or new map (from Trends/Gap/manual)
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = getSiteSlug(req)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({}))
  const {
    topic,
    market    = 'us',
    seed_keywords,
    add_cluster,         // { keyword, volume?, difficulty?, source, source_ref_id, map_id }
  } = body as {
    topic?:        string
    market?:       string
    seed_keywords?: string[]
    add_cluster?:  { keyword: string; volume?: number; difficulty?: number; source?: string; source_ref_id?: string; map_id?: string }
  }

  // ── Mode A: add a single keyword to an existing map ──────────────────────
  if (add_cluster?.map_id) {
    const { keyword, volume, difficulty, source = 'manual', source_ref_id } = add_cluster

    // Fetch difficulty if not provided
    let kd = difficulty
    if (kd == null) {
      const diff = await getBulkKeywordDifficulty([keyword], market === 'id' ? 2360 : 2840, market === 'id' ? 'id' : 'en')
      kd = diff[keyword] ?? null
    }

    const { data: cluster, error } = await db
      .from('keyword_map_clusters')
      .insert({
        map_id:        add_cluster.map_id,
        owner_user_id: ownerId,
        keyword,
        search_volume: volume ?? null,
        difficulty:    kd ?? null,
        source,
        source_ref_id: source_ref_id ?? null,
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'Keyword already exists in this map' }, { status: 409 })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ cluster })
  }

  // ── Mode B: generate a full new map ──────────────────────────────────────
  if (!topic) return NextResponse.json({ error: 'topic is required' }, { status: 400 })

  const topicSlug   = slugify(topic)
  const locationCode = market === 'id' ? 2360 : 2840
  const languageCode = market === 'id' ? 'id' : 'en'

  // Check if map with same slug exists for this site
  const { data: existing } = await db
    .from('keyword_maps')
    .select('id')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('topic_slug', topicSlug)
    .maybeSingle()

  if (existing) return NextResponse.json({ error: `A map for "${topic}" already exists.`, existing_id: existing.id }, { status: 409 })

  // 1. Keyword suggestions from DataForSEO
  const seeds = seed_keywords?.length ? seed_keywords : [topic]
  let suggestions = await getKeywordSuggestions(seeds[0], locationCode, languageCode, 40)
  suggestions = suggestions.filter(s => s.search_volume && s.search_volume > 0).slice(0, 30)

  if (!suggestions.length) suggestions = [{ keyword: topic, search_volume: null, cpc: null, competition: null, keyword_difficulty: null }]

  // 2. Bulk difficulty
  const kwList    = suggestions.map(s => s.keyword)
  const diffMap   = await getBulkKeywordDifficulty(kwList, locationCode, languageCode)

  const enriched  = suggestions.map(s => ({
    keyword:    s.keyword,
    volume:     s.search_volume ?? 0,
    difficulty: diffMap[s.keyword] ?? null,
  }))

  // 3. Claude organizes into pillar + clusters
  const marketLabel = market === 'id' ? 'Indonesia' : 'United States'
  const kwLines = enriched.map(k => `- "${k.keyword}" (vol: ${k.volume?.toLocaleString() ?? 'n/a'}, difficulty: ${k.difficulty ?? 'n/a'})`).join('\n')

  const organizationPrompt = `You are an SEO strategist organizing a topic cluster for G2G.com — a gaming marketplace.

Topic: "${topic}"
Market: ${marketLabel}
G2G context: sells in-game items, currencies (diamonds, gold, coins), gift cards, accounts, boosts.

Keywords to organize:
${kwLines}

Create an optimal topic cluster. Return ONLY valid JSON matching this exact structure:
{
  "pillar": {
    "keyword": "...",
    "suggested_title": "...",
    "url_slug": "..."
  },
  "clusters": [
    {
      "group": "Group name (e.g. Price & Buying, Guides & How-To, Account & Services)",
      "keywords": [
        {
          "keyword": "...",
          "content_type": "landing_page|guide|comparison|faq",
          "intent": "commercial|informational|transactional|navigational",
          "suggested_title": "...",
          "url_slug": "...",
          "priority_order": 1
        }
      ]
    }
  ],
  "priority_note": "Short note on content writing order and why",
  "linking_note": "Internal linking strategy (1-2 sentences)",
  "estimated_authority_weeks": 12
}

Rules:
- Pillar = highest commercial intent + solid search volume (the main "buy X" or core category keyword)
- Group clusters by semantic sub-topic (3-5 groups, 2-6 keywords each)
- Priority order: lower difficulty clusters first to build topical authority before tackling hard keywords
- landing_page for commercial/transactional, guide for informational, faq for question-based, comparison for versus/alternative
- Only use keywords from the list provided`

  let aiNotes = { priority_note: '', linking_note: '', estimated_authority_weeks: 12 }
  let pillarKw = ''
  let pillarTitle = ''
  let pillarSlug  = ''
  const clusterRows: {
    keyword: string; volume: number | null; difficulty: number | null
    intent: string; content_type: string; cluster_group: string
    suggested_title: string; url_slug: string; priority_order: number; is_pillar: boolean
  }[] = []

  try {
    const msg = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2000,
      messages:   [{ role: 'user', content: organizationPrompt }],
    })
    const raw   = msg.content[0]?.type === 'text' ? msg.content[0].text : '{}'
    const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}'
    const parsed  = JSON.parse(jsonStr)

    pillarKw    = parsed.pillar?.keyword ?? seeds[0]
    pillarTitle = parsed.pillar?.suggested_title ?? topic
    pillarSlug  = parsed.pillar?.url_slug ?? slugify(pillarKw)

    aiNotes = {
      priority_note:            parsed.priority_note ?? '',
      linking_note:             parsed.linking_note ?? '',
      estimated_authority_weeks: parsed.estimated_authority_weeks ?? 12,
    }

    // Pillar cluster row
    const pillarEnriched = enriched.find(e => e.keyword === pillarKw) ?? { keyword: pillarKw, volume: null, difficulty: null }
    clusterRows.push({
      keyword:        pillarKw,
      volume:         pillarEnriched.volume,
      difficulty:     pillarEnriched.difficulty,
      intent:         'commercial',
      content_type:   'landing_page',
      cluster_group:  'Pillar',
      suggested_title: pillarTitle,
      url_slug:       pillarSlug,
      priority_order: 0,
      is_pillar:      true,
    })

    // Cluster rows
    let orderCounter = 1
    for (const group of parsed.clusters ?? []) {
      for (const kw of group.keywords ?? []) {
        if (kw.keyword === pillarKw) continue
        const enrichedKw = enriched.find(e => e.keyword === kw.keyword)
        clusterRows.push({
          keyword:        kw.keyword,
          volume:         enrichedKw?.volume ?? null,
          difficulty:     enrichedKw?.difficulty ?? null,
          intent:         kw.intent ?? 'informational',
          content_type:   kw.content_type ?? 'guide',
          cluster_group:  group.group ?? 'General',
          suggested_title: kw.suggested_title ?? kw.keyword,
          url_slug:       kw.url_slug ?? slugify(kw.keyword),
          priority_order: kw.priority_order ?? orderCounter++,
          is_pillar:      false,
        })
      }
    }
  } catch {
    // Fallback: use all suggestions without AI organization
    pillarKw    = enriched[0]?.keyword ?? topic
    pillarTitle = topic
    pillarSlug  = slugify(pillarKw)
    enriched.forEach((k, i) => clusterRows.push({
      keyword:        k.keyword,
      volume:         k.volume,
      difficulty:     k.difficulty,
      intent:         'commercial',
      content_type:   'landing_page',
      cluster_group:  'General',
      suggested_title: k.keyword,
      url_slug:       slugify(k.keyword),
      priority_order: i,
      is_pillar:      i === 0,
    }))
  }

  // 4. Save map + clusters
  const { data: map, error: mapErr } = await db
    .from('keyword_maps')
    .insert({
      owner_user_id:  ownerId,
      site_slug:      siteSlug,
      topic,
      topic_slug:     topicSlug,
      market,
      pillar_keyword: pillarKw,
      pillar_title:   pillarTitle,
      pillar_url_slug: pillarSlug,
      ai_notes:       aiNotes,
    })
    .select()
    .single()

  if (mapErr || !map) return NextResponse.json({ error: mapErr?.message ?? 'Map creation failed' }, { status: 500 })

  // Insert clusters in bulk
  if (clusterRows.length) {
    await db.from('keyword_map_clusters').insert(
      clusterRows.map(c => ({ ...c, map_id: map.id, owner_user_id: ownerId }))
    )
  }

  // Return full map with clusters
  const { data: clusters } = await db
    .from('keyword_map_clusters')
    .select('*')
    .eq('map_id', map.id)
    .order('priority_order')

  return NextResponse.json({ map, clusters: clusters ?? [] })
}
