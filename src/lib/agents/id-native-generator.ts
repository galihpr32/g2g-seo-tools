// Sprint BRAGI.ID.NATIVE — Native Indonesian content generation.
//
// Used when seo_content_briefs.id_experiment_variant === 'id_native'.
// Instead of generate-EN → Haiku-translate, we prompt the same brief
// requirements directly in Bahasa Indonesia. Reading-quality theory: a
// model writing fresh in ID picks more natural collocations than a
// translator constrained by EN sentence structure.
//
// Hypothesis we're testing: ID-native copy will outperform EN→translate
// on these metrics (Friday KPI):
//   • CTR on Indonesian SERP impressions (GSC, country=id)
//   • Time-on-page / engagement (GA4)
//   • Brief reviewer satisfaction (brief_review_feedback)
//
// We use Sonnet (not Haiku) because translation tolerated Haiku's
// occasional clunkiness — native generation is the actual quality bar.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logClaudeUsage } from '@/lib/api-logger'
import { BRAGI_MODEL_T2 } from '@/lib/anthropic/model-tier'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Sonnet 4 by default (same as T2 Bragi). Override per experiment if needed:
//   ID_NATIVE_MODEL=claude-sonnet-4-6
const MODEL = process.env.ID_NATIVE_MODEL ?? BRAGI_MODEL_T2

export interface IdNativeInput {
  briefId:         string
  primaryKeyword:  string
  productName:     string
  category:        string
  englishMarkdown: string         // The EN source — used as content blueprint, NOT translated word-for-word
  tier:            1 | 2
}

export interface IdNativeResult {
  ok:        boolean
  markdown?: string
  error?:    string
  usage?:    { inputTokens: number; outputTokens: number }
  model?:    string
}

function buildPrompt(input: IdNativeInput): string {
  return `Kamu adalah copywriter SEO senior untuk G2G.com — marketplace gaming yang punya banyak pembeli Indonesia.

PRODUK         : ${input.productName}
KATEGORI       : ${input.category}
KEYWORD UTAMA  : ${input.primaryKeyword}
TIER           : T${input.tier}

TUGAS:
Tulis ulang artikel di bawah ini DALAM BAHASA INDONESIA dari nol — jangan menerjemahkan kata demi kata. Pakai blueprint Inggrisnya cuma sebagai outline (urutan section, fakta, klaim). Output harus terasa seperti ditulis langsung oleh orang Indonesia yang ngerti gaming.

ATURAN:
1. Struktur markdown tetap sama: heading (##, ###), bullet, link, bold. Jumlah section sama dengan versi Inggris.
2. KEYWORD UTAMA ("${input.primaryKeyword}") tetap dalam bentuk Inggris di meta title, H1, dan minimal 3 kali di body — gamer Indonesia search pakai brand term Inggris.
3. Nama brand, game, dan produk: tetap Inggris ("G2G", "Steam", "FIFA Mobile", "Dota 2", "GamerProtect").
4. Trust signal (GamerProtect, ISO/IEC 27001:2013, 200+ payment methods, 24/7 support) — bagian brand Inggris, bagian deskriptif diterjemahkan natural.
5. Pakai "kamu" (informal), BUKAN "Anda" — gamer Indonesia.
6. Pakai kalimat aktif, hindari kata-kata kaku khas terjemahan ("memungkinkan kamu untuk", "memberikan pengalaman yang"). Tulis seperti ngobrol sama temen yang lebih jago.
7. Mata uang & angka: biarkan apa adanya (USD, $, jumlah numerik).
8. JANGAN pakai forbidden words atau terjemahan langsungnya: "immerse yourself" / "selami", "dive into" / "menyelami", "embark on" / "memulai perjalanan", "unlock" sebagai metafora.
9. Output HANYA markdown — tidak ada preamble, tidak ada JSON, tidak ada catatan.

BLUEPRINT INGGRIS (gunakan untuk struktur dan fakta, JANGAN diterjemahkan):

${input.englishMarkdown}

Tulis versi ID-native sekarang:`
}

export async function generateIdNativeContent(
  input: IdNativeInput,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?:      SupabaseClient<any>,
  ownerId?: string,
): Promise<IdNativeResult> {
  try {
    const prompt = buildPrompt(input)
    const res = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 6000,
      messages:   [{ role: 'user', content: prompt }],
    })

    if (db && ownerId) {
      logClaudeUsage(db, ownerId, {
        model:       MODEL,
        endpoint:    'brief_id_native',
        triggeredBy: 'agent_bragi',
        usage:       res.usage,
        extra: {
          brief_id:        input.briefId,
          primary_keyword: input.primaryKeyword,
          variant:         'id_native',
          tier:            input.tier,
        },
      })
    }

    const text = res.content
      .filter(b => b.type === 'text')
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim()
      .replace(/^```(?:markdown|md)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')

    if (!text || text.length < 200) {
      return { ok: false, error: `id-native output too short (${text.length} chars)`, model: MODEL }
    }

    return {
      ok:       true,
      markdown: text,
      usage:    { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      model:    MODEL,
    }
  } catch (err) {
    return {
      ok:    false,
      error: err instanceof Error ? err.message : String(err),
      model: MODEL,
    }
  }
}
