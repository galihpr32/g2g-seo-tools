import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface Message { role: 'user' | 'assistant'; content: string }

// Page context descriptions — injected based on current URL
const PAGE_CONTEXTS: Record<string, string> = {
  '/dashboard':                    'the main SEO dashboard showing traffic, clicks, and impressions overview',
  '/gsc/ranking-drop':             'GSC Clicks Drop Alert — monitors pages that lost traffic recently',
  '/gsc/product-rankings':         'Top Product Tracker — tracks keyword rankings for specific G2G product pages',
  '/gsc/action-items':             'Action Items — SEO tasks and content briefs assigned to the team',
  '/gsc/index-coverage':           'Index Coverage — shows Google indexing status for G2G pages',
  '/gsc/core-web-vitals':          'Core Web Vitals — page performance metrics (LCP, CLS, INP)',
  '/ga4/organic-traffic':          'GA4 Organic Traffic — sessions, engagement, and organic conversions',
  '/ga4/content-performance':      'Content Performance — which pages drive the most engaged traffic',
  '/semrush/rankings':             'SEMrush Keyword Rankings — G2G organic keyword positions with intent badges',
  '/semrush/site-audit':           'SEMrush Site Audit — technical SEO issues across the site',
  '/semrush/competitors':          'SEMrush Competitor Tracking — how G2G compares to top competitors',
  '/competitive/keyword-gap':      'Keyword Gap Finder — keywords competitors rank for that G2G does not',
  '/competitive/opportunities':    'Page Opportunities — potential new pages based on keyword gaps',
  '/competitive/serp-tracker':     'SERP & Share of Voice — G2G visibility across tracked keywords',
  '/competitive/page-analyzer':    'Page Analyzer — deep analysis of any URL vs competitors',
  '/content/trends':               'Game Trends — trending games by Steam players and search volume',
  '/content/studio':               'Content Studio — AI-powered content creation wizard for G2G product pages',
  '/knowledge-base':               'Knowledge Base — G2G brand guidelines, USPs, and writing rules',
  '/reports/weekly':               'Weekly Pulse Report — weekly SEO performance summary for G2G',
  '/reports/monthly':              'Monthly SEO Report — monthly performance, wins, and action plan',
  '/reports/serp-features':        'SERP Features — which featured snippets, PAA, image packs G2G captures',
  '/reports/backlinks':            'Backlink Audit — referring domains, anchor text, and toxic link signals',
  '/backlinks':                    'Backlink Tracker — paid and organic backlinks being monitored',
  '/tools/url-analysis':           'URL Analyzer — deep SEO analysis of any G2G page',
  '/tools/api-costs':              'API Cost Tracker — usage and spend across SEMrush, DataForSEO, etc.',
  '/campaigns':                    'SEO Campaigns — active campaign tracking with kanban board',
  '/team-performance':             'Team Performance — output and activity metrics for the SEO team',
}

function getPageContext(pathname: string): string {
  // Exact match first
  if (PAGE_CONTEXTS[pathname]) return PAGE_CONTEXTS[pathname]
  // Prefix match
  for (const [key, desc] of Object.entries(PAGE_CONTEXTS)) {
    if (pathname.startsWith(key)) return desc
  }
  return 'the G2G SEO Tools dashboard'
}

// POST /api/ai/chat
// Body: { messages: Message[], current_page: string, page_data?: string }
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { messages, current_page = '/', page_data } = await req.json() as {
    messages:     Message[]
    current_page: string
    page_data?:   string
  }

  if (!messages?.length) return NextResponse.json({ error: 'No messages' }, { status: 400 })

  const pageDesc = getPageContext(current_page)

  const systemPrompt = `You are an expert SEO strategist and assistant embedded in G2G's internal SEO tool suite.

G2G (g2g.com) is a leading gaming marketplace — it sells in-game items, currencies, gift cards, top-ups (Robux, V-Bucks, Free Fire diamonds), game accounts, boosting services, and GamePal companions.

The user is currently on: ${pageDesc}${page_data ? `\n\nRelevant data from this page:\n${page_data}` : ''}

YOUR ROLE:
- Answer SEO questions with expert, actionable advice tailored to G2G's context
- Analyse data the user shares and provide specific recommendations
- Help prioritise actions by impact and effort
- Know G2G's competitive landscape: games marketplaces, gift card resellers, gaming companions
- Reference the current page context when relevant — if the user asks "what should I do about this?" you understand what "this" refers to
- Be concise but thorough — bullet points for lists, prose for explanations
- When suggesting content, follow G2G writing rules: GamerProtect, escrow, verified sellers, 200+ payment methods, ISO/IEC 27001:2013, no competitor mentions, no forbidden words (immerse yourself, embark, dive into, etc.)

TONE: Professional, direct, collaborative. Like a senior SEO consultant talking to the team.`

  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     systemPrompt,
      messages:   messages.map(m => ({ role: m.role, content: m.content })),
    })

    const reply = response.content[0]?.type === 'text' ? response.content[0].text : ''
    return NextResponse.json({ reply })
  } catch (e) {
    console.error('[ai/chat] error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
