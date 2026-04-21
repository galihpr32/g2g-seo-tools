import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// GET /api/outreach/prospects?status=contacted&q=search&page=1
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const url    = new URL(req.url)
  const status = url.searchParams.get('status') ?? ''
  const q      = url.searchParams.get('q') ?? ''
  const page   = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'))
  const limit  = 50

  let query = db
    .from('outreach_prospects')
    .select('*')
    .eq('owner_user_id', ownerId)
    .order('updated_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)

  if (status) query = query.eq('status', status)
  if (q)      query = query.ilike('domain', `%${q}%`)

  const { data: items } = await query

  // Status counts
  const { data: rawCounts } = await db
    .from('outreach_prospects')
    .select('status')
    .eq('owner_user_id', ownerId)

  type StatusCounts = Record<string, number>
  const counts: StatusCounts = { all: 0, prospecting: 0, contacted: 0, negotiating: 0, accepted: 0, published: 0, rejected: 0 }
  for (const row of rawCounts ?? []) {
    counts.all++
    if (row.status in counts) counts[row.status]++
  }

  return NextResponse.json({ items: items ?? [], counts, page })
}

// POST /api/outreach/prospects — add a new prospect (from discovery or manually)
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    domain:           string
    authority_score?: number
    organic_traffic?: number
    organic_keywords?: number
    contact_name?:    string
    contact_email?:   string
    topic?:           string
    target_url?:      string
    anchor_text?:     string
    notes?:           string
    follow_up_date?:  string
    source_keyword?:  string
    discovered_via?:  string
  }

  if (!body.domain?.trim()) {
    return NextResponse.json({ error: 'domain is required' }, { status: 400 })
  }

  const { data, error } = await db
    .from('outreach_prospects')
    .upsert({
      owner_user_id:    ownerId,
      domain:           body.domain.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''),
      authority_score:  body.authority_score ?? null,
      organic_traffic:  body.organic_traffic ?? null,
      organic_keywords: body.organic_keywords ?? null,
      contact_name:     body.contact_name    ?? null,
      contact_email:    body.contact_email   ?? null,
      topic:            body.topic           ?? null,
      target_url:       body.target_url      ?? null,
      anchor_text:      body.anchor_text     ?? null,
      notes:            body.notes           ?? null,
      follow_up_date:   body.follow_up_date  ?? null,
      source_keyword:   body.source_keyword  ?? null,
      discovered_via:   body.discovered_via  ?? 'manual',
      status:           'prospecting',
      updated_at:       new Date().toISOString(),
    }, { onConflict: 'owner_user_id,domain' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ prospect: data })
}
