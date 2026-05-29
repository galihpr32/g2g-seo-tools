/**
 * Generate "Beyond Keywords: G2G's Next SEO Era" — 8-slide boss deck.
 *
 * USAGE (run from project root):
 *   npx tsx scripts/generate-seo-evolution-deck.ts
 *
 * REQUIREMENTS:
 *   - .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   - npm packages: pptxgenjs (already in deps)
 *
 * OUTPUT:
 *   ./seo-evolution-deck.pptx in project root
 *
 * The deck is visual-heavy with extensive speaker notes per slide
 * (Galih reads off the notes — slides themselves stay light).
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import pptxgen from 'pptxgenjs'

// ───────────────────────────────────────────────────────────────────────────
// Palette — Charcoal Minimal + Coral accent. Premium dark feel.
// ───────────────────────────────────────────────────────────────────────────
const C = {
  bgDark:    '0F1117',
  bgLight:   'F7F7F5',
  card:      '1A1D26',
  cardLight: 'FFFFFF',
  text:      'F5F5F7',
  textDim:   '8B91A0',
  textDark:  '1A1D26',
  textDimDark: '5A6275',
  border:    '2B2F3A',
  borderLight: 'E5E5E0',
  accent:    'F96167',     // coral — used sparingly for emphasis
  accent2:   '7A8FA8',     // muted slate — secondary
  gold:      'F4B860',
  emerald:   '4ED9A5',
  red:       'F96167',
}

// ───────────────────────────────────────────────────────────────────────────
// Data shape pulled from Supabase
// ───────────────────────────────────────────────────────────────────────────
interface DeckData {
  total_keywords:        number
  total_winners:         number
  total_products:        number
  products_with_winners: number
  winners_top3:          number
  winners_top4to10:      number
  winners_beyond10:      number
  winners_untracked:     number
  hugin_discovered_count: number
  hugin_avg_growth_pct:   number | null
  hugin_high_growth_count: number  // queries with growth_pct ≥ 50
  freyja_mentions_total: number | null
  brands:                string[]
}

async function fetchDeckData(): Promise<DeckData> {
  const url     = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key     = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local')
  }
  const db = createClient(url, key, { auth: { persistSession: false } })

  // Brand scope: G2G only (per boss presentation focus)
  const SITE = 'g2g'

  // Find product IDs for G2G
  const { data: products, error: prodErr } = await db
    .from('product_tiers')
    .select('id')
    .eq('site_slug', SITE)
  if (prodErr) throw prodErr
  const productIds = (products ?? []).map(p => String(p.id))
  const total_products = productIds.length

  // KW + winner counts
  const { count: total_keywords } = await db
    .from('tier_keywords')
    .select('id', { count: 'exact', head: true })
    .in('product_tier_id', productIds)

  const { data: winners, error: winErr } = await db
    .from('tier_keywords')
    .select('id, product_tier_id, keyword')
    .in('product_tier_id', productIds)
    .eq('is_cluster_winner', true)
  if (winErr) throw winErr
  const total_winners = (winners ?? []).length
  const winnerIds = (winners ?? []).map(w => w.id as string)

  const products_with_winners = new Set((winners ?? []).map(w => w.product_tier_id as string)).size

  // Latest position per winner — pull recent snapshots, keep latest per tier_keyword_id
  const sinceIso = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
  const { data: snaps } = await db
    .from('tier_serp_snapshots')
    .select('tier_keyword_id, snapshot_date, our_position')
    .in('tier_keyword_id', winnerIds.length > 0 ? winnerIds : ['00000000-0000-0000-0000-000000000000'])
    .gte('snapshot_date', sinceIso)
    .order('snapshot_date', { ascending: false })
    .limit(5000)

  const latestPosByKw = new Map<string, number>()
  for (const s of snaps ?? []) {
    if (!s.tier_keyword_id || s.our_position == null) continue
    if (!latestPosByKw.has(s.tier_keyword_id)) latestPosByKw.set(s.tier_keyword_id, Number(s.our_position))
  }

  let winners_top3 = 0, winners_top4to10 = 0, winners_beyond10 = 0, winners_untracked = 0
  for (const id of winnerIds) {
    const pos = latestPosByKw.get(id)
    if (pos == null) winners_untracked++
    else if (pos <= 3) winners_top3++
    else if (pos <= 10) winners_top4to10++
    else winners_beyond10++
  }

  // Hugin long-tail signals — use 30d period
  const { data: hugin } = await db
    .from('hugin_queries')
    .select('id, growth_pct, status')
    .eq('site_slug', SITE)
    .eq('period_days', 30)

  const huginRows = hugin ?? []
  const hugin_discovered_count = huginRows.filter(h => h.status === 'discovered').length
  const growthVals = huginRows.map(h => Number(h.growth_pct)).filter(v => !isNaN(v) && isFinite(v))
  const hugin_avg_growth_pct = growthVals.length > 0
    ? +(growthVals.reduce((s, v) => s + v, 0) / growthVals.length).toFixed(1)
    : null
  const hugin_high_growth_count = growthVals.filter(v => v >= 50).length

  // Freyja — optional, ignore if table missing
  let freyja_mentions_total: number | null = null
  try {
    const { data: freyja } = await db
      .from('freyja_signals')
      .select('mentions')
      .eq('site_slug', SITE)
    if (freyja) {
      freyja_mentions_total = freyja.reduce((s, f) => s + (Number(f.mentions) || 0), 0)
    }
  } catch { /* table optional */ }

  return {
    total_keywords:        total_keywords ?? 0,
    total_winners,
    total_products,
    products_with_winners,
    winners_top3,
    winners_top4to10,
    winners_beyond10,
    winners_untracked,
    hugin_discovered_count,
    hugin_avg_growth_pct,
    hugin_high_growth_count,
    freyja_mentions_total,
    brands: [SITE],
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Deck builder
// ───────────────────────────────────────────────────────────────────────────
export function buildDeck(data: DeckData): pptxgen {
  const pres = new pptxgen()
  pres.layout = 'LAYOUT_WIDE'   // 13.3 × 7.5
  pres.author = 'G2G SEO Team'
  pres.title  = 'Beyond Keywords: G2G\'s Next SEO Era'

  // Runtime shape enum (TS types miss the instance member, but it exists at runtime).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SH: any = (pres as any).shapes

  // Reusable helpers
  const addTitleStrip = (slide: pptxgen.Slide, num: number, label: string) => {
    slide.addText(`${String(num).padStart(2, '0')}`, {
      x: 0.5, y: 0.45, w: 0.8, h: 0.5, fontSize: 14, fontFace: 'Calibri',
      color: C.accent, bold: true, charSpacing: 4,
    })
    slide.addText(label, {
      x: 1.25, y: 0.45, w: 11.5, h: 0.5, fontSize: 14, fontFace: 'Calibri',
      color: C.textDim, charSpacing: 4,
    })
    slide.addShape(SH.LINE, {
      x: 0.5, y: 7.0, w: 12.3, h: 0,
      line: { color: C.border, width: 0.5 },
    })
    slide.addText('G2G SEO  ·  Confidential', {
      x: 0.5, y: 7.1, w: 12.3, h: 0.3, fontSize: 9, fontFace: 'Calibri',
      color: C.textDim,
    })
  }

  // ─── Slide 1: Title (dark) ───────────────────────────────────────────────
  {
    const s = pres.addSlide()
    s.background = { color: C.bgDark }

    s.addText('BEYOND KEYWORDS', {
      x: 0.7, y: 2.3, w: 12, h: 0.6, fontSize: 18, fontFace: 'Calibri',
      color: C.accent, charSpacing: 8, bold: true,
    })
    s.addText('G2G\'s Next SEO Era', {
      x: 0.7, y: 2.95, w: 12, h: 1.5, fontSize: 60, fontFace: 'Georgia',
      color: C.text, bold: true,
    })
    s.addShape(SH.RECTANGLE, {
      x: 0.7, y: 4.6, w: 0.6, h: 0.04, fill: { color: C.accent }, line: { color: C.accent },
    })
    s.addText('From keyword hunting to topical authority', {
      x: 0.7, y: 4.7, w: 12, h: 0.5, fontSize: 20, fontFace: 'Georgia',
      italic: true, color: C.textDim,
    })

    s.addText('G2G SEO  ·  Internal Briefing  ·  2026', {
      x: 0.7, y: 6.9, w: 12, h: 0.3, fontSize: 10, fontFace: 'Calibri',
      color: C.textDim, charSpacing: 3,
    })

    s.addNotes(
      `Speaker notes (Slide 1 — Title):

Open with energy. This is not "another SEO update." This is a strategic positioning move.

Suggested narration:
"Today I want to walk you through where SEO is heading, what we've already built that puts us ahead of most marketplaces, and what we're rolling out next to widen the gap. By the end you'll see that we're not just chasing keywords anymore — we're building topical authority, which is what actually wins in the AI search era."

Pause briefly before moving to slide 2.`
    )
  }

  // ─── Slide 2: The Shift (dark, comparison) ──────────────────────────────
  {
    const s = pres.addSlide()
    s.background = { color: C.bgDark }
    addTitleStrip(s, 2, 'THE SHIFT')

    s.addText('SEO is no longer a keyword game.', {
      x: 0.5, y: 1.1, w: 12.3, h: 0.7, fontSize: 32, fontFace: 'Georgia',
      color: C.text, bold: true,
    })
    s.addText('It\'s a topical authority game.', {
      x: 0.5, y: 1.7, w: 12.3, h: 0.7, fontSize: 32, fontFace: 'Georgia',
      color: C.accent, italic: true,
    })

    // Two columns
    const leftX = 0.5, rightX = 6.9, colW = 6.0
    // Left header
    s.addShape(SH.RECTANGLE, {
      x: leftX, y: 2.7, w: colW, h: 0.5, fill: { color: '262A35' }, line: { color: C.border },
    })
    s.addText('SEO 2010-2020', {
      x: leftX, y: 2.7, w: colW, h: 0.5, fontSize: 14, fontFace: 'Calibri',
      color: C.textDim, bold: true, align: 'center', valign: 'middle',
      charSpacing: 3, margin: 0,
    })
    // Right header
    s.addShape(SH.RECTANGLE, {
      x: rightX, y: 2.7, w: colW, h: 0.5, fill: { color: '2D1B1E' }, line: { color: C.accent },
    })
    s.addText('SEO 2024-2026', {
      x: rightX, y: 2.7, w: colW, h: 0.5, fontSize: 14, fontFace: 'Calibri',
      color: C.accent, bold: true, align: 'center', valign: 'middle',
      charSpacing: 3, margin: 0,
    })

    const rows = [
      ['Keyword stuffing',        'Topical authority'],
      ['Backlink volume',         'E-E-A-T signals'],
      ['Exact-match anchors',     'Entity-based semantic search'],
      ['One keyword → one page',  'One page → one topic cluster'],
      ['SERP ranking = goal',     'SERP + AI Overview + LLM citation = goal'],
      ['Game the algorithm',      'Satisfy intent + be cite-able by AI'],
    ]
    let rowY = 3.3
    for (const [left, right] of rows) {
      s.addShape(SH.RECTANGLE, {
        x: leftX, y: rowY, w: colW, h: 0.45,
        fill: { color: '1A1D26' }, line: { color: C.border, width: 0.5 },
      })
      s.addText(left, {
        x: leftX + 0.2, y: rowY, w: colW - 0.4, h: 0.45,
        fontSize: 13, fontFace: 'Calibri', color: C.textDim, valign: 'middle', margin: 0,
      })
      s.addShape(SH.RECTANGLE, {
        x: rightX, y: rowY, w: colW, h: 0.45,
        fill: { color: '1A1D26' }, line: { color: C.border, width: 0.5 },
      })
      s.addText(right, {
        x: rightX + 0.2, y: rowY, w: colW - 0.4, h: 0.45,
        fontSize: 13, fontFace: 'Calibri', color: C.text, valign: 'middle', margin: 0,
      })
      rowY += 0.5
    }

    s.addNotes(
      `Speaker notes (Slide 2 — The Shift):

Frame this as the BACKDROP, not the news. Boss should leave this slide knowing the industry has moved.

Suggested narration:
"For roughly a decade, SEO meant two things — stuff the right keywords on a page, and build as many backlinks as possible. That game is over. Google's algorithm now reads pages the way a human does — looking for entity coverage, topical depth, and trust signals. AI Overviews and ChatGPT-style search assistants are taking over the click. If your page isn't comprehensive enough to be cited by AI, you're invisible to a growing share of search traffic. Backlinks still matter, keywords still matter — but they're table stakes now. The winning strategy is depth, not breadth."

Pause. Let it land. The next slide proves this matters for G2G specifically.`
    )
  }

  // ─── Slide 3: Why This Matters for G2G (light, data) ────────────────────
  {
    const s = pres.addSlide()
    s.background = { color: C.bgLight }
    addTitleStrip(s, 3, 'WHY THIS MATTERS FOR G2G')

    // Override strip footer color for light bg
    s.addShape(SH.RECTANGLE, {
      x: 0, y: 7.0, w: 13.3, h: 0.5, fill: { color: C.bgLight }, line: { color: 'FFFFFF' },
    })
    s.addShape(SH.LINE, {
      x: 0.5, y: 7.0, w: 12.3, h: 0, line: { color: C.borderLight, width: 0.5 },
    })
    s.addText('G2G SEO  ·  Confidential', {
      x: 0.5, y: 7.1, w: 12.3, h: 0.3, fontSize: 9, fontFace: 'Calibri',
      color: C.textDimDark,
    })

    s.addText('We are already in this game.', {
      x: 0.5, y: 1.1, w: 12.3, h: 0.6, fontSize: 28, fontFace: 'Georgia',
      color: C.textDark, bold: true,
    })
    s.addText('The data shows where we stand.', {
      x: 0.5, y: 1.65, w: 12.3, h: 0.5, fontSize: 18, fontFace: 'Georgia',
      color: C.textDimDark, italic: true,
    })

    // 4 large stat cards (row 1)
    const cardY = 2.6
    const cardH = 1.5
    const cards = [
      { label: 'Keywords tracked',  value: String(data.total_keywords), sub: `across ${data.total_products} priority products` },
      { label: 'Cluster winners',   value: String(data.total_winners),  sub: `top 3 per cluster, scored & ranked` },
      { label: 'Long-tail discoveries', value: String(data.hugin_discovered_count), sub: `from GSC in last 30 days` },
      { label: 'High-growth queries',   value: String(data.hugin_high_growth_count), sub: `growing 50%+ month-over-month` },
    ]
    const cardW = (13.3 - 0.5 - 0.5 - 3 * 0.25) / 4
    let cx = 0.5
    for (const c of cards) {
      s.addShape(SH.RECTANGLE, {
        x: cx, y: cardY, w: cardW, h: cardH,
        fill: { color: C.cardLight }, line: { color: C.borderLight, width: 1 },
      })
      s.addShape(SH.RECTANGLE, {
        x: cx, y: cardY, w: 0.06, h: cardH, fill: { color: C.accent }, line: { color: C.accent },
      })
      s.addText(c.value, {
        x: cx + 0.25, y: cardY + 0.15, w: cardW - 0.4, h: 0.7,
        fontSize: 36, fontFace: 'Georgia', color: C.textDark, bold: true, valign: 'top', margin: 0,
      })
      s.addText(c.label, {
        x: cx + 0.25, y: cardY + 0.85, w: cardW - 0.4, h: 0.3,
        fontSize: 11, fontFace: 'Calibri', color: C.textDark, bold: true,
        charSpacing: 2, margin: 0,
      })
      s.addText(c.sub, {
        x: cx + 0.25, y: cardY + 1.15, w: cardW - 0.4, h: 0.3,
        fontSize: 9, fontFace: 'Calibri', color: C.textDimDark, italic: true, margin: 0,
      })
      cx += cardW + 0.25
    }

    // Closing strip (statement)
    s.addShape(SH.RECTANGLE, {
      x: 0.5, y: 4.6, w: 12.3, h: 1.5,
      fill: { color: '2D1B1E' }, line: { color: '2D1B1E' },
    })
    s.addText('Long-tail conversational search is growing fast.', {
      x: 0.8, y: 4.8, w: 11.7, h: 0.5, fontSize: 20, fontFace: 'Georgia',
      color: C.text, italic: true,
    })
    const huginAvgStr = data.hugin_avg_growth_pct != null
      ? `Hugin tracks an average of ${data.hugin_avg_growth_pct}% growth across discovered queries.`
      : `Hugin is tracking growth across discovered queries every day.`
    s.addText([
      { text: huginAvgStr, options: { breakLine: true } },
      { text: 'Marketplaces that don\'t deepen their pages now will be leapfrogged by competitors that do.', options: {} },
    ], {
      x: 0.8, y: 5.4, w: 11.7, h: 0.7, fontSize: 13, fontFace: 'Calibri',
      color: C.textDim,
    })

    s.addNotes(
      `Speaker notes (Slide 3 — Why This Matters):

This is the data slide. Boss likes vision backed by data — give him both.

Suggested narration:
"Here's where we stand internally. We're tracking ${data.total_keywords} keywords across ${data.total_products} priority products. Of those, ${data.total_winners} are cluster winners — these are the most competitive keywords, the ones we've identified as most worth defending and growing. In the last 30 days alone, Hugin — our long-tail discovery system — has surfaced ${data.hugin_discovered_count} new queries from Google Search Console, ${data.hugin_high_growth_count} of which are growing 50% month-over-month or faster.

The point isn't just the numbers. The point is the SHAPE of the trend: people are searching in longer, more conversational ways, and they're trusting AI-generated answers more. Our competitors are catching on. The marketplaces that deepen their product pages now will own this next wave."

Move to the next slide where we show what we've already built to capture this.`
    )
  }

  // ─── Slide 4: What We've Built (dark, system map) ───────────────────────
  {
    const s = pres.addSlide()
    s.background = { color: C.bgDark }
    addTitleStrip(s, 4, 'WHAT WE HAVE BUILT')

    s.addText('Eight intelligent agents.', {
      x: 0.5, y: 1.1, w: 12.3, h: 0.6, fontSize: 28, fontFace: 'Georgia',
      color: C.text, bold: true,
    })
    s.addText('One unified content intelligence stack.', {
      x: 0.5, y: 1.65, w: 12.3, h: 0.5, fontSize: 18, fontFace: 'Georgia',
      color: C.textDim, italic: true,
    })

    // 4×2 grid of agent cards
    const agents = [
      { name: 'BRAGI',   role: 'AI content generator' },
      { name: 'MIMIR',   role: 'Memory & learning loop' },
      { name: 'HUGIN',   role: 'Long-tail discovery from GSC' },
      { name: 'FORSETI', role: 'Community signal monitor' },
      { name: 'SAGA',    role: 'Keyword cluster builder' },
      { name: 'FREYJA',  role: 'AI Visibility tracker' },
      { name: 'LOKI',    role: 'Competitor intelligence' },
      { name: 'HEIMDALL',role: 'Real-time alerts' },
    ]
    const gridX = 0.5, gridY = 2.5
    const cellW = 3.0, cellH = 1.0
    const colGap = 0.2, rowGap = 0.2
    for (let i = 0; i < agents.length; i++) {
      const col = i % 4
      const row = Math.floor(i / 4)
      const x = gridX + col * (cellW + colGap)
      const y = gridY + row * (cellH + rowGap)
      s.addShape(SH.RECTANGLE, {
        x, y, w: cellW, h: cellH,
        fill: { color: C.card }, line: { color: C.border, width: 1 },
      })
      s.addShape(SH.RECTANGLE, {
        x, y, w: 0.05, h: cellH, fill: { color: C.accent }, line: { color: C.accent },
      })
      s.addText(agents[i].name, {
        x: x + 0.2, y: y + 0.1, w: cellW - 0.3, h: 0.4,
        fontSize: 16, fontFace: 'Georgia', color: C.text, bold: true,
        charSpacing: 2, margin: 0,
      })
      s.addText(agents[i].role, {
        x: x + 0.2, y: y + 0.5, w: cellW - 0.3, h: 0.4,
        fontSize: 11, fontFace: 'Calibri', color: C.textDim, margin: 0,
      })
    }

    // Bottom strip: ranking distribution of winners
    const stripY = 5.0
    s.addText('Where our cluster winners rank today:', {
      x: 0.5, y: stripY, w: 12.3, h: 0.4, fontSize: 14, fontFace: 'Calibri',
      color: C.textDim, charSpacing: 2,
    })
    // Stacked horizontal bar
    const barY = stripY + 0.5
    const barH = 0.65
    const totalWinners = Math.max(1, data.total_winners)
    const segments = [
      { label: `Top 3 (${data.winners_top3})`,       value: data.winners_top3,       color: C.emerald },
      { label: `Top 4-10 (${data.winners_top4to10})`, value: data.winners_top4to10,   color: C.gold },
      { label: `Beyond 10 (${data.winners_beyond10})`,value: data.winners_beyond10,   color: C.red },
      { label: `Untracked (${data.winners_untracked})`,value: data.winners_untracked, color: C.accent2 },
    ]
    const fullBarW = 12.3
    let segX = 0.5
    for (const seg of segments) {
      const segW = (seg.value / totalWinners) * fullBarW
      if (segW > 0.01) {
        s.addShape(SH.RECTANGLE, {
          x: segX, y: barY, w: segW, h: barH,
          fill: { color: seg.color }, line: { color: seg.color },
        })
        if (segW > 1.2) {
          s.addText(`${seg.value}`, {
            x: segX, y: barY, w: segW, h: barH,
            fontSize: 18, fontFace: 'Georgia', color: '0F1117', bold: true,
            align: 'center', valign: 'middle', margin: 0,
          })
        }
      }
      segX += segW
    }
    // Legend
    let legX = 0.5
    for (const seg of segments) {
      s.addShape(SH.OVAL, {
        x: legX, y: barY + barH + 0.2, w: 0.18, h: 0.18,
        fill: { color: seg.color }, line: { color: seg.color },
      })
      s.addText(seg.label, {
        x: legX + 0.25, y: barY + barH + 0.18, w: 3, h: 0.25,
        fontSize: 10, fontFace: 'Calibri', color: C.textDim, valign: 'middle', margin: 0,
      })
      legX += 3.0
    }

    s.addNotes(
      `Speaker notes (Slide 4 — What We've Built):

Build credibility — boss should feel proud, then primed for the gap.

Suggested narration:
"This is what we've quietly built over the last several months. Eight specialized agents, each handling a piece of the SEO operation. Bragi writes content, Mimir remembers what works, Hugin discovers long-tail opportunities from Search Console, Forseti monitors community sentiment on Reddit, Saga clusters keywords, Freyja tracks AI visibility — meaning where ChatGPT and Gemini are citing us, Loki watches competitors, Heimdall alerts us in real-time when something moves.

The stat strip at the bottom answers the question I know you've been asking — where do our most competitive keywords actually rank? Right now: ${data.winners_top3} are in the top 3, ${data.winners_top4to10} are in positions 4 to 10, ${data.winners_beyond10} are still beyond position 10, and ${data.winners_untracked} are not yet measured. That's the picture today. The next slide explains why the picture isn't where it could be — and what's slowing us down."

This naturally leads into the gap.`
    )
  }

  // ─── Slide 5: The Gap (light, timeline) ─────────────────────────────────
  {
    const s = pres.addSlide()
    s.background = { color: C.bgLight }
    addTitleStrip(s, 5, 'THE GAP')

    // Override footer for light
    s.addShape(SH.RECTANGLE, {
      x: 0, y: 7.0, w: 13.3, h: 0.5, fill: { color: C.bgLight }, line: { color: 'FFFFFF' },
    })
    s.addShape(SH.LINE, {
      x: 0.5, y: 7.0, w: 12.3, h: 0, line: { color: C.borderLight, width: 0.5 },
    })
    s.addText('G2G SEO  ·  Confidential', {
      x: 0.5, y: 7.1, w: 12.3, h: 0.3, fontSize: 9, fontFace: 'Calibri', color: C.textDimDark,
    })

    s.addText('We are already upgrading content this way.', {
      x: 0.5, y: 1.1, w: 12.3, h: 0.6, fontSize: 28, fontFace: 'Georgia',
      color: C.textDark, bold: true,
    })
    s.addText('But manual research can\'t keep pace with the scale.', {
      x: 0.5, y: 1.7, w: 12.3, h: 0.5, fontSize: 18, fontFace: 'Georgia',
      color: C.accent, italic: true,
    })

    // Side-by-side: manual cost vs needed velocity
    const colY = 2.7
    const colH = 3.5
    const lw = 6.0, rw = 6.0
    const lx = 0.5, rx = 6.8

    // Left — manual
    s.addShape(SH.RECTANGLE, {
      x: lx, y: colY, w: lw, h: colH,
      fill: { color: C.cardLight }, line: { color: C.borderLight, width: 1 },
    })
    s.addText('Manual upgrade — today', {
      x: lx + 0.3, y: colY + 0.25, w: lw - 0.6, h: 0.4,
      fontSize: 11, fontFace: 'Calibri', color: C.textDimDark,
      bold: true, charSpacing: 3, margin: 0,
    })
    s.addText('4-8 hours', {
      x: lx + 0.3, y: colY + 0.65, w: lw - 0.6, h: 0.8,
      fontSize: 48, fontFace: 'Georgia', color: C.textDark, bold: true, margin: 0,
    })
    s.addText('research time per product page', {
      x: lx + 0.3, y: colY + 1.45, w: lw - 0.6, h: 0.4,
      fontSize: 13, fontFace: 'Calibri', color: C.textDimDark, italic: true, margin: 0,
    })
    s.addText([
      { text: 'SERP analysis · PAA extraction', options: { breakLine: true, bullet: true } },
      { text: 'Competitor review · brief writing', options: { breakLine: true, bullet: true } },
      { text: 'Fan-out brainstorm · schema mapping', options: { bullet: true } },
    ], {
      x: lx + 0.3, y: colY + 2.0, w: lw - 0.6, h: 1.3,
      fontSize: 12, fontFace: 'Calibri', color: C.textDark, paraSpaceAfter: 4,
    })

    // Right — what's needed
    s.addShape(SH.RECTANGLE, {
      x: rx, y: colY, w: rw, h: colH,
      fill: { color: '2D1B1E' }, line: { color: '2D1B1E' },
    })
    s.addText('Needed pace — 461 winners', {
      x: rx + 0.3, y: colY + 0.25, w: rw - 0.6, h: 0.4,
      fontSize: 11, fontFace: 'Calibri', color: C.accent,
      bold: true, charSpacing: 3, margin: 0,
    })
    const monthsNeeded = Math.ceil(data.total_winners / 12)   // assume 12 pages/month manual
    s.addText(`${monthsNeeded}+ months`, {
      x: rx + 0.3, y: colY + 0.65, w: rw - 0.6, h: 0.8,
      fontSize: 48, fontFace: 'Georgia', color: C.text, bold: true, margin: 0,
    })
    s.addText('to manually upgrade every winner page', {
      x: rx + 0.3, y: colY + 1.45, w: rw - 0.6, h: 0.4,
      fontSize: 13, fontFace: 'Calibri', color: C.textDim, italic: true, margin: 0,
    })
    s.addText([
      { text: 'Search behavior shifts every quarter', options: { breakLine: true, bullet: true } },
      { text: 'Competitors deepening their pages now', options: { breakLine: true, bullet: true } },
      { text: 'AI Overview citations being decided today', options: { bullet: true } },
    ], {
      x: rx + 0.3, y: colY + 2.0, w: rw - 0.6, h: 1.3,
      fontSize: 12, fontFace: 'Calibri', color: C.text, paraSpaceAfter: 4,
    })

    // Bottom takeaway
    s.addText(
      'The approach is valid. The velocity is the bottleneck.',
      {
        x: 0.5, y: 6.4, w: 12.3, h: 0.5,
        fontSize: 18, fontFace: 'Georgia', color: C.textDark, italic: true,
        align: 'center',
      }
    )

    s.addNotes(
      `Speaker notes (Slide 5 — The Gap):

Frame as honest reality, not a complaint. We've been doing the right thing — just slower than the market moves.

Suggested narration:
"We're already upgrading content the right way — research the SERP, pull PAA questions, study competitors, write structured briefs, deploy. The team is doing it well. The problem isn't quality. It's velocity.

A single product page upgrade takes 4 to 8 hours of manual research. At realistic team capacity, that's roughly 10 to 15 pages per month. We have ${data.total_winners} winners that deserve this treatment. At that pace, it takes ${monthsNeeded} months or more to get through them all.

In the meantime, the search landscape changes every quarter. AI Overview citations get decided right now. Competitors that deepen their pages this quarter, not next year, will own the next phase of growth. Our approach is right — we just need to compress 4-8 hours into 30-45 minutes per page."

Pause. Move to the solution.`
    )
  }

  // ─── Slide 6: Content Kit Builder (dark, flow diagram) ──────────────────
  {
    const s = pres.addSlide()
    s.background = { color: C.bgDark }
    addTitleStrip(s, 6, 'CONTENT KIT BUILDER')

    s.addText('One winner keyword in.', {
      x: 0.5, y: 1.1, w: 12.3, h: 0.6, fontSize: 26, fontFace: 'Georgia',
      color: C.text, bold: true,
    })
    s.addText('One comprehensive product page brief out.', {
      x: 0.5, y: 1.7, w: 12.3, h: 0.5, fontSize: 18, fontFace: 'Georgia',
      color: C.accent, italic: true,
    })

    // 3-column flow: INPUT → PROCESS → OUTPUT
    const flowY = 2.7
    const flowH = 3.6
    const colW2 = 4.0
    const gap2 = 0.15
    const positions = [0.5, 0.5 + colW2 + gap2, 0.5 + 2 * (colW2 + gap2)]

    const cols = [
      {
        title: 'INPUT',
        items: [
          '1 cluster winner KW',
          'from existing Keyword Master',
        ],
        accent: false,
      },
      {
        title: 'PROCESS (~45 sec)',
        items: [
          'SERP scrape (PAA + related)',
          'Semantic expansion (DFS Labs)',
          'Long-tail integration (Hugin)',
          'Intent classifier (filter)',
          'Fan-out generator (Haiku)',
          'Content gap analysis',
        ],
        accent: true,
      },
      {
        title: 'OUTPUT',
        items: [
          'Section blueprint (5-7 H2)',
          'FAQ (EN + ID side-by-side)',
          'Fan-out passages library',
          'Keyword placement map',
          'Cross-link suggestions',
          'FAQPage JSON-LD schema',
        ],
        accent: false,
      },
    ]
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]
      const x = positions[i]
      s.addShape(SH.RECTANGLE, {
        x, y: flowY, w: colW2, h: flowH,
        fill: { color: c.accent ? '2D1B1E' : C.card },
        line: { color: c.accent ? C.accent : C.border, width: c.accent ? 2 : 1 },
      })
      s.addText(c.title, {
        x: x + 0.3, y: flowY + 0.25, w: colW2 - 0.6, h: 0.4,
        fontSize: 11, fontFace: 'Calibri',
        color: c.accent ? C.accent : C.textDim,
        bold: true, charSpacing: 4, margin: 0,
      })
      s.addText(c.items.map((it, idx) => ({
        text: it,
        options: { bullet: true, breakLine: idx < c.items.length - 1 },
      })), {
        x: x + 0.3, y: flowY + 0.75, w: colW2 - 0.6, h: flowH - 1.0,
        fontSize: 13, fontFace: 'Calibri', color: C.text,
        paraSpaceAfter: 6, valign: 'top',
      })
    }

    // Arrows between columns
    const arrowY = flowY + flowH / 2
    for (let i = 0; i < 2; i++) {
      const arrX = positions[i] + colW2 + 0.01
      s.addShape(SH.LINE, {
        x: arrX, y: arrowY, w: gap2 - 0.02, h: 0,
        line: { color: C.accent, width: 2, endArrowType: 'triangle' },
      })
    }

    // Bottom tagline
    s.addText(
      'From one keyword winner, into one product page that owns the entire topic.',
      {
        x: 0.5, y: 6.55, w: 12.3, h: 0.4,
        fontSize: 16, fontFace: 'Georgia', color: C.textDim, italic: true,
        align: 'center',
      }
    )

    s.addNotes(
      `Speaker notes (Slide 6 — Content Kit Builder):

This is the WHAT. Keep it simple — flow diagram tells the story.

Suggested narration:
"The Content Kit Builder is the solution. From the Keyword Master page, you click one button on any cluster winner. The system automatically does six things in roughly 45 seconds:

It scrapes the SERP for the primary keyword, pulling People Also Ask questions and related searches. It expands semantically using DataForSEO Labs. It pulls relevant long-tail queries from Hugin. It classifies the intent of every candidate keyword, filtering out anything that would dilute the transactional intent of our product page. It generates AI Overview-style sub-queries using Haiku. And it analyzes content gaps versus the top 10 competitors on the SERP.

The output is everything we need to upgrade that product page comprehensively — a section blueprint mapping H2 headers to supporting keywords, an FAQ section in English and Indonesian side-by-side, a library of short passages optimized for LLM citation, a keyword placement map, cross-link suggestions to related products, and schema markup. All of this feeds into Bragi, our existing content generator, in the same review flow we use today."

Move to the demo.`
    )
  }

  // ─── Slide 7: Demo Workflow (light, 6-step timeline) ────────────────────
  {
    const s = pres.addSlide()
    s.background = { color: C.bgLight }
    addTitleStrip(s, 7, 'DEMO — REAL EXAMPLE')

    s.addShape(SH.RECTANGLE, {
      x: 0, y: 7.0, w: 13.3, h: 0.5, fill: { color: C.bgLight }, line: { color: 'FFFFFF' },
    })
    s.addShape(SH.LINE, {
      x: 0.5, y: 7.0, w: 12.3, h: 0, line: { color: C.borderLight, width: 0.5 },
    })
    s.addText('G2G SEO  ·  Confidential', {
      x: 0.5, y: 7.1, w: 12.3, h: 0.3, fontSize: 9, fontFace: 'Calibri', color: C.textDimDark,
    })

    s.addText('Path of Exile 2 — "cheap poe 2 item"', {
      x: 0.5, y: 1.1, w: 12.3, h: 0.6, fontSize: 24, fontFace: 'Georgia',
      color: C.textDark, bold: true,
    })
    s.addText('Real winner KW · Tier 1 · EN · Currently ranked #2', {
      x: 0.5, y: 1.65, w: 12.3, h: 0.4, fontSize: 14, fontFace: 'Calibri',
      color: C.textDimDark, italic: true,
    })

    // 6-step horizontal timeline
    const steps = [
      { num: '1', title: 'CLICK',         desc: 'Build Content Kit on winner row' },
      { num: '2', title: 'ANALYZE',       desc: 'SERP + intent classifier · 45 sec' },
      { num: '3', title: 'REVIEW',        desc: '5 H2 sections + 10 FAQ + 8 passages' },
      { num: '4', title: 'TWEAK',         desc: 'Remove unwanted, edit phrasing' },
      { num: '5', title: 'SEND TO BRAGI', desc: 'Brief into existing pipeline' },
      { num: '6', title: 'PUBLISH',       desc: 'Approve + upload via CMS' },
    ]
    const stepY = 2.4
    const stepH = 1.6
    const stepW = (12.3 - 5 * 0.15) / 6
    let sx = 0.5
    for (const st of steps) {
      // Connector line
      if (st.num !== '1') {
        s.addShape(SH.LINE, {
          x: sx - 0.15, y: stepY + 0.4, w: 0.15, h: 0,
          line: { color: C.accent, width: 2 },
        })
      }
      // Number circle
      s.addShape(SH.OVAL, {
        x: sx + (stepW - 0.8) / 2, y: stepY, w: 0.8, h: 0.8,
        fill: { color: C.accent }, line: { color: C.accent },
      })
      s.addText(st.num, {
        x: sx + (stepW - 0.8) / 2, y: stepY, w: 0.8, h: 0.8,
        fontSize: 28, fontFace: 'Georgia', color: 'FFFFFF', bold: true,
        align: 'center', valign: 'middle', margin: 0,
      })
      // Title
      s.addText(st.title, {
        x: sx, y: stepY + 0.9, w: stepW, h: 0.35,
        fontSize: 11, fontFace: 'Calibri', color: C.textDark, bold: true,
        align: 'center', charSpacing: 2, margin: 0,
      })
      // Description
      s.addText(st.desc, {
        x: sx, y: stepY + 1.25, w: stepW, h: 0.45,
        fontSize: 10, fontFace: 'Calibri', color: C.textDimDark,
        align: 'center', margin: 0,
      })
      sx += stepW + 0.15
    }

    // Below: Output preview card
    const outY = 4.4
    s.addText('Sample kit output — auto-generated:', {
      x: 0.5, y: outY, w: 12.3, h: 0.35, fontSize: 12, fontFace: 'Calibri',
      color: C.textDimDark, charSpacing: 2,
    })
    const outBoxH = 2.0
    s.addShape(SH.RECTANGLE, {
      x: 0.5, y: outY + 0.45, w: 12.3, h: outBoxH,
      fill: { color: C.cardLight }, line: { color: C.borderLight, width: 1 },
    })
    s.addShape(SH.RECTANGLE, {
      x: 0.5, y: outY + 0.45, w: 0.06, h: outBoxH, fill: { color: C.accent }, line: { color: C.accent },
    })
    s.addText([
      { text: 'Section blueprint — 5 H2 ', options: { bold: true } },
      { text: '(all commercial-supportive after intent filter):', options: { italic: true, breakLine: true } },
      { text: '• Cheap PoE 2 Items — Best Prices Curated  ', options: { breakLine: true } },
      { text: '• How to Buy PoE 2 Items Safely  ', options: { breakLine: true } },
      { text: '• Cross-Platform Delivery: PoE 2 Items for PC, PS5, Xbox  ', options: { breakLine: true } },
      { text: '• Best Item Packages for League Start  ', options: { breakLine: true } },
      { text: '• PoE 2 Items vs Farming Yourself  ', options: { breakLine: true } },
      { text: 'Cross-links: ', options: { bold: true } },
      { text: 'Diablo 4 Currency · Last Epoch Gold · PoE 2 Currency', options: {} },
    ], {
      x: 0.8, y: outY + 0.6, w: 11.7, h: outBoxH - 0.3,
      fontSize: 12, fontFace: 'Calibri', color: C.textDark, valign: 'top', paraSpaceAfter: 2,
    })

    s.addText('Total cycle: ~25-45 minutes from click to live page.', {
      x: 0.5, y: outY + 2.55, w: 12.3, h: 0.4,
      fontSize: 14, fontFace: 'Georgia', color: C.accent, italic: true,
      align: 'center',
    })

    s.addNotes(
      `Speaker notes (Slide 7 — Demo Workflow):

This is where the boss will picture using it. Walk through concretely.

Suggested narration:
"Let me walk you through a real example using one of our actual winners — 'cheap poe 2 item' on Path of Exile 2, Tier 1, English market, currently ranked #2.

Step one: I click Build Content Kit on that row in Keyword Master.
Step two: the system analyzes for about 45 seconds — scraping the SERP, classifying intent on every candidate keyword, generating fan-out queries.
Step three: a preview appears showing me five H2 sections, ten FAQ questions, and eight short passages — all pre-filtered for commercial intent. I can see at the bottom of the slide what it generated: section by section, all five H2s passed the intent filter as commercial-supportive. No fluff.
Step four: I review, maybe remove one section I don't want, tweak phrasing on a FAQ.
Step five: I click Send to Bragi. The brief enters our existing content generation pipeline.
Step six: I review the generated draft, approve, upload via the CMS pipeline we already have.

Total time from click to live page: 25 to 45 minutes. Versus 4 to 8 hours today. That's a 10x velocity gain on quality work we're already doing."

Move to the cost and ask.`
    )
  }

  // ─── Slide 8: Cost, Timeline, Outcomes, Ask (dark) ──────────────────────
  {
    const s = pres.addSlide()
    s.background = { color: C.bgDark }
    addTitleStrip(s, 8, 'COST · TIMELINE · OUTCOMES')

    s.addText('Cheap to run. Quick to ship.', {
      x: 0.5, y: 1.1, w: 12.3, h: 0.6, fontSize: 28, fontFace: 'Georgia',
      color: C.text, bold: true,
    })
    s.addText('Built on infrastructure we already have.', {
      x: 0.5, y: 1.7, w: 12.3, h: 0.5, fontSize: 18, fontFace: 'Georgia',
      color: C.textDim, italic: true,
    })

    // Cost table — left
    const costX = 0.5, costW = 6.0, costY = 2.7, costH = 3.5
    s.addShape(SH.RECTANGLE, {
      x: costX, y: costY, w: costW, h: costH,
      fill: { color: C.card }, line: { color: C.border, width: 1 },
    })
    s.addText('Cost per kit', {
      x: costX + 0.3, y: costY + 0.25, w: costW - 0.6, h: 0.4,
      fontSize: 11, fontFace: 'Calibri', color: C.accent,
      bold: true, charSpacing: 3, margin: 0,
    })

    const costRows: [string, string][] = [
      ['SERP scrape (primary)',         '$0.002'],
      ['Related keywords expansion',     '$0.005'],
      ['Intent classification × 15',     '$0.015'],
      ['Fan-out generator (Haiku)',      '$0.005'],
      ['Content gap analyzer (Haiku)',   '$0.010'],
    ]
    let crY = costY + 0.7
    for (const [label, val] of costRows) {
      s.addText(label, {
        x: costX + 0.3, y: crY, w: costW - 1.8, h: 0.32,
        fontSize: 12, fontFace: 'Calibri', color: C.text, valign: 'middle', margin: 0,
      })
      s.addText(val, {
        x: costX + costW - 1.8, y: crY, w: 1.5, h: 0.32,
        fontSize: 12, fontFace: 'Calibri', color: C.textDim,
        align: 'right', valign: 'middle', margin: 0,
      })
      crY += 0.36
    }
    s.addShape(SH.LINE, {
      x: costX + 0.3, y: crY + 0.05, w: costW - 0.6, h: 0,
      line: { color: C.border, width: 0.5 },
    })
    s.addText('Total per kit', {
      x: costX + 0.3, y: crY + 0.15, w: costW - 1.8, h: 0.4,
      fontSize: 14, fontFace: 'Calibri', color: C.accent, bold: true, valign: 'middle', margin: 0,
    })
    s.addText('~$0.037', {
      x: costX + costW - 1.8, y: crY + 0.15, w: 1.5, h: 0.4,
      fontSize: 16, fontFace: 'Georgia', color: C.accent, bold: true,
      align: 'right', valign: 'middle', margin: 0,
    })

    // Right — practical scenarios
    const sceX = 6.8, sceW = 6.0
    s.addShape(SH.RECTANGLE, {
      x: sceX, y: costY, w: sceW, h: costH,
      fill: { color: '2D1B1E' }, line: { color: C.accent, width: 1 },
    })
    s.addText('Practical scenarios', {
      x: sceX + 0.3, y: costY + 0.25, w: sceW - 0.6, h: 0.4,
      fontSize: 11, fontFace: 'Calibri', color: C.accent,
      bold: true, charSpacing: 3, margin: 0,
    })
    const scenarios: Array<[string, string]> = [
      [`One-shot all ${data.total_winners} winners`,  '~$17'],
      ['Monthly refresh top 20',                       '~$9 / year'],
      ['Weekly refresh top 50',                        '~$96 / year'],
    ]
    let scrY = costY + 0.7
    for (const [label, val] of scenarios) {
      s.addText(label, {
        x: sceX + 0.3, y: scrY, w: sceW - 2.0, h: 0.4,
        fontSize: 13, fontFace: 'Calibri', color: C.text, valign: 'middle', margin: 0,
      })
      s.addText(val, {
        x: sceX + sceW - 2.0, y: scrY, w: 1.7, h: 0.4,
        fontSize: 18, fontFace: 'Georgia', color: C.text, bold: true,
        align: 'right', valign: 'middle', margin: 0,
      })
      scrY += 0.5
    }
    // Timeline + zero added cost (compact, single-line entries)
    s.addShape(SH.LINE, {
      x: sceX + 0.3, y: scrY + 0.05, w: sceW - 0.6, h: 0,
      line: { color: C.border, width: 0.5 },
    })
    s.addText([
      { text: 'Engineering: ', options: { bold: true } },
      { text: '2 weeks · 3-4 sprints', options: { breakLine: true } },
      { text: 'Content: ', options: { bold: true } },
      { text: '$0 extra (uses Bragi)', options: { breakLine: true } },
      { text: 'Risk: ', options: { bold: true } },
      { text: 'low (enriches existing pipeline)', options: {} },
    ], {
      x: sceX + 0.3, y: scrY + 0.15, w: sceW - 0.6, h: 1.0,
      fontSize: 11, fontFace: 'Calibri', color: C.text, paraSpaceAfter: 2,
    })

    // Bottom — the ask
    const askY = 6.4
    s.addText('From keyword hunting to topical authority.', {
      x: 0.5, y: askY, w: 12.3, h: 0.4,
      fontSize: 20, fontFace: 'Georgia', color: C.accent, italic: true,
      align: 'center',
    })
    s.addText('Same team. Same infrastructure. Ten times the velocity.', {
      x: 0.5, y: askY + 0.45, w: 12.3, h: 0.4,
      fontSize: 14, fontFace: 'Calibri', color: C.textDim, align: 'center',
    })

    s.addNotes(
      `Speaker notes (Slide 8 — Cost & Ask):

Close strong. The numbers are tiny vs the upside.

Suggested narration:
"The cost breakdown is straightforward. Each Content Kit costs about 3.7 cents to generate — that's DataForSEO calls for SERP analysis and intent classification, plus two Haiku calls for fan-out and content gap analysis.

In practical terms: one-shot building kits for all ${data.total_winners} cluster winners costs roughly $17 total. Monthly refreshing the top 20 most strategic ones — about $9 per year. Even an aggressive weekly refresh of the top 50 only costs us $96 a year.

Engineering is roughly 2 weeks, 3 to 4 sprints. The content team adds zero additional cost because we're using Bragi which we already built. Risk is low because we're not replacing anything — we're enriching the input to the brief pipeline. If the kit produces garbage on some keyword, we just don't send it to Bragi. Existing workflow is fully intact.

What I'm asking for is approval to roll this out. We'll start the Sprint chain this cycle. Mimir learning loop stays active so we polish the output continuously. And we'll measure impact via the Friday KPI digest — AI Visibility, ranking distribution, long-tail capture, dwell time. If the numbers don't move in 90 days, we kill it. They will move."

End on the tagline. Open Q&A.`
    )
  }

  return pres
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[deck] Fetching data from Supabase…')
  const data = await fetchDeckData()
  console.log('[deck] Data summary:', JSON.stringify(data, null, 2))

  console.log('[deck] Building presentation…')
  const pres = buildDeck(data)

  const outPath = 'seo-evolution-deck.pptx'
  await pres.writeFile({ fileName: outPath })
  console.log(`[deck] Saved → ${outPath}`)
}

// Only auto-run when invoked directly (not when imported by smoke test)
if (process.argv[1]?.endsWith('generate-seo-evolution-deck.ts')) {
  main().catch(err => {
    console.error('[deck] FAILED:', err)
    process.exit(1)
  })
}
