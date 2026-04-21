import { createClient } from '@supabase/supabase-js'

/**
 * Server-side Supabase client using the Service Role key.
 * BYPASSES Row Level Security — use only in server components / API routes.
 * Never import this in client components.
 *
 * Use this when you need to:
 * - Query workspace_members to resolve effective owner ID
 * - Read another user's data on behalf of a workspace member
 */
export function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  )
}
