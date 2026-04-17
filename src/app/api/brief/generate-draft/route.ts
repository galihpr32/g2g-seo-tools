import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
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
  draft_status?: 'generating'
}

// POST /api/brief/generate-draft
// Body: { brief_id, content_type, idea_index }
// idea_index = position within the content_type group (0 = first blog idea, 1 = second, etc.)
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { brief_id, content_type, idea_index } = await request.json() as {
    brief_id: string
    content_type: string
    idea_index: number
  }

  if (!brief_id || !content_type) {
    return NextResponse.json({ error: 'Missing brief_id or content_type' }, { status: 400 })
  }

  // Load brief (with user-scoped client — RLS protects it)
  const { data: brief } = await supabase
    .from('seo_content_briefs')
    .select('id, page, primary_keyword, topic, content_ideas')
    .eq('id', brief_id)
    .single()

  if (!brief) return NextResponse.json({ error: 'Brief not found' }, { status: 404 })

  const allIdeas = (brief.content_ideas ?? []) as ContentIdea[]

  // Find the target idea: nth idea of the given content_type
  const typeIdeas = allIdeas.filter(i => i.content_type === content_type)
  const idx = idea_index ?? 0
  const targetIdea = typeIdeas[idx]

  if (!targetIdea) return NextResponse.json({ error: 'Idea not found' }, { status: 404 })

  // Mark the idea as generating in DB
  const updatedIdeas = allIdeas.map(idea => {
    if (idea === targetIdea) return { ...idea, draft_status: 'generating' as const }
    return idea
  })

  await supabase
    .from('seo_content_briefs')
    .update({ content_ideas: updatedIdeas })
    .eq('id', brief_id)

  // Run draft generation in background (keeps function alive after response)
  after(
    runDraftGeneration(brief_id, brief.page, brief.primary_keyword, targetIdea, content_type)
      .catch(err => console.error('Draft generation error:', err))
  )

  return NextResponse.json({ ok: true, status: 'generating' })
}

async function runDraftGeneration(
  briefId: string,
  page: string,
  primaryKeyword: string,
  idea: ContentIdea,
  contentType: string
) {
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const supabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  try {
    const prompt = buildDraftPrompt(idea, contentType, page, primaryKeyword)

    const aiResponse = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    })

    const draft = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : ''

    // Load current ideas fresh from DB (other ideas may have changed)
    const { data: brief } = await supabase
      .from('seo_content_briefs')
      .select('content_ideas')
      .eq('id', briefId)
      .single()

    const currentIdeas = (brief?.content_ideas ?? []) as ContentIdea[]

    // Find and update the right idea (match by title + content_type since order can shift)
    let matched = false
    const finalIdeas = currentIdeas.map(i => {
      if (!matched && i.content_type === contentType && i.title === idea.title) {
        matched = true
        return { ...i, draft, draft_status: undefined }
      }
      return i
    })

    await supabase
      .from('seo_content_briefs')
      .update({ content_ideas: finalIdeas })
      .eq('id', briefId)

  } catch (err) {
    console.error('Draft generation failed:', err)
    // Clear the generating state on failure
    const { data: brief } = await supabase
      .from('seo_content_briefs')
      .select('content_ideas')
      .eq('id', briefId)
      .single()

    const currentIdeas = (brief?.content_ideas ?? []) as ContentIdea[]
    const clearedIdeas = currentIdeas.map(i =>
      i.content_type === contentType && i.title === idea.title
        ? { ...i, draft_status: undefined }
        : i
    )
    await supabase.from('seo_content_briefs').update({ content_ideas: clearedIdeas }).eq('id', briefId)
  }
}

function buildDraftPrompt(idea: ContentIdea, contentType: string, page: string, keyword: string): string {
  const base = `
Idea title: ${idea.title}
Angle: ${idea.notes || '(see title)'}
Target keyword: ${idea.target_keyword || keyword}
Platform: ${idea.platform}
Target page to link back to: ${page}

Write ONLY the finished content — no preamble, no "here is the draft" intro. Start directly.`

  if (contentType === 'blog_post') {
    return `You are an expert SEO content writer for G2G.com, a gaming marketplace. Write a complete, publish-ready blog article (600-900 words) for the following idea:
${base}

Requirements:
- Use markdown (# H1, ## H2, **bold**)
- Mention and link to ${page} naturally near the end
- Target the keyword "${idea.target_keyword || keyword}" without stuffing
- Write for a gaming audience — practical, engaging tone`
  }

  if (contentType === 'forum') {
    return `You are writing on behalf of a G2G.com user. Write a complete Reddit post or forum thread (300-500 words) for the following idea:
${base}

Requirements:
- Sound natural and community-oriented — not promotional
- Include a relevant, natural mention and link to ${page}
- Provide genuine value to the forum community
- Use Reddit markdown (## for sections, **bold**, bullet lists)`
  }

  if (contentType === 'social') {
    return `You are a social media content creator for G2G.com. Write complete social media content for the following idea:
${base}

Requirements:
- Match the format for ${idea.platform}
- If Twitter/X: write a numbered thread (1/, 2/, etc.)
- If TikTok: write a script with [visual cues]
- If Instagram: write caption + 10-15 hashtags
- Include a natural reference to ${page}
- Keep it engaging and platform-native`
  }

  return `Write a complete content draft (400-600 words) for this idea:
${base}
Include a natural reference to ${page}.`
}
