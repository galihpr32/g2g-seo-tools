import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Resolve the "effective owner" user ID for data queries.
 *
 * - If the calling user is a workspace owner (or has no membership):
 *   returns their own user ID.
 * - If the calling user is an ACTIVE member of someone else's workspace:
 *   returns the owner's user ID so all data queries use the owner's connections.
 *
 * Usage in every server page/component:
 *   const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
 *   // then query: .eq('user_id', effectiveOwnerId)
 */
export async function getEffectiveOwnerId(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  // Fast path: look up by member_user_id (already linked)
  const { data } = await supabase
    .from('workspace_members')
    .select('owner_user_id')
    .eq('member_user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  if (data?.owner_user_id) return data.owner_user_id

  // Fallback: invited user who accepted the email invite but was never linked.
  // When Supabase creates the user on invite acceptance, member_user_id is still null.
  // We look up by email and auto-link so data sharing works immediately.
  const { data: { user } } = await supabase.auth.getUser()
  if (user?.email) {
    const { data: byEmail } = await supabase
      .from('workspace_members')
      .select('id, owner_user_id, status')
      .eq('member_email', user.email.toLowerCase())
      .in('status', ['active', 'pending'])
      .is('member_user_id', null)
      .maybeSingle()

    if (byEmail) {
      // Auto-link: stamp the real user ID and activate so next requests use the fast path
      await supabase
        .from('workspace_members')
        .update({
          member_user_id: userId,
          status:         'active',
          approved_at:    byEmail.status === 'pending' ? new Date().toISOString() : undefined,
        })
        .eq('id', byEmail.id)

      return byEmail.owner_user_id
    }
  }

  return userId
}

/**
 * Returns the user's role in the workspace.
 * - 'owner'  : this user is the workspace owner (has their own connections)
 * - 'manager': active member with manager role
 * - 'member' : active member with member role
 * - 'pending': pre-registered but not yet approved
 * - null     : not part of any workspace (solo user)
 */
export async function getWorkspaceRole(
  supabase: SupabaseClient,
  userId: string
): Promise<'owner' | 'manager' | 'member' | 'pending' | null> {
  // Check if this user IS an owner (they have workspace_members rows they created)
  const { count: ownedCount } = await supabase
    .from('workspace_members')
    .select('*', { count: 'exact', head: true })
    .eq('owner_user_id', userId)

  if ((ownedCount ?? 0) > 0) return 'owner'

  // Otherwise check if they're a member
  const { data } = await supabase
    .from('workspace_members')
    .select('role, status')
    .eq('member_user_id', userId)
    .maybeSingle()

  if (!data) return null
  if (data.status === 'pending')  return 'pending'
  if (data.status === 'active')   return data.role as 'manager' | 'member'
  return null
}

/**
 * Returns whether the current user can see team performance data.
 * Only workspace owners and members with role='manager' can see this.
 */
export async function canSeeTeamPerformance(
  supabase: SupabaseClient,
  userId: string
): Promise<boolean> {
  const role = await getWorkspaceRole(supabase, userId)
  // null = solo user (no workspace set up yet) → full access
  return role === 'owner' || role === 'manager' || role === null
}
