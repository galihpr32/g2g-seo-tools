import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 30

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

type Intent = 'I' | 'N' | 'C' | 'T'

// ── POST /api/keywords/intent ─────────────────────────────────────────────────
// Body: { keywords: string[] }
// Returns: { intents: Record<string, Intent> }
//
// Flow:
//   1. Check cache (keyword_intents table) for all keywords
//   2. Batch-classify any uncached keywords with Claude (50 per request)
//   3. Store results in cache, return full map
export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { keywords } = await req.json() as { keywords: string[] }
    if (!Array.isArray(keywords) || keywords.length === 0) {
      return NextResponse.json({ intents: {} })
    }

    // Dedupe and normalise
    const unique = Array.from(new Set(keywords.map(k => k.toLowerCase().trim()))).filter(Boolean)

    // ── Check cache ──────────────────────────────────────────────────────────
    const { data: cached } = await supabase
      .from('keyword_intents')
      .select('keyword, intent, classified_at')
      .in('keyword', unique)

    const intentMap: Record<string, Intent> = {}
    const freshCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000  // 30 days

    const cachedFresh = new Set<string>()
    for (const row of cached ?? []) {
      const age = new Date(row.classified_at).getTime()
      if (age > freshCutoff) {
        intentMap[row.keyword] = row.intent as Intent
        cachedFresh.add(row.keyword)
      }
    }

    // ── Classify uncached keywords with Claude ───────────────────────────────
    const uncached = unique.filter(k => !cachedFresh.has(k))

    if (uncached.length > 0) {
      const BATCH = 50
      for (let i = 0; i < uncached.length; i += BATCH) {
        const batch = uncached.slice(i, i + BATCH)
        try {
          const prompt = `You are a search intent classifier for an SEO tool.

Classify each keyword by search intent using ONLY these labels:
- I = Informational (user wants to learn, research, or get answers)
- N = Navigational (user wants to reach a specific site or page)
- C = Commercial (user is comparing or researching before buying)
- T = Transactional (user wants to buy, download, sign up, or take action now)

Context: These keywords are from a gaming marketplace (G2G) that sells in-game items, gift cards, and top-ups (Robux, V-Bucks, Free Fire diamonds, etc).

Respond with ONLY a valid JSON object mapping each keyword to its label. No explanation, no markdown.

Keywords to classify:
${batch.map(k => `"${k}"`).join('\n')}

Example response format:
{"buy robux": "T", "what is robux": "I", "g2g.com": "N", "best robux site": "C"}`

          const msg = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',  // fast + cheap for classification
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
          })

          const raw = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '{}'
          // Strip any markdown fences if present
          const jsonStr = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim()
          const result = JSON.parse(jsonStr) as Record<string, string>

          const valid: Intent[] = ['I', 'N', 'C', 'T']
          const toInsert: { keyword: string; intent: Intent }[] = []

          for (const kw of batch) {
            const label = result[kw]?.toUpperCase() as Intent
            if (valid.includes(label)) {
              intentMap[kw] = label
              toInsert.push({ keyword: kw, intent: label })
            }
          }

          // Upsert into cache
          if (toInsert.length > 0) {
            await supabase
              .from('keyword_intents')
              .upsert(toInsert.map(r => ({ ...r, classified_at: new Date().toISOString() })), {
                onConflict: 'keyword',
              })
          }
        } catch (e) {
          console.warn(`[keyword-intent] batch ${i}–${i + BATCH} failed:`, e)
          // Continue — partial results are fine
        }
      }
    }

    return NextResponse.json({ intents: intentMap })
  } catch (err) {
    console.error('[keyword-intent] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
