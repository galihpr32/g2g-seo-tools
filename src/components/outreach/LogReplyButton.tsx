'use client'

/**
 * LogReplyButton — manual paste of email correspondence per outreach prospect.
 *
 * Until we wire Gmail OAuth (later phase), this is the bridge between
 * Specialist 2's external email client and the funnel data layer. Simple
 * modal: pick direction, pick sentiment, paste body, submit.
 */

import { useState } from 'react'

interface Props {
  prospectId: string
  /** Compact pill size for table rows; full size for detail view */
  variant?:   'compact' | 'block'
  onLogged?:  () => void
}

export default function LogReplyButton({ prospectId, variant = 'compact', onLogged }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={
          variant === 'compact'
            ? 'text-[10px] bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white border border-gray-700 px-2 py-1 rounded transition'
            : 'text-xs bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 font-medium px-3 py-1.5 rounded transition'
        }
        title="Paste email body to log this conversation"
      >
        📧 Log reply
      </button>
      {open && (
        <LogReplyModal
          prospectId={prospectId}
          onClose={() => setOpen(false)}
          onSubmitted={() => { setOpen(false); onLogged?.() }}
        />
      )}
    </>
  )
}

function LogReplyModal({ prospectId, onClose, onSubmitted }: {
  prospectId: string
  onClose:    () => void
  onSubmitted: () => void
}) {
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('inbound')
  const [sentiment, setSentiment] = useState<'positive' | 'neutral' | 'negative' | ''>('')
  const [emailBody, setEmailBody] = useState('')
  const [busy,      setBusy]      = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!emailBody.trim()) {
      setError('Paste the email content first.')
      return
    }
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/outreach/prospects/${prospectId}/log-reply`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          direction,
          sentiment: sentiment || undefined,
          body:      emailBody.trim(),
        }),
      })
      const d = await res.json()
      if (!res.ok || !d.ok) throw new Error(d.error ?? `HTTP ${res.status}`)
      onSubmitted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-white font-semibold text-sm flex items-center gap-2">
            📧 Log email correspondence
          </h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Direction</label>
              <div className="flex border border-gray-700 rounded overflow-hidden">
                {(['outbound', 'inbound'] as const).map(d => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirection(d)}
                    className={`flex-1 text-xs px-3 py-1.5 transition ${
                      direction === d
                        ? d === 'outbound' ? 'bg-blue-600 text-white' : 'bg-amber-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                    }`}
                  >
                    {d === 'outbound' ? '✉️ Outbound (we sent)' : '📨 Inbound (they replied)'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Sentiment {direction === 'outbound' && <span className="text-gray-600">(skip for outbound)</span>}
              </label>
              <select
                value={sentiment}
                onChange={e => setSentiment(e.target.value as typeof sentiment)}
                disabled={direction === 'outbound'}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white focus:outline-none focus:border-amber-500 disabled:opacity-50 text-xs"
              >
                <option value="">— pick —</option>
                <option value="positive">😊 Positive</option>
                <option value="neutral">😐 Neutral</option>
                <option value="negative">😞 Negative</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Email body</label>
            <textarea
              value={emailBody}
              onChange={e => setEmailBody(e.target.value)}
              rows={8}
              placeholder="Paste the full email content here…"
              maxLength={5000}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-200 focus:outline-none focus:border-amber-500 resize-none text-xs"
            />
            <p className="text-[10px] text-gray-600 mt-1">{emailBody.length}/5000 chars</p>
          </div>

          {error && <p className="text-red-400 text-xs">⚠️ {error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300 px-3 py-2 transition">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-semibold px-4 py-2 rounded transition"
            >
              {busy ? 'Logging…' : '📧 Log reply'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
