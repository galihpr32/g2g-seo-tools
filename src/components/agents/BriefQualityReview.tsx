/**
 * BriefQualityReview — comprehensive Tyr review render (SWA-style).
 *
 * Renders 5 sections:
 *   1. Mimir's auto-suggestion panel (override/regen/section-regen/rerun)
 *   2. Overall score gauge + verdict reasoning
 *   3. Per-dimension bars (8 dimensions × 10) with comments
 *   4. Strengths (green) / Weaknesses (red) two-column
 *   5. Prioritised suggestions (sortable by priority)
 *
 * Backwards-compat: if breakdown is in old shape (only flat coverage /
 * intent_match / keyword_grounding / faq_realism), render limited 4-dim
 * view with a notice.
 */
import TyrSuggestionPanel from '@/components/agents/TyrSuggestionPanel'
import { suggestTyrAction } from '@/lib/agents/tyr-suggestion'

interface DimensionScore {
  score:    number          // 0-10
  comment:  string
}

interface Suggestion {
  priority: 'high' | 'medium' | 'low'
  text:     string
}

export interface TyrBreakdown {
  // New rich shape (from Tyr v2+).
  // `internal_links` is OPTIONAL — Tyr omits it for standalone pages with
  // no related content to link to (isolated product lines, one-off landings).
  // The UI iterates Object.entries(dimensions) so missing entries simply
  // aren't rendered, and the overall score scales by present dimensions.
  dimensions?: {
    coverage:           DimensionScore
    intent_match:       DimensionScore
    heading_structure:  DimensionScore
    keyword_strategy:   DimensionScore
    eeat_signals:       DimensionScore
    faq_quality:        DimensionScore
    meta_description:   DimensionScore
    internal_links?:    DimensionScore
  }
  strengths?:    string[]
  weaknesses?:   string[]
  suggestions?:  Suggestion[]

  // Legacy shape (Tyr v1)
  coverage?:          number
  intent_match?:      number
  keyword_grounding?: number
  faq_realism?:       number
  redflags?:          string[]
  reasoning?:         string
}

const DIMENSION_META: Record<keyof NonNullable<TyrBreakdown['dimensions']>, { label: string; emoji: string; help: string }> = {
  coverage:          { label: 'Sub-intent Coverage',  emoji: '🎯', help: 'Does the outline cover what users actually search for?' },
  intent_match:      { label: 'Intent Match',          emoji: '🧭', help: 'H1 + meta align with commercial intent?' },
  heading_structure: { label: 'Heading Structure',     emoji: '🪜', help: 'Single H1, 4-6 well-named H2s, no skipped levels' },
  keyword_strategy:  { label: 'Keyword Strategy',      emoji: '🔑', help: 'Primary + LSI variants, semantic variation' },
  eeat_signals:      { label: 'E-E-A-T Signals',       emoji: '🛡️', help: 'Trust, expertise, authoritativeness signals planned' },
  faq_quality:       { label: 'FAQ Quality',           emoji: '❓', help: 'Real "People Also Ask" questions, grounded answers' },
  meta_description:  { label: 'Meta Description',      emoji: '📄', help: '150-160 chars, primary keyword, clear CTA' },
  internal_links:    { label: 'Internal Linking',      emoji: '🔗', help: 'Plans links to related categories/pillars' },
}

const PRIORITY_META: Record<Suggestion['priority'], { color: string; bg: string; emoji: string; label: string }> = {
  high:   { color: 'text-red-300',    bg: 'bg-red-900/30 border-red-700/40',       emoji: '🔥', label: 'HIGH' },
  medium: { color: 'text-amber-300',  bg: 'bg-amber-900/30 border-amber-700/40',   emoji: '⚡', label: 'MEDIUM' },
  low:    { color: 'text-blue-300',   bg: 'bg-blue-900/30 border-blue-700/40',     emoji: '💡', label: 'LOW' },
}

interface Props {
  score?:     number | null      // overall 0-100
  status?:    string | null      // 'reviewed' | 'borderline' | 'failed'
  reviewedAt?: string | null
  threshold?: number             // default 80
  breakdown:  TyrBreakdown | null
  /** Brief id — needed for the suggestion panel's action wiring. When omitted
   *  the panel is hidden (e.g. preview surfaces). */
  briefId?:   string
  /** Hide the suggestion panel (e.g. brief is published — actions don't apply) */
  hideSuggestion?: boolean
}

function scoreColor(score: number, threshold: number): string {
  if (score >= threshold + 10) return 'text-green-400'
  if (score >= threshold)      return 'text-orange-400'
  if (score >= threshold - 10) return 'text-amber-400'
  return 'text-red-400'
}

function scoreBgColor(score: number, threshold: number): string {
  if (score >= threshold + 10) return 'bg-green-500'
  if (score >= threshold)      return 'bg-orange-500'
  if (score >= threshold - 10) return 'bg-amber-500'
  return 'bg-red-500'
}

function dimensionBgColor(score: number): string {
  if (score >= 8) return 'bg-green-500'
  if (score >= 6) return 'bg-orange-500'
  if (score >= 4) return 'bg-amber-500'
  return 'bg-red-500'
}

export default function BriefQualityReview({
  score,
  status,
  reviewedAt,
  threshold = 80,
  breakdown,
  briefId,
  hideSuggestion,
}: Props) {
  if (!breakdown) return null

  // Compute auto-suggestion ONCE — pure function, no side effects.
  // Hidden when no briefId (preview), explicitly hidden, or when status
  // is already 'reviewed' (Override action would be redundant).
  const suggestion = (briefId && !hideSuggestion)
    ? suggestTyrAction({ score: score ?? null, status: status ?? null, breakdown })
    : null

  const isRichShape = !!breakdown.dimensions
  const hasAnyContent =
    isRichShape ||
    breakdown.coverage != null ||
    breakdown.reasoning ||
    (breakdown.redflags && breakdown.redflags.length > 0)

  if (!hasAnyContent) return null

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-5">
      {/* Mimir's auto-suggestion — surfaces FIRST so Specialist 1 sees the
          recommended action before scrolling through dimension scores. */}
      {suggestion && briefId && (
        <TyrSuggestionPanel briefId={briefId} suggestion={suggestion} />
      )}

      <header className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            ⚖️ Tyr Quality Review
          </h2>
          <p className="text-gray-400 text-xs mt-0.5">
            {(() => {
              const dimCount = isRichShape && breakdown.dimensions
                ? Object.values(breakdown.dimensions).filter(Boolean).length
                : 4
              return `Comprehensive ${dimCount}-dimension SEO brief audit`
            })()}
            {reviewedAt && ` · Reviewed ${new Date(reviewedAt).toLocaleDateString()}`}
          </p>
        </div>
        {/* Overall score gauge */}
        {score != null && (
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className={`text-4xl font-bold font-mono ${scoreColor(score, threshold)}`}>{score}</p>
              <p className="text-xs text-gray-500">/ 100</p>
            </div>
            <div className={`px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider ${
              status === 'reviewed'   ? 'bg-green-900/50 text-green-300' :
              status === 'borderline' ? 'bg-amber-900/50 text-amber-300' :
              status === 'failed'     ? 'bg-red-900/50 text-red-300'    :
                                        'bg-gray-800 text-gray-400'
            }`}>
              {status ?? '—'}
            </div>
          </div>
        )}
      </header>

      {/* Overall reasoning */}
      {breakdown.reasoning && (
        <div className="mb-5 p-3 bg-gray-950 border-l-2 border-purple-500 rounded">
          <p className="text-xs uppercase tracking-wider text-purple-400 mb-1">Overall Verdict</p>
          <p className="text-gray-300 text-sm leading-relaxed">{breakdown.reasoning}</p>
        </div>
      )}

      {/* Score gauge bar */}
      {score != null && (
        <div className="mb-6">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
            <span>0</span>
            <span>Threshold {threshold}</span>
            <span>100</span>
          </div>
          <div className="relative h-2.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className={`h-full ${scoreBgColor(score, threshold)} transition-all`}
              style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
            />
            {/* threshold marker */}
            <div
              className="absolute top-0 bottom-0 w-px bg-white/40"
              style={{ left: `${threshold}%` }}
            />
          </div>
        </div>
      )}

      {/* Dimensions — rich shape */}
      {isRichShape && breakdown.dimensions && (
        <div className="mb-6">
          <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">Per-Dimension Breakdown</h3>
          <div className="space-y-2.5">
            {/* N/A note: Tyr omits internal_links for standalone pages with no related content */}
            {!breakdown.dimensions.internal_links && (
              <div className="mb-2.5 px-3 py-2 bg-gray-950/50 border border-gray-800/60 border-dashed rounded-lg flex items-center gap-2 text-xs text-gray-500">
                <span>🔗</span>
                <span><span className="text-gray-400 font-medium">Internal Linking</span> — N/A (no related G2G content for this page; not scored)</span>
              </div>
            )}
            {Object.entries(breakdown.dimensions).map(([key, dim]) => {
              const meta = DIMENSION_META[key as keyof typeof DIMENSION_META]
              if (!meta || !dim) return null  // skip if dim missing (e.g. internal_links omitted)
              return (
                <div key={key} className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1.5 gap-3">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span>{meta.emoji}</span>
                      <p className="text-white text-sm font-medium truncate" title={meta.help}>{meta.label}</p>
                    </div>
                    <p className={`font-mono font-bold text-sm ${
                      dim.score >= 8 ? 'text-green-400' :
                      dim.score >= 6 ? 'text-orange-400' :
                      dim.score >= 4 ? 'text-amber-400' : 'text-red-400'
                    }`}>
                      {dim.score}/10
                    </p>
                  </div>
                  <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden mb-1.5">
                    <div
                      className={`h-full ${dimensionBgColor(dim.score)} transition-all`}
                      style={{ width: `${(dim.score / 10) * 100}%` }}
                    />
                  </div>
                  {dim.comment && (
                    <p className="text-gray-400 text-xs leading-relaxed">{dim.comment}</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Legacy shape — show flat scores if rich not available */}
      {!isRichShape && (
        <div className="mb-6 p-3 bg-amber-950/20 border border-amber-800/30 rounded text-xs text-amber-300">
          ℹ This brief was reviewed by an older Tyr version (4 dimensions only). Rerun Tyr to get the full 8-dimension audit.
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
            {([['Coverage', breakdown.coverage], ['Intent', breakdown.intent_match], ['Keywords', breakdown.keyword_grounding], ['FAQ', breakdown.faq_realism]] as const).map(([label, val]) =>
              val != null ? (
                <div key={label} className="bg-gray-950 rounded p-2 text-center">
                  <p className="text-white font-bold text-base">{val}/10</p>
                  <p className="text-gray-500 text-[10px] uppercase tracking-wider">{label}</p>
                </div>
              ) : null
            )}
          </div>
        </div>
      )}

      {/* Strengths + Weaknesses */}
      {(breakdown.strengths?.length || breakdown.weaknesses?.length || breakdown.redflags?.length) ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {breakdown.strengths && breakdown.strengths.length > 0 && (
            <div className="bg-green-950/20 border border-green-800/30 rounded-lg p-4">
              <h3 className="text-xs uppercase tracking-wider text-green-400 mb-2">✅ Strengths</h3>
              <ul className="space-y-1.5 text-sm text-gray-300">
                {breakdown.strengths.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-green-400">+</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {((breakdown.weaknesses && breakdown.weaknesses.length > 0) || (breakdown.redflags && breakdown.redflags.length > 0)) && (
            <div className="bg-red-950/20 border border-red-800/30 rounded-lg p-4">
              <h3 className="text-xs uppercase tracking-wider text-red-400 mb-2">⚠️ Weaknesses</h3>
              <ul className="space-y-1.5 text-sm text-gray-300">
                {(breakdown.weaknesses ?? breakdown.redflags ?? []).map((w, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-red-400">−</span>
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}

      {/* Suggestions — sorted by priority */}
      {breakdown.suggestions && breakdown.suggestions.length > 0 && (
        <div>
          <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">📋 Suggestions to improve</h3>
          <ul className="space-y-2">
            {[...breakdown.suggestions]
              .sort((a, b) => {
                const order = { high: 0, medium: 1, low: 2 }
                return order[a.priority] - order[b.priority]
              })
              .map((s, i) => {
                const m = PRIORITY_META[s.priority]
                return (
                  <li key={i} className={`flex items-start gap-3 p-2.5 rounded border ${m.bg}`}>
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${m.color} bg-black/20 flex-shrink-0`}>
                      {m.emoji} {m.label}
                    </span>
                    <p className="text-sm text-gray-200 leading-relaxed flex-1">{s.text}</p>
                  </li>
                )
              })}
          </ul>
        </div>
      )}
    </section>
  )
}
