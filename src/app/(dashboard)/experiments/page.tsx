'use client'

/**
 * /experiments — Start / Stop / Continue tracker
 *
 * Three-column Kanban: Start (new this period), Continue (carried over),
 * Stop (ended this period). Each card shows the title, hypothesis, success
 * metric, and links to the keywords/pages it touches.
 *
 * Right side: Mimir's Council — a chat panel where the user asks Mimir for
 * experiment ideas grounded in the latest report data. Mimir's proposals
 * render as cards with an "Add as experiment" button → creates the row in
 * the Start column with one click.
 *
 * Site-aware via useSiteSlug — G2G and OffGamers each have their own
 * experiment list and Mimir conversation history.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'
import PromoteToKbButton from '@/components/agents/PromoteToKbButton'

interface Experiment {
  id:               string
  title:            string
  hypothesis:       string | null
  category:         string | null
  status:           'start' | 'continue' | 'stop'
  period_started:   string
  period_ended:     string | null
  success_metric:   string | null
  baseline_value:   number | null
  target_value:     number | null
  current_value:    number | null
  linked_keywords:  string[]
  linked_pages:     string[]
  decision_notes:   string | null
  outcome:          'success' | 'partial' | 'failure' | 'inconclusive' | null
  source:           string | null
  created_at:       string
  updated_at:       string
}

interface MimirProposal {
  title:           string
  hypothesis:      string
  category:        'on-page' | 'content' | 'technical' | 'links' | 'experimentation'
  successMetric:   string
  baselineValue?:  number
  targetValue?:    number
  linkedKeywords?: string[]
  linkedPages?:    string[]
  confidence:      number
  effort:          number
}

interface ChatMessage {
  role:    'user' | 'assistant'
  content: string
  ts?:     string
  proposals?: MimirProposal[]
}

interface EvidenceCard {
  experiment: {
    id:             string
    title:          string
    status:         string
    baseline_value: number | null
    target_value:   number | null
    current_value:  number | null
    period_started: string
  }
  card: {
    id:             string
    recommendation: 'continue' | 'stop' | 'inconclusive'
    rationale:      string
    confidence:     number
  }
}

const CAT_COLORS: Record<string, string> = {
  'on-page':         'bg-blue-500/15 text-blue-300 border-blue-500/30',
  'content':         'bg-purple-500/15 text-purple-300 border-purple-500/30',
  'technical':       'bg-amber-500/15 text-amber-300 border-amber-500/30',
  'links':           'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'experimentation': 'bg-pink-500/15 text-pink-300 border-pink-500/30',
}

const STATUS_LABELS = {
  start:    { label: 'Start',    icon: '🌱', tint: 'border-green-500/30 bg-green-500/5' },
  continue: { label: 'Continue', icon: '🔄', tint: 'border-blue-500/30 bg-blue-500/5' },
  stop:     { label: 'Stop',     icon: '🛑', tint: 'border-red-500/30 bg-red-500/5' },
} as const

function periodLabel(period: string): string {
  // 'YYYY-MM' → 'Apr 2026'
  const [y, m] = period.split('-')
  const d = new Date(Number(y), Number(m) - 1, 1)
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

// ── Experiment card ────────────────────────────────────────────────────────
function ExperimentCard({ exp, onTransition, onDelete }: {
  exp:          Experiment
  onTransition: (id: string, status: Experiment['status'], extras?: Partial<Experiment>) => void
  onDelete:     (id: string) => void
}) {
  const [showDecisionForm, setShowDecisionForm] = useState(false)
  const [decisionNotes,    setDecisionNotes]    = useState('')
  const [outcome,          setOutcome]          = useState<Experiment['outcome']>('partial')

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {exp.category && (
              <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-medium ${CAT_COLORS[exp.category] ?? 'bg-gray-800 text-gray-400 border-gray-700'}`}>
                {exp.category}
              </span>
            )}
            <span className="text-[10px] text-gray-500">{periodLabel(exp.period_started)}{exp.period_ended ? ` → ${periodLabel(exp.period_ended)}` : ''}</span>
            {exp.source === 'mimir' && (
              <span className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">🪶 Mimir</span>
            )}
          </div>
          <h3 className="text-white text-sm font-semibold leading-tight">{exp.title}</h3>
        </div>
        <button onClick={() => onDelete(exp.id)} className="text-gray-700 hover:text-red-400 text-xs leading-none px-1" title="Delete">×</button>
      </div>

      {exp.hypothesis && <p className="text-gray-400 text-xs leading-relaxed mb-2">{exp.hypothesis}</p>}

      {exp.success_metric && (
        <div className="mb-2 px-2 py-1.5 bg-gray-800/50 rounded text-[11px]">
          <p className="text-gray-500 uppercase tracking-wider text-[9px] mb-0.5">Success metric</p>
          <p className="text-gray-300">{exp.success_metric}</p>
          {(exp.baseline_value != null || exp.target_value != null) && (
            <p className="text-gray-500 mt-0.5">
              {exp.baseline_value != null && <>baseline: <span className="text-gray-300">{exp.baseline_value}</span></>}
              {exp.target_value != null && <>{exp.baseline_value != null ? ' · ' : ''}target: <span className="text-gray-300">{exp.target_value}</span></>}
              {exp.current_value != null && <> · current: <span className="text-white font-medium">{exp.current_value}</span></>}
            </p>
          )}
        </div>
      )}

      {/* Stagnant flag: experiment hasn't seen current_value movement in 14d.
          We approximate "stagnant" using updated_at since the weekly cron
          ONLY writes when the value changes meaningfully (>0.05 diff). So if
          updated_at hasn't advanced in 14 days, the metric isn't moving. */}
      {exp.status === 'continue' && exp.current_value != null && (() => {
        const ageDays = (Date.now() - new Date(exp.updated_at).getTime()) / 86400_000
        if (ageDays >= 14) {
          return (
            <div className="mb-2 px-2 py-1 bg-amber-500/10 border border-amber-500/30 rounded text-[10px] text-amber-300 flex items-center gap-1.5">
              <span>⚠️</span>
              <span>Stagnant — metric unchanged for {Math.floor(ageDays)}d. Candidate to stop.</span>
            </div>
          )
        }
        return null
      })()}

      {(exp.linked_keywords.length > 0 || exp.linked_pages.length > 0) && (
        <div className="flex flex-wrap gap-1 mb-2">
          {exp.linked_keywords.slice(0, 4).map(kw => (
            <span key={kw} className="text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">🎯 {kw}</span>
          ))}
          {exp.linked_pages.slice(0, 2).map(p => (
            <span key={p} className="text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded truncate max-w-[180px]" title={p}>📄 {p}</span>
          ))}
        </div>
      )}

      {exp.decision_notes && (
        <div className="mt-2 px-2 py-1.5 bg-red-500/5 border border-red-500/20 rounded text-[11px]">
          <p className="text-red-300 uppercase tracking-wider text-[9px] mb-0.5">Lesson learned ({exp.outcome ?? 'n/a'})</p>
          <p className="text-gray-300">{exp.decision_notes}</p>
        </div>
      )}

      {/* When experiment ended SUCCESS, surface "Promote to KB" — this is the
          codification step that turns a validated bet into a permanent rule. */}
      {exp.status === 'stop' && exp.outcome === 'success' && (
        <div className="mt-2 flex justify-end">
          <PromoteToKbButton
            source="experiment_promote"
            experimentId={exp.id}
            defaultTitle={`Validated: ${exp.title}`}
            defaultRuleText={[
              exp.hypothesis ? `Hypothesis: ${exp.hypothesis}` : null,
              exp.decision_notes ? `Lesson: ${exp.decision_notes}` : null,
            ].filter(Boolean).join('\n\n') || ''}
            defaultPatternKind="winning"
          />
        </div>
      )}

      {/* Lifecycle actions */}
      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-800">
        {exp.status === 'start' && (
          <button onClick={() => onTransition(exp.id, 'continue')} className="text-[11px] text-blue-300 hover:text-blue-200 px-2 py-1 rounded bg-blue-500/10 border border-blue-500/30 hover:bg-blue-500/20 transition">
            🔄 Mark Continue
          </button>
        )}
        {exp.status === 'continue' && (
          <button onClick={() => setShowDecisionForm(s => !s)} className="text-[11px] text-red-300 hover:text-red-200 px-2 py-1 rounded bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 transition">
            🛑 End experiment
          </button>
        )}
        {exp.status === 'stop' && (
          <button onClick={() => onTransition(exp.id, 'continue')} className="text-[11px] text-gray-400 hover:text-white px-2 py-1 rounded bg-gray-800 border border-gray-700 hover:border-gray-600 transition">
            ↺ Re-open
          </button>
        )}
      </div>

      {showDecisionForm && (
        <div className="mt-3 space-y-2 bg-gray-800/40 rounded p-2.5">
          <select value={outcome ?? 'partial'} onChange={e => setOutcome(e.target.value as Experiment['outcome'])}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-red-500">
            <option value="success">✅ Success</option>
            <option value="partial">⚠️ Partial</option>
            <option value="failure">❌ Failure</option>
            <option value="inconclusive">❓ Inconclusive</option>
          </select>
          <textarea value={decisionNotes} onChange={e => setDecisionNotes(e.target.value)}
            placeholder="Lesson learned — what worked, what didn't, what would you do differently?"
            rows={3}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-red-500" />
          <div className="flex gap-2">
            <button
              onClick={() => {
                onTransition(exp.id, 'stop', { decision_notes: decisionNotes, outcome })
                setShowDecisionForm(false)
              }}
              disabled={!decisionNotes.trim()}
              className="flex-1 text-xs bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white px-2 py-1.5 rounded transition"
            >
              Confirm Stop
            </button>
            <button onClick={() => setShowDecisionForm(false)} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1.5 transition">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Mimir's chat panel ─────────────────────────────────────────────────────
function MimirPanel({ siteSlug, onAccept }: {
  siteSlug: string
  onAccept: (proposal: MimirProposal) => Promise<void>
}) {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages]             = useState<ChatMessage[]>([])
  const [input,    setInput]                = useState('')
  const [sending,  setSending]              = useState(false)
  const [error,    setError]                = useState<string | null>(null)

  // Reset thread when site changes — different brand, different conversation
  useEffect(() => {
    setConversationId(null)
    setMessages([])
  }, [siteSlug])

  async function send(messageOverride?: string) {
    const text = messageOverride ?? input
    if (!text.trim() || sending) return
    setSending(true); setError(null)
    // Optimistic — show user message immediately so the UI feels responsive
    const userMsg: ChatMessage = { role: 'user', content: text, ts: new Date().toISOString() }
    setMessages(prev => [...prev, userMsg])
    if (!messageOverride) setInput('')

    try {
      const res = await fetch('/api/experiments/mimir', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ conversationId, message: text, site: siteSlug }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Mimir error')
      setConversationId(data.conversationId)
      setMessages(data.messages)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  const QUICK_PROMPTS = [
    'Generate 3 experiment ideas based on the latest report',
    'What should I test for low-CTR keywords?',
    'Suggest a quick-win experiment I can ship in 1 week',
    'Analyze why keyword X dropped (paste the data)',
  ]

  return (
    <div className="flex flex-col h-full bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-white font-semibold text-sm">🪶 Mimir&apos;s Council</h2>
            <p className="text-amber-300/70 text-[11px]">Norse god of wisdom — generates experiment ideas grounded in your data</p>
          </div>
          <button
            onClick={() => { setConversationId(null); setMessages([]) }}
            disabled={messages.length === 0}
            className="text-[11px] text-gray-500 hover:text-white disabled:opacity-30 px-2 py-1 transition"
          >
            New thread
          </button>
        </div>
      </div>

      {/* Message history */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <p className="text-2xl mb-3">🪶</p>
            <p className="text-gray-400 text-sm font-medium mb-1">Mimir awaits your question.</p>
            <p className="text-gray-600 text-xs mb-5">Try one of these to start:</p>
            <div className="space-y-1.5">
              {QUICK_PROMPTS.map(p => (
                <button key={p} onClick={() => send(p)} disabled={sending}
                  className="block w-full text-left text-xs text-gray-300 bg-gray-800 hover:bg-gray-700 px-3 py-2 rounded-lg transition disabled:opacity-50">
                  &ldquo;{p}&rdquo;
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
              m.role === 'user'
                ? 'bg-red-700/20 text-white border border-red-700/40'
                : 'bg-gray-800 text-gray-200 border border-gray-700'
            }`}>
              <p className="whitespace-pre-wrap">{stripExperimentBlocks(m.content)}</p>
              {m.proposals && m.proposals.length > 0 && (
                <div className="mt-3 space-y-2">
                  {m.proposals.map((p, j) => (
                    <ProposalCard key={j} proposal={p} onAccept={onAccept} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {sending && (
          <div className="flex justify-start">
            <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-400">
              <span className="inline-flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
                Mimir is thinking…
              </span>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-500/10 border-t border-red-500/30 text-xs text-red-300">⚠️ {error}</div>
      )}

      {/* Input */}
      <div className="border-t border-gray-800 p-3 flex gap-2">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Ask Mimir for experiment ideas, paste data to analyze, refine a proposal…"
          rows={2}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500 resize-none"
        />
        <button
          onClick={() => send()}
          disabled={sending || !input.trim()}
          className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm font-semibold px-4 py-2 rounded-lg transition self-end"
        >
          Ask
        </button>
      </div>
    </div>
  )
}

// Strip ```experiment ...``` blocks from chat bubble (proposals render as cards instead)
function stripExperimentBlocks(text: string): string {
  return text.replace(/```experiment[\s\S]+?```/g, '').trim()
}

// ── Mimir's proposal card ──────────────────────────────────────────────────
function ProposalCard({ proposal, onAccept }: {
  proposal: MimirProposal
  onAccept: (p: MimirProposal) => Promise<void>
}) {
  const [accepting, setAccepting] = useState(false)
  const [accepted,  setAccepted]  = useState(false)

  async function handleAccept() {
    setAccepting(true)
    try {
      await onAccept(proposal)
      setAccepted(true)
    } finally {
      setAccepting(false)
    }
  }

  return (
    <div className="bg-gray-900/80 border border-amber-500/30 rounded-lg p-3 text-xs">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <h4 className="font-semibold text-white text-sm flex-1">{proposal.title}</h4>
        <div className="flex gap-1 flex-shrink-0">
          <span className="text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded">⚡{proposal.confidence}/5</span>
          <span className="text-[10px] bg-gray-800 text-gray-400 border border-gray-700 px-1.5 py-0.5 rounded">⏱{proposal.effort}/5</span>
        </div>
      </div>
      <p className="text-gray-300 mb-2 leading-relaxed">{proposal.hypothesis}</p>
      {proposal.successMetric && (
        <p className="text-gray-400 mb-2"><span className="text-gray-500 uppercase text-[9px] tracking-wider">Success: </span>{proposal.successMetric}</p>
      )}
      {((proposal.linkedKeywords?.length ?? 0) > 0 || (proposal.linkedPages?.length ?? 0) > 0) && (
        <div className="flex flex-wrap gap-1 mb-2">
          {(proposal.linkedKeywords ?? []).slice(0, 3).map(kw => <span key={kw} className="text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">🎯 {kw}</span>)}
          {(proposal.linkedPages    ?? []).slice(0, 2).map(p  => <span key={p} className="text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded truncate max-w-[150px]" title={p}>📄 {p}</span>)}
        </div>
      )}
      <button
        onClick={handleAccept}
        disabled={accepting || accepted}
        className={`w-full text-xs font-semibold px-3 py-1.5 rounded transition ${
          accepted
            ? 'bg-green-700/20 text-green-300 border border-green-700/40'
            : 'bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50'
        }`}
      >
        {accepted ? '✓ Added to Start column' : accepting ? 'Adding…' : '+ Add as experiment'}
      </button>
    </div>
  )
}

// ── Manual add modal ───────────────────────────────────────────────────────
function ManualAddForm({ onSave, onCancel }: { onSave: (data: Partial<Experiment>) => Promise<void>; onCancel: () => void }) {
  const [title,         setTitle]    = useState('')
  const [hypothesis,    setHyp]      = useState('')
  const [category,      setCategory] = useState<string>('on-page')
  const [success,       setSuccess]  = useState('')
  const [keywords,      setKeywords] = useState('')
  const [pages,         setPages]    = useState('')
  const [saving,        setSaving]   = useState(false)
  const [err,           setErr]      = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) { setErr('Title required'); return }
    setSaving(true); setErr(null)
    try {
      await onSave({
        title:           title.trim(),
        hypothesis:      hypothesis.trim() || null,
        category,
        success_metric:  success.trim() || null,
        linked_keywords: keywords.split(',').map(s => s.trim()).filter(Boolean),
        linked_pages:    pages.split(',').map(s => s.trim()).filter(Boolean),
      })
      onCancel()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-gray-900 border border-gray-700 rounded-xl p-5 space-y-3 text-sm">
      <h2 className="text-white font-semibold mb-2">+ Add experiment manually</h2>
      <div>
        <label className="block text-xs text-gray-400 mb-1">Title <span className="text-red-500">*</span></label>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Add FAQ section to top 5 category pages"
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-red-500" />
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1">Hypothesis</label>
        <textarea value={hypothesis} onChange={e => setHyp(e.target.value)} rows={2}
          placeholder="Why we think this will help"
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-red-500" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Category</label>
          <select value={category} onChange={e => setCategory(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-red-500">
            {Object.keys(CAT_COLORS).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1">Success metric</label>
        <input value={success} onChange={e => setSuccess(e.target.value)}
          placeholder="e.g. Avg position for [keyword] improves from 14 to ≤8 in 30d"
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-red-500" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Linked keywords <span className="text-gray-600">(comma-separated)</span></label>
          <input value={keywords} onChange={e => setKeywords(e.target.value)}
            placeholder="wow gold, valorant points"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-red-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Linked pages <span className="text-gray-600">(comma-separated)</span></label>
          <input value={pages} onChange={e => setPages(e.target.value)}
            placeholder="/categories/wow-gold"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-red-500" />
        </div>
      </div>
      {err && <p className="text-red-400 text-xs">{err}</p>}
      <div className="flex gap-3 pt-1">
        <button type="submit" disabled={saving} className="bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white font-semibold px-4 py-2 rounded-lg transition">
          {saving ? 'Adding…' : '+ Add experiment'}
        </button>
        <button type="button" onClick={onCancel} className="text-gray-500 hover:text-gray-300 px-4 py-2 transition">Cancel</button>
      </div>
    </form>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function ExperimentsPage() {
  const siteSlug = useSiteSlug()
  const [experiments,  setExperiments]  = useState<Experiment[]>([])
  const [loading,      setLoading]      = useState(true)
  const [showManual,   setShowManual]   = useState(false)
  const [prepLoading,  setPrepLoading]  = useState(false)
  const [prepCards,    setPrepCards]    = useState<EvidenceCard[] | null>(null)
  const [prepSummary,  setPrepSummary]  = useState<{ continueCount: number; stopCount: number; inconclusiveCount: number } | null>(null)
  const [prepError,    setPrepError]    = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/experiments?site=${siteSlug}`)
      if (res.ok) {
        const { experiments } = await res.json()
        setExperiments(experiments ?? [])
      }
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [siteSlug])

   
  useEffect(() => { load() }, [load])

  async function handleManualAdd(data: Partial<Experiment>) {
    const res = await fetch('/api/experiments', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...data, site: siteSlug }),
    })
    if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to add')
    await load()
  }

  async function handleAcceptProposal(p: MimirProposal) {
    const res = await fetch('/api/experiments', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        site:           siteSlug,
        title:          p.title,
        hypothesis:     p.hypothesis,
        category:       p.category,
        success_metric: p.successMetric,
        baseline_value: p.baselineValue,
        target_value:   p.targetValue,
        linked_keywords: p.linkedKeywords ?? [],
        linked_pages:    p.linkedPages    ?? [],
        source:         'mimir',
        source_context: { confidence: p.confidence, effort: p.effort },
      }),
    })
    if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to add')
    await load()
  }

  async function handleTransition(id: string, status: Experiment['status'], extras?: Partial<Experiment>) {
    await fetch('/api/experiments', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id, status, ...extras }),
    })
    await load()
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this experiment? This cannot be undone.')) return
    await fetch(`/api/experiments?id=${id}`, { method: 'DELETE' })
    await load()
  }

  // Pre-meeting prep — Mimir analyzes all active experiments + recommends
  // continue/stop/inconclusive per item. Used by Head before end-of-month
  // decision meeting.
  async function runPrepMeeting() {
    setPrepLoading(true); setPrepError(null); setPrepCards(null); setPrepSummary(null)
    try {
      const res = await fetch('/api/experiments/prep-meeting', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ site: siteSlug }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`)
      setPrepCards(d.evidenceCards ?? [])
      setPrepSummary(d.summary ?? null)
    } catch (e) {
      setPrepError(e instanceof Error ? e.message : String(e))
    } finally {
      setPrepLoading(false)
    }
  }

  // Group by status
  const grouped = useMemo(() => ({
    start:    experiments.filter(e => e.status === 'start'),
    continue: experiments.filter(e => e.status === 'continue'),
    stop:     experiments.filter(e => e.status === 'stop').slice(0, 12),    // limit "history" column
  }), [experiments])

  return (
    <div className="p-8 max-w-[1600px]">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">🧪 Experiments</h1>
          <p className="text-gray-400 text-sm mt-1">
            Start / Stop / Continue framework — test ideas one period at a time. Mimir helps you generate evidence-grounded proposals.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={runPrepMeeting}
            disabled={prepLoading}
            className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm font-semibold px-4 py-2 rounded-lg transition flex items-center gap-1.5"
            title="Mimir analyzes all active experiments + recommends continue/stop"
          >
            {prepLoading ? '🪶 Mimir thinking…' : '🪶 Pre-Meeting Prep'}
          </button>
          <button
            onClick={() => setShowManual(s => !s)}
            className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition"
          >
            + Add manually
          </button>
        </div>
      </div>

      {showManual && (
        <div className="mb-6 max-w-3xl">
          <ManualAddForm onSave={handleManualAdd} onCancel={() => setShowManual(false)} />
        </div>
      )}

      {/* Pre-meeting prep — evidence cards from Mimir */}
      {prepError && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-300">
          ⚠️ {prepError}
        </div>
      )}
      {prepCards && (
        <div className="mb-6 bg-gradient-to-r from-amber-500/5 to-transparent border border-amber-500/30 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-white font-semibold text-sm flex items-center gap-2">
              🪶 Mimir&apos;s Pre-Meeting Recommendations
            </h2>
            {prepSummary && (
              <p className="text-[11px] text-gray-400">
                <span className="text-blue-300">{prepSummary.continueCount} continue</span> ·{' '}
                <span className="text-red-300">{prepSummary.stopCount} stop</span> ·{' '}
                <span className="text-gray-400">{prepSummary.inconclusiveCount} inconclusive</span>
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {prepCards.map(c => {
              const recColor =
                c.card.recommendation === 'continue' ? 'border-blue-500/40 bg-blue-500/5' :
                c.card.recommendation === 'stop'     ? 'border-red-500/40 bg-red-500/5'   :
                                                       'border-gray-700 bg-gray-800/30'
              const recBadge =
                c.card.recommendation === 'continue' ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'  :
                c.card.recommendation === 'stop'     ? 'bg-red-500/15 text-red-300 border-red-500/30'      :
                                                       'bg-gray-700/40 text-gray-400 border-gray-700'
              return (
                <div key={c.experiment.id} className={`rounded-lg p-3 border ${recColor}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${recBadge}`}>
                      {c.card.recommendation}
                    </span>
                    <span className="text-[10px] text-gray-500">⚡{c.card.confidence}/5</span>
                  </div>
                  <p className="text-white font-medium text-xs mb-1">{c.experiment.title}</p>
                  {(c.experiment.baseline_value != null || c.experiment.current_value != null) && (
                    <p className="text-[10px] text-gray-500 mb-2">
                      {c.experiment.baseline_value ?? '?'} → {c.experiment.current_value ?? '?'} (target {c.experiment.target_value ?? '?'})
                    </p>
                  )}
                  <p className="text-[11px] text-gray-300 leading-relaxed">{c.card.rationale}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 2/3 Kanban + 1/3 Mimir */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 min-h-[70vh]">
        {/* Kanban — 2 columns */}
        <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-4">
          {(['start', 'continue', 'stop'] as const).map(status => {
            const meta = STATUS_LABELS[status]
            const items = grouped[status]
            return (
              <section key={status} className={`flex flex-col rounded-xl border ${meta.tint} p-3`}>
                <header className="flex items-center justify-between mb-3 px-1">
                  <h2 className="text-white font-semibold text-sm flex items-center gap-1.5">
                    <span>{meta.icon}</span>{meta.label}
                  </h2>
                  <span className="text-[10px] text-gray-500 bg-gray-900 px-1.5 py-0.5 rounded">{items.length}</span>
                </header>
                <div className="flex-1 space-y-2 overflow-y-auto">
                  {loading ? (
                    <p className="text-gray-500 text-xs text-center py-6">Loading…</p>
                  ) : items.length === 0 ? (
                    <p className="text-gray-600 text-xs text-center py-6 italic">
                      {status === 'start'    && 'No new ideas this period. Ask Mimir →'}
                      {status === 'continue' && 'Nothing carried over yet.'}
                      {status === 'stop'     && 'No experiments stopped.'}
                    </p>
                  ) : items.map(exp => (
                    <ExperimentCard
                      key={exp.id}
                      exp={exp}
                      onTransition={handleTransition}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>

        {/* Mimir — 1 column */}
        <div className="lg:col-span-1 min-h-[600px]">
          <MimirPanel siteSlug={siteSlug} onAccept={handleAcceptProposal} />
        </div>
      </div>
    </div>
  )
}
