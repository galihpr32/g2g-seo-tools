'use client'

import { useParams } from 'next/navigation'
import MonthlyReportPage from '@/app/(dashboard)/reports/monthly/page'

const KNOWN_SITES = ['g2g', 'offgamers']

export default function SiteMonthlyReportPage() {
  const params = useParams()
  const rawSite = (params?.site as string) || 'g2g'
  // Guard against unknown slugs
  const site = KNOWN_SITES.includes(rawSite) ? rawSite : 'g2g'
  return <MonthlyReportPage site={site} />
}
