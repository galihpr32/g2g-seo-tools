import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getKeywordSuggestions } from '@/lib/dataforseo/client'
import Anthropic from '@anthropic-ai/sdk'
import { logApiUsage } from '@/lib/api-logger'

export const maxDuration = 120

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// POST /api/content/studio/generate
// Body: { draft_id?, topic, game_name?, content_type, tone, language, target_audience?,
//         word_count, target_keywords, image_urls?, custom_instructions? }
// Returns: { draft_id, content, meta_title, meta_description }
export async function POST(req: Request) {
  const supabase   = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json() as {
    draft_id?:            string
    topic:                string
    game_name?:           string
    content_type:         string
    tone:                 string
    language:             string
    target_audience?:     string
    word_count:           number
    target_keywords:      string[]
    image_urls?:          string[]
    custom_instructions?: string
    // Tema 3 — KB integration. When set, the brand context + matched
    // category context + selected platform's house rules are loaded from
    // knowledge_base_items and injected into the prompt.
    platform_id?:         string | null
  }

  const {
    draft_id, topic, game_name, content_type, tone, language,
    target_audience, word_count, target_keywords, image_urls = [],
    custom_instructions, platform_id,
  } = body

  if (!topic) return NextResponse.json({ error: 'Missing topic' }, { status: 400 })

  // ── Load KB context (brand + matched category + selected platform) ────────
  // Mirrors the KB injection pattern in lib/agents/brief-generator.ts so
  // Content Studio output is consistent with Bragi briefs.
  interface KBItemRow { id: string; category: string; name: string; data: Record<string, unknown> }
  const { data: kbRows } = await db
    .from('knowledge_base_items')
    .select('id, category, name, data')
    .eq('owner_user_id', ownerId)

  const kbItems: KBItemRow[] = (kbRows ?? []) as KBItemRow[]
  const brand    = kbItems.find(i => i.category === 'brand')
  const usps     = kbItems.filter(i => i.category === 'usp')
  const platform = platform_id ? kbItems.find(i => i.category === 'platform' && i.id === platform_id) : null

  // Best-effort category match: token overlap between topic and category names.
  const topicTokens = topic.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3)
  const matchedCategory = (() => {
    const candidates = kbItems.filter(i => i.category === 'category')
    let best: { item: KBItemRow; score: number } | null = null
    for (const c of candidates) {
      const nameTokens = c.name.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3)
      const overlap    = nameTokens.filter(t => topicTokens.includes(t)).length
      if (overlap >= 1 && (!best || overlap > best.score)) best = { item: c, score: overlap }
    }
    return best?.item ?? null
  })()

  const kbBlocks: string[] = []
  if (brand?.data) {
    const b = brand.data as { tone?: string; audience?: string; dos?: string[]; donts?: string[] }
    const lines = [
      'BRAND CONTEXT:',
      b.tone     ? `Tone: ${b.tone}`         : '',
      b.audience ? `Audience: ${b.audience}` : '',
      b.dos?.length   ? `DOs: ${b.dos.join('; ')}`     : '',
      b.donts?.length ? `DON'Ts: ${b.donts.join('; ')}` : '',
    ].filter(Boolean)
    if (lines.length > 1) kbBlocks.push(lines.join('\n'))
  }
  if (matchedCategory?.data) {
    const c = matchedCategory.data as { description?: string; angle?: string }
    const lines = [
      `CATEGORY CONTEXT — ${matchedCategory.name}:`,
      c.description ? `Description: ${c.description}` : '',
      c.angle       ? `Content angle: ${c.angle}`     : '',
    ].filter(Boolean)
    if (lines.length > 1) kbBlocks.push(lines.join('\n'))
  }
  if (usps.length) {
    const lines = [
      'UNIQUE SELLING POINTS (mention naturally where they fit):',
      ...usps.map(u => {
        const d = u.data as { description?: string }
        return `- ${u.name}${d.description ? `: ${d.description}` : ''}`
      }),
    ]
    kbBlocks.push(lines.join('\n'))
  }
  if (platform?.data) {
    const p = platform.data as { tone?: string; format?: string; guidelines?: string; examples?: string; notes?: string }
    const lines = [
      `PLATFORM TARGET — ${platform.name} (apply these house rules):`,
      p.tone       ? `Tone: ${p.tone}`             : '',
      p.format     ? `Format: ${p.format}`         : '',
      p.guidelines ? `Guidelines: ${p.guidelines}` : '',
      p.examples   ? `Examples: ${p.examples}`     : '',
      p.notes      ? `Notes: ${p.notes}`           : '',
    ].filter(Boolean)
    if (lines.length > 1) kbBlocks.push(lines.join('\n'))
  }
  const kbBlock = kbBlocks.length ? `\n---\n${kbBlocks.join('\n\n')}\n---\n` : ''

  // ── Content type config ────────────────────────────────────────────────────
  const typeDescriptions: Record<string, string> = {
    blog_post:     'a detailed blog post / article for the G2G blog or content marketing',
    landing_page:  'a product landing page with clear value propositions and CTAs for G2G',
    category_page: 'an SEO-optimised category/listing page for G2G marketplace',
    guide:         'a comprehensive how-to guide or tutorial',
    listicle:      'a listicle (list-based article) covering top options or tips',
  }

  const toneDescriptions: Record<string, string> = {
    informative:  'clear, educational, and factual — like a knowledgeable friend explaining something',
    persuasive:   'compelling and conversion-focused — highlights benefits, creates urgency',
    casual:       'friendly, approachable, and conversational — like talking to a gamer friend',
    professional: 'authoritative and polished — suitable for business or tech audiences',
  }

  const contentTypeDesc = typeDescriptions[content_type] ?? content_type
  const toneDesc        = toneDescriptions[tone]         ?? tone

  // ── Build prompt ───────────────────────────────────────────────────────────
  const imageSection = image_urls.length > 0
    ? `\nImages to include in the content (use markdown image syntax with these URLs):\n${image_urls.map((url, i) => `- Image ${i + 1}: ${url}`).join('\n')}\n`
    : ''

  const prompt = `You are an expert SEO content writer for G2G, a leading gaming marketplace that sells in-game items, currencies, gift cards, and top-ups (Robux, V-Bucks, Free Fire diamonds, game accounts, etc.).

Write ${contentTypeDesc} about: "${topic}"${game_name ? ` (Game: ${game_name})` : ''}

REQUIREMENTS:
- Language: ${language === 'en' ? 'English' : language === 'id' ? 'Indonesian (Bahasa Indonesia)' : language}
- Tone: ${toneDesc}
- Target length: approximately ${word_count} words
- Target audience: ${target_audience || 'gamers interested in purchasing in-game items'}
- Target keywords to naturally include: ${target_keywords.length > 0 ? target_keywords.join(', ') : 'none specified'}
${imageSection}
${custom_instructions ? `\nAdditional instructions from the writer:\n${custom_instructions}\n` : ''}
${kbBlock}
SEO RULES:
- Use the primary keyword (first in the list) in: the H1 title, first paragraph, at least one H2, and meta title
- Distribute secondary keywords naturally throughout
- Include internal link opportunities (use placeholder text like "[Link: G2G category page for X]")
- Write for featured snippet capture where relevant (short, direct answers to likely questions)

OUTPUT FORMAT:
Return a JSON object with these fields:
{
  "title": "SEO-optimised H1 title",
  "meta_title": "Meta title (50-60 chars)",
  "meta_description": "Meta description (150-160 chars)",
  "content": "Full markdown content starting with # [title]\\n\\n..."
}

The content field should be complete, publish-ready markdown. Use proper heading hierarchy (# H1, ## H2, ### H3). Include a compelling introduction, well-structured body sections, and a clear conclusion/CTA.`

  // ── Create / update draft record ───────────────────────────────────────────
  let savedDraftId = draft_id
  if (!savedDraftId) {
    const { data: draft, error: insertErr } = await db
      .from('content_studio_drafts')
      .insert({
        owner_user_id: ownerId,
        title:         topic,
        topic,
        game_name:     game_name ?? null,
        content_type,
        tone,
        language,
        target_audience: target_audience ?? null,
        word_count,
        target_keywords,
        image_urls,
        status:        'generating',
      })
      .select('id')
      .single()
    if (insertErr) console.warn('[studio/generate] draft insert failed:', insertErr.message)
    else savedDraftId = draft?.id
  } else {
    await db
      .from('content_studio_drafts')
      .update({ status: 'generating', updated_at: new Date().toISOString() })
      .eq('id', savedDraftId)
  }

  // ── Generate with Claude ───────────────────────────────────────────────────
  try {
    const msg = await anthropic.messages.create({
      model:      'claude-opus-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    })

    logApiUsage(supabase, ownerId, { api: 'claude', endpoint: 'content_studio_generate', triggeredBy: 'brief_generate', callCount: 1 })

    const raw = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : ''
    const jsonStr = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim()

    let parsed: { title?: string; meta_title?: string; meta_description?: string; content?: string }
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      // Fallback: treat entire response as content
      parsed = { content: raw, title: topic, meta_title: topic, meta_description: '' }
    }

    const { title, meta_title, meta_description, content } = parsed

    // ── Update draft ─────────────────────────────────────────────────────────
    if (savedDraftId) {
      await db
        .from('content_studio_drafts')
        .update({
          title:           title ?? topic,
          content:         content ?? '',
          meta_title:      meta_title ?? '',
          meta_description: meta_description ?? '',
          status:          'done',
          updated_at:      new Date().toISOString(),
        })
        .eq('id', savedDraftId)
    }

    return NextResponse.json({
      draft_id:        savedDraftId,
      title,
      meta_title,
      meta_description,
      content,
    })
  } catch (e) {
    if (savedDraftId) {
      await db
        .from('content_studio_drafts')
        .update({ status: 'draft', updated_at: new Date().toISOString() })
        .eq('id', savedDraftId)
    }
    console.error('[studio/generate] error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
