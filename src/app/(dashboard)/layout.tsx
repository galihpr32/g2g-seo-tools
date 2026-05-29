// Auth uses cookies → implicitly dynamic, no need to force it explicitly
import DashboardShell from '@/components/dashboard/DashboardShell'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getWorkspaceRole } from '@/lib/workspace'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'

// Sprint FRIDAY.KPI.PUBLIC-LINK — paths that should be reachable by anonymous
// visitors when shared externally. Two flavours:
//
//   STATIC_PUBLIC: page has no auth-gated data fetch, so we just render the
//                  body without the dashboard shell — same URL, no login.
//
//   REDIRECT_TO_PUBLIC_WEEKLY: page DOES fetch auth-gated APIs, so rendering
//                  it directly would 401 the data. Instead we redirect anon
//                  visitors to the tokenized /public/weekly/<token> route,
//                  which is purpose-built for unauthenticated access. URL in
//                  the browser changes; data still loads.
const STATIC_PUBLIC_PATHS = [
  '/methodology/competitive-keywords',
]
const REDIRECT_TO_PUBLIC_WEEKLY = [
  '/reports/weekly',
]

function matchesAny(pathname: string, list: string[]): boolean {
  return list.some(p => pathname === p || pathname.startsWith(p + '/'))
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const hdrs = await headers()
  const pathname = hdrs.get('x-pathname') ?? ''

  // ── Anonymous → /reports/weekly: redirect to the published public token ──
  if (!user && matchesAny(pathname, REDIRECT_TO_PUBLIC_WEEKLY)) {
    const db = createServiceClient()
    const { data: pub } = await db
      .from('weekly_reports')
      .select('public_token')
      .eq('publish_status', 'published')
      .not('public_token', 'is', null)
      .order('published_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const token = (pub?.public_token ?? null) as string | null
    if (token) redirect(`/public/weekly/${token}`)
    // No published token yet → bare placeholder. Don't dump them to login
    // because that's confusing when they followed a shared link.
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="text-5xl mb-4">📭</div>
          <h1 className="text-xl font-bold mb-2">No public weekly report yet</h1>
          <p className="text-sm text-gray-400">The team hasn't published this week's report publicly. Check back soon.</p>
        </div>
      </div>
    )
  }

  // ── Anonymous → static public path: render bare, no shell ───────────────-
  if (!user && matchesAny(pathname, STATIC_PUBLIC_PATHS)) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100">
        {children}
      </div>
    )
  }

  if (!user) redirect('/login')

  // Check workspace role — block pending members from accessing the dashboard
  const role = await getWorkspaceRole(supabase, user.id)

  if (role === 'pending') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-8">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-10 max-w-md w-full text-center">
          <div className="text-5xl mb-4">⏳</div>
          <h1 className="text-white text-xl font-bold mb-2">Waiting for approval</h1>
          <p className="text-gray-400 text-sm leading-relaxed mb-6">
            Your account has been registered and is waiting for the workspace owner to approve your access.
            You'll be able to log in once approved.
          </p>
          <p className="text-gray-600 text-xs">
            Signed in as <span className="text-gray-400">{user.email}</span>
          </p>
          <form action="/api/auth/signout" method="POST" className="mt-6">
            <button
              type="submit"
              className="text-sm text-gray-500 hover:text-gray-300 transition underline"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    )
  }

  return <DashboardShell>{children}</DashboardShell>
}
