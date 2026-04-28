'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { usePathname } from 'next/navigation'

interface Message {
  role:    'user' | 'assistant'
  content: string
  id:      string
}

interface ConfirmPayload {
  type:               string
  agent:              string
  category:           string
  cost_warning:       boolean
  cooldown_hours:     number
  hours_since_last:   number | null
  last_status:        string | null
  last_ran:           string | null
  confirmation_token: string
}

const QUICK_PROMPTS = [
  { label: '🎯 Keyword gaps',     prompt: 'Find me the top 10 keywords that competitors rank well for but G2G doesn\'t. Prioritize by search volume.' },
  { label: '📊 Top pages',        prompt: 'What are G2G\'s top performing pages right now and which ones should I focus on?' },
  { label: '🏆 Competitor SoV',   prompt: 'How does G2G\'s Share of Voice compare to competitors? Who is winning right now?' },
  { label: '✅ What\'s pending?',  prompt: 'What are the most urgent SEO action items and what have the agents found recently?' },
]

// ── Confirmation payload parser ───────────────────────────────────────────────
// Extracts <<<MIMIR_CONFIRM>>>...<<</MIMIR_CONFIRM>>> from assistant messages.
// Returns { visibleText, payload } — payload is null if no marker found.
function parseConfirmBlock(content: string): { visibleText: string; payload: ConfirmPayload | null } {
  const OPEN  = '<<<MIMIR_CONFIRM>>>'
  const CLOSE = '<<</MIMIR_CONFIRM>>>'
  const start = content.indexOf(OPEN)
  const end   = content.indexOf(CLOSE)
  if (start === -1 || end === -1 || end <= start) {
    return { visibleText: content, payload: null }
  }
  const jsonStr    = content.slice(start + OPEN.length, end).trim()
  const visibleText = (content.slice(0, start) + content.slice(end + CLOSE.length)).trim()
  try {
    const payload = JSON.parse(jsonStr) as ConfirmPayload
    return { visibleText, payload }
  } catch {
    return { visibleText, payload: null }
  }
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
function renderMarkdown(text: string) {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let listItems: string[] = []

  function flushList() {
    if (listItems.length) {
      elements.push(
        <ul key={`list-${elements.length}`} className="list-disc list-inside space-y-1 my-2 text-gray-200 text-sm">
          {listItems.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
        </ul>
      )
      listItems = []
    }
  }

  function renderInline(s: string): React.ReactNode {
    const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**'))
        return <strong key={i} className="text-white font-semibold">{part.slice(2, -2)}</strong>
      if (part.startsWith('`') && part.endsWith('`'))
        return <code key={i} className="bg-gray-700 text-gray-200 px-1 rounded text-xs">{part.slice(1, -1)}</code>
      return part
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (/^[-*•]\s/.test(line)) {
      listItems.push(line.replace(/^[-*•]\s/, ''))
      continue
    }

    flushList()

    if (!line.trim()) {
      if (i > 0 && lines[i - 1].trim()) elements.push(<div key={`br-${i}`} className="h-2" />)
      continue
    }

    if (/^#{1,3}\s/.test(line)) {
      const text = line.replace(/^#{1,3}\s/, '')
      elements.push(
        <p key={i} className="text-white font-semibold text-sm mt-3 mb-1">{renderInline(text)}</p>
      )
      continue
    }

    elements.push(
      <p key={i} className="text-gray-200 text-sm leading-relaxed">{renderInline(line)}</p>
    )
  }

  flushList()
  return <>{elements}</>
}

// ── Confirmation card ─────────────────────────────────────────────────────────
function ConfirmCard({
  payload,
  onConfirm,
  onCancel,
  disabled,
}: {
  payload:   ConfirmPayload
  onConfirm: (token: string) => void
  onCancel:  () => void
  disabled:  boolean
}) {
  const agentLabel = payload.agent.charAt(0).toUpperCase() + payload.agent.slice(1)
  const isAmber    = payload.cost_warning

  const lastRunText = (() => {
    if (!payload.last_ran) return 'Never run before — first run'
    const h = payload.hours_since_last
    const status = payload.last_status ?? 'unknown'
    if (h === null) return `Last run: ${new Date(payload.last_ran).toLocaleString()} (${status})`
    if (h < 1) return `Last run: ${Math.round(h * 60)}m ago (${status})`
    return `Last run: ${h.toFixed(1)}h ago (${status})`
  })()

  return (
    <div className={`mt-2 rounded-xl border p-3 text-xs ${
      isAmber
        ? 'border-amber-500/50 bg-amber-950/30'
        : 'border-gray-700 bg-gray-900/50'
    }`}>
      <div className="flex items-start gap-2 mb-2">
        <span className={`text-base leading-none ${isAmber ? 'text-amber-400' : 'text-gray-400'}`}>
          {isAmber ? '⚠' : '🤖'}
        </span>
        <div className="flex-1">
          <p className={`font-semibold text-sm ${isAmber ? 'text-amber-300' : 'text-gray-200'}`}>
            Confirm: trigger {agentLabel}?
          </p>
          <p className="text-gray-400 mt-0.5">{lastRunText}</p>
          {isAmber && (
            <p className="text-amber-400/80 mt-0.5">
              ⚠ Cost warning — within {payload.cooldown_hours}h cooldown.
            </p>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onConfirm(payload.confirmation_token)}
          disabled={disabled}
          className="flex-1 px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white font-medium transition disabled:opacity-40 disabled:cursor-not-allowed text-xs"
        >
          Yes, trigger
        </button>
        <button
          onClick={onCancel}
          disabled={disabled}
          className="flex-1 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium transition disabled:opacity-40 disabled:cursor-not-allowed text-xs"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function AIAssistant() {
  const pathname = usePathname()
  const [open,     setOpen]     = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  // Track which tokens have been acted on (to disable buttons after first click)
  const [usedTokens, setUsedTokens] = useState<Set<string>>(new Set())
  const bottomRef  = useRef<HTMLDivElement>(null)
  const inputRef   = useRef<HTMLTextAreaElement>(null)

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100)
  }, [open])

  const appendMessage = useCallback((role: 'user' | 'assistant', content: string) => {
    setMessages(prev => [...prev, { role, content, id: (Date.now() + Math.random()).toString() }])
  }, [])

  const sendMessage = useCallback(async (text?: string) => {
    const content = (text ?? input).trim()
    if (!content || loading) return

    const userMsg: Message = { role: 'user', content, id: Date.now().toString() }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setLoading(true)
    setError(null)

    try {
      const res  = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages:     nextMessages.map(m => ({ role: m.role, content: m.content })),
          current_page: pathname,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: data.reply, id: (Date.now() + 1).toString() },
      ])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [input, messages, pathname, loading])

  async function handleConfirm(token: string, agentLabel: string) {
    setUsedTokens(prev => new Set([...prev, token]))
    try {
      const res  = await fetch('/api/ai/confirm-agent-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation_token: token }),
      })
      const data = await res.json() as {
        ok?: boolean; agent?: string; run_id?: string; summary?: string
        actionsQueued?: number; error?: string
      }
      if (!res.ok || !data.ok) {
        appendMessage('assistant', `✗ Could not trigger ${agentLabel}: ${data.error ?? 'Unknown error'}`)
      } else {
        const parts = [`✓ **${agentLabel}** triggered successfully.`]
        if (data.run_id)        parts.push(`Run ID: \`${data.run_id}\``)
        if (data.summary)       parts.push(data.summary)
        if (data.actionsQueued) parts.push(`${data.actionsQueued} action${data.actionsQueued !== 1 ? 's' : ''} queued.`)
        appendMessage('assistant', parts.join('\n'))
      }
    } catch (e) {
      appendMessage('assistant', `✗ Network error triggering ${agentLabel}: ${String(e)}`)
    }
  }

  function handleCancel(agentLabel: string, token: string) {
    setUsedTokens(prev => new Set([...prev, token]))
    appendMessage('assistant', `✗ Cancelled. No agent triggered. (${agentLabel} run skipped)`)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  function clearChat() { setMessages([]); setError(null); setUsedTokens(new Set()) }

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(v => !v)}
        className={`fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all duration-200 ${
          open
            ? 'bg-gray-700 text-white rotate-45'
            : 'bg-red-600 hover:bg-red-500 text-white'
        }`}
        title="Ask Mimir"
        aria-label="Open Mimir The All Knowing"
      >
        {open ? (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-20 right-6 z-50 w-[380px] max-h-[600px] flex flex-col bg-gray-950 border border-gray-700 rounded-2xl shadow-2xl shadow-black/50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 flex-shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-red-600 flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
              <div>
                <p className="text-white text-sm font-semibold leading-tight">Mimir The All Knowing</p>
                <p className="text-gray-500 text-[10px]">Reads live data · answers from anywhere</p>
              </div>
            </div>
            {messages.length > 0 && (
              <button onClick={clearChat}
                className="text-xs text-gray-600 hover:text-gray-400 transition">
                Clear
              </button>
            )}
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0">
            {messages.length === 0 ? (
              <div className="py-2">
                <p className="text-gray-400 text-xs mb-3">Ask anything — Mimir reads your live SEO data to answer:</p>
                <div className="grid grid-cols-2 gap-2">
                  {QUICK_PROMPTS.map(q => (
                    <button
                      key={q.label}
                      onClick={() => sendMessage(q.prompt)}
                      className="text-left text-[11px] px-2.5 py-2 rounded-lg bg-gray-900 border border-gray-800 text-gray-300 hover:border-red-600/50 hover:text-white transition"
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map(msg => {
                if (msg.role === 'user') {
                  return (
                    <div key={msg.id} className="flex gap-2.5 flex-row-reverse">
                      <div className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold mt-0.5 bg-gray-700 text-gray-300">U</div>
                      <div className="max-w-[85%] rounded-2xl px-3 py-2.5 bg-red-600/20 border border-red-600/30">
                        <p className="text-gray-200 text-sm">{msg.content}</p>
                      </div>
                    </div>
                  )
                }

                // Assistant message — may contain a MIMIR_CONFIRM block
                const { visibleText, payload } = parseConfirmBlock(msg.content)
                const agentLabel = payload
                  ? payload.agent.charAt(0).toUpperCase() + payload.agent.slice(1)
                  : ''
                const isUsed = payload ? usedTokens.has(payload.confirmation_token) : false

                return (
                  <div key={msg.id} className="flex gap-2.5">
                    <div className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold mt-0.5 bg-red-600 text-white">M</div>
                    <div className="max-w-[85%] rounded-2xl px-3 py-2.5 bg-gray-900 border border-gray-800">
                      {renderMarkdown(visibleText)}
                      {payload && (
                        <ConfirmCard
                          payload={payload}
                          disabled={isUsed}
                          onConfirm={token => handleConfirm(token, agentLabel)}
                          onCancel={() => handleCancel(agentLabel, payload.confirmation_token)}
                        />
                      )}
                    </div>
                  </div>
                )
              })
            )}

            {/* Loading indicator */}
            {loading && (
              <div className="flex gap-2.5">
                <div className="w-6 h-6 rounded-full flex-shrink-0 bg-red-600 flex items-center justify-center text-[10px] font-bold text-white mt-0.5">M</div>
                <div className="bg-gray-900 border border-gray-800 rounded-2xl px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                    <span className="text-[10px] text-gray-600">consulting the well…</span>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <p className="text-red-400 text-xs text-center">⚠️ {error}</p>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="px-3 pb-3 pt-2 border-t border-gray-800 flex-shrink-0">
            <div className="flex items-end gap-2 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 focus-within:border-red-600/60 transition">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about SEO, data, strategy…"
                rows={1}
                className="flex-1 bg-transparent text-sm text-white placeholder-gray-600 resize-none focus:outline-none max-h-28 overflow-y-auto"
                style={{ lineHeight: '1.5' }}
              />
              <button
                onClick={() => sendMessage()}
                disabled={!input.trim() || loading}
                className="w-7 h-7 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center flex-shrink-0 transition mb-0.5"
              >
                <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>
            <p className="text-[10px] text-gray-700 mt-1.5 text-center">Enter to send · Shift+Enter for new line</p>
          </div>
        </div>
      )}
    </>
  )
}
