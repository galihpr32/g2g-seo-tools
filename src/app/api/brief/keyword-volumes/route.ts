import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getKeywordVolumes } from '@/lib/semrush/client'

export const maxDuration = 30

// POST /api/brief/keyword-volumes
// Body: { keywords: string[], database?: string }
// Returns: { volumes: Record<string, { search_volume, cpc, keyword_difficulty }> }
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const keywords: string[] = Array.isArray(body.keywords) ? body.keywords.slice(0, 100) : []
  const database: string = typeof body.database === 'string' ? body.database : 'us'

  if (keywords.length === 0) {
    return NextResponse.json({ volumes: {} })
  }

  const map = await getKeywordVolumes(keywords, database)
  const volumes: Record<string, { search_volume: number; cpc: number; keyword_difficulty: number }> = {}
  for (const [kw, data] of map) {
    volumes[kw] = data
  }

  return NextResponse.json({ volumes })
}
