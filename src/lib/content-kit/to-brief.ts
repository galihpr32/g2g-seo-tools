// ─── Kit → Bragi brief assembler ───────────────────────────────────────────
//
// Sprint CKB.5 — Convert a ready ContentKitData into a structured brief
// `notes` string that Bragi can consume during generation. We embed the
// kit ID at the top so Mimir can backtrack later; the rest is plain text
// that the prompt builder reads as additional context.
//
// Why notes-as-text vs FK column: keeps the brief pipeline backwards
// compatible. Bragi's existing prompt builder already concatenates
// `notes` into the system prompt verbatim, so we get blueprint injection
// for free with no schema changes upstream.

import type { ContentKitData } from './types'

export interface ToBriefArgs {
  kitId:           string
  primaryKeyword:  string
  productName:     string
  data:            ContentKitData
}

/**
 * Produce the `notes` string that gets written into seo_content_briefs.notes.
 * Bragi reads `notes` and concatenates it into the prompt, so this is the
 * vehicle by which our section blueprint, FAQ, fan-out passages, etc. land
 * in the LLM call.
 */
export function kitToBriefNotes(args: ToBriefArgs): string {
  const { kitId, primaryKeyword, productName, data } = args
  const lines: string[] = []

  lines.push(`▼ CONTENT KIT — kit_id=${kitId}`)
  lines.push(`Primary keyword: ${primaryKeyword}`)
  lines.push(`Product: ${productName}`)
  lines.push(`Sections passed intent filter: ${data.meta.candidates_passed}/${data.meta.candidates_total}`)
  lines.push('')

  // Section blueprint — the most important hand-off
  lines.push('━━━ SECTION BLUEPRINT (use these as H2s in order) ━━━')
  for (const s of data.sections) {
    lines.push('')
    lines.push(`H2 #${s.position}: "${s.h2_title}"`)
    lines.push(`  target keyword: ${s.target_kw}`)
    lines.push(`  intent class:   ${s.intent_class}`)
    lines.push(`  body outline:   ${s.body_outline}`)
    if (s.cta_bridge) lines.push(`  *** CTA bridge required at end of section ***`)
  }
  lines.push('')

  // Keyword placement map
  lines.push('━━━ KEYWORD PLACEMENT ━━━')
  lines.push(`Primary in H1 + intro + conclusion + 2-3 body: "${data.keyword_placement.primary}"`)
  if (data.keyword_placement.primary_variants.length > 0) {
    lines.push(`Primary variants (H2/H3): ${data.keyword_placement.primary_variants.join(' · ')}`)
  }
  if (data.keyword_placement.supporting.length > 0) {
    lines.push(`Supporting (one per H2): ${data.keyword_placement.supporting.join(' · ')}`)
  }
  if (data.keyword_placement.semantic_variations.length > 0) {
    lines.push(`Semantic variations (alt text + microcopy): ${data.keyword_placement.semantic_variations.slice(0, 6).join(' · ')}`)
  }
  lines.push('')

  // FAQ
  if (data.faq.length > 0) {
    lines.push('━━━ FAQ SECTION (render after main H2s) ━━━')
    for (const f of data.faq) {
      lines.push(`Q (EN): ${f.q_en}`)
      lines.push(`A (EN, 40-80 words): ${f.a_en}`)
      lines.push(`Q (ID): ${f.q_id}`)
      lines.push(`A (ID, 40-80 words): ${f.a_id}`)
      lines.push('')
    }
  }

  // Fan-out passages — AI Overview-ready blocks to inject into sections
  if (data.fan_out_passages.length > 0) {
    lines.push('━━━ FAN-OUT PASSAGES (drop into the suggested section) ━━━')
    for (const p of data.fan_out_passages) {
      lines.push(`[Section: ${p.section_hint}] Topic: ${p.topic}`)
      lines.push(`EN: ${p.passage_en}`)
      lines.push(`ID: ${p.passage_id}`)
      lines.push('')
    }
  }

  // Cross-link instructions
  if (data.cross_links.length > 0) {
    lines.push('━━━ INTERNAL CROSS-LINKS (place naturally in body) ━━━')
    for (const cl of data.cross_links) {
      lines.push(`  → anchor "${cl.anchor_text}" → ${cl.target_url || '[resolve from target_product_id]'} (${cl.reason})`)
    }
    lines.push('')
  }

  // Gap analysis as "must address" hints
  if (data.gap_analysis.gaps.length > 0) {
    lines.push('━━━ COMPETITOR GAPS TO ADDRESS ━━━')
    for (const g of data.gap_analysis.gaps) {
      lines.push(`[${g.priority}] ${g.topic}: ${g.why}`)
    }
    lines.push('')
  }

  // Schema reminder
  if (data.schema_additions.faq_jsonld) {
    lines.push('━━━ SCHEMA ━━━')
    lines.push('FAQPage JSON-LD pre-rendered; include verbatim in <script type="application/ld+json">.')
    lines.push('')
  }

  lines.push('▲ END CONTENT KIT')
  return lines.join('\n')
}
