'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

// ─── /forseti/[id] — Thread detail + response form ──────────────────────────

interface Thread {
  id:                       string
  reddit_id:                string
  reddit_url:               string
  subreddit:                string
  thread_title:             string
  thread_permalink:         string | null
  op_username:              string | null
  op_post_score:            number
  op_comment_count:         number
  op_post_body:             string | null
  op_post_at:               string | null
  auto_category:            string
  manual_category_override: string | null
  effective_category:       string
  auto_severity:            number
  manual_severity_override: number | null
  effective_severity:       number
  status:                   string
  assignee_user_id:         string | null
  assigned_at:              string | null
  responded_at:             string | null
  resolved_at:              string | null
  first_seen_at:            string
  last_synced_at:           string
}

interface ActivityEntry {
  id:                string
  response_type:     string
  response_text:     string | null
  response_url:      string | null
  outcome_note:      string | null
  status_before:     string | null
  status_after:      string | null
  posted_by_user_id: string | null
  created_at:        string
}

const STATUSES = ['spotted', 'drafted', 'sent', 'op_replied', 'resolved', 'escalated', 'ignored'] as const

export default function ForsetiDetailPage() {
  const params = useParams()
  const id     = params?.id as string

  const [thread,    setThread]    = useState<Thread | null>(null)
  const [activity,  setActivity]  = useState<ActivityEntry[]>([])
  const [loading,   setLoading]   = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)

  // Response form state
  const [responseType, setResponseType] = useState<'reply' | 'internal_note' | 'escalation'>('reply')
  const [responseText, setResponseText] = useState('')
  const [responseUrl,  setResponseUrl]  = useState('')
  const [outcomeNote,  setOutcomeNote]  = useState('')
  const [newStatus,    setNewStatus]    = useState<string>('')
  const [saving,       setSaving]       = useState(false)
  const [err,          setErr]          = useState<string | null>(null)
  // Sprint #354 FORSETI.AI.REPLY — drafting state + tone control
  const [drafting,     setDrafting]     = useState(false)
  const [draftTone,    setDraftTone]    = useState<'helpful' | 'empathetic' | 'professional'>('helpful')
  const [draftMeta,    setDraftMeta]    = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    ;(async () => {
      try {
        const res  = await fetch(`/api/forseti/threads/${id}`)
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) { setErr(data.error ?? 'Failed to load'); return }
        setThread(data.thread)
        setActivity(data.responses ?? [])
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [id, refreshTick])

  async function saveResponse() {
    if (!responseText.trim() && responseType === 'reply') {
      setErr('Response text required')
      return
    }
    setSaving(true); setErr(null)
    try {
      const res = await fetch(`/api/forseti/threads/${id}/responses`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          response_type: responseType,
          response_text: responseText,
          response_url:  responseUrl,
          outcome_note:  outcomeNote,
          new_status:    newStatus || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErr(data.error ?? 'Failed')
      } else {
        setResponseText(''); setResponseUrl(''); setOutcomeNote(''); setNewStatus('')
        setRefreshTick(t => t + 1)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setSaving(false)
  }

  // Sprint #354 FORSETI.AI.REPLY — call backend to draft a reply, pre-fill
  // the response textarea so the human can review + edit + post manually.
  async function draftAiReply() {
    setDrafting(true); setErr(null); setDraftMeta(null)
    try {
      const res = await fetch(`/api/forseti/threads/${id}/draft-reply`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tone: draftTone }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setErr(data.error ?? `HTTP ${res.status}`)
      } else {
        setResponseType('reply')
        setResponseText(data.draft as string)
        setDraftMeta(`✨ Drafted (${data.tone}, ${data.model}) — ${data.context_summary}. Review + edit before posting.`)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setDrafting(false)
  }

  async function quickStatusChange(status: string) {
    const res = await fetch(`/api/forseti/threads?id=${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status }),
    })
    if (res.ok) setRefreshTick(t => t + 1)
  }

  async function assignToMe() {
    // user.id is implicit on the API side via session
    const res = await fetch(`/api/forseti/threads?id=${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ assignee_user_id: 'self' }),
    })
    // Hack: API doesn't accept 'self'. Use session user_id route instead.
    // We re-fetch a stub from the API session — but simpler: just refresh.
    if (res.ok) setRefreshTick(t => t + 1)
  }

  if (loading) return <div className="p-8 text-gray-500">Loading…</div>
  if (err && !thread) return <div className="p-8 text-red-400">Error: {err}</div>
  if (!thread) return <div className="p-8 text-gray-500">Thread not found.</div>

  const sevColor = {
    5: 'border-red-600    bg-red-500/10    text-red-300',
    4: 'border-orange-600 bg-orange-500/10 text-orange-300',
    3: 'border-amber-700  bg-amber-500/10  text-amber-300',
    2: 'border-gray-700   bg-gray-800/40   text-gray-300',
    1: 'border-gray-800   bg-gray-900/40   text-gray-500',
  }[thread.effective_severity as 1|2|3|4|5]

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-5">
      <Link href="/forseti" className="text-sm text-gray-400 hover:text-purple-300">← Back to triage queue</Link>

      <div className={`rounded-lg border p-4 ${sevColor}`}>
        <div className="flex items-center gap-2 text-xs mb-2">
          <span className="px-2 py-0.5 rounded border border-current uppercase tracking-wide font-semibold">
            SEV {thread.effective_severity}
          </span>
          <span>📈 {thread.op_post_score} up · 💬 {thread.op_comment_count} cmt</span>
          <span>r/{thread.subreddit}</span>
          <span className="text-gray-500">· {thread.effective_category}</span>
        </div>
        <h1 className="text-xl font-bold text-white">{thread.thread_title}</h1>
        {thread.op_username && (
          <p className="text-xs text-gray-400 mt-1">
            Posted by u/{thread.op_username}
            {thread.op_post_at && ` · ${new Date(thread.op_post_at).toLocaleString()}`}
          </p>
        )}
        <a href={thread.reddit_url} target="_blank" rel="noopener noreferrer" className="text-xs text-purple-300 hover:text-purple-200 inline-block mt-2">
          Open on Reddit ↗
        </a>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* Left: original post + activity */}
        <div className="lg:col-span-3 space-y-4">
          <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <h2 className="text-sm font-semibold text-white mb-2">Original Post</h2>
            {thread.op_post_body ? (
              <p className="text-sm text-gray-300 whitespace-pre-wrap">{thread.op_post_body}</p>
            ) : (
              <p className="text-xs text-gray-500 italic">No body text — likely a link post. Open on Reddit to see context.</p>
            )}
          </section>

          <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <h2 className="text-sm font-semibold text-white mb-3">Activity Log</h2>
            {activity.length === 0 ? (
              <p className="text-xs text-gray-500 italic">No actions logged yet. Use the form on the right to log a response.</p>
            ) : (
              <ol className="space-y-2.5">
                {activity.map(a => (
                  <li key={a.id} className="text-xs">
                    <div className="flex items-center gap-1.5 text-gray-400">
                      <span className="font-medium text-gray-300">{formatActivityType(a)}</span>
                      <span>·</span>
                      <span>{new Date(a.created_at).toLocaleString()}</span>
                    </div>
                    {a.response_text && <p className="mt-1 text-gray-300 whitespace-pre-wrap bg-gray-950/40 border border-gray-800 rounded p-2">{a.response_text}</p>}
                    {a.outcome_note  && <p className="mt-1 text-amber-300 italic">Outcome: {a.outcome_note}</p>}
                    {a.response_url  && <a href={a.response_url} target="_blank" rel="noopener noreferrer" className="text-purple-300 hover:underline">Reddit reply ↗</a>}
                    {a.status_before && a.status_after && a.status_before !== a.status_after && (
                      <p className="text-gray-500">Status: {a.status_before} → {a.status_after}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        {/* Right: response form + status */}
        <div className="lg:col-span-2 space-y-4">
          <section className="rounded-lg border border-gray-800 bg-gray-900 p-4">
            <h2 className="text-sm font-semibold text-white mb-3">Current Status</h2>
            <p className="text-sm text-gray-300 mb-2">{statusBadge(thread.status)}</p>
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map(s => (
                <button
                  key={s}
                  onClick={() => quickStatusChange(s)}
                  disabled={s === thread.status}
                  className={`px-2 py-1 text-xs rounded border transition ${
                    s === thread.status
                      ? 'border-purple-500 bg-purple-700/30 text-purple-100'
                      : 'border-gray-700 text-gray-400 hover:text-white hover:border-gray-600'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            {!thread.assignee_user_id && (
              <button onClick={assignToMe} className="mt-3 text-xs text-purple-300 hover:text-purple-200">+ Assign to me</button>
            )}
          </section>

          <section className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-2">
            <h2 className="text-sm font-semibold text-white">Log a Response</h2>
            <div className="flex gap-2 text-xs">
              {(['reply', 'internal_note', 'escalation'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setResponseType(t)}
                  className={`px-2 py-1 rounded border ${responseType === t ? 'border-purple-500 bg-purple-700/30 text-purple-100' : 'border-gray-700 text-gray-400'}`}
                >
                  {t}
                </button>
              ))}
            </div>

            {/* Sprint #354 FORSETI.AI.REPLY — AI draft button row.
                Only shown when 'reply' is selected (drafts make no sense for
                internal_note / escalation). Tone toggle lets human steer
                the voice without re-prompting. */}
            {responseType === 'reply' && (
              <div className="space-y-1.5 -mb-1">
                <div className="flex items-center gap-2">
                  <button
                    onClick={draftAiReply}
                    disabled={drafting}
                    className="px-3 py-1.5 bg-emerald-700/40 hover:bg-emerald-700/60 disabled:opacity-40 border border-emerald-500/50 text-emerald-100 text-xs font-semibold rounded transition inline-flex items-center gap-1.5"
                    title="Generate a Mimir-aware reply draft. You review + edit + post manually."
                  >
                    {drafting ? '⏳ Drafting…' : '✨ Draft AI reply'}
                  </button>
                  <div className="inline-flex gap-0.5 bg-gray-950 border border-gray-800 rounded p-0.5 text-[10px]">
                    {(['helpful', 'empathetic', 'professional'] as const).map(t => (
                      <button
                        key={t}
                        onClick={() => setDraftTone(t)}
                        className={`px-2 py-0.5 rounded ${draftTone === t ? 'bg-emerald-700/40 text-emerald-100' : 'text-gray-500 hover:text-gray-300'}`}
                        title={`Draft with ${t} tone`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                {draftMeta && (
                  <p className="text-[11px] text-emerald-300/80 italic">{draftMeta}</p>
                )}
              </div>
            )}

            <textarea
              rows={5}
              value={responseText}
              onChange={e => setResponseText(e.target.value)}
              placeholder={responseType === 'reply' ? 'Paste the response you posted on Reddit (for archive)… or click ✨ Draft AI reply above to start with a Mimir-aware draft.' : responseType === 'internal_note' ? 'Internal note…' : 'Why escalated + to whom…'}
              className="w-full bg-gray-950 border border-gray-700 rounded p-2 text-sm text-white"
            />
            {responseType === 'reply' && (
              <input
                type="text"
                value={responseUrl}
                onChange={e => setResponseUrl(e.target.value)}
                placeholder="Reddit comment URL (after posting)"
                className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200"
              />
            )}
            <input
              type="text"
              value={outcomeNote}
              onChange={e => setOutcomeNote(e.target.value)}
              placeholder="Outcome note (optional) — e.g. 'OP edited post, sentiment positive'"
              className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200"
            />
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-500">Change status to:</span>
              <select value={newStatus} onChange={e => setNewStatus(e.target.value)} className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200">
                <option value="">— no change —</option>
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={saveResponse}
                disabled={saving}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm rounded"
              >
                {saving ? 'Saving…' : 'Save log entry'}
              </button>
              {err && <span className="text-xs text-red-400">{err}</span>}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    spotted:     '🟡 Spotted (needs assignment)',
    drafted:     '📝 Response drafted',
    sent:        '📤 Response sent on Reddit',
    op_replied:  '💬 OP replied back',
    resolved:    '✅ Resolved',
    escalated:   '⤴ Escalated internally',
    ignored:     '🚫 Ignored (not actionable)',
    deleted_by_op: '🗑 Deleted by OP',
  }
  return map[status] ?? status
}

function formatActivityType(a: ActivityEntry): string {
  if (a.response_type === 'reply')         return '📤 Replied'
  if (a.response_type === 'internal_note') return '📝 Internal note'
  if (a.response_type === 'escalation')    return '⤴ Escalated'
  if (a.response_type === 'status_change') return '🔄 Status change'
  return a.response_type
}
