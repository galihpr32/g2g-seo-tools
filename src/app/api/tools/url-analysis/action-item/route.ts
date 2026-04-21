import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { url, action_type, notes } = body

    if (!url || !action_type || !['on_page', 'off_page'].includes(action_type)) {
      return NextResponse.json(
        { error: 'Invalid request: url and action_type (on_page|off_page) required' },
        { status: 400 }
      )
    }

    const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
    const db = createServiceClient()

    // Get the site_url from gsc_connections
    const { data: gscConn } = await db
      .from('gsc_connections')
      .select('site_url')
      .eq('user_id', effectiveOwnerId)
      .maybeSingle()

    if (!gscConn?.site_url) {
      return NextResponse.json(
        { error: 'No GSC connection found. Please connect Google Search Console first.' },
        { status: 400 }
      )
    }

    // Create action item
    const { data, error } = await db
      .from('seo_action_items')
      .insert({
        user_id: effectiveOwnerId,
        site_url: gscConn.site_url,
        page: url,
        action_type,
        notes: notes || null,
        status: 'pending',
        snapshot_date: new Date().toISOString().split('T')[0],
      })
      .select('id')
      .single()

    if (error) {
      console.error('Supabase insert error:', error)
      return NextResponse.json(
        { error: 'Failed to create action item', detail: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({ id: data.id })
  } catch (err) {
    console.error('Action item creation error:', err)
    return NextResponse.json(
      { error: 'Internal server error', detail: String(err) },
      { status: 500 }
    )
  }
}
