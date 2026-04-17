import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getKeywordSuggestions, batchSerpData } from '@/lib/dataforseo/client'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

type ContentIdea = {
  content_type: string
  title: string
  platform: string
  target_keyword: string
  notes: string
  draft?: string
  draft_status?: string
}

// POST /api/brief/add-ideas
// Body: { brief_id, content_type, count }
// Appends `count` new ideas of `content_type` to an existing off-page brief
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { brief_id, content_type, count } = await request.json() as {
    brief_id: string
    content_type: 'blog_post' | 'forum' | 'social'
    count: number
  }

  if (!brief_id || !content_type || !count) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const { data: brief } = await supabase
    .from('seo_content_briefs')
    .select('*')
    .eq('id', brief_id)
    .single()

  if (!brief) return NextResponse.json({ error: 'Brief not found' }, { status: 404 })

  // Run idea generation in background
  after(
    runAddIdeas(brief_id, brief, content_type, Math.min(count, 5))
      .catch(err => console.error('Add ideas error:', err))
  )

  return NextResponse.json({ ok: true, status: 'generating' })
}

async function runAddIdeas(
  briefId: string,
  brief: any,
  contentType: 'blog_post' | 'forum' | 'social',
  count: number
) {
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const supabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  try {
    // Get fresh SERP data for context
    const primaryKeyword = brief.primary_keyword ?? ''
    const kwSuggestions = await getKeywordSuggestions(primaryKeyword).catch(() => [])
    const serpData = await batchSerpData([primaryKeyword]).catch(() => ({
      organicResults: [], peopleAlsoAsk: [], relatedSearches: []
    }))

    const existingIdeas = (brief.content_ideas ?? []) as ContentIdea[]
    const existingOfType = existingIdeas.filter(i => i.content_type === contentType)
    const existingTitles = existingOfType.map(i => i.title).join(', ')

    const TYPE_LABELS: Record<string, string> = {
      blog_post: 'blog post or long-form article',
      forum: 'Reddit or gaming forum post',
      social: 'social media content (Twitter/X, TikTok, or Instagram)',
    }
    const PLATFORMS: Record<string, string> = {
      blog_post: 'Blog / Medium / Gaming publication',
      forum: 'Reddit r/gaming / Discord / GameFAQs',
      social: 'Twitter/X / TikTok / Instagram',
    }

    const prompt = `You are an SEO content strategist for G2G.com, a gaming marketplace. Generate ${count} NEW ${TYPE_LABELS[contentType]} idea${count > 1 ? 's' : ''} to support this target page:

TARGET PAGE: ${brief.page}
PRIMARY KEYWORD: ${primaryKeyword}
TOPIC: ${brief.topic ?? primaryKeyword}

${existingTitles ? `ALREADY EXISTING IDEAS (do NOT repeat these):
${existingTitles}` : ''}

SERP CONTEXT:
${serpData.peopleAlsoAsk.slice(0, 5).map((q: any) => `- ${q.question}`).join('\n')}

KEYWORD IDEAS:
${kwSuggestions.slice(0, 10).map((k: any) => `- "${k.keyword}" | vol: ${k.search_volume ?? '?'}`).join('\n')}

For each new idea, use EXACTLY this format:
- Title: [idea title]
- Angle: [unique hook or angle — different from existing ideas]
- Target keyword: [1 keyword]
- Platform: [${PLATFORMS[contentType]}]
- Why: [1 sentence on SEO value]

Generate exactly ${count} new idea${count > 1 ? 's' : ''} now. Start directly with "- Title:".`

    const aiResponse = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    })

    const rawText = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : ''

    // Parse new ideas
    const blocks = rawText.split(/\n(?=-\s*Title:)/i).filter(Boolean)
    const newIdeas: ContentIdea[] = blocks.map((block: string) => {
      const titleMatch    = block.match(/Title:\s*(.+)/i)
      const platformMatch = block.match(/Platform:\s*(.+)/i)
      const kwMatch       = block.match(/Target keyword:\s*(.+)/i)
      const angleMatch    = block.match(/Angle:\s*(.+)/i)
      const whyMatch      = block.match(/Why:\s*(.+)/i)
      return {
        content_type: contentType,
        title: titleMatch?.[1]?.trim() ?? '',
        platform: platformMatch?.[1]?.trim() ?? '',
        target_keyword: kwMatch?.[1]?.trim() ?? '',
        notes: [angleMatch?.[1]?.trim(), whyMatch?.[1]?.trim()].filter(Boolean).join(' | '),
      }
    }).filter((i: ContentIdea) => i.title)

    // Load fresh content_ideas from DB (may have changed while generating)
    const { data: freshBrief } = await supabase
      .from('seo_content_briefs')
      .select('content_ideas')
      .eq('id', briefId)
      .single()

    const currentIdeas = (freshBrief?.content_ideas ?? []) as ContentIdea[]

    await supabase
      .from('seo_content_briefs')
      .update({ content_ideas: [...currentIdeas, ...newIdeas] })
      .eq('id', briefId)

  } catch (err) {
    console.error('Add ideas pipeline failed:', err)
  }
}
