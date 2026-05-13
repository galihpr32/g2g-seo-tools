'use client'

/**
 * Floating "🐛 Report" button — present on every dashboard page.
 *
 * Position: bottom-right, vertically stacked with AIAssistant (we offset
 * vertically so they don't overlap). The button opens a modal with the
 * standard fields (title, description, severity), auto-captures page_url
 * + submitter, and POSTs to /api/feedback.
 *
 * Why floating + global: the user (any role) should be able to report from
 * the page where the issue happened — context (page_url) auto-captured.
 * Decoupled from any specific feature so we never have to think "should
 * this page have a feedback form?".
 */

import { useState } from 'react'
import { usePathname } from 'next/navigation'

export default function BugReportButton() {
  const pathname  = usePathname()
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Report a bug or send feedback"
        aria-label="Report a bug or send feedback"
        // Stacked above AIAssistant button. AIAssistant lives at bottom-6/right-6 (24px),
        // we offset bottom-24/right-6 so we stack vertically with a 24px gap.
        className="fixed bottom-24 right-6 z-40 flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white text-xs font-medium px-3 py-2 rounded-full border border-gray-700 hover:border-gray-600 shadow-lg transition print:hidden"
      >
        <span>🐛</span>
        <span>Report</span>
      </button>

      {open && (
        <BugReportModal
          pageUrl={pathname}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

// ── Modal ──────────────────────────────────────────────────────────────────

function BugReportModal({ pageUrl, onClose }: { pageUrl: string; onClose: () => void }) {
  const [title,       setTitle]       = useState('')
  const [description, setDescription] = useState('')
  const [severity,    setSeverity]    = useState<'low' | 'medium' | 'high'>('medium')
  const [submitting,  setSubmitting]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [success,     setSuccess]     = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !description.trim()) {
      setError('Title and description required.')
      return
    }
    setSubmitting(true); setError(null)
    try {
      const res = await fetch('/api/feedback', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          title:       title.trim(),
          description: description.trim(),
          severity,
          page_url:    pageUrl,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      setSuccess(true)
      setTimeout(() => onClose(), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-white font-semibold text-sm flex items-center gap-2">
            <span>🐛</span> Report a bug or send feedback
          </h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {success ? (
          <div className="p-8 text-center">
            <p className="text-3xl mb-3">✅</p>
            <p className="text-white font-medium">Thanks — sent!</p>
            <p className="text-gray-500 text-xs mt-1">Galih will see this in /feedback.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3 text-sm">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Title <span className="text-red-500">*</span></label>
              <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Short summary (e.g. PPTX export crashes for April report)"
                maxLength={200}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1">Description <span className="text-red-500">*</span></label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Steps to reproduce, what you expected, what happened, etc."
                rows={5}
                maxLength={5000}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-red-500 resize-none"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1">Severity</label>
              <div className="flex gap-2">
                {(['low', 'medium', 'high'] as const).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSeverity(s)}
                    className={`flex-1 text-xs px-3 py-1.5 rounded-lg border transition ${
                      severity === s
                        ? s === 'high'   ? 'bg-red-500/15 text-red-300 border-red-500/30'
                          : s === 'medium' ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                                           : 'bg-gray-700/30 text-gray-300 border-gray-700'
                        : 'border-gray-700 text-gray-500 hover:text-white hover:border-gray-600'
                    }`}
                  >
                    {s.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <div className="text-[11px] text-gray-600 bg-gray-800/50 rounded px-2 py-1.5 break-all">
              📍 {pageUrl}
            </div>

            {error && <p className="text-red-400 text-xs">⚠️ {error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="text-xs text-gray-500 hover:text-gray-300 px-3 py-2 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="text-xs bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white font-semibold px-4 py-2 rounded-lg transition"
              >
                {submitting ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
