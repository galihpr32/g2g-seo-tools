export const dynamic = 'force-dynamic'

import Sidebar from '@/components/dashboard/Sidebar'
import { createClient } from '@/lib/supabase/server'
import { getWorkspaceRole } from '@/lib/workspace'
import { redirect } from 'next/navigation'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

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

  return (
    <div className="flex min-h-screen bg-gray-950">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  )
}
