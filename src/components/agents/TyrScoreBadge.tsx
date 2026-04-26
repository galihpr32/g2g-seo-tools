/**
 * TyrScoreBadge — visual differentiator for Tyr quality scores.
 *
 * Color rule:
 *   score ≥ threshold + 10        → green   (clearly good)
 *   score ≥ threshold             → orange  (passed but borderline)
 *   score ≥ threshold - window    → amber   (borderline / needs revision)
 *   score < threshold - window    → red     (failed / regenerate)
 */

interface TyrBreakdown {
  coverage?:           number
  intent_match?:       number
  keyword_grounding?:  number
  faq_realism?:        number
  redflags?:           string[]
  reasoning?:          string
}

export interface TyrScoreBadgeProps {
  score:             number | null | undefined
  threshold?:        number   // default 80
  borderlineWindow?: number   // default 10
  breakdown?:        TyrBreakdown | null
  size?:             'sm' | 'md'
  showLabel?:        boolean
}

export default function TyrScoreBadge({
  score,
  threshold = 80,
  borderlineWindow = 10,
  breakdown,
  size = 'md',
  showLabel = true,
}: TyrScoreBadgeProps) {
  if (score == null) {
    return (
      <span className={`inline-flex items-center gap-1 rounded border border-gray-700/50 bg-gray-800/30 text-gray-500 ${size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'}`}>
        <span>—</span>
        {showLabel && <span>not reviewed</span>}
      </span>
    )
  }

  const failThreshold = threshold - borderlineWindow

  let tier: 'green' | 'orange' | 'amber' | 'red'
  let label: string
  let icon: string

  if (score >= threshold + 10) {
    tier = 'green'; label = 'good';        icon = '🟢'
  } else if (score >= threshold) {
    tier = 'orange'; label = 'passed';     icon = '🟠'
  } else if (score >= failThreshold) {
    tier = 'amber'; label = 'borderline';  icon = '🟠'
  } else {
    tier = 'red'; label = 'failed';        icon = '🔴'
  }

  const tierClasses: Record<typeof tier, string> = {
    green:  'border-green-700/50  bg-green-900/30  text-green-300',
    orange: 'border-orange-700/50 bg-orange-900/30 text-orange-300',
    amber:  'border-amber-700/50  bg-amber-900/30  text-amber-300',
    red:    'border-red-700/50    bg-red-900/30    text-red-300',
  }

  const tooltip = breakdown
    ? buildTooltip(breakdown, score, threshold)
    : `Tyr score ${score}/100 (threshold ${threshold})`

  return (
    <span
      className={`inline-flex items-center gap-1 rounded border ${tierClasses[tier]} ${size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'} font-medium`}
      title={tooltip}
    >
      <span>{icon}</span>
      <span className="font-mono">{score}</span>
      {showLabel && <span className="opacity-80">{label}</span>}
    </span>
  )
}

function buildTooltip(b: TyrBreakdown, score: number, threshold: number): string {
  const parts: string[] = [`Tyr score: ${score}/100 (threshold ${threshold})`]
  const dims: Array<[string, number | undefined]> = [
    ['Coverage',          b.coverage],
    ['Intent match',      b.intent_match],
    ['Keyword grounding', b.keyword_grounding],
    ['FAQ realism',       b.faq_realism],
  ]
  for (const [name, v] of dims) {
    if (typeof v === 'number') parts.push(`${name}: ${v}/10`)
  }
  if (b.reasoning) parts.push(`— ${b.reasoning}`)
  if (b.redflags?.length) parts.push(`Issues: ${b.redflags.slice(0, 3).join('; ')}`)
  return parts.join('\n')
}
