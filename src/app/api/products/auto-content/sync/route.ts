import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { readProductSheet } from '@/lib/google/sheets'
import { buildCategoryInstructions, detectCategory } from '@/lib/g2g-category-prompts'
import { getKeywordSuggestions } from '@/lib/dataforseo/client'
import { logApiUsage } from '@/lib/api-logger'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 120

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// POST /api/products/auto-content/sync
// Body: { spreadsheet_id?, sheet_name?, limit?, regenerate_existing? }
// Reads the Google Sheet, generates content for new/pending products, saves to DB
export async function POST(req: Request) {
  const supabase  = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const body = await req.json().catch(() => ({})) as {
    spreadsheet_id?:      string
    sheet_name?:          string
    limit?:               number
    regenerate_existing?: boolean
  }

  // ── Load sheet config ──────────────────────────────────────────────────────
  const { data: sheetConfig } = await supabase
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

  // ── Read Google Sheet ──────────────────────────────────────────────────────
  let sheetRows
  try {
    sheetRows = await readProductSheet(spreadsheetId, sheetName)
  } catch (e) {
    return NextResponse.json({ error: `Google Sheets error: ${String(e)}` }, { status: 500 })
  }

  if (!sheetRows.length) {
    return NextResponse.json({ synced: 0, message: 'Sheet is empty or no valid rows found' })
  }

  // ── Find which products need content generated ─────────────────────────────
  const allRelationIds = sheetRows.map(r => r.relationId)

  const { data: existing } = await supabase
    .from('product_content_queue')
    .select('relation_id, status')
    .eq('owner_user_id', ownerId)
    .in('relation_id', allRelationIds)

  const existingMap = new Map((existing ?? []).map(r => [r.relation_id, r.status]))

  const toProcess = sheetRows.filter(row => {
    const status = existingMap.get(row.relationId)
    if (!status) return true                                       // new product
    if (body.regenerate_existing) return true                      // forced regen
    return status === 'pending' || status === 'failed'             // retry failures
  }).slice(0, limit)

  if (!toProcess.length) {
    return NextResponse.json({ synced: 0, message: 'All products already have content' })
  }

  // ── Upsert rows as 'generating' ────────────────────────────────────────────
  await supabase
    .from('product_content_queue')
    .upsert(
      toProcess.map(row => ({
        owner_user_id: ownerId,
        relation_id:   row.relationId,
        product_name:  row.productName,
        category:      row.category,
        url:           row.url,
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
      // Derive main keyword from product name + category
      const mainKeyword = row.productName
      const gameName    = extractGameName(row.productName, row.category)

      // Get keyword suggestions for context (non-blocking, best-effort)
      let secondaryKws: string[] = []
      try {
        const suggestions = await getKeywordSuggestions(mainKeyword, 2840, 'en', 10)
        secondaryKws = suggestions.slice(0, 5).map(s => s.keyword)
      } catch { /* skip — not critical */ }

      // Build category-specific instructions from Master Prompt List
      const categoryInstructions = buildCategoryInstructions(row.url, gameName, mainKeyword)

      const prompt = `${categoryInstructions}

PRODUCT DETAILS:
- Product Name: ${row.productName}
- Category: ${row.category}
- URL: ${row.url}
- Primary Keyword: ${mainKeyword}
- Secondary Keywords: ${secondaryKws.join(', ') || 'none'}

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

      const msg = await anthropic.messages.create({
        model:      'claude-haiku-4-5-20251001',  // fast + cheap for bulk generation
        max_tokens: 4096,
        messages:   [{ role: 'user', content: prompt }],
      })

      logApiUsage(supabase, ownerId, { api: 'claude', endpoint: 'product_auto_content', triggeredBy: 'other', callCount: 1 })

      const raw     = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '{}'
      const jsonStr = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim()
      const parsed  = JSON.parse(jsonStr)

      // Save to DB
      await supabase
        .from('product_content_queue')
        .update({
          meta_title:            parsed.meta_title            ?? '',
          meta_description:      parsed.meta_description      ?? '',
          meta_keywords:         parsed.meta_keywords         ?? '',
          marketing_title:       parsed.marketing_title       ?? row.productName,
          marketing_description: parsed.marketing_description ?? '',
          status:                'generated',
          generated_at:          new Date().toISOString(),
          updated_at:            new Date().toISOString(),
        })
        .eq('owner_user_id', ownerId)
        .eq('relation_id', row.relationId)

      results.push({ relationId: row.relationId, ok: true })
    } catch (e) {
      console.error(`[auto-content] failed for ${row.relationId}:`, e)
      await supabase
        .from('product_content_queue')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('owner_user_id', ownerId)
        .eq('relation_id', row.relationId)
      results.push({ relationId: row.relationId, ok: false, error: String(e) })
    }
  }

  // Update last_synced_at
  await supabase
    .from('product_sheet_config')
    .upsert({
      owner_user_id: ownerId,
      spreadsheet_id: spreadsheetId,
      sheet_name: sheetName,
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'owner_user_id' })

  const succeeded = results.filter(r => r.ok).length
  const failed    = results.filter(r => !r.ok).length

  return NextResponse.json({
    synced:    succeeded,
    failed,
    total:     toProcess.length,
    sheetRows: sheetRows.length,
    results,
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function extractGameName(productName: string, category: string): string {
  // Try to extract the game name by removing common category suffixes
  const suffixes = [
    'coins', 'currency', 'gold', 'credits', 'gems', 'tokens',
    'account', 'accounts', 'boosting', 'boost', 'power leveling',
    'cd key', 'game key', 'keys', 'gift card', 'top-up', 'topup',
    'gamepal', 'companion', 'software',
  ]
  let name = productName.toLowerCase()
  for (const s of suffixes) {
    name = name.replace(new RegExp(`\\s*-?\\s*${s}s?\\s*$`, 'i'), '')
    name = name.replace(new RegExp(`^buy\\s+`, 'i'), '')
  }
  return name.trim() || productName
}
