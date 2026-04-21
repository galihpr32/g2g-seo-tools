import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getKeywordOrganicResults, getDomainAuthority, type OutreachCandidate } from '@/lib/semrush/client'

export const maxDuration = 60

// GET /api/outreach/discover?keyword=buy+gaming+currency&database=us&limit=20
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const url      = new URL(req.url)
  const keyword  = url.searchParams.get('keyword') ?? ''
  const database = url.searchParams.get('database') ?? 'us'
  const limit    = Math.min(30, parseInt(url.searchParams.get('limit') ?? '20'))

  if (!keyword.trim()) {
    return NextResponse.json({ error: 'keyword is required' }, { status: 400 })
  }

  // 1. Get domains ranking for keyword
  let candidates: OutreachCandidate[]
  try {
    candidates = await getKeywordOrganicResults(keyword, database, limit)
  } catch (e) {
    return NextResponse.json({ error: `SEMrush error: ${String(e)}` }, { status: 500 })
  }

  if (!candidates.length) {
    return NextResponse.json({ candidates: [], keyword, database })
  }

  // 2. Enrich top 10 with domain authority (parallel, best-effort)
  const top10 = candidates.slice(0, 10)
  const enriched = await Promise.all(
    top10.map(async c => {
      try {
        const auth = await getDomainAuthority(c.domain, database)
        return {
          ...c,
          authorityScore:  auth?.authorityScore  ?? 0,
          organicTraffic:  auth?.organicTraffic   ?? c.organicTraffic,
          organicKeywords: auth?.organicKeywords  ?? 0,
        }
      } catch {
        return c
      }
    })
  )

  // The rest (11-30) get basic data without enrichment
  const rest = candidates.slice(10).map(c => ({ ...c, authorityScore: 0 }))
  const allCandidates = [...enriched, ...rest]

  // 3. Check which domains are already in the tracker
  const domains = allCandidates.map(c => c.domain)
  const { data: existing } = await supabase
    .from('outreach_prospects')
    .select('domain, status')
    .eq('owner_user_id', ownerId)
    .in('domain', domains)

  const existingMap = new Map((existing ?? []).map(r => [r.domain, r.status]))

  // 4. Filter out g2g.com itself
  const filtered = allCandidates
    .filter(c => !c.domain.includes('g2g.com'))
    .map(c => ({
      ...c,
      inTracker:     existingMap.has(c.domain),
      trackerStatus: existingMap.get(c.domain) ?? null,
    }))

  return NextResponse.json({ candidates: filtered, keyword, database, total: filtered.length })
}
