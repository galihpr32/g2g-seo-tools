import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { readProductSheet, writeProductRow, SHEET_STATUS } from '@/lib/google/sheets'
import { buildCategoryInstructions } from '@/lib/g2g-category-prompts'
import { createProductDoc } from '@/lib/google/drive'
import { getKeywordSuggestions } from '@/lib/dataforseo/client'
import { logApiUsage } from '@/lib/api-logger'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 120

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// POST /api/products/auto-content/sync
// Body: { spreadsheet_id?, sheet_name?, limit?, regenerate_existing? }
// Reads the Google Sheet (Status = "To Do" rows), generates content, writes back to sheet + DB.
export async function POST(req: Request) {
  const supabase  = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    spreadsheet_id?:      string
    sheet_name?:          string
    limit?:               number
    regenerate_existing?: boolean
  }

  // ── Load sheet config ──────────────────────────────────────────────────────
  const { data: sheetConfig } = await db
    .from('product_sheet_config')
    .select('*')
    .eq('owner_user_id', ownerId)
    .single()

  const spreadsheetId = body.spreadsheet_id ?? sheetConfig?.spreadsheet_id
  const sheetName     = body.sheet_name     ?? sheetConfig?.sheet_name ?? 'Sheet1'
  const limit         = body.limit          ?? 20   // max products per run (API cost guard)

  if (!spreadsheetId) {
    return NextResponse.json({ error: 'No spreadsheet configured. Set up Google Sheet first.' }, { status: 400 })
  }

  // ── Read Google Sheet (only "To Do" rows by default) ──────────────────────
  let sheetRows
  try {
    // allStatuses=true when regenerate_existing so we can also redo failed/generated rows
    sheetRows = await readProductSheet(spreadsheetId, sheetName, 2, 500, !!body.regenerate_existing)
  } catch (e) {
    return NextResponse.json({ error: `Google Sheets error: ${String(e)}` }, { status: 500 })
  }

  if (!sheetRows.length) {
    // Pull a raw count so the UI can tell the user EXACTLY why 0 rows were
    // found — most common cause is column G ("Status") not being "To Do"
    // (e.g. blank, "Done", "ToDo" without space, lowercase).
    let rawCount = 0
    let nonTodoCount = 0
    let missingFieldCount = 0
    try {
      const allRows = await readProductSheet(spreadsheetId, sheetName, 2, 500, true)
      rawCount = allRows.length
      nonTodoCount = allRows.filter(r => r.sheetStatus !== SHEET_STATUS.TODO).length
      missingFieldCount = allRows.filter(r => !r.productName || !r.relationId).length
    } catch { /* swallow; diagnostic best-effort */ }

    return NextResponse.json({
      synced:   0,
      message:  rawCount === 0
                  ? `Sheet is empty or unreachable. Verify the spreadsheet ID + sheet name "${sheetName}" exist and the row data starts at row 2.`
                  : `Sheet has ${rawCount} rows but none are "To Do". ` +
                    `${nonTodoCount} rows have a different status (Generated / blank / typo). ` +
                    `${missingFieldCount} rows missing productName or relationId. ` +
                    `To regenerate already-Generated rows, pass {regenerate_existing: true}.`,
      diagnostics: { rawCount, nonTodoCount, missingFieldCount, sheetName },
    })
  }

  // ── If regenerate_existing, also include already-failed DB rows ────────────
  let toProcess = sheetRows

  if (!body.regenerate_existing) {
    // Skip rows already successfully generated in our DB
    const allRelationIds = sheetRows.map(r => r.relationId)
    const { data: existing } = await db
      .from('product_content_queue')
      .select('relation_id, status')
      .eq('owner_user_id', ownerId)
      .in('relation_id', allRelationIds)

    const existingMap = new Map((existing ?? []).map(r => [r.relation_id, r.status]))

    toProcess = sheetRows.filter(row => {
      const dbStatus = existingMap.get(row.relationId)
      if (!dbStatus) return true                          // new product — process
      return dbStatus === 'failed'                        // retry failures
    })
  }

  toProcess = toProcess.slice(0, limit)

  if (!toProcess.length) {
    return NextResponse.json({
      synced:  0,
      message: `All ${sheetRows.length} "To Do" rows already have content in DB. Pass {regenerate_existing: true} to regenerate them.`,
      diagnostics: { sheetRows: sheetRows.length, alreadyDone: sheetRows.length },
    })
  }

  // ── Upsert rows as 'generating' in DB ─────────────────────────────────────
  await db
    .from('product_content_queue')
    .upsert(
      toProcess.map(row => ({
        owner_user_id: ownerId,
        relation_id:   row.relationId,
        product_name:  row.productName,
        category:      row.category,
        url:           buildProductUrl(row.category, row.productName),
        sheet_row:     row.rowIndex,
        status:        'generating',
        updated_at:    new Date().toISOString(),
      })),
      { onConflict: 'owner_user_id,relation_id' }
    )

  // ── Generate content for each product ─────────────────────────────────────
  const results: { relationId: string; ok: boolean; error?: string }[] = []

  for (const row of toProcess) {
    try {
      const gameName    = extractGameName(row.productName, row.category)
      const productUrl  = buildProductUrl(row.category, row.productName)

      // Use existing keyword from sheet if already filled; otherwise ask DataForSEO
      let mainKeyword      = row.mainKeyword      || row.productName
      let secondaryKwStr   = row.secondaryKeyword || ''

      if (!row.mainKeyword) {
        try {
          const suggestions = await getKeywordSuggestions(row.productName, 2840, 'en', 10)
          if (suggestions.length) {
            mainKeyword    = suggestions[0].keyword
            secondaryKwStr = suggestions.slice(1, 6).map(s => s.keyword).join(', ')
          }
        } catch { /* non-critical — fall back to product name */ }
      }

      // Build category-specific instructions from Master Prompt List
      // If no template found for this category, falls back to a generic product description prompt
      const categoryInstructions = buildCategoryInstructions(productUrl, gameName, mainKeyword)

      const prompt = buildPrompt({
        categoryInstructions,
        productName:  row.productName,
        category:     row.category,
        url:          productUrl,
        mainKeyword,
        secondaryKws: secondaryKwStr,
      })

      const msg = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',  // fast + cheap for bulk generation
        max_tokens: 4096,
        messages:   [{ role: 'user', content: prompt }],
      })

      logApiUsage(supabase, ownerId, { api: 'claude', endpoint: 'product_auto_content', triggeredBy: 'other', callCount: 1 })

      const raw     = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '{}'
      const jsonStr = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim()
      const parsed  = JSON.parse(jsonStr)

      // ── Create Google Doc (dual-output backup) ────────────────────────────
      let googleDocUrl = ''
      try {
        googleDocUrl = await createProductDoc({
          productName:          row.productName,
          category:             row.category,
          relationId:           row.relationId,
          mainKeyword,
          secondaryKeyword:     secondaryKwStr,
          metaTitle:            parsed.meta_title            ?? '',
          metaDescription:      parsed.meta_description      ?? '',
          metaKeywords:         parsed.meta_keywords         ?? '',
          marketingTitle:       parsed.marketing_title       ?? row.productName,
          marketingDescription: parsed.marketing_description ?? '',
        })
      } catch (docErr) {
        // Google Doc creation is best-effort — log but don't fail the whole product
        console.error(`[auto-content] Google Doc creation failed for ${row.relationId}:`, docErr)
      }

      // ── Save to DB ────────────────────────────────────────────────────────
      await db
        .from('product_content_queue')
        .update({
          meta_title:            parsed.meta_title            ?? '',
          meta_description:      parsed.meta_description      ?? '',
          meta_keywords:         parsed.meta_keywords         ?? '',
          marketing_title:       parsed.marketing_title       ?? row.productName,
          marketing_description: parsed.marketing_description ?? '',
          main_keyword:          mainKeyword,
          secondary_keywords:    secondaryKwStr,
          google_doc_url:        googleDocUrl || null,
          status:                'generated',
          generated_at:          new Date().toISOString(),
          updated_at:            new Date().toISOString(),
        })
        .eq('owner_user_id', ownerId)
        .eq('relation_id', row.relationId)

      // ── Write back to Google Sheet ────────────────────────────────────────
      try {
        await writeProductRow(spreadsheetId, sheetName, row.rowIndex, {
          mainKeyword,
          secondaryKeyword: secondaryKwStr,
          enFileName:       googleDocUrl || '',
          status:           SHEET_STATUS.GENERATED,
        })
      } catch (sheetErr) {
        // Sheet write-back is best-effort — don't fail the product
        console.error(`[auto-content] Sheet write-back failed for row ${row.rowIndex}:`, sheetErr)
      }

      results.push({ relationId: row.relationId, ok: true })
    } catch (e) {
      console.error(`[auto-content] failed for ${row.relationId}:`, e)

      await db
        .from('product_content_queue')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('owner_user_id', ownerId)
        .eq('relation_id', row.relationId)

      // Mark as Failed in sheet too
      try {
        await writeProductRow(spreadsheetId, sheetName, row.rowIndex, {
          status: SHEET_STATUS.FAILED,
        })
      } catch { /* best-effort */ }

      results.push({ relationId: row.relationId, ok: false, error: String(e) })
    }
  }

  // ── Update last_synced_at ──────────────────────────────────────────────────
  await db
    .from('product_sheet_config')
    .upsert({
      owner_user_id:  ownerId,
      spreadsheet_id: spreadsheetId,
      sheet_name:     sheetName,
      last_synced_at: new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    }, { onConflict: 'owner_user_id' })

  const succeeded = results.filter(r => r.ok).length
  const failed    = results.filter(r => !r.ok).length

  return NextResponse.json({
    synced:        succeeded,
    failed,
    total:         toProcess.length,
    sheetRowsRead: sheetRows.length,
    results,
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Construct a representative G2G URL from the sheet category name.
 * This URL is passed to detectCategory() / buildCategoryInstructions() which
 * uses URL pattern matching to select the right prompt template.
 *
 * Sheet categories → G2G URL segment mapping:
 *   Gift Cards, Payment Card  → gift-card
 *   Accounts                  → accounts
 *   Video Game, Game Keys     → cd-key
 *   Software                  → software
 *   Boosting                  → boosting
 *   Currency, Top Up, Coins   → game-coins
 *   Items, Direct Top Up      → game-items  (will fall back to generic)
 *   Telco                     → telco        (will fall back to generic)
 */
function buildProductUrl(category: string, productName: string): string {
  const cat = category.toLowerCase().trim()
  const slug = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  let segment = 'product'

  if (cat.includes('gift') || cat.includes('payment card')) {
    segment = 'gift-card'
  } else if (cat.includes('account')) {
    segment = 'accounts'
  } else if (cat.includes('video game') || cat.includes('game key') || cat.includes('cd key')) {
    segment = 'cd-key'
  } else if (cat.includes('software') || cat.includes('app')) {
    segment = 'software'
  } else if (cat.includes('boost')) {
    segment = 'boosting'
  } else if (cat.includes('currency') || cat.includes('coin') || cat.includes('gold') || cat.includes('top up') || cat.includes('topup')) {
    segment = 'game-coins'
  } else if (cat.includes('item')) {
    segment = 'game-items'
  } else if (cat.includes('gamepal') || cat.includes('lfg')) {
    segment = 'gamepal'
  } else if (cat.includes('telco')) {
    segment = 'telco'
  }

  return `https://www.g2g.com/${segment}/${slug}`
}

function extractGameName(productName: string, _category: string): string {
  const suffixes = [
    'coins', 'currency', 'gold', 'credits', 'gems', 'tokens',
    'account', 'accounts', 'boosting', 'boost', 'power leveling',
    'cd key', 'game key', 'keys', 'gift card', 'top-up', 'topup',
    'gamepal', 'companion', 'software', 'items', 'item',
  ]
  let name = productName
  for (const s of suffixes) {
    name = name.replace(new RegExp(`\\s*-?\\s*${s}s?\\s*$`, 'i'), '')
    name = name.replace(/^buy\s+/i, '')
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
