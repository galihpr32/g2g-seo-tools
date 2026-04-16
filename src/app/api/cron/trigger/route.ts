import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Server-side trigger for manual sync — only authenticated users can call this
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/cron/gsc-daily`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    })
    const data = await res.json()
    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
