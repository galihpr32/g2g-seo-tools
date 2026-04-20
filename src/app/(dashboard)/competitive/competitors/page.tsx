'use client'

import { useState, useEffect, useCallback } from 'react'
import { LottieLoader } from '@/components/ui/LottieLoader'

interface Competitor {
  id: string
  domain: string
  name: string
  active: boolean
  notes?: string | null
  created_at: string
}

// ── Inline form ───────────────────────────────────────────────────────────────
function CompetitorForm({ initial, onSave, onCancel }: {
  initial?: Partial<Competitor>
  onSave: (data: { domain: string; name: string; notes: string }) => Promise<void>
  onCancel: () => void
}) {
  const [domain, setDomain] = useState(initial?.domain ?? '')
  const [name,   setName]   = useState(initial?.name   ?? '')
  const [notes,  setNotes]  = useState(initial?.notes  ?? '')
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!domain.trim() || !name.trim()) { setErr('Domain and name are required.'); return }
    setSaving(true); setErr(null)
    try { await onSave({ domain, name, notes }) }
    catch (e) { setErr(String(e)) }
    finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Competitor name <span className="text-red-500">*</span></label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. PlayerAuctions"
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Domain <span className="text-red-500">*</span></label>
          <input value={domain} onChange={e => setDomain(e.target.value)}
            placeholder="e.g. playerauctions.com" disabled={!!initial?.id}
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 disabled:opacity-50" />
        </div>
      </div>
      <div>
        <label className="block text-xs text-gray-400 mb-1">Notes <span className="text-gray-600">(optional)</span></label>
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Main marketplace competitor, watches G2G closely"
          className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
      </div>
      {err && <p className="text-red-400 text-xs">{err}</p>}
      <div className="flex items-center gap-3 pt-1">
        <button type="submit" disabled={saving}
          className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2 rounded-lg transition">
          {saving ? 'Saving…' : initial?.id ? 'Save changes' : 'Add competitor'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-gray-500 hover:text-gray-300 transition">Cancel</button>
      </div>
    </form>
  )
}

// ── Competitor row card ───────────────────────────────────────────────────────
function CompetitorCard({ competitor, onDelete, onEdit, onToggle }: {
  competitor: Competitor
  onDelete: (id: string) => void
  onEdit: (c: Competitor) => void
  onToggle: (id: string, active: boolean) => void
}) {
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    if (!confirm(`Remove "${competitor.name}" from your competitor list?`)) return
    setDeleting(true)
    await fetch(`/api/competitors?id=${competitor.id}`, { method: 'DELETE' })
    onDelete(competitor.id)
  }

  return (
    <div className={`bg-gray-900 border rounded-xl p-4 flex items-center gap-4 transition ${
      competitor.active ? 'border-gray-800 hover:border-gray-700' : 'border-gray-800 opacity-50'
    }`}>
      {/* Domain favicon */}
      <div className="w-9 h-9 rounded-lg bg-gray-800 border border-gray-700 flex items-center justify-center flex-shrink-0 overflow-hidden">
        <img
          src={`https://www.google.com/s2/favicons?sz=32&domain_url=${competitor.domain}`}
          alt=""
          className="w-5 h-5"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-white text-sm font-semibold">{competitor.name}</p>
          {!competitor.active && <span className="text-xs text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full">Paused</span>}
        </div>
        <a href={`https://${competitor.domain}`} target="_blank" rel="noopener noreferrer"
          className="text-xs text-blue-400 hover:text-blue-300 transition">{competitor.domain}</a>
        {competitor.notes && <p className="text-xs text-gray-500 mt-0.5 truncate">{competitor.notes}</p>}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => onToggle(competitor.id, !competitor.active)}
          title={competitor.active ? 'Pause tracking' : 'Resume tracking'}
          className="text-xs text-gray-500 hover:text-white px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 transition"
        >
          {competitor.active ? '⏸' : '▶'}
        </button>
        <button onClick={() => onEdit(competitor)}
          className="text-xs text-gray-500 hover:text-white px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 transition">
          Edit
        </button>
        <button onClick={handleDelete} disabled={deleting}
          className="text-xs text-gray-600 hover:text-red-400 px-2 py-1 rounded bg-gray-800 hover:bg-red-500/10 transition">
          {deleting ? '…' : 'Remove'}
        </button>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CompetitorsPage() {
  const [competitors, setCompetitors] = useState<Competitor[]>([])
  const [loading, setLoading]         = useState(true)
  const [showForm, setShowForm]       = useState(false)
  const [editing, setEditing]         = useState<Competitor | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/competitors')
      if (res.ok) {
        const { competitors } = await res.json()
        setCompetitors(competitors)
      }
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleSave(data: { domain: string; name: string; notes: string }) {
    if (editing) {
      const res = await fetch(`/api/competitors?id=${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to update')
    } else {
      const res = await fetch('/api/competitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const { error } = await res.json()
        throw new Error(error ?? 'Failed to create')
      }
    }
    setShowForm(false); setEditing(null)
    await load()
  }

  async function handleToggle(id: string, active: boolean) {
    await fetch(`/api/competitors?id=${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    })
    setCompetitors(prev => prev.map(c => c.id === id ? { ...c, active } : c))
  }

  const active = competitors.filter(c => c.active)
  const paused = competitors.filter(c => !c.active)

  return (
    <div className="p-8 max-w-3xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">👁️ Competitor List</h1>
          <p className="text-gray-400 text-sm mt-1">
            Manage the domains you want to track across Keyword Gap and SERP Share of Voice.
            {competitors.length > 0 && ` ${active.length} active · ${competitors.length} total`}
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setShowForm(true) }}
          className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-4 py-2 rounded-xl transition"
        >
          + Add competitor
        </button>
      </div>

      {/* Form */}
      {(showForm || editing) && (
        <div className="mb-6">
          <CompetitorForm
            initial={editing ?? undefined}
            onSave={handleSave}
            onCancel={() => { setShowForm(false); setEditing(null) }}
          />
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-12">
          <LottieLoader size={80} text="Loading competitors…" />
        </div>
      )}

      {/* Empty state */}
      {!loading && competitors.length === 0 && !showForm && (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">👁️</p>
          <p className="text-white font-semibold mb-1">No competitors tracked yet</p>
          <p className="text-gray-400 text-sm mb-5">
            Add competitor domains to use them in Keyword Gap analysis and SERP Share of Voice tracking.
          </p>
          <button onClick={() => setShowForm(true)}
            className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition">
            + Add your first competitor
          </button>
        </div>
      )}

      {/* Active competitors */}
      {!loading && active.length > 0 && (
        <div className="space-y-2 mb-4">
          {active.map(c => (
            <CompetitorCard key={c.id} competitor={c}
              onDelete={id => setCompetitors(prev => prev.filter(x => x.id !== id))}
              onEdit={c => { setEditing(c); setShowForm(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}

      {/* Paused */}
      {!loading && paused.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2">Paused</p>
          <div className="space-y-2">
            {paused.map(c => (
              <CompetitorCard key={c.id} competitor={c}
                onDelete={id => setCompetitors(prev => prev.filter(x => x.id !== id))}
                onEdit={c => { setEditing(c); setShowForm(false) }}
                onToggle={handleToggle}
              />
            ))}
          </div>
        </div>
      )}

      {/* Info tip */}
      {!loading && competitors.length > 0 && (
        <div className="mt-6 bg-blue-500/5 border border-blue-500/20 rounded-xl p-4">
          <p className="text-blue-300 text-xs font-medium mb-1">💡 How competitors are used</p>
          <p className="text-gray-500 text-xs">
            Active competitors appear as options in the <strong className="text-gray-400">Keyword Gap</strong> and{' '}
            <strong className="text-gray-400">SERP &amp; Share of Voice</strong> tools.
            Pausing a competitor hides it from those dropdowns but keeps the historical data.
          </p>
        </div>
      )}
    </div>
  )
}
