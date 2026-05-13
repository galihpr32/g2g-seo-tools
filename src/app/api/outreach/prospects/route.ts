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
    domain:             string
    site?:              string   // which brand is adding this prospect ('g2g' | 'offgamers')
    authority_score?:   number
    organic_traffic?:   number
    organic_keywords?:  number
    contact_name?:      string
    contact_email?:     string
    topic?:             string
    target_url?:        string
    anchor_text?:       string
    notes?:             string
    follow_up_date?:    string
    source_keyword?:    string
    discovered_via?:    string
    // Hermod v2 — Brief mode + score breakdown
    approval_required?: boolean
    score_breakdown?:   Record<string, unknown>
  }

  // Resolve site slug: body.site → active-site cookie → 'g2g'
  const cookieSite = req.headers.get('cookie')?.match(/active-site=([^;]+)/)?.[1] ?? 'g2g'
  const siteSlug   = body.site ?? cookieSite

  if (!body.domain?.trim()) {
    return NextResponse.json({ error: 'domain is required' }, { status: 400 })
  }

  const briefMode = body.approval_required === true

  // Compose notes — preserve any user-supplied notes, append the score
  // breakdown JSON as a tail block so existing tooling that reads `notes`
  // still works while we expose structured data downstream.
  let notesField = body.notes ?? null
  if (body.score_breakdown && Object.keys(body.score_breakdown).length) {
    const tail = `\n\n---\nHermod score: ${JSON.stringify(body.score_breakdown)}`
    notesField = (notesField ?? '') + tail
  }

  const { data, error } = await db
    .from('outreach_prospects')
    .upsert({
      owner_user_id:    ownerId,
      site_slug:        siteSlug,
      domain:           body.domain.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''),
      authority_score:  body.authority_score ?? null,
      organic_traffic:  body.organic_traffic ?? null,
      organic_keywords: body.organic_keywords ?? null,
      contact_name:     body.contact_name    ?? null,
      contact_email:    body.contact_email   ?? null,
      topic:            body.topic           ?? null,
      target_url:       body.target_url      ?? null,
      anchor_text:      body.anchor_text     ?? null,
      notes:            notesField,
      follow_up_date:   body.follow_up_date  ?? null,
      source_keyword:   body.source_keyword  ?? null,
      discovered_via:   body.discovered_via  ?? 'manual',
      status:           'prospecting',
      // Brief mode — queue as pending_approval so the row sits idle until
      // the user clicks Send on the Outreach page (clears approved_for_send_at).
      approval_required:    briefMode,
      approved_for_send_at: briefMode ? null : new Date().toISOString(),
      approved_for_send_by: briefMode ? null : ownerId,
      updated_at:       new Date().toISOString(),
    }, { onConflict: 'owner_user_id,site_slug,domain' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ prospect: data })
}
