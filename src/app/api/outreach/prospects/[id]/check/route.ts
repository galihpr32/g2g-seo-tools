import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// POST /api/outreach/prospects/[id]/check
// Fetches the published URL and checks if a backlink to g2g.com still exists
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const { id } = await params

  // Fetch the prospect
  const { data: prospect, error: fetchError } = await db
    .from('outreach_prospects')
    .select('id, published_url, status')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .single()

  if (fetchError || !prospect) {
    return NextResponse.json({ error: 'Prospect not found' }, { status: 404 })
  }

  if (!prospect.published_url) {
    return NextResponse.json({ error: 'No published URL set for this prospect' }, { status: 400 })
  }

  // Fetch the page and check for g2g.com link
  let backlinkLive = false
  let checkError: string | null = null

  try {
    const res = await fetch(prospect.published_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; G2GSEOBot/1.0; +https://g2g.com)',
      },
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      checkError = `HTTP ${res.status}`
    } else {
      const html = await res.text()
      // Check for any g2g.com link (href containing g2g.com)
      backlinkLive = /href=["'][^"']*g2g\.com[^"']*["']/i.test(html)
    }
  } catch (e) {
    checkError = String(e)
  }

  // Update DB
  await db
    .from('outreach_prospects')
    .update({
      backlink_live:   backlinkLive,
      last_checked_at: new Date().toISOString(),
      check_error:     checkError,
      updated_at:      new Date().toISOString(),
    })
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  return NextResponse.json({
    id,
    published_url:  prospect.published_url,
    backlink_live:  backlinkLive,
    check_error:    checkError,
    checked_at:     new Date().toISOString(),
  })
}
