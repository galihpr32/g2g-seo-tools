import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getWorkspaceRole } from '@/lib/workspace'

// GET /api/workspace/role — returns the current user's workspace role
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const role = await getWorkspaceRole(supabase, user.id)
  // null = solo user (no workspace), treat as owner-level
  const isMember = role === 'member' || role === 'manager'

  return NextResponse.json({ role: role ?? 'owner', isMember })
}
