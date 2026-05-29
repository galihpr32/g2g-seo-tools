'use client'

import { useEffect, useState } from 'react'
import type { ContentKitData, KitSection, KitFaqItem, KitFanOutPassage } from '@/lib/content-kit/types'

/**
 * Sprint CKB.4 — Content Kit Builder modal.
 *
 * Reusable across Keyword Master row + Priority Products detail page.
 *
 * Lifecycle:
 *   1. PRE-BUILD: user reviews target_sections + DIY counter toggle, hits Start
 *   2. BUILDING: poll /api/content-kit/:id every 3s until status flips
 *   3. READY: show kit preview, allow per-section edit/remove, send to Bragi
 *   4. SENT: terminal state, kit moved into Bragi pipeline
 *   5. FAILED: error_message shown, retry button
 */

interface KitRecord {
  id:                  string
  status:              'pending' | 'building' | 'ready' | 'failed' | 'sent_to_bragi' | 'superseded'
  primary_keyword:     string
  market:              'us' | 'id'
  language:            'en' | 'id'
  kit_data:            ContentKitData | null
  error_message:       string | null
  build_started_at:    string | null
  build_completed_at:  string | null
  sent_to_bragi_at:    string | null
}

export interface ContentKitModalProps {
  open:                boolean
  onClose:             () => void
  primaryKeywordId:    string
  productTierId:       string
  primaryKeyword:      string
  productName:         string
}

export function ContentKitModal(props: ContentKitModalProps) {
  const { open, onClose, primaryKeywordId, productTierId, primaryKeyword, productName } = props

  const [kit,         setKit]         = useState<KitRecord | null>(null)
  const [building,    setBuilding]    = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [targetSections, setTargetSections] = useState(6)
  const [includeDiy,     setIncludeDiy]     = useState(false)
  const [sending,     setSending]     = useState(false)
  const [polling,     setPolling]     = useState(false)

  // Reset on close
  useEffect(() => {
    if (!open) {
      setKit(null); setError(null); setBuilding(false); setSending(false); setPolling(false)
    }
  }, [open])

  // Poll while building
  useEffect(() => {
    if (!kit || !polling) return
    const interval = setInterval(async () => {
      try {
        const r = await fetch(`/api/content-kit/${kit.id}`)
        const d = await r.json()
        if (r.ok && d.kit) {
          setKit(d.kit as KitRecord)
          if (d.kit.status === 'ready' || d.kit.status === 'failed' || d.kit.status === 'sent_to_bragi') {
            setPolling(false); setBuilding(false)
          }
        }
      } catch { /* keep polling */ }
    }, 3000)
    return () => clearInterval(interval)
  }, [kit, polling])

  async function startBuild() {
    setBuilding(true); setError(null)
    try {
      const r = await fetch('/api/content-kit/build', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_tier_id:    productTierId,
          primary_keyword_id: primaryKeywordId,
          target_sections:    targetSections,
          include_diy:        includeDiy,
        }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error ?? `HTTP ${r.status}`); setBuilding(false); return }
      // Fetch initial record + start polling
      const r2 = await fetch(`/api/content-kit/${d.kit_id}`)
      const d2 = await r2.json()
      setKit(d2.kit as KitRecord)
      setPolling(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBuilding(false)
    }
  }

  async function persistKitEdit(updated: ContentKitData) {
    if (!kit) return
    setKit({ ...kit, kit_data: updated })
    await fetch(`/api/content-kit/${kit.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kit_data: updated }),
    }).catch(() => { /* non-blocking */ })
  }

  async function sendToBragi() {
    if (!kit) return
    setSending(true); setError(null)
    try {
      const r = await fetch(`/api/content-kit/${kit.id}/send-to-bragi`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output_type: 'optimize_existing' }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error ?? 'Send failed'); setSending(false); return }
      setKit({ ...kit, status: 'sent_to_bragi', sent_to_bragi_at: new Date().toISOString() })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setSending(false) }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm overflow-y-auto p-4">
      <div className="w-full max-w-4xl bg-gray-950 border border-gray-800 rounded-xl shadow-2xl my-8">
        {/* Header */}
        <header className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-white font-bold text-lg flex items-center gap-2">
              🎯 Build Content Kit
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">
              <span className="text-amber-300">{primaryKeyword}</span>
              {' · '}
              <span className="text-gray-300">{productName}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">✕</button>
        </header>

        {/* Body — switches by state */}
        <div className="p-5">
          {!kit && !building && (
            <PreBuildState
              targetSections={targetSections}
              setTargetSections={setTargetSections}
              includeDiy={includeDiy}
              setIncludeDiy={setIncludeDiy}
              onStart={startBuild}
            />
          )}

          {(building || (kit && (kit.status === 'pending' || kit.status === 'building'))) && (
            <BuildingState kit={kit} />
          )}

          {kit && kit.status === 'failed' && (
            <FailedState
              error={kit.error_message ?? error ?? 'Unknown error'}
              onRetry={() => { setKit(null); setBuilding(false); setError(null) }}
            />
          )}

          {kit && (kit.status === 'ready' || kit.status === 'sent_to_bragi') && kit.kit_data && (
            <ReadyState
              kit={kit}
              onEdit={persistKitEdit}
              onSendToBragi={sendToBragi}
              sending={sending}
            />
          )}

          {error && !kit && (
            <div className="mt-3 p-3 rounded bg-red-500/15 border border-red-500/40 text-sm text-red-200">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Sub-states ──────────────────────────────────────────────────────────────

function PreBuildState(props: {
  targetSections:    number
  setTargetSections: (n: number) => void
  includeDiy:        boolean
  setIncludeDiy:     (v: boolean) => void
  onStart:           () => void
}) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-300">
        Generate a comprehensive content kit for this primary keyword. We&apos;ll scrape SERP, classify intent on
        ~15 candidate KWs, generate fan-out passages, run gap analysis, and assemble a section blueprint ready
        for Bragi. Takes ~45 seconds.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-xs text-gray-400 block mb-1">Target H2 sections</span>
          <input
            type="number" min={4} max={10}
            value={props.targetSections}
            onChange={e => props.setTargetSections(Math.min(10, Math.max(4, Number(e.target.value) || 6)))}
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
          />
          <span className="text-[10px] text-gray-500 block mt-1">Default 6. Beyond 8 risks page dilution.</span>
        </label>

        <label className="flex items-start gap-2 cursor-pointer pt-5">
          <input
            type="checkbox" checked={props.includeDiy}
            onChange={e => props.setIncludeDiy(e.target.checked)}
            className="mt-0.5"
          />
          <div>
            <span className="text-sm text-white">Include DIY counter-content</span>
            <p className="text-[10px] text-gray-500 mt-0.5">
              Generate sections that address &quot;how to farm yourself&quot;-style KWs with counter-arguments.
              Risky — only enable if writer can execute well.
            </p>
          </div>
        </label>
      </div>

      <div className="bg-gray-900/60 border border-gray-800 rounded p-3 text-xs text-gray-400">
        Estimated cost: ~$0.037 per kit ·{' '}
        Intent filter strict (≥7/10 ecommerce in SERP top 10) ·{' '}
        Cross-tier internal links allowed
      </div>

      <button
        onClick={props.onStart}
        className="w-full px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-gray-950 font-semibold rounded-lg transition"
      >
        🎯 Start build
      </button>
    </div>
  )
}

function BuildingState({ kit }: { kit: KitRecord | null }) {
  const phaseLabel = !kit ? 'Initializing...' :
    kit.status === 'pending' ? 'Queued · SERP scrape next...' :
    kit.status === 'building' ? 'Classifying intent · generating fan-out · analyzing gaps...' :
    'Working...'
  return (
    <div className="py-12 text-center space-y-4">
      <div className="inline-block w-12 h-12 rounded-full border-4 border-amber-500 border-t-transparent animate-spin" />
      <p className="text-white font-semibold">Building content kit</p>
      <p className="text-xs text-gray-400">{phaseLabel}</p>
      <p className="text-[10px] text-gray-600 italic">Polling every 3 seconds · safe to close and check back later via Keyword Master</p>
    </div>
  )
}

function FailedState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="py-8 text-center space-y-4">
      <div className="text-red-400 text-3xl">⚠</div>
      <p className="text-white font-semibold">Build failed</p>
      <p className="text-xs text-red-200/80 max-w-md mx-auto break-words">{error}</p>
      <button onClick={onRetry} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded">
        ↻ Try again
      </button>
    </div>
  )
}

function ReadyState(props: {
  kit:           KitRecord
  onEdit:        (next: ContentKitData) => void
  onSendToBragi: () => void
  sending:       boolean
}) {
  const { kit } = props
  const data = kit.kit_data!
  const sent = kit.status === 'sent_to_bragi'

  function removeSection(i: number) {
    if (!confirm('Remove this section?')) return
    const next = { ...data, sections: data.sections.filter((_, idx) => idx !== i) }
    props.onEdit(next)
  }
  function removeFaq(i: number) {
    const next = { ...data, faq: data.faq.filter((_, idx) => idx !== i) }
    props.onEdit(next)
  }
  function removeFanOut(i: number) {
    const next = { ...data, fan_out_passages: data.fan_out_passages.filter((_, idx) => idx !== i) }
    props.onEdit(next)
  }

  return (
    <div className="space-y-5">
      {/* Meta strip */}
      <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
        <div className="flex gap-3 flex-wrap">
          <Pill label={`${data.sections.length} sections`} tone="emerald" />
          <Pill label={`${data.faq.length} FAQ`} tone="blue" />
          <Pill label={`${data.fan_out_passages.length} passages`} tone="violet" />
          <Pill label={`${data.cross_links.length} cross-links`} tone="amber" />
          <Pill label={`${data.gap_analysis.gaps.length} gaps`} tone="red" />
        </div>
        <span className="text-gray-500">
          ~${data.meta.cost_estimate.toFixed(3)} · {data.meta.candidates_passed}/{data.meta.candidates_total} passed
        </span>
      </div>

      {/* Sections */}
      <KitSectionList sections={data.sections} onRemove={removeSection} />

      {/* FAQ */}
      <KitFaqList faq={data.faq} onRemove={removeFaq} language={kit.language} />

      {/* Fan-out passages */}
      <KitFanOutList passages={data.fan_out_passages} onRemove={removeFanOut} />

      {/* Cross-links */}
      {data.cross_links.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-white mb-2">🔗 Cross-link suggestions</h3>
          <ul className="space-y-1.5 text-xs">
            {data.cross_links.map(cl => (
              <li key={cl.target_product_id} className="bg-gray-900 border border-gray-800 rounded p-2 flex items-center gap-2">
                <span className="text-[9px] uppercase font-bold text-gray-500">{cl.reason}</span>
                <span className="text-amber-300">→ {cl.anchor_text}</span>
                {cl.target_url && <a href={cl.target_url} target="_blank" rel="noreferrer" className="text-gray-500 hover:text-blue-400 ml-auto truncate max-w-[200px]">{cl.target_url}</a>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Gap analysis */}
      {data.gap_analysis.gaps.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-white mb-2">📊 Content gaps (vs top 10 competitors)</h3>
          <ul className="space-y-1.5 text-xs">
            {data.gap_analysis.gaps.map((g, i) => (
              <li key={i} className="bg-gray-900 border border-gray-800 rounded p-2.5">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded ${
                    g.priority === 'high' ? 'bg-red-500/20 text-red-300' :
                    g.priority === 'medium' ? 'bg-amber-500/20 text-amber-300' :
                    'bg-gray-700/40 text-gray-400'
                  }`}>{g.priority}</span>
                  <span className="text-white font-medium">{g.topic}</span>
                </div>
                <p className="text-gray-400 italic leading-relaxed">{g.why}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-between pt-3 border-t border-gray-800">
        {sent ? (
          <div className="flex items-center gap-2 text-emerald-300 text-sm">
            ✓ Sent to Bragi at {kit.sent_to_bragi_at ? new Date(kit.sent_to_bragi_at).toLocaleTimeString() : ''}
          </div>
        ) : (
          <span className="text-xs text-gray-500">Review + edit sections above, then push to Bragi pipeline.</span>
        )}
        <button
          onClick={props.onSendToBragi}
          disabled={props.sending || sent}
          className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-gray-950 font-semibold rounded-lg"
        >
          {sent ? '✓ Sent' : props.sending ? 'Sending...' : '📤 Send to Bragi'}
        </button>
      </div>
    </div>
  )
}

// ─── List sub-components ─────────────────────────────────────────────────────

function KitSectionList(props: { sections: KitSection[]; onRemove: (i: number) => void }) {
  if (props.sections.length === 0) return null
  return (
    <section>
      <h3 className="text-sm font-semibold text-white mb-2">📑 Section blueprint</h3>
      <ol className="space-y-2">
        {props.sections.map((s, i) => (
          <li key={i} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center justify-center text-xs font-bold">
                {s.position}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-white font-medium text-sm">{s.h2_title}</p>
                <div className="flex flex-wrap gap-2 mt-1 text-[10px]">
                  <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">target: {s.target_kw}</span>
                  <span className={`px-1.5 py-0.5 rounded ${
                    s.intent_class === 'commercial-supportive' ? 'bg-emerald-500/20 text-emerald-300' :
                    s.intent_class === 'commercial-investigation' ? 'bg-amber-500/20 text-amber-300' :
                    s.intent_class === 'diy-competing' ? 'bg-red-500/20 text-red-300' :
                    'bg-gray-700 text-gray-400'
                  }`}>{s.intent_class}</span>
                  <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">source: {s.source}</span>
                  {s.cta_bridge && <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">CTA bridge</span>}
                </div>
                <p className="text-xs text-gray-400 mt-1.5 italic leading-relaxed">{s.body_outline}</p>
              </div>
              {props.sections.length > 1 && i > 0 && (
                <button onClick={() => props.onRemove(i)} className="text-gray-600 hover:text-red-400 text-xs">✕</button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function KitFaqList(props: { faq: KitFaqItem[]; onRemove: (i: number) => void; language: 'en' | 'id' }) {
  if (props.faq.length === 0) return null
  return (
    <section>
      <h3 className="text-sm font-semibold text-white mb-2">❓ FAQ ({props.faq.length})</h3>
      <ul className="space-y-1.5">
        {props.faq.map((f, i) => (
          <li key={i} className="bg-gray-900 border border-gray-800 rounded p-2.5 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-white font-medium">{props.language === 'id' ? f.q_id : f.q_en}</p>
                <p className="text-gray-400 mt-0.5 italic">{props.language === 'id' ? f.a_id : f.a_en}</p>
              </div>
              <span className="text-[9px] uppercase text-gray-500 flex-shrink-0">{f.source}</span>
              <button onClick={() => props.onRemove(i)} className="text-gray-600 hover:text-red-400 flex-shrink-0">✕</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function KitFanOutList(props: { passages: KitFanOutPassage[]; onRemove: (i: number) => void }) {
  if (props.passages.length === 0) return null
  return (
    <section>
      <h3 className="text-sm font-semibold text-white mb-2">🔮 Fan-out passages (AI Overview-ready)</h3>
      <ul className="space-y-1.5">
        {props.passages.map((p, i) => (
          <li key={i} className="bg-gray-900 border border-gray-800 rounded p-2.5 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-amber-300 font-medium text-[11px]">{p.topic}</p>
                <p className="text-gray-300 mt-1 leading-relaxed">{p.passage_en}</p>
                <p className="text-gray-500 mt-0.5 italic leading-relaxed">{p.passage_id}</p>
                <p className="text-[9px] text-gray-600 mt-1">→ {p.section_hint}</p>
              </div>
              <button onClick={() => props.onRemove(i)} className="text-gray-600 hover:text-red-400 flex-shrink-0">✕</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Pill({ label, tone }: { label: string; tone: 'emerald' | 'blue' | 'violet' | 'amber' | 'red' }) {
  const cls = {
    emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    blue:    'bg-blue-500/15 text-blue-300 border-blue-500/30',
    violet:  'bg-violet-500/15 text-violet-300 border-violet-500/30',
    amber:   'bg-amber-500/15 text-amber-300 border-amber-500/30',
    red:     'bg-red-500/15 text-red-300 border-red-500/30',
  }[tone]
  return <span className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${cls}`}>{label}</span>
}
