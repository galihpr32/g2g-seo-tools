'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { SERP_COUNTRIES } from '@/lib/country-config'

export function CountryPicker({ currentDb }: { currentDb: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function handleChange(db: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('db', db)
    router.push(`?${params.toString()}`)
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-gray-500 text-sm">Market:</span>
      <select
        value={currentDb}
        onChange={e => handleChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 cursor-pointer"
      >
        {SERP_COUNTRIES.map(c => (
          <option key={c.semrushDb} value={c.semrushDb}>
            {c.flag} {c.label}
          </option>
        ))}
      </select>
    </div>
  )
}
