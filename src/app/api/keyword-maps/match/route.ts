import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// ── POST — find best-matching map for a keyword ───────────────────────────────
// Body: { keyword }
// Returns: { suggestedMap, allMaps }
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { keyword = '' } = await req.json().catch(() => ({}))

  const { data: maps } = await db
    .from('keyword_maps')
    .select('id, topic, topic_slug, aliases, status')
    .eq('owner_user_id', ownerId)
    .order('created_at', { ascending: false })

  if (!maps?.length) return NextResponse.json({ suggestedMap: null, allMaps: [] })

  // Strip generic gaming marketplace terms to get topic tokens
  const stripped = keyword
    .toLowerCase()
    .replace(/\b(buy|cheap|best|free|top|how\s+to|get|sell|purchase|price|guide|tips|safe|fast|instant|legit|trusted)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const kwTokens = new Set(stripped.split(' ').filter((t: string) => t.length > 1))

  let bestMap = null
  let bestScore = 0

  for (const map of maps) {
    let score = 0
    const topicTokens = map.topic_slug.split('-').filter((t: string) => t.length > 1)
    const aliases: string[] = (map.aliases ?? []).map((a: string) => a.toLowerCase())

    // Score: each topic token found in keyword tokens
    for (const t of topicTokens) {
      if (kwTokens.has(t)) score += 2
      // Also check raw keyword (not stripped)
      if (keyword.toLowerCase().includes(t)) score += 1
    }
    // Alias match (stronger signal)
    for (const alias of aliases) {
      if (keyword.toLowerCase().includes(alias)) score += 3
    }

    if (score > bestScore) {
      bestScore = score
      bestMap   = map
    }
  }

  // Only suggest if confidence is reasonable (at least one meaningful match)
  return NextResponse.json({
    suggestedMap: bestScore >= 2 ? bestMap : null,
    allMaps:      maps,
  })
}
