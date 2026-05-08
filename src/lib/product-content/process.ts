import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { writeProductRow, SHEET_STATUS } from '@/lib/google/sheets'
import { buildCategoryInstructions } from '@/lib/g2g-category-prompts'
import { createProductDoc } from '@/lib/google/drive'
import { getKeywordSuggestions } from '@/lib/dataforseo/client'
import { logApiUsage } from '@/lib/api-logger'
import { translateProductContent } from '@/lib/agents/product-translator'

/**
 * Single source of truth for generating product content (EN + ID).
 *
 * Used by:
 *   - /api/products/auto-content/sync         — sheet-driven manual sync
 *   - /api/cron/product-content-auto          — scheduled background processor
 *   - /api/products/auto-content/process-row  — per-row "Process now" action
 *
 * Idempotent: caller is responsible for setting status='generating' before
 * invocation. We update DB to 'generated' or 'failed' on completion.
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'

export interface QueueRow {
  id:                string
  owner_user_id:     string
  relation_id:       string
  product_name:      string
  category:          string | null
  url:               string | null
  sheet_row:         number | null
  main_keyword:      string | null
  secondary_keywords: string | null
}

export interface SheetTarget {
  spreadsheetId: string
  sheetName:     string
}

export interface ProcessResult {
  ok:        boolean
  error?:    string
  warning?:  string
  /** Per-row stat returned to the caller for summary display. */
  enDocUrl?: string
  idDocUrl?: string
}

// ─── Helpers — kept here so both sync + cron use identical logic ─────────────

export function buildProductUrl(category: string, productName: string): string {
  const cat = (category ?? '').toLowerCase().trim()
  const slug = (productName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  let segment = 'product'
  if (cat.includes('gift') || cat.includes('payment card')) segment = 'gift-card'
  else if (cat.includes('account')) segment = 'accounts'
  else if (cat.includes('video game') || cat.includes('game key') || cat.includes('cd key')) segment = 'cd-key'
  else if (cat.includes('software') || cat.includes('app')) segment = 'software'
  else if (cat.includes('boost')) segment = 'boosting'
  else if (cat.includes('currency') || cat.includes('coin') || cat.includes('gold') || cat.includes('top up') || cat.includes('topup')) segment = 'game-coins'
  else if (cat.includes('item')) segment = 'game-items'
  else if (cat.includes('gamepal') || cat.includes('lfg')) segment = 'gamepal'
  else if (cat.includes('telco')) segment = 'telco'

  return `https://www.g2g.com/${segment}/${slug}`
}

export function extractGameName(productName: string): string {
  const suffixes = [
    'coins', 'currency', 'gold', 'credits', 'gems', 'tokens',
    'account', 'accounts', 'boosting', 'boost', 'power leveling',
    'cd key', 'game key', 'keys', 'gift card', 'top-up', 'topup',
    'gamepal', 'companion', 'software', 'items', 'item',
  ]
  let name = (productName ?? '').toLowerCase()
  for (const suf of suffixes) {
    name = name.replace(new RegExp(`\\b${suf}\\b`, 'gi'), '').trim()
  }
  return name.trim() || productName
}

function buildPrompt(opts: {
  categoryInstructions: string
  productName:  string
  category:     string
  url:          string
  mainKeyword:  string
  secondaryKws: string
}): string {
  return `${opts.categoryInstructions}

PRODUCT DETAILS:
- Product Name: ${opts.productName}
- Category: ${opts.category}
- URL: ${opts.url}
- Primary Keyword: ${opts.mainKeyword}
- Secondary Keywords: ${opts.secondaryKws || 'none'}

Generate the complete product page content following ALL the instructions above.

Return a JSON object with these exact fields:
{
  "meta_title": "SEO title ≤60 chars",
  "meta_description": "SEO description ≤110 chars",
  "meta_keywords": "keyword1, keyword2, keyword3",
  "marketing_title": "Product page H1 title",
  "marketing_description": "Full HTML product description using <br><br> between paragraphs, following the section structure above"
}

No markdown fences. Only valid JSON.`
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function processProductRow(
  row:      QueueRow,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  sheet:    SheetTarget | null,
): Promise<ProcessResult> {
  try {
    const productName = row.product_name
    const category    = row.category ?? ''
    const productUrl  = row.url ?? buildProductUrl(category, productName)

    // 1. Resolve keywords (use existing or fetch from DataForSEO)
    let mainKeyword    = row.main_keyword       || productName
    let secondaryKwStr = row.secondary_keywords || ''

    if (!row.main_keyword) {
      try {
        const suggestions = await getKeywordSuggestions(productName, 2840, 'en', 10)
        if (suggestions.length) {
          mainKeyword    = suggestions[0].keyword
          secondaryKwStr = suggestions.slice(1, 6).map(s => s.keyword).join(', ')
        }
      } catch { /* non-critical — fallback to product name */ }
    }

    // 2. Generate EN content via Haiku
    const categoryInstructions = buildCategoryInstructions(productUrl, extractGameName(productName), mainKeyword)
    const prompt = buildPrompt({
      categoryInstructions,
      productName,
      category,
      url: productUrl,
      mainKeyword,
      secondaryKws: secondaryKwStr,
    })

    const msg = await anthropic.messages.create({
      model:      CLAUDE_MODEL,
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }],
    })
    logApiUsage(supabase, row.owner_user_id, {
      api: 'claude', endpoint: 'product_auto_content',
      triggeredBy: 'other', callCount: 1,
    })

    const raw     = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '{}'
    const jsonStr = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim()
    const parsed  = JSON.parse(jsonStr) as Record<string, string>

    // 3. Create EN Google Doc — REQUIRED for status='generated'.
    // If this fails the row goes to status='failed' with the error captured
    // in generation_error so users can debug (Drive API not enabled, folder
    // permission denied, etc.) without crawling Vercel function logs.
    let enDocUrl = ''
    let enDocError: string | null = null
    try {
      enDocUrl = await createProductDoc({
        productName,
        category,
        relationId:           row.relation_id,
        mainKeyword,
        secondaryKeyword:     secondaryKwStr,
        metaTitle:            parsed.meta_title            ?? '',
        metaDescription:      parsed.meta_description      ?? '',
        metaKeywords:         parsed.meta_keywords         ?? '',
        marketingTitle:       parsed.marketing_title       ?? productName,
        marketingDescription: parsed.marketing_description ?? '',
        language:             'en',
      })
    } catch (docErr) {
      enDocError = docErr instanceof Error ? docErr.message : String(docErr)
      console.error(`[process] EN doc failed for ${row.relation_id}:`, docErr)
    }

    // 4. Translate to Indonesian + create ID doc
    let idDocUrl = ''
    let idBundle: ReturnType<typeof Object> | null = null
    let idWarning: string | null = null
    try {
      const tx = await translateProductContent({
        productName,
        category,
        mainKeyword,
        english: {
          meta_title:            parsed.meta_title            ?? '',
          meta_description:      parsed.meta_description      ?? '',
          meta_keywords:         parsed.meta_keywords         ?? '',
          marketing_title:       parsed.marketing_title       ?? productName,
          marketing_description: parsed.marketing_description ?? '',
        },
      }, supabase, row.owner_user_id)

      if (tx.ok && tx.bundle) {
        idBundle = tx.bundle
        try {
          idDocUrl = await createProductDoc({
            productName,
            category,
            relationId:           row.relation_id,
            mainKeyword,
            secondaryKeyword:     secondaryKwStr,
            metaTitle:            tx.bundle.meta_title,
            metaDescription:      tx.bundle.meta_description,
            metaKeywords:         tx.bundle.meta_keywords,
            marketingTitle:       tx.bundle.marketing_title,
            marketingDescription: tx.bundle.marketing_description,
            language:             'id',
          })
        } catch (docErr) {
          idWarning = `ID doc create failed: ${docErr instanceof Error ? docErr.message : String(docErr)}`
        }
      } else {
        idWarning = tx.error ?? 'Translation returned no bundle'
      }
    } catch (txErr) {
      idWarning = `Translate exception: ${txErr instanceof Error ? txErr.message : String(txErr)}`
    }

    const enSucceeded = !!enDocUrl   // No URL → row failed (drive API or folder access)
    const idGenSucceeded = !!(idBundle && idDocUrl)
    // Avoid TS complaint on object index
    const idB = idBundle as null | { meta_title: string; meta_description: string; meta_keywords: string; marketing_title: string; marketing_description: string }

    // 5. Save EN + ID content to DB
    // EN status reflects whether a usable Doc URL was produced. Without it,
    // the team has no artifact to upload — calling that "generated" was the
    // bug users reported on 2026-05-08.
    await db
      .from('product_content_queue')
      .update({
        // EN fields
        meta_title:            parsed.meta_title            ?? '',
        meta_description:      parsed.meta_description      ?? '',
        meta_keywords:         parsed.meta_keywords         ?? '',
        marketing_title:       parsed.marketing_title       ?? productName,
        marketing_description: parsed.marketing_description ?? '',
        main_keyword:          mainKeyword,
        secondary_keywords:    secondaryKwStr,
        google_doc_url:        enDocUrl || null,
        status:                enSucceeded ? 'generated' : 'failed',
        generated_at:          enSucceeded ? new Date().toISOString() : null,
        generation_error:      enSucceeded ? null : (enDocError ?? 'EN Google Doc creation returned empty URL — check Drive API + GOOGLE_DRIVE_FOLDER_ID.'),
        // ID fields
        id_meta_title:            idB?.meta_title            ?? null,
        id_meta_description:      idB?.meta_description      ?? null,
        id_meta_keywords:         idB?.meta_keywords         ?? null,
        id_marketing_title:       idB?.marketing_title       ?? null,
        id_marketing_description: idB?.marketing_description ?? null,
        id_google_doc_url:        idDocUrl || null,
        id_status:                idGenSucceeded ? 'generated' : 'failed',
        id_generated_at:          idGenSucceeded ? new Date().toISOString() : null,
        id_generation_error:      idGenSucceeded ? null : (idWarning ?? null),
        updated_at:               new Date().toISOString(),
      })
      .eq('owner_user_id', row.owner_user_id)
      .eq('relation_id', row.relation_id)

    // 6. Write back to sheet (D-I) — only if a sheet target was provided
    if (sheet && row.sheet_row) {
      try {
        await writeProductRow(sheet.spreadsheetId, sheet.sheetName, row.sheet_row, {
          mainKeyword,
          secondaryKeyword: secondaryKwStr,
          enFileName:       enDocUrl || '',
          status:           enSucceeded ? SHEET_STATUS.GENERATED : SHEET_STATUS.FAILED,
          idFileName:       idDocUrl || '',
          idStatus:         idGenSucceeded ? SHEET_STATUS.GENERATED : SHEET_STATUS.FAILED,
        })
      } catch (sheetErr) {
        console.error(`[process] sheet write-back failed for row ${row.sheet_row}:`, sheetErr)
      }
    }

    return {
      ok:        enSucceeded,
      enDocUrl:  enDocUrl || undefined,
      idDocUrl:  idDocUrl || undefined,
      error:     enSucceeded ? undefined : (enDocError ?? 'EN doc URL was empty'),
      warning:   idWarning ?? undefined,
    }
  } catch (e) {
    console.error(`[process] failed for ${row.relation_id}:`, e)

    // Mark BOTH columns failed since ID translates from EN — if EN bombs, ID can't proceed
    await db
      .from('product_content_queue')
      .update({
        status:    'failed',
        id_status: 'failed',
        updated_at: new Date().toISOString(),
      })
      .eq('owner_user_id', row.owner_user_id)
      .eq('relation_id', row.relation_id)

    if (sheet && row.sheet_row) {
      try {
        await writeProductRow(sheet.spreadsheetId, sheet.sheetName, row.sheet_row, {
          status:   SHEET_STATUS.FAILED,
          idStatus: SHEET_STATUS.FAILED,
        })
      } catch { /* best-effort */ }
    }

    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Reset stuck-state rows: anything in status='generating' for >10 minutes is
 * treated as a crashed worker. Move it back to 'pending' so the next
 * processing pass picks it up.
 */
export async function recoverStuckRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId?: string,
): Promise<number> {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString()
  let q = db
    .from('product_content_queue')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('status', 'generating')
    .lt('updated_at', cutoff)

  if (ownerId) q = q.eq('owner_user_id', ownerId)

  const { data, error } = await q.select('id')
  if (error) {
    console.error('[recoverStuckRows] failed:', error.message)
    return 0
  }
  return data?.length ?? 0
}
