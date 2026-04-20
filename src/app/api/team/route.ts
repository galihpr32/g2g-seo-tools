import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// ── GET /api/team — list all workspace members for the current owner ──────────
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: members, error } = await supabase
    .from('workspace_members')
    .select('id, member_email, member_user_id, role, status, created_at, approved_at')
    .eq('owner_user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ members: members ?? [] })
}

// ── POST /api/team — owner pre-registers a member email ──────────────────────
// Body: { email: string, role?: 'member' | 'manager' }
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { email, role = 'member' } = await request.json() as { email: string; role?: string }

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
  }

  // Can't add yourself
  if (email.toLowerCase() === user.email?.toLowerCase()) {
    return NextResponse.json({ error: 'You cannot add yourself as a team member' }, { status: 400 })
  }

  // Check if email is already a member of this workspace
  const { data: existing } = await supabase
    .from('workspace_members')
    .select('id, status')
    .eq('owner_user_id', user.id)
    .eq('member_email', email.toLowerCase())
    .maybeSingle()

  if (existing) {
    return NextResponse.json(
      { error: `${email} is already ${existing.status === 'active' ? 'an active member' : 'pending approval'}` },
      { status: 409 }
    )
  }

  // Check if this email is already registered in Supabase auth (for immediate linking)
  // We do this via service role since auth.users is not accessible from client
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const serviceSupabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: authUsers } = await serviceSupabase.auth.admin.listUsers()
  const existingUser = authUsers?.users?.find(
    u => u.email?.toLowerCase() === email.toLowerCase()
  )

  // Only treat as an existing confirmed user if they've actually verified their email.
  // An unconfirmed user (e.g. from a previous broken invite) still needs a new invite email.
  const isConfirmed = !!existingUser?.email_confirmed_at

  const { data: member, error } = await supabase
    .from('workspace_members')
    .insert({
      owner_user_id:  user.id,
      member_email:   email.toLowerCase(),
      member_user_id: isConfirmed ? existingUser!.id : null,
      role:           role === 'manager' ? 'manager' : 'member',
      status:         isConfirmed ? 'active' : 'pending',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Send invitation email for any user who hasn't confirmed their account yet
  if (!isConfirmed) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? ''
    await serviceSupabase.auth.admin.inviteUserByEmail(email.toLowerCase(), {
      redirectTo: `${appUrl}/dashboard`,
    })
  }

  return NextResponse.json({ member })
}

// ── PATCH /api/team — approve, reject, change role, or remove a member ────────
// Body: { id: string, action: 'approve' | 'reject' | 'remove' | 'set_role', role?: string }
export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id, action, role } = await request.json() as {
    id: string
    action: 'approve' | 'reject' | 'remove' | 'set_role'
    role?: string
  }

  if (!id || !action) {
    return NextResponse.json({ error: 'Missing id or action' }, { status: 400 })
  }

  // Verify this record belongs to the current owner (RLS also protects this)
  const { data: record } = await supabase
    .from('workspace_members')
    .select('id, status')
    .eq('id', id)
    .eq('owner_user_id', user.id)
    .single()

  if (!record) return NextResponse.json({ error: 'Member not found' }, { status: 404 })

  let updates: Record<string, unknown> = {}

  if (action === 'approve') {
    updates = { status: 'active', approved_at: new Date().toISOString() }
  } else if (action === 'reject') {
    updates = { status: 'rejected' }
  } else if (action === 'remove') {
    const { error } = await supabase
      .from('workspace_members')
      .delete()
      .eq('id', id)
      .eq('owner_user_id', user.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } else if (action === 'set_role') {
    if (!role || !['member', 'manager'].includes(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
    }
    updates = { role }
  } else {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  const { error } = await supabase
    .from('workspace_members')
    .update(updates)
    .eq('id', id)
    .eq('owner_user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
