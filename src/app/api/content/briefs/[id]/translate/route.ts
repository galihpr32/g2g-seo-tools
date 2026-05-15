import { NextResponse, after } from 'next/server'
import { createClient }        from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { canAccessOwnerData }  from '@/lib/workspace'
import Anthropic               from '@anthropic-ai/sdk'
import { logClaudeUsage }      from '@/lib/api-logger'
// Sprint BRAGI.ID.NATIVE — read variant + invoke native generator when assigned
import { resolveTierForPage }     from '@/lib/anthropic/model-tier'
import { ensureIdVariantForBrief } from '@/lib/experiments/id-native'
import { generateIdNativeContent } from '@/lib/agents/id-native-generator'

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL     = 'claude-haiku-4-5-20251001'

const SUPPORTED_LANGS: Record<string, string> = {
  id: 'Indonesian (Bahasa Indonesia)',
  es: 'Spanish (Castilian, neutral Latin American)',
  pt: 'Portuguese (Brazilian)',
  th: 'Thai',
  vi: 'Vietnamese',
}

/**
 * POST /api/content/briefs/[id]/translate
 *
 * Translates seo_content_briefs.final_content into a target language and
 * stores the result in final_content_translations[lang].
 *
 * Body: { lang: 'id' | 'es' | 'pt' | 'th' | 'vi' }
 *
 * Returns immediately and runs translation in after() so the lambda doesn't
 * time out on a 20-30s Claude call.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  let lang = 'id'
  try {
    const body = await request.json() as { lang?: string }
    if (body.lang) lang = String(body.lang).toLowerCase()
  } catch { /* default id */ }

  if (!SUPPORTED_LANGS[lang]) {
    return NextResponse.json(
      { error: `Unsupported lang "${lang}". Supported: ${Object.keys(SUPPORTED_LANGS).join(', ')}` },
      { status: 400 },
    )
  }

  const db = createServiceClient()
  const { data: brief } = await db
    .from('seo_content_briefs')
    .select('owner_user_id, final_content, primary_keyword, final_content_translations, site_slug, page, id_experiment_variant')
    .eq('id', id)
    .maybeSingle()
  if (!brief) return NextResponse.json({ error: 'Brief not found' }, { status: 404 })

  const ownerId = String(brief.owner_user_id)
  const allowed = await canAccessOwnerData(supabase, user.id, ownerId)
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const sourceText = String(brief.final_content ?? '').trim()
  if (!sourceText) {
    return NextResponse.json(
      { error: 'No final_content to translate — run assembly first.' },
      { status: 400 },
    )
  }

  after(async () => {
    try {
      const langName = SUPPORTED_LANGS[lang]
      const keyword  = String(brief.primary_keyword ?? '')

      // ─── Sprint BRAGI.ID.NATIVE — variant-aware branching ────────────────
      // For Indonesian only, check the brief's experiment variant. If
      // variant=id_native, generate fresh ID copy directly via Sonnet.
      // Otherwise fall through to the legacy Haiku-translate path below.
      if (lang === 'id') {
        const tier = await resolveTierForPage(db, brief.page ?? null, brief.site_slug ?? null)
        if (tier === 1 || tier === 2) {
          // Lazily assign variant if missing (e.g. brief was created pre-experiment)
          const assignment = await ensureIdVariantForBrief(db, id, tier)
          if (assignment.variant === 'id_native') {
            const result = await generateIdNativeContent({
              briefId:         id,
              primaryKeyword:  keyword,
              productName:     keyword,     // best available proxy when product_name not stored on brief
              category:        '',
              englishMarkdown: sourceText,
              tier,
            }, db, ownerId)
            if (result.ok && result.markdown) {
              const existing = (brief.final_content_translations ?? {}) as Record<string, string>
              const updated  = { ...existing, id: result.markdown }
              await db
                .from('seo_content_briefs')
                .update({
                  final_content_translations: updated,
                  updated_at:                 new Date().toISOString(),
                })
                .eq('id', id)
              console.log(`[translate] brief ${id} ID generated via id_native (${result.model})`)
              return
            }
            console.warn(`[translate] brief ${id} id_native failed (${result.error}), falling back to en_translate`)
            // fall through to legacy translation as safety net
          }
        }
      }

      const prompt = `You are a professional SEO translator. Translate the markdown article below into ${langName}, following these rules:

1. Preserve markdown structure exactly: headings (#, ##, ###), lists, bold, links — keep them intact.
2. The primary keyword "${keyword}" SHOULD remain in English where it appears as a brand-style search term (gamers in ${langName}-speaking countries search in English for game accounts, items, currencies). Translate the surrounding prose, not the brand+game noun phrase.
3. Brand names, product names, game names: keep in English (e.g. "G2G", "GamerProtect", "Steam", "FIFA Mobile", "Dota 2").
4. Trust signals (GamerProtect, ISO/IEC 27001:2013, 200+ payment methods, 24/7 support) — keep brand-name parts in English, translate descriptive parts.
5. Localise idioms, currency references, and tone naturally for the target audience. Don't word-for-word.
6. Forbidden words still apply (translated equivalents of "immerse yourself", "dive into", "embark", etc. — avoid them in the target language too).
7. Output ONLY the translated markdown. No preamble, no JSON, no notes.

Article to translate:

${sourceText}`

      const response = await anthropic.messages.create({
        model:      MODEL,
        max_tokens: 4096,
        messages:   [{ role: 'user', content: prompt }],
      })

      logClaudeUsage(db, ownerId, {
        model:       MODEL,
        endpoint:    'brief_translate',
        triggeredBy: 'agent_bragi',
        usage:       response.usage,
        extra:       { brief_id: id, lang },
      })

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b.type === 'text' ? b.text : ''))
        .join('\n')
        .trim()
        .replace(/^```(?:markdown|md)?\s*\n?/, '')
        .replace(/\n?```\s*$/, '')

      if (!text || text.length < 100) {
        console.error(`[translate] brief ${id} lang=${lang} empty output`)
        return
      }

      const existing = (brief.final_content_translations ?? {}) as Record<string, string>
      const updated  = { ...existing, [lang]: text }

      await db
        .from('seo_content_briefs')
        .update({
          final_content_translations: updated,
          updated_at:                 new Date().toISOString(),
        })
        .eq('id', id)
    } catch (err) {
      console.error(`[translate] brief ${id} lang=${lang} failed:`, err)
    }
  })

  return NextResponse.json({ ok: true, lang, queued: true })
}
