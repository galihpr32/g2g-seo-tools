import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Resolve the "effective owner" user ID for data queries.
 *
 * - If the calling user is a workspace owner (or has no membership):
 *   returns their own user ID.
 * - If the calling user is an ACTIVE member of someone else's workspace:
 *   returns the owner's user ID so all data queries use the owner's connections.
 *
 * IMPORTANT: Uses the service role client internally to query workspace_members
 * so that Row Level Security cannot block the lookup. The `supabase` param
 * (user's auth client) is only used to resolve the calling user's email for
 * the invite-flow fallback.
 *
 * Usage in every server page/component:
 *   const ownerId = await getEffectiveOwnerId(supabase, user.id)
 *   const db = createServiceClient()       // use for data queries
 *   db.from('...').eq('user_id', ownerId)  // reads owner's data regardless of RLS
 */
export async function getEffectiveOwnerId(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  // Use service role to bypass RLS on workspace_members
  const db = createServiceClient()

  // Fast path: look up by member_user_id (already linked)
  const { data } = await db
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
    const { data: byEmail } = await db
      .from('workspace_members')
      .select('id, owner_user_id, status')
      .eq('member_email', user.email.toLowerCase())
      .in('status', ['active', 'pending'])
      .is('member_user_id', null)
      .maybeSingle()

    if (byEmail) {
      // Auto-link: stamp the real user ID and activate so next requests use the fast path
      await db
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
  const db = createServiceClient()

  // Check if this user IS an owner (they have workspace_members rows they created)
  const { count: ownedCount } = await db
    .from('workspace_members')
    .select('*', { count: 'exact', head: true })
    .eq('owner_user_id', userId)

  if ((ownedCount ?? 0) > 0) return 'owner'

  // Otherwise check if they're a member
  const { data } = await db
    .from('workspace_members')
    .select('role, status')
    .eq('member_user_id', userId)
    .maybeSingle()

  if (!data) {
    // Last resort: check by email (in case member_user_id is still null)
    const { data: { user } } = await supabase.auth.getUser()
    if (user?.email) {
      const { data: byEmail } = await db
        .from('workspace_members')
        .select('role, status')
        .eq('member_email', user.email.toLowerCase())
        .in('status', ['active', 'pending'])
        .maybeSingle()
      if (byEmail?.status === 'active') return byEmail.role as 'manager' | 'member'
      if (byEmail?.status === 'pending') return 'pending'
    }
    return null
  }

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
