'use client'

/**
 * MimirPanel — the page-aware Mimir companion (Level B).
 *
 * Slide-over from right (~420px) triggered by a "Mimir" button on the host
 * page. Inside: chat thread with Mimir, scoped to the page's data via
 * `pageContext`. Mimir is server-instructed to behave as a writing-coach /
 * report-companion / drop-diagnostician / etc. depending on `kind`.
 *
 * Usage:
 *   <MimirPanel
 *     trigger="Ask Mimir"
 *     pageContext={{ kind: 'monthly_report', id: report.id }}
 *   />
 *
 * The button is the entire UI surface — clicking opens the slide-over. Host
 * pages can also pass `defaultOpen` to start expanded.
 */

import { useEffect, useState } from 'react'
import type { PageContext } from '@/lib/agents/mimir-context'
import type { ExperimentProposal } from '@/lib/agents/mimir-council'

interface ChatMessage {
  role:    'user' | 'assistant'
  content: string
  ts?:     string
  proposals?: ExperimentProposal[]
}

interface MimirPanelProps {
  pageContext: PageContext
  /** Visible label on the trigger button (default: "🪶 Mimir") */
  trigger?: string
  /** Auto-open on mount */
  defaultOpen?: boolean
  /** When the host wants to react to Mimir's experiment proposals (only
   *  applies to kind='experiments'). */
  onProposalAccepted?: (proposal: ExperimentProposal) => Promise<void>
}

export default function MimirPanel({
  pageContext,
  trigger = '🪶 Mimir',
  defaultOpen = false,
  onProposalAccepted,
}: MimirPanelProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Open Mimir for this page"
        className="inline-flex items-center gap-1.5 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-xs font-medium px-3 py-1.5 rounded-lg transition"
      >
        {trigger}
      </button>

      {open && (
        <MimirSlideOver
          pageContext={pageContext}
          onClose={() => setOpen(false)}
          onProposalAccepted={onProposalAccepted}
        />
      )}
    </>
  )
}

// ── Slide-over ─────────────────────────────────────────────────────────────

function MimirSlideOver({
  pageContext, onClose, onProposalAccepted,
}: {
  pageContext: PageContext
  onClose: () => void
  onProposalAccepted?: (proposal: ExperimentProposal) => Promise<void>
}) {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages,       setMessages]       = useState<ChatMessage[]>([])
  const [contextLabel,   setContextLabel]   = useState('Mimir')
  const [quickPrompts,   setQuickPrompts]   = useState<string[]>([])
  const [parseProposals, setParseProposals] = useState(false)
  const [input,          setInput]          = useState('')
  const [sending,        setSending]        = useState(false)
  const [error,          setError]          = useState<string | null>(null)

  // Pre-load past conversations for this exact page (kind + id) so user can
  // resume threads. We pick the most recent if any, or start fresh.
  useEffect(() => {
    const params = new URLSearchParams({ kind: pageContext.kind })
    if (pageContext.id) params.set('id', String(pageContext.id))

    fetch(`/api/mimir/chat?${params.toString()}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.conversations?.length) {
          // Pick most recent and load full thread
          const latest = d.conversations[0]
          fetch(`/api/mimir/chat?conversationId=${latest.id}`)
            .then(r => r.ok ? r.json() : null)
            .then(c => {
              if (c?.conversation) {
                setConversationId(String(c.conversation.id))
                setMessages((c.conversation.messages ?? []) as ChatMessage[])
              }
            })
            .catch(() => { /* silent — start fresh */ })
        }
      })
      .catch(() => { /* silent */ })
  }, [pageContext.kind, pageContext.id])

  async function send(messageOverride?: string) {
    const text = messageOverride ?? input
    if (!text.trim() || sending) return
    setSending(true); setError(null)

    // Optimistic
    setMessages(prev => [...prev, { role: 'user', content: text, ts: new Date().toISOString() }])
    if (!messageOverride) setInput('')

    try {
      const res = await fetch('/api/mimir/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ conversationId, message: text, pageContext }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setConversationId(String(data.conversationId))
      setMessages(data.messages)
      setContextLabel(String(data.contextLabel ?? 'Mimir'))
      setQuickPrompts(data.quickPrompts ?? [])
      setParseProposals(!!data.parseProposals)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" />

      {/* Slide-over */}
      <aside
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md bg-gray-900 border-l border-gray-800 flex flex-col shadow-2xl"
      >
        <header className="px-4 py-3 border-b border-gray-800 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent flex items-center justify-between">
          <div>
            <h2 className="text-white font-semibold text-sm">🪶 {contextLabel}</h2>
            <p className="text-amber-300/70 text-[11px]">Norse god of wisdom — page-aware advisor</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setConversationId(null); setMessages([]) }}
              disabled={messages.length === 0}
              className="text-[11px] text-gray-500 hover:text-white disabled:opacity-30 px-2 py-1 transition"
            >
              New thread
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-gray-500 hover:text-white text-xl leading-none px-1"
            >
              ×
            </button>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="text-center py-8">
              <p className="text-2xl mb-3">🪶</p>
              <p className="text-gray-400 text-sm font-medium mb-1">Mimir awaits.</p>
              <p className="text-gray-600 text-xs mb-5">Try one of these to start:</p>
              <div className="space-y-1.5">
                {(quickPrompts.length > 0 ? quickPrompts : [
                  'Help me understand this page',
                  'What should I focus on first?',
                ]).map(p => (
                  <button
                    key={p}
                    onClick={() => send(p)}
                    disabled={sending}
                    className="block w-full text-left text-xs text-gray-300 bg-gray-800 hover:bg-gray-700 px-3 py-2 rounded-lg transition disabled:opacity-50"
                  >
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
                {m.proposals && m.proposals.length > 0 && parseProposals && onProposalAccepted && (
                  <div className="mt-3 space-y-2">
                    {m.proposals.map((p, j) => (
                      <ProposalCard key={j} proposal={p} onAccept={onProposalAccepted} />
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
            placeholder="Ask Mimir about this page…"
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
      </aside>
    </div>
  )
}

// ── Proposal card (only for experiments kind) ─────────────────────────────

function ProposalCard({ proposal, onAccept }: {
  proposal: ExperimentProposal
  onAccept: (p: ExperimentProposal) => Promise<void>
}) {
  const [accepting, setAccepting] = useState(false)
  const [accepted,  setAccepted]  = useState(false)

  async function handleAccept() {
    setAccepting(true)
    try {
      await onAccept(proposal)
      setAccepted(true)
    } finally { setAccepting(false) }
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
      <button
        onClick={handleAccept}
        disabled={accepting || accepted}
        className={`w-full text-xs font-semibold px-3 py-1.5 rounded transition ${
          accepted
            ? 'bg-green-700/20 text-green-300 border border-green-700/40'
            : 'bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50'
        }`}
      >
        {accepted ? '✓ Added' : accepting ? 'Adding…' : '+ Add as experiment'}
      </button>
    </div>
  )
}

function stripExperimentBlocks(text: string): string {
  return text.replace(/```experiment[\s\S]+?```/g, '').trim()
}
