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

/**
 * Client-side image resize → JPEG data URL. Keeps DB rows manageable —
 * a 1280px screenshot at 0.85 quality lands ~150-400KB. We store inline in
 * bug_reports.attachments (text[]) so no Supabase Storage bucket is needed.
 *
 * Tradeoff vs. proper Storage: data URLs are CPU/bandwidth-heavy when the
 * feedback list renders, but at our volume (≤100 tickets) this is fine and
 * lets us ship without infra changes. If we cross ~500 tickets with images,
 * migrate to Storage with signed URLs.
 */
async function resizeImageToDataUrl(file: File, maxDim: number, quality: number): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale  = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const w      = Math.round(bitmap.width  * scale)
  const h      = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unsupported')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()

  // Use JPEG — significantly smaller than PNG for screenshots with text.
  return canvas.toDataURL('image/jpeg', quality)
}

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
  // Screenshot attachments. Stored as data: URLs after client-side resize to
  // keep DB rows manageable. Up to 3 per report.
  const [attachments, setAttachments] = useState<string[]>([])
  const [submitting,  setSubmitting]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [success,     setSuccess]     = useState(false)

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return
    const limit = Math.max(0, 3 - attachments.length)
    const picks = Array.from(files).slice(0, limit)
    setError(null)
    const converted: string[] = []
    for (const f of picks) {
      if (!f.type.startsWith('image/')) {
        setError('Only image files (PNG/JPG) are supported.')
        continue
      }
      try {
        const dataUrl = await resizeImageToDataUrl(f, 1280, 0.85)
        converted.push(dataUrl)
      } catch (e) {
        console.error('[bug-report] image resize failed:', e)
      }
    }
    if (converted.length) setAttachments(prev => [...prev, ...converted])
  }

  function removeAttachment(idx: number) {
    setAttachments(prev => prev.filter((_, i) => i !== idx))
  }

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
          attachments,
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

            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Screenshots <span className="text-gray-600">(optional, up to 3 — auto-resized to ≤1280px)</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {attachments.map((a, i) => (
                  <div key={i} className="relative group">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a} alt={`screenshot-${i + 1}`} className="h-16 w-16 object-cover rounded border border-gray-700" />
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      className="absolute -top-1 -right-1 bg-red-600 hover:bg-red-500 text-white text-[10px] w-4 h-4 rounded-full"
                    >×</button>
                  </div>
                ))}
                {attachments.length < 3 && (
                  <label className="h-16 w-16 rounded border border-dashed border-gray-700 hover:border-blue-500 hover:text-blue-300 text-gray-500 flex items-center justify-center cursor-pointer text-xs text-center">
                    + Add
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={e => handleFiles(e.target.files)}
                    />
                  </label>
                )}
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
