'use client'

import { useParams } from 'next/navigation'
import WeeklyReportPage from '@/app/(dashboard)/reports/weekly/page'

const KNOWN_SITES = ['g2g', 'offgamers']

export default function SiteWeeklyReportPage() {
  const params = useParams()
  const rawSite = (params?.site as string) || 'g2g'
  // Guard against unknown slugs
  const site = KNOWN_SITES.includes(rawSite) ? rawSite : 'g2g'
  return <WeeklyReportPage site={site} />
}
