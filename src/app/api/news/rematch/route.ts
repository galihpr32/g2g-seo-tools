import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 30

/**
 * POST /api/news/rematch
 *
 * Re-evaluates KB matching for ALL existing news_game_extractions of this
 * owner using the latest fuzzy matcher (token overlap + abbreviation
 * expansion). Use after KB changes or after the matcher is upgraded —
 * avoids needing to re-run Haiku extraction (saves cost).
 *
 * Returns counts: { evaluated, newly_matched, kept_matched }
 */

const KB_STOP_TOKENS = new Set([
  'account','accounts','accs','acc','gold','silver','diamonds','crystals','gems',
  'items','keys','cards','top-up','topup','currency','coins','credits','tokens',
  'wallet','voucher','vouchers','coaching','boost','boosting','services','service',
  'gift','rivals','dlc','expansion','recharge','code','codes',
])

const GAME_ABBREVIATIONS: Record<string, string[]> = {
  'wow':   ['world','of','warcraft'],
  'lol':   ['league','of','legends'],
  'csgo':  ['counter','strike','global','offensive'],
  'cs':    ['counter','strike'],
  'mlbb':  ['mobile','legends','bang','bang'],
  'pubg':  ['playerunknowns','battlegrounds'],
  'gi':    ['genshin','impact'],
  'gta':   ['grand','theft','auto'],
  'tft':   ['teamfight','tactics'],
  'd2r':   ['diablo','2','resurrected'],
  'd4':    ['diablo','4'],
  'ff':    ['final','fantasy'],
  'ffxiv': ['final','fantasy','xiv'],
  'cod':   ['call','of','duty'],
  'rs':    ['runescape'],
  'osrs':  ['old','school','runescape'],
  'apex':  ['apex','legends'],
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !KB_STOP_TOKENS.has(t))
}
function expand(arr: string[]): string[] {
  const out: string[] = []
  for (const t of arr) {
    out.push(t)
    const e = GAME_ABBREVIATIONS[t]
    if (e) out.push(...e)
  }
  return out
}
function fuzzyMatchKb(extracted: string, kb: string): boolean {
  const a = expand(tokens(extracted))
  const b = expand(tokens(kb))
  if (a.length === 0 || b.length === 0) return false
  const setB = new Set(b)
  return a.some(t => setB.has(t))
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  // Pull all KB category items + all existing extractions for this owner
  const [{ data: kb }, { data: extractions }] = await Promise.all([
    db.from('knowledge_base_items').select('id, name').eq('owner_user_id', ownerId).eq('category', 'category'),
    db.from('news_game_extractions').select('id, game_name, kb_matched, kb_category_id').eq('owner_user_id', ownerId),
  ])

  const kbList   = (kb ?? []) as Array<{ id: string; name: string }>
  const extList  = (extractions ?? []) as Array<{ id: string; game_name: string; kb_matched: boolean; kb_category_id: string | null }>

  let newlyMatched = 0
  let keptMatched  = 0
  let unchanged    = 0

  for (const ext of extList) {
    let bestMatch: { id: string; name: string } | null = null
    for (const k of kbList) {
      if (fuzzyMatchKb(ext.game_name, k.name)) {
        bestMatch = { id: k.id, name: k.name }
        break
      }
    }

    if (bestMatch && !ext.kb_matched) {
      // Newly matched — flip true
      await db
        .from('news_game_extractions')
        .update({ kb_matched: true, kb_category_id: bestMatch.id })
        .eq('id', ext.id)
      newlyMatched++
    } else if (bestMatch && ext.kb_matched) {
      // Already matched, possibly re-bind kb_category_id
      if (ext.kb_category_id !== bestMatch.id) {
        await db
          .from('news_game_extractions')
          .update({ kb_category_id: bestMatch.id })
          .eq('id', ext.id)
      }
      keptMatched++
    } else if (!bestMatch && ext.kb_matched) {
      // Was matched but no longer — keep as-is to avoid surprise data loss.
      // Operator can manually clear via DB if KB intentionally removed an entry.
      keptMatched++
    } else {
      unchanged++
    }
  }

  return NextResponse.json({
    ok:             true,
    evaluated:      extList.length,
    newly_matched:  newlyMatched,
    kept_matched:   keptMatched,
    unchanged,
    kb_categories:  kbList.length,
  })
}
