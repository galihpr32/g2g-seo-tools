import React from 'react'

export type Intent = 'I' | 'N' | 'C' | 'T'

const CONFIG: Record<Intent, { label: string; title: string; classes: string }> = {
  I: {
    label: 'I',
    title: 'Informational — user wants to learn or research',
    classes: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  },
  N: {
    label: 'N',
    title: 'Navigational — user wants a specific site or page',
    classes: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  },
  C: {
    label: 'C',
    title: 'Commercial — user is comparing before buying',
    classes: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  },
  T: {
    label: 'T',
    title: 'Transactional — user wants to buy or take action',
    classes: 'bg-green-500/15 text-green-300 border-green-500/30',
  },
}

interface IntentBadgeProps {
  intent: Intent | null | undefined
  loading?: boolean
}

export function IntentBadge({ intent, loading }: IntentBadgeProps) {
  if (loading) {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold border bg-gray-800 border-gray-700 text-gray-600 animate-pulse">
        ?
      </span>
    )
  }
  if (!intent) return null

  const cfg = CONFIG[intent]
  return (
    <span
      title={cfg.title}
      className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold border flex-shrink-0 cursor-help ${cfg.classes}`}
    >
      {cfg.label}
    </span>
  )
}

// Filter pill for use in filter bars
export function IntentFilter({
  intent,
  active,
  count,
  onClick,
}: {
  intent: Intent
  active: boolean
  count: number
  onClick: () => void
}) {
  const cfg = CONFIG[intent]
  return (
    <button
      onClick={onClick}
      title={cfg.title}
      className={`text-xs px-2.5 py-1.5 rounded-lg border transition flex items-center gap-1.5 ${
        active
          ? `${cfg.classes} border-opacity-100`
          : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
      }`}
    >
      <span className="font-bold">{cfg.label}</span>
      <span className="text-gray-500">{count}</span>
    </button>
  )
}

export const INTENT_LABELS: Record<Intent, string> = {
  I: 'Informational',
  N: 'Navigational',
  C: 'Commercial',
  T: 'Transactional',
}
