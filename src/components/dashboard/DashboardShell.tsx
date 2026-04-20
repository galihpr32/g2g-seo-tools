'use client'

import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'

const KNOWN_SITES = ['g2g', 'offgamers']

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // Detect site slug from URL prefix (/offgamers/... → 'offgamers')
  const parts = pathname.split('/').filter(Boolean)
  const site = parts.length > 0 && KNOWN_SITES.includes(parts[0]) ? parts[0] : 'g2g'

  return (
    <div className="flex min-h-screen bg-gray-950" data-site={site}>
      <Sidebar />
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  )
}
