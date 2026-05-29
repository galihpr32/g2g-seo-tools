'use client'

/**
 * /knowledge-base/proposals — KB rule proposals review queue
 *
 * Where insights become rules. Three columns:
 *   - Pending review (new proposals from cron / Promote-to-KB buttons)
 *   - Approved (user accepted, but not yet applied to a KB item)
 *   - Applied (written into knowledge_base_items.data)
 *
 * On approve: user picks which KB item + field to extend. The PATCH writes
 * the rule_text into the chosen item's data field (append to array, or
 * concat to string).
 */

import { useCallback, useEffect, useState } from 'react'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'

interface Proposal {
  id:                    string
  title:                 string
  rule_text:             string
  pattern_kind:          'winning' | 'cautionary' | 'exclusion' | 'tone' | 'format' | 'generic'
  source:                'cron_extractor' | 'brief_promote' | 'experiment_promote' | 'manual'
  source_brief_ids:      string[]
  source_loser_ids:      string[]
  source_experiment_id:  string | null
  confidence:            number | null
  suggested_kb_item_id:  string | null
  suggested_kb_field:    string | null
  status:                'pending' | 'approved' | 'rejected' | 'applied'
  status_changed_at:     string | null
  review_notes:          string | null
  applied_kb_item_id:    string | null
  applied_kb_field:      string | null
  applied_at:            string | null
  created_at:            string
}

interface KbItem {
  id:        string
  category:  'brand' | 'category' | 'platform'
  name:      string
  data:      Record<string, unknown>
}

const PATTERN_STYLES: Record<Proposal['pattern_kind'], string> = {
  winning:    'bg-green-500/15 text-green-300 border-green-500/30',
  cautionary: 'bg-red-500/15 text-red-300 border-red-500/30',
  exclusion:  'bg-amber-500/15 text-amber-300 border-amber-500/30',
  tone:       'bg-purple-500/15 text-purple-300 border-purple-500/30',
  format:     'bg-blue-500/15 text-blue-300 border-blue-500/30',
  generic:    'bg-gray-700/30 text-gray-400 border-gray-700',
}

const SOURCE_LABEL: Record<Proposal['source'], string> = {
  cron_extractor:     '🤖 Auto-extracted',
  brief_promote:      '📝 From brief',
  experiment_promote: '🧪 From experiment',
  manual:             '✍️ Manual',
}

const FIELD_OPTIONS = ['dos', 'donts', 'writing_rules', 'format', 'tone', 'notes']

export default function KbProposalsPage() {
  const siteSlug = useSiteSlug()
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [kbItems,   setKbItems]   = useState<KbItem[]>([])
  const [loading,   setLoading]   = useState(true)
  const [tab,       setTab]       = useState<'pending' | 'approved' | 'applied' | 'rejected'>('pending')
  const [extracting, setExtracting] = useState(false)
  const [extractMsg, setExtractMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [pRes, kRes] = await Promise.all([
        fetch(`/api/knowledge-base/proposals?site=${siteSlug}`),
        fetch('/api/knowledge-base'),
      ])
      if (pRes.ok) setProposals((await pRes.json()).proposals ?? [])
      if (kRes.ok) {
        const d = await kRes.json()
        setKbItems(d.items ?? [])
      }
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [siteSlug])

   
  useEffect(() => { load() }, [load])

  const grouped = {
    pending:  proposals.filter(p => p.status === 'pending'),
    approved: proposals.filter(p => p.status === 'approved'),
    applied:  proposals.filter(p => p.status === 'applied'),
    rejected: proposals.filter(p => p.status === 'rejected'),
  }

  async function patch(id: string, updates: Record<string, unknown>) {
    await fetch('/api/knowledge-base/proposals', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id, ...updates }),
    })
    await load()
  }

  async function manualExtract() {
    setExtracting(true); setExtractMsg(null)
    try {
      const res = await fetch('/api/knowledge-base/proposals/extract', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ site: siteSlug }),
      })
      const d = await res.json()
      if (!res.ok) {
        setExtractMsg(`⚠️ ${d.error ?? `HTTP ${res.status}`}`)
      } else if (d.warning) {
        setExtractMsg(`ℹ️ ${d.warning}`)
      } else {
        setExtractMsg(`✓ Extracted ${d.proposalsWritten} proposal(s) from ${d.winners} winner(s) + ${d.losers} loser(s).`)
      }
      await load()
    } catch (e) {
      setExtractMsg(`⚠️ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExtracting(false)
    }
  }

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <span>🧠</span> KB Rule Proposals
          </h1>
          <p className="text-gray-400 text-sm mt-1">
            Patterns extracted from winning briefs + insights from team. Approve to add to your knowledge base.
          </p>
        </div>
        <button
          onClick={manualExtract}
          disabled={extracting}
          className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm font-semibold px-4 py-2 rounded-lg transition"
          title="Run the winners-vs-losers extractor manually"
        >
          {extracting ? 'Extracting…' : '⚡ Run extractor now'}
        </button>
      </div>

      {extractMsg && (
        <div className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-200">
          {extractMsg}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-5">
        {(['pending', 'approved', 'applied', 'rejected'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition ${
              tab === t
                ? 'bg-red-700 border-red-600 text-white'
                : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
            }`}
          >
            {t.toUpperCase()} ({grouped[t].length})
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : grouped[tab].length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">📭</p>
          <p className="text-gray-400 text-sm">No proposals in this state.</p>
          {tab === 'pending' && (
            <p className="text-gray-600 text-xs mt-1">
              Run the extractor (top-right) or wait for the monthly cron, or click &ldquo;Promote to KB&rdquo; from a brief / experiment.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {grouped[tab].map(p => (
            <ProposalCard
              key={p.id}
              proposal={p}
              kbItems={kbItems}
              onPatch={patch}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Proposal card ──────────────────────────────────────────────────────────

function ProposalCard({ proposal: p, kbItems, onPatch }: {
  proposal: Proposal
  kbItems:  KbItem[]
  onPatch:  (id: string, updates: Record<string, unknown>) => Promise<void>
}) {
  const [showApprove, setShowApprove] = useState(false)
  const [showReject,  setShowReject]  = useState(false)
  const [pickedItem,  setPickedItem]  = useState<string>(p.suggested_kb_item_id ?? '')
  const [pickedField, setPickedField] = useState<string>(p.suggested_kb_field ?? 'dos')
  const [reason,      setReason]      = useState('')
  const [working,     setWorking]     = useState(false)

  async function handleApprove() {
    setWorking(true)
    try {
      await onPatch(p.id, { status: 'approved', review_notes: reason.trim() || null })
      setShowApprove(false)
    } finally { setWorking(false) }
  }

  async function handleApply() {
    if (!pickedItem || !pickedField) return
    setWorking(true)
    try {
      await onPatch(p.id, {
        status:             'applied',
        applied_kb_item_id: pickedItem,
        applied_kb_field:   pickedField,
      })
      setShowApprove(false)
    } finally { setWorking(false) }
  }

  async function handleReject() {
    setWorking(true)
    try {
      await onPatch(p.id, { status: 'rejected', review_notes: reason.trim() || null })
      setShowReject(false)
    } finally { setWorking(false) }
  }

  const appliedItem = p.applied_kb_item_id
    ? kbItems.find(k => k.id === p.applied_kb_item_id)
    : null

  return (
    <article className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <header className="flex items-start gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${PATTERN_STYLES[p.pattern_kind]}`}>
              {p.pattern_kind}
            </span>
            <span className="text-[10px] text-gray-500">{SOURCE_LABEL[p.source]}</span>
            {p.confidence != null && (
              <span className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">⚡{p.confidence}/5</span>
            )}
            <span className="text-[10px] text-gray-500">{new Date(p.created_at).toLocaleDateString('id-ID')}</span>
          </div>
          <h3 className="text-white font-semibold text-sm">{p.title}</h3>
        </div>
      </header>

      <p className="text-gray-300 text-sm leading-relaxed mb-3">{p.rule_text}</p>

      {/* Source briefs */}
      {(p.source_brief_ids.length > 0 || p.source_loser_ids.length > 0) && (
        <div className="text-[10px] text-gray-500 mb-3 space-x-3">
          {p.source_brief_ids.length > 0 && (
            <span>📈 {p.source_brief_ids.length} winner brief{p.source_brief_ids.length > 1 ? 's' : ''}</span>
          )}
          {p.source_loser_ids.length > 0 && (
            <span>📉 {p.source_loser_ids.length} loser brief{p.source_loser_ids.length > 1 ? 's' : ''}</span>
          )}
        </div>
      )}

      {/* Applied state — show where it landed */}
      {p.status === 'applied' && appliedItem && (
        <div className="bg-green-500/5 border border-green-500/20 rounded p-2 mb-2 text-xs">
          <p className="text-green-300">
            ✓ Applied to <span className="font-medium">{appliedItem.name}</span> ({appliedItem.category}) → field <code className="text-green-200 bg-green-500/10 px-1 rounded">{p.applied_kb_field}</code>
          </p>
          {p.applied_at && <p className="text-gray-500 text-[10px] mt-0.5">{new Date(p.applied_at).toLocaleString('id-ID')}</p>}
        </div>
      )}

      {/* Rejected — show reason */}
      {p.status === 'rejected' && p.review_notes && (
        <div className="bg-red-500/5 border border-red-500/20 rounded p-2 mb-2 text-xs">
          <p className="text-red-300 uppercase tracking-wider text-[10px] mb-0.5">Rejection reason</p>
          <p className="text-gray-300">{p.review_notes}</p>
        </div>
      )}

      {/* Action buttons */}
      {p.status === 'pending' && !showApprove && !showReject && (
        <div className="flex gap-2 mt-3 pt-3 border-t border-gray-800">
          <button
            onClick={() => setShowApprove(true)}
            className="flex-1 text-xs bg-green-700/20 hover:bg-green-700/30 text-green-300 border border-green-700/40 font-medium px-3 py-1.5 rounded transition"
          >
            ✓ Approve & apply
          </button>
          <button
            onClick={() => setShowReject(true)}
            className="text-xs bg-red-700/10 hover:bg-red-700/20 text-red-400 border border-red-700/30 px-3 py-1.5 rounded transition"
          >
            ✕ Reject
          </button>
        </div>
      )}

      {p.status === 'approved' && !showApprove && (
        <div className="flex gap-2 mt-3 pt-3 border-t border-gray-800">
          <button
            onClick={() => setShowApprove(true)}
            className="flex-1 text-xs bg-amber-600 hover:bg-amber-500 text-white font-semibold px-3 py-1.5 rounded transition"
          >
            ⚡ Apply to KB item
          </button>
        </div>
      )}

      {/* Approve form (item + field picker) */}
      {showApprove && (
        <div className="mt-3 pt-3 border-t border-gray-800 space-y-2">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Apply to KB item</p>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={pickedItem}
              onChange={e => setPickedItem(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-amber-500"
            >
              <option value="">— pick KB item —</option>
              {kbItems.map(k => (
                <option key={k.id} value={k.id}>{k.category}: {k.name}</option>
              ))}
            </select>
            <select
              value={pickedField}
              onChange={e => setPickedField(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-amber-500"
            >
              {FIELD_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Optional: why approving this rule?"
            rows={2}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-amber-500 resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={p.status === 'pending' ? handleApprove : handleApply}
              disabled={working || (p.status !== 'pending' && (!pickedItem || !pickedField))}
              className="flex-1 text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-semibold px-3 py-1.5 rounded transition"
            >
              {working ? 'Working…' : (p.status === 'pending' ? 'Approve only' : 'Apply now')}
            </button>
            {p.status === 'pending' && (
              <button
                onClick={handleApply}
                disabled={working || !pickedItem || !pickedField}
                className="flex-1 text-xs bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white font-semibold px-3 py-1.5 rounded transition"
              >
                {working ? 'Working…' : 'Approve + Apply'}
              </button>
            )}
            <button onClick={() => setShowApprove(false)} className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1.5 transition">Cancel</button>
          </div>
        </div>
      )}

      {/* Reject form */}
      {showReject && (
        <div className="mt-3 pt-3 border-t border-gray-800 space-y-2">
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Why rejecting? (optional but helpful for future extractor learning)"
            rows={2}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-red-500 resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleReject}
              disabled={working}
              className="flex-1 text-xs bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white font-semibold px-3 py-1.5 rounded transition"
            >
              {working ? 'Working…' : 'Confirm reject'}
            </button>
            <button onClick={() => setShowReject(false)} className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1.5 transition">Cancel</button>
          </div>
        </div>
      )}
    </article>
  )
}
