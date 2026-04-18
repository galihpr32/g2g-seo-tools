import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 30

// ── POST /api/knowledge-base/suggest ─────────────────────────────────────────
// Body: { type: 'brand' | 'category' | 'platform', name?: string, site_url?: string }
// Returns suggested data fields for the given KB item type.
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json() as {
    type: 'brand' | 'category' | 'platform'
    name?: string
    site_url?: string
  }

  const client = new Anthropic()

  let prompt = ''

  if (body.type === 'brand') {
    const siteUrl = body.site_url ?? 'https://www.g2g.com'
    prompt = `You are an SEO content strategist. Analyze the brand at ${siteUrl} and suggest knowledge base fields for AI content generation.

Return a JSON object with these exact keys:
{
  "tone": "1-2 sentence description of the brand tone of voice (e.g. casual, trustworthy, gamer-friendly)",
  "audience": "1-2 sentence description of target audience",
  "dos": ["list of 4-6 things to DO in content", "..."],
  "donts": ["list of 4-6 things to AVOID in content", "..."],
  "notes": "any other important brand context for content writers"
}

Focus on: G2G is a gaming marketplace for buying/selling in-game items, currency, accounts, and top-up services. Be specific and practical.
Return only the JSON, no markdown.`
  } else if (body.type === 'category') {
    prompt = `You are an SEO content strategist for G2G.com, a gaming marketplace.
The product category is: "${body.name}"

Return a JSON object with these exact keys:
{
  "description": "1-2 sentences describing what this product category is on G2G",
  "buyer_intent": "describe the search intent of buyers looking for this category (informational? transactional? specific game?)",
  "keywords": ["5-8 relevant keywords or phrases for this category", "mix of short and long-tail"],
  "angle": "what content angle works best for this category (e.g. safety/trust, price comparison, fastest delivery)",
  "notes": "any special considerations for creating content for this category"
}

Return only the JSON, no markdown.`
  } else if (body.type === 'platform') {
    prompt = `You are a content strategist who specializes in platform-specific writing for SEO and brand mentions.
The platform is: "${body.name}"

Return a JSON object with these exact keys:
{
  "writing_rules": "2-3 sentences on the core rules for writing on this platform",
  "format": "describe ideal format: length, structure, use of lists/paragraphs",
  "tone": "describe the appropriate tone for this platform",
  "dos": ["list of 3-5 things that work well on this platform", "..."],
  "donts": ["list of 3-5 things to avoid on this platform", "..."],
  "notes": "any platform-specific notes about posting, visibility, or community rules"
}

Return only the JSON, no markdown.`
  }

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = message.content[0].type === 'text' ? message.content[0].text : ''
    const json = JSON.parse(text.trim())
    return NextResponse.json({ suggestion: json })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
