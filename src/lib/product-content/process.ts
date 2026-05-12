import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  writeProductRow,
  SHEET_STATUS,
  formatErrorStatus,
  ensureIdTab,
  findRowByRelationId,
  appendProductRow,
} from '@/lib/google/sheets'
import { getKeywordSuggestions } from '@/lib/dataforseo/client'
import { logApiUsage } from '@/lib/api-logger'
import { translateProductContent, type ProductContentBundle } from '@/lib/agents/product-translator'

/**
 * Sheet-as-database Product Content processor (2026-05-12 refactor).
 *
 * Flow per row:
 *   1. Fetch keywords from DataForSEO (main + 4-5 secondary)
 *   2. Generate structured EN content via Claude — 8 H2 sections + 5-7 FAQ Q/A
 *   3. Translate EN → Indonesian (same structure)
 *   4. Save both to DB (mirror) + write back to sheet:
 *        EN tab: cols F-AG on the original row
 *        ID tab: matching row (by Relation ID); auto-create tab if missing
 *   5. Update col E on EN tab to "Generated" or "Error: <stage-tagged>"
 *
 * No Google Drive doc creation — sheet is the canonical store.
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'

export interface QueueRow {
  id:              string
  owner_user_id:   string
  relation_id:     string
  product_name:    string
  category:        string | null
  request_date:    string | null
  sheet_row:       number | null
}

export interface SheetTarget {
  spreadsheetId: string
  sheetName:     string
  /** Optional. When set, writeProductRow aligns to the user's actual column
   *  layout (e.g. extra annotation columns or single-cell FAQs). When omitted,
   *  the canonical SHEET_COLS layout is used. Populate via getSheetColumnMap()
   *  in the sync route + pass through here. */
  colMap?:       Record<string, number>
}

export interface ProcessResult {
  ok:        boolean
  error?:    string
  warning?:  string
  bundle?:   ProductContentBundle
}

// ─── Helpers — kept here so both manual button + cron use identical logic ────

export function buildProductUrl(category: string, productName: string): string {
  const cat = (category ?? '').toLowerCase().trim()
  const slug = (productName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  let segment = 'product'
  if (cat.includes('gift') || cat.includes('payment card'))            segment = 'gift-card'
  else if (cat.includes('account'))                                     segment = 'accounts'
  else if (cat.includes('video game') || cat.includes('game key') || cat.includes('cd key')) segment = 'cd-key'
  else if (cat.includes('software') || cat.includes('app'))             segment = 'software'
  else if (cat.includes('boost'))                                       segment = 'boosting'
  else if (cat.includes('currency') || cat.includes('coin') || cat.includes('gold') || cat.includes('top up') || cat.includes('topup')) segment = 'game-coins'
  else if (cat.includes('item'))                                        segment = 'game-items'
  else if (cat.includes('gamepal') || cat.includes('lfg'))              segment = 'gamepal'
  else if (cat.includes('telco'))                                       segment = 'telco'

  return `https://www.g2g.com/${segment}/${slug}`
}

function extractGameName(productName: string): string {
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

// ─── Structured prompt ───────────────────────────────────────────────────────

function buildPrompt(opts: {
  productName:      string
  category:         string
  url:              string
  mainKeyword:      string
  secondaryKeyword: string
}): string {
  return `You are writing G2G.com product page content. G2G is a global gaming marketplace where players buy/sell game accounts, currency, items, boosting services, gift cards, and keys.

PRODUCT DETAILS:
- Product Name: ${opts.productName}
- Category:     ${opts.category}
- URL:          ${opts.url}
- Primary Keyword:     ${opts.mainKeyword}
- Secondary Keywords:  ${opts.secondaryKeyword || '(none — derive from product context)'}

OUTPUT STRUCTURE — strict:
1. SEO meta (3 fields: meta_title ≤60 chars, meta_description ≤110 chars, meta_keyword comma-separated 5-8 terms)
2. Marketing H1 title — punchy, 50-80 chars, ${opts.mainKeyword} prominent
3. EIGHT marketing sections — each is ONE <h2> + body paragraphs in HTML. Pick eight relevant topics for the category:
   • For Accounts: What is, Why Buy on G2G, Account Features, How It Works, Pricing, Safety & Verification, Payment Options, Customer Support
   • For Currency/Coins: What is, Why Buy, How to Order, Delivery Speed, Pricing & Best Sellers, Security, Payment Methods, Buyer Reviews
   • For Gift Cards: About, Where to Use, How to Redeem, Why Buy on G2G, Denominations, Instant Delivery, Security, FAQ Closing
   • For Game Keys: About, Activation Region, How It Works, Pricing, Instant Delivery, Verified Sellers, Payment Methods, Support
   • For Boosting: Service Overview, Why Choose G2G, How Boost Works, Account Safety, Pricing Tiers, Boost Speed, Payment, Support
   • Default: pick 8 logical sections that explain product + trust + flow + pricing + delivery + support
   Each section is FULL HTML in a single string: "<h2>Section Title</h2><p>Paragraph 1.</p><p>Paragraph 2.</p>" — use <ul>/<ol>/<strong> where they add value.
4. FIVE to SEVEN FAQ Q/A pairs — questions real buyers ask. Each Q is one sentence; each A is 1-2 short paragraphs in plain prose (NO HTML in answers).

WRITING RULES:
- Use ${opts.mainKeyword} naturally 3-5 times across the full content (NOT keyword-stuff).
- Tone: friendly, trustworthy, action-oriented. Speak to a gamer, not a corporate buyer.
- Include 1-2 "G2G.com" mentions per section where natural.
- Mention safety / escrow / verified sellers where relevant.
- Never invent specific prices or guarantees we can't keep.
- Never use forbidden phrases: "in conclusion", "in this article", "let's dive in", "look no further".

Return ONLY a JSON object (no markdown fences, no commentary). EXACT shape:
{
  "meta_title":       "string ≤60 chars",
  "meta_description": "string ≤110 chars",
  "meta_keyword":     "kw1, kw2, kw3, kw4, kw5",
  "marketing_title":  "H1 title string",
  "marketing_sections": [
    "<h2>...</h2><p>...</p>",
    "<h2>...</h2><p>...</p>",
    "<h2>...</h2><p>...</p>",
    "<h2>...</h2><p>...</p>",
    "<h2>...</h2><p>...</p>",
    "<h2>...</h2><p>...</p>",
    "<h2>...</h2><p>...</p>",
    "<h2>...</h2><p>...</p>"
  ],
  "faqs": [
    { "q": "Question 1?", "a": "Answer 1." },
    { "q": "Question 2?", "a": "Answer 2." },
    { "q": "Question 3?", "a": "Answer 3." },
    { "q": "Question 4?", "a": "Answer 4." },
    { "q": "Question 5?", "a": "Answer 5." }
  ]
}`
}

// ─── Generate EN content via Claude ──────────────────────────────────────────

async function generateEnContent(
  opts: {
    productName:      string
    category:         string
    url:              string
    mainKeyword:      string
    secondaryKeyword: string
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  ownerId:  string,
): Promise<{ ok: true; bundle: ProductContentBundle } | { ok: false; error: string }> {
  let raw = ''
  try {
    const prompt = buildPrompt(opts)
    const msg = await anthropic.messages.create({
      model:      CLAUDE_MODEL,
      max_tokens: 8192,
      messages:   [{ role: 'user', content: prompt }],
    })
    logApiUsage(supabase, ownerId, {
      api: 'claude', endpoint: 'product_auto_content_structured',
      triggeredBy: 'other', callCount: 1,
    })

    raw = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '{}'
    const jsonStr = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim()
    const parsed  = JSON.parse(jsonStr) as Record<string, unknown>

    if (typeof parsed.meta_title       !== 'string') return { ok: false, error: '[stage:gen] missing meta_title in AI output' }
    if (typeof parsed.meta_description !== 'string') return { ok: false, error: '[stage:gen] missing meta_description' }
    if (typeof parsed.marketing_title  !== 'string') return { ok: false, error: '[stage:gen] missing marketing_title' }
    if (!Array.isArray(parsed.marketing_sections))   return { ok: false, error: '[stage:gen] missing marketing_sections array' }
    if (!Array.isArray(parsed.faqs))                  return { ok: false, error: '[stage:gen] missing faqs array' }

    const sections = (parsed.marketing_sections as unknown[]).map(s => String(s ?? ''))
    while (sections.length < 8) sections.push('')

    const faqs = (parsed.faqs as unknown[]).map(f => {
      const obj = f as Record<string, unknown>
      return { q: String(obj.q ?? ''), a: String(obj.a ?? '') }
    }).filter(f => f.q.trim() && f.a.trim())

    if (faqs.length < 5) {
      return { ok: false, error: `[stage:gen] only ${faqs.length} valid FAQs returned (min 5)` }
    }

    return {
      ok: true,
      bundle: {
        metaTitle:         String(parsed.meta_title),
        metaDescription:   String(parsed.meta_description),
        metaKeyword:       String(parsed.meta_keyword ?? ''),
        marketingTitle:    String(parsed.marketing_title),
        marketingSections: sections.slice(0, 8),
        faqs:              faqs.slice(0, 7),
      },
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Distinguish parse errors (most common — Claude returned non-JSON) from
    // API errors so the stage tag tells us where to look.
    if (e instanceof SyntaxError) {
      return { ok: false, error: `[stage:parse] ${msg} — first 200 chars of output: ${raw.slice(0, 200)}` }
    }
    return { ok: false, error: `[stage:anthropic] ${msg}` }
  }
}

// ─── Main processor ──────────────────────────────────────────────────────────

export async function processProductRow(
  row: QueueRow,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:  SupabaseClient<any, any, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  sheet: SheetTarget | null,
): Promise<ProcessResult> {
  try {
    const productName = row.product_name
    const category    = row.category ?? ''
    const productUrl  = buildProductUrl(category, productName)

    // ── 1. Fetch keywords from DataForSEO ────────────────────────────────────
    let mainKeyword     = productName
    let secondaryKeyword = ''
    try {
      const suggestions = await getKeywordSuggestions(extractGameName(productName), 2840, 'en', 10)
      if (suggestions.length) {
        mainKeyword      = suggestions[0].keyword
        secondaryKeyword = suggestions.slice(1, 6).map(s => s.keyword).join(', ')
      }
    } catch (kwErr) {
      // Non-blocking — fall back to product name as main keyword.
      console.warn(`[process] DataForSEO keyword fetch failed for ${row.relation_id}:`, kwErr)
    }

    // ── 2. Generate EN content (structured: 8 sections + 5-7 FAQs) ──────────
    const enResult = await generateEnContent({
      productName, category, url: productUrl, mainKeyword, secondaryKeyword,
    }, supabase, row.owner_user_id)

    if (!enResult.ok) {
      await persistFailure(db, row, enResult.error, sheet)
      return { ok: false, error: enResult.error }
    }
    const en = enResult.bundle

    // ── 3. Translate to Indonesian (same structure) ──────────────────────────
    let idBundle: ProductContentBundle | null = null
    let idWarning: string | null = null
    try {
      const tx = await translateProductContent({
        productName, category, mainKeyword,
        english: en,
      }, supabase, row.owner_user_id)
      if (tx.ok && tx.bundle) idBundle = tx.bundle
      else                     idWarning = tx.error ?? 'Translation returned no bundle'
    } catch (txErr) {
      idWarning = `Translation exception: ${txErr instanceof Error ? txErr.message : String(txErr)}`
    }

    // ── 4. Save EN + ID to DB ────────────────────────────────────────────────
    await db
      .from('product_content_queue')
      .update({
        // EN payload
        meta_title:           en.metaTitle,
        meta_description:     en.metaDescription,
        meta_keywords:        en.metaKeyword,        // legacy column name, plural
        marketing_title:      en.marketingTitle,
        marketing_sections:   en.marketingSections,  // NEW jsonb
        faqs:                 en.faqs,               // NEW jsonb
        main_keyword:         mainKeyword,
        secondary_keywords:   secondaryKeyword,
        status:               'generated',
        generated_at:         new Date().toISOString(),
        generation_error:     null,
        google_doc_url:       null,                  // explicit clear (legacy)
        // ID payload
        id_meta_title:        idBundle?.metaTitle       ?? null,
        id_meta_description:  idBundle?.metaDescription ?? null,
        id_meta_keywords:     idBundle?.metaKeyword     ?? null,
        id_marketing_title:   idBundle?.marketingTitle  ?? null,
        id_marketing_sections: idBundle?.marketingSections ?? [],
        id_faqs:               idBundle?.faqs           ?? [],
        id_status:            idBundle ? 'generated' : 'failed',
        id_generated_at:      idBundle ? new Date().toISOString() : null,
        id_generation_error:  idWarning,
        id_google_doc_url:    null,                  // explicit clear
        updated_at:           new Date().toISOString(),
      })
      .eq('owner_user_id', row.owner_user_id)
      .eq('relation_id', row.relation_id)

    // ── 5. Write back to EN sheet tab ────────────────────────────────────────
    if (sheet && row.sheet_row) {
      try {
        await writeProductRow(sheet.spreadsheetId, sheet.sheetName, row.sheet_row, {
          createNow:         SHEET_STATUS.GENERATED,
          mainKeyword,
          secondaryKeyword,
          metaTitle:         en.metaTitle,
          metaDescription:   en.metaDescription,
          metaKeyword:       en.metaKeyword,
          marketingTitle:    en.marketingTitle,
          marketingSections: en.marketingSections,
          faqs:              en.faqs,
        }, sheet.colMap)
      } catch (sheetErr) {
        console.error(`[process] EN sheet write-back failed for row ${row.sheet_row}:`, sheetErr)
      }
    }

    // ── 6. Write to ID sheet tab (auto-create + match by Relation ID) ───────
    if (sheet && idBundle) {
      try {
        const idTab = await ensureIdTab(sheet.spreadsheetId, sheet.sheetName)
        const idRowIndex = await findRowByRelationId(sheet.spreadsheetId, idTab, row.relation_id)

        const idUpdate = {
          createNow:         SHEET_STATUS.GENERATED,
          mainKeyword,                                                  // same kw (Indonesian users search EN brand terms)
          secondaryKeyword,
          metaTitle:         idBundle.metaTitle,
          metaDescription:   idBundle.metaDescription,
          metaKeyword:       idBundle.metaKeyword,
          marketingTitle:    idBundle.marketingTitle,
          marketingSections: idBundle.marketingSections,
          faqs:              idBundle.faqs,
        }

        if (idRowIndex > 0) {
          await writeProductRow(sheet.spreadsheetId, idTab, idRowIndex, idUpdate)
        } else {
          await appendProductRow(sheet.spreadsheetId, idTab, {
            productName: row.product_name,
            category:    row.category ?? '',
            relationId:  row.relation_id,
            requestDate: row.request_date ?? '',
          }, idUpdate)
        }
      } catch (idSheetErr) {
        // Non-blocking — EN tab already has the success status.
        console.error(`[process] ID sheet write failed for ${row.relation_id}:`, idSheetErr)
      }
    }

    return { ok: true, bundle: en, warning: idWarning ?? undefined }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    console.error(`[process] failed for ${row.relation_id}:`, e)
    await persistFailure(db, row, errMsg, sheet)
    return { ok: false, error: errMsg }
  }
}

// ─── Failure persistence helper ──────────────────────────────────────────────

async function persistFailure(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:    SupabaseClient<any, any, any>,
  row:   QueueRow,
  msg:   string,
  sheet: SheetTarget | null,
): Promise<void> {
  await db
    .from('product_content_queue')
    .update({
      status:              'failed',
      id_status:           'failed',
      generation_error:    msg,
      id_generation_error: msg,
      updated_at:          new Date().toISOString(),
    })
    .eq('owner_user_id', row.owner_user_id)
    .eq('relation_id', row.relation_id)

  if (sheet && row.sheet_row) {
    try {
      await writeProductRow(sheet.spreadsheetId, sheet.sheetName, row.sheet_row, {
        createNow: formatErrorStatus(msg),
      }, sheet.colMap)
    } catch { /* best-effort */ }
  }
}

/**
 * Reset stuck rows: anything in status='generating' for >10 minutes is
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
