'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  useDraggable,
  useDroppable,
  closestCenter,
} from '@dnd-kit/core'
import { LottieLoader } from '@/components/ui/LottieLoader'
import SagaProposalsPanel from '@/components/agents/SagaProposalsPanel'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AiNotes {
  priority_note?: string
  linking_note?: string
  estimated_authority_weeks?: number
}

interface KeywordMap {
  id: string
  topic: string
  topic_slug: string
  aliases: string[]
  pillar_keyword: string | null
  pillar_title: string | null
  pillar_url_slug: string | null
  market: string
  status: string
  ai_notes: AiNotes | null
  created_at: string
  updated_at: string
  keyword_map_clusters?: [{ count: number }]
}

interface Cluster {
  id: string
  map_id: string
  keyword: string
  search_volume: number | null
  difficulty: number | null
  intent: string | null
  content_type: string | null
  cluster_group: string | null
  suggested_title: string | null
  url_slug: string | null
  priority_order: number
  is_pillar: boolean
  status: string
  source: string
  created_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  not_started: 'bg-gray-800 text-gray-400 border-gray-700',
  writing:     'bg-blue-900/50 text-blue-300 border-blue-700',
  review:      'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  published:   'bg-green-900/50 text-green-300 border-green-700',
  tracking:    'bg-purple-900/50 text-purple-300 border-purple-700',
}
const STATUS_LABELS: Record<string, string> = {
  not_started: 'Not started',
  writing:     'Writing',
  review:      'Review',
  published:   'Published',
  tracking:    'Tracking',
}
const STATUS_FLOW = ['not_started', 'writing', 'review', 'published', 'tracking']

const MAP_STATUS_STYLES: Record<string, string> = {
  planning:    'bg-gray-800 text-gray-400',
  in_progress: 'bg-blue-900/50 text-blue-300',
  published:   'bg-green-900/50 text-green-300',
}

const INTENT_COLORS: Record<string, string> = {
  commercial:    'bg-red-900/40 text-red-300',
  transactional: 'bg-orange-900/40 text-orange-300',
  informational: 'bg-blue-900/40 text-blue-300',
  navigational:  'bg-purple-900/40 text-purple-300',
}

const CONTENT_TYPE_COLORS: Record<string, string> = {
  landing_page: 'bg-green-900/40 text-green-300',
  guide:        'bg-blue-900/40 text-blue-300',
  comparison:   'bg-yellow-900/40 text-yellow-300',
  faq:          'bg-gray-700 text-gray-300',
}

function diffColor(d: number | null) {
  if (d == null) return 'text-gray-600'
  if (d < 30)    return 'text-green-400'
  if (d < 60)    return 'text-yellow-400'
  return 'text-red-400'
}

function volFmt(v: number | null) {
  if (!v) return '—'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`
  return String(v)
}

// ── DifficultyBar ─────────────────────────────────────────────────────────────
function DifficultyBar({ value }: { value: number | null }) {
  if (value == null) return <span className="text-gray-600 text-xs">—</span>
  const color = value < 30 ? '#22c55e' : value < 60 ? '#eab308' : '#ef4444'
  return (
    <div className="flex items-center gap-1.5 min-w-[60px]">
      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
      <span className={`text-xs tabular-nums ${diffColor(value)}`}>{value}</span>
    </div>
  )
}

// ── StatusPill ────────────────────────────────────────────────────────────────
function StatusPill({ status, onChange }: { status: string; onChange: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border cursor-pointer select-none transition hover:opacity-80 ${STATUS_STYLES[status] ?? STATUS_STYLES.not_started}`}
      >
        {STATUS_LABELS[status] ?? status}
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[130px]">
          {STATUS_FLOW.map(s => (
            <button
              key={s}
              onClick={e => { e.stopPropagation(); onChange(s); setOpen(false) }}
              className={`w-full text-left text-xs px-3 py-1.5 hover:bg-gray-700 transition flex items-center gap-2 ${s === status ? 'text-white font-semibold' : 'text-gray-400'}`}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_STYLES[s]?.split(' ')[0]}`} />
              {STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── CreateMapModal ─────────────────────────────────────────────────────────────
function CreateMapModal({ onClose, onCreated, prefillKeyword }: {
  onClose: () => void
  onCreated: (map: KeywordMap, clusters: Cluster[]) => void
  prefillKeyword?: string | null
}) {
  const [topic, setTopic]         = useState(prefillKeyword ?? '')
  const [market, setMarket]       = useState('us')
  const [seeds, setSeeds]         = useState('')
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')

  async function handleSubmit() {
    if (!topic.trim()) return
    setLoading(true)
    setError('')
    try {
      const seed_keywords = seeds.trim() ? seeds.split(',').map(s => s.trim()).filter(Boolean) : undefined
      const res = await fetch('/api/keyword-maps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: topic.trim(), market, seed_keywords }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to create map')
      } else {
        onCreated(data.map, data.clusters ?? [])
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-white font-semibold text-sm">New Keyword Map</h2>
            <p className="text-gray-500 text-xs mt-0.5">AI will organize keywords into a topic cluster</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition text-lg">✕</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-gray-400 text-xs font-medium mb-1.5">Topic *</label>
            <input
              type="text"
              value={topic}
              onChange={e => setTopic(e.target.value)}
              placeholder="e.g. Mobile Legends, Genshin Impact"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500"
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            />
          </div>

          <div>
            <label className="block text-gray-400 text-xs font-medium mb-1.5">Market</label>
            <div className="flex gap-2">
              {[{ v: 'us', l: '🇺🇸 United States' }, { v: 'id', l: '🇮🇩 Indonesia' }].map(o => (
                <button
                  key={o.v}
                  onClick={() => setMarket(o.v)}
                  className={`flex-1 text-xs py-2 rounded-lg border transition ${market === o.v ? 'bg-red-700 border-red-600 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'}`}
                >
                  {o.l}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-gray-400 text-xs font-medium mb-1.5">Seed Keywords <span className="text-gray-600">(optional, comma-separated)</span></label>
            <input
              type="text"
              value={seeds}
              onChange={e => setSeeds(e.target.value)}
              placeholder="e.g. buy mobile legends diamonds, ml top up"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500"
            />
          </div>

          {error && (
            <div className="bg-red-900/30 border border-red-700 rounded-lg px-3 py-2 text-red-300 text-xs">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 pb-5 flex gap-3">
          <button onClick={onClose} className="flex-1 text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 py-2 rounded-lg transition">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !topic.trim()}
            className="flex-1 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2 rounded-lg transition flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Generating…
              </>
            ) : (
              <>✨ Generate Map</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── MoveClusterModal ──────────────────────────────────────────────────────────
function MoveClusterModal({ cluster, currentMapId, allMaps, onClose, onMoved }: {
  cluster: Cluster
  currentMapId: string
  allMaps: KeywordMap[]
  onClose: () => void
  onMoved: (clusterId: string, newMapId: string) => void
}) {
  const otherMaps   = allMaps.filter(m => m.id !== currentMapId)
  const [targetMap, setTargetMap] = useState(otherMaps[0]?.id ?? '')
  const [group, setGroup]         = useState('')
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')

  async function handleMove() {
    if (!targetMap) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/keyword-maps/${currentMapId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster_id:    cluster.id,
          move_to_map_id: targetMap,
          cluster_group: group.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to move keyword')
      } else {
        onMoved(cluster.id, targetMap)
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-white font-semibold text-sm">Move Keyword</h2>
            <p className="text-gray-500 text-xs mt-0.5 font-mono truncate max-w-[280px]">{cluster.keyword}</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition text-lg">✕</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {otherMaps.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-4">No other maps available. Create another map first.</p>
          ) : (
            <>
              <div>
                <label className="block text-gray-400 text-xs font-medium mb-1.5">Move to Map</label>
                <select
                  value={targetMap}
                  onChange={e => setTargetMap(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
                >
                  {otherMaps.map(m => (
                    <option key={m.id} value={m.id}>{m.topic}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-gray-400 text-xs font-medium mb-1.5">Group name <span className="text-gray-600">(optional)</span></label>
                <input
                  type="text"
                  value={group}
                  onChange={e => setGroup(e.target.value)}
                  placeholder="e.g. Price & Buying"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500"
                />
              </div>
            </>
          )}

          {error && (
            <div className="bg-red-900/30 border border-red-700 rounded-lg px-3 py-2 text-red-300 text-xs">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 pb-5 flex gap-3">
          <button onClick={onClose} className="flex-1 text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 py-2 rounded-lg transition">
            Cancel
          </button>
          {otherMaps.length > 0 && (
            <button
              onClick={handleMove}
              disabled={loading || !targetMap}
              className="flex-1 text-sm bg-blue-700 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2 rounded-lg transition flex items-center justify-center gap-2"
            >
              {loading ? (
                <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Moving…</>
              ) : '→ Move Keyword'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── AddKeywordModal ───────────────────────────────────────────────────────────
function AddKeywordModal({ mapId, allMaps, onClose, onAdded, prefillKeyword, prefillVolume }: {
  mapId: string | null
  allMaps: KeywordMap[]
  onClose: () => void
  onAdded: (cluster: Cluster) => void
  prefillKeyword?: string | null
  prefillVolume?: number | null
}) {
  const [selectedMapId, setSelectedMapId] = useState(mapId ?? allMaps[0]?.id ?? '')
  const [keyword, setKeyword]   = useState(prefillKeyword ?? '')
  const [volume, setVolume]     = useState(prefillVolume ? String(prefillVolume) : '')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')

  async function handleAdd() {
    if (!keyword.trim() || !selectedMapId) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/keyword-maps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          add_cluster: {
            map_id:  selectedMapId,
            keyword: keyword.trim(),
            volume:  volume ? parseInt(volume) : undefined,
            source:  'manual',
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to add keyword')
      } else {
        onAdded(data.cluster)
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-white font-semibold text-sm">Add Keyword to Map</h2>
            <p className="text-gray-500 text-xs mt-0.5">Manually add a keyword to an existing topic map</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition text-lg">✕</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-gray-400 text-xs font-medium mb-1.5">Target Map</label>
            <select
              value={selectedMapId}
              onChange={e => setSelectedMapId(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
            >
              {allMaps.map(m => (
                <option key={m.id} value={m.id}>{m.topic}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-gray-400 text-xs font-medium mb-1.5">Keyword</label>
            <input
              type="text"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="e.g. buy mobile legends diamonds"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500"
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
            />
          </div>

          <div>
            <label className="block text-gray-400 text-xs font-medium mb-1.5">Search Volume <span className="text-gray-600">(optional)</span></label>
            <input
              type="number"
              value={volume}
              onChange={e => setVolume(e.target.value)}
              placeholder="e.g. 12000"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500"
            />
          </div>

          {error && (
            <div className="bg-red-900/30 border border-red-700 rounded-lg px-3 py-2 text-red-300 text-xs">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 pb-5 flex gap-3">
          <button onClick={onClose} className="flex-1 text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 py-2 rounded-lg transition">
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={loading || !keyword.trim() || !selectedMapId}
            className="flex-1 text-sm bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2 rounded-lg transition flex items-center justify-center gap-2"
          >
            {loading ? (
              <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />Adding…</>
            ) : '+ Add Keyword'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── TreeView ──────────────────────────────────────────────────────────────────
// ── DroppableGroup: cluster_group container that accepts dropped keywords ───
function DroppableGroup({ id, children, isOver }: { id: string; children: React.ReactNode; isOver: boolean }) {
  const { setNodeRef } = useDroppable({ id })
  return (
    <div
      ref={setNodeRef}
      className={`bg-gray-900 border rounded-xl overflow-hidden transition ${
        isOver ? 'border-purple-500 ring-2 ring-purple-500/30' : 'border-gray-800'
      }`}
    >
      {children}
    </div>
  )
}

// ── DraggableClusterRow: ClusterRow wrapped with drag handle ────────────────
function DraggableClusterRow({
  cluster, onStatusChange, onMoveRequest, onDeleteRequest,
}: {
  cluster: Cluster
  onStatusChange: (id: string, status: string) => void
  onMoveRequest: (c: Cluster) => void
  onDeleteRequest: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id:   cluster.id,
    data: { cluster },
  })

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 50 : 1 }
    : { opacity: isDragging ? 0.4 : 1 }

  return (
    <div ref={setNodeRef} style={style} className="relative">
      {/* Drag handle ::: at start of row */}
      <div className="absolute left-1 top-1/2 -translate-y-1/2 z-10 text-gray-700 hover:text-gray-400 cursor-grab active:cursor-grabbing select-none px-1"
           {...attributes} {...listeners}
           title="Drag to move between groups">
        ≡
      </div>
      <div className="pl-6">
        <ClusterRow
          cluster={cluster}
          onStatusChange={onStatusChange}
          onMoveRequest={onMoveRequest}
          onDeleteRequest={onDeleteRequest}
        />
      </div>
    </div>
  )
}

function TreeView({ clusters, allMaps, activeMapId, onStatusChange, onMoveRequest, onDeleteRequest, onClusterGroupChange }: {
  clusters: Cluster[]
  allMaps: KeywordMap[]
  activeMapId: string
  onStatusChange: (clusterId: string, status: string) => void
  onMoveRequest: (cluster: Cluster) => void
  onDeleteRequest: (clusterId: string) => void
  onClusterGroupChange: (clusterId: string, newGroup: string) => Promise<void>
}) {
  // Group clusters by cluster_group
  const grouped = clusters.reduce<Record<string, Cluster[]>>((acc, c) => {
    const g = c.cluster_group ?? 'General'
    if (!acc[g]) acc[g] = []
    acc[g].push(c)
    return acc
  }, {})

  // Pillar first
  const pillar   = clusters.find(c => c.is_pillar)
  const groupKeys = Object.keys(grouped).filter(k => k !== 'Pillar')

  // Always include 'General' as a drop target even if empty (so users can move to it)
  if (!groupKeys.includes('General')) groupKeys.push('General')

  // DnD state
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [overGroupId,  setOverGroupId]  = useState<string | null>(null)

  function handleDragStart(e: DragStartEvent) {
    setActiveDragId(String(e.active.id))
  }

  function handleDragOver(e: { over?: { id: string | number } | null }) {
    setOverGroupId(e.over ? String(e.over.id) : null)
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveDragId(null)
    setOverGroupId(null)
    if (!e.over) return

    const cluster = clusters.find(c => c.id === e.active.id)
    if (!cluster) return

    const targetGroup = String(e.over.id).replace(/^group:/, '')
    const currentGroup = cluster.cluster_group ?? 'General'

    if (targetGroup === currentGroup) return  // no-op

    onClusterGroupChange(cluster.id, targetGroup)
  }

  const draggedCluster = activeDragId ? clusters.find(c => c.id === activeDragId) : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
    <div className="space-y-4">
      {/* Pillar card */}
      {pillar && (
        <div className="bg-gradient-to-r from-red-900/30 to-gray-900 border border-red-800/50 rounded-xl p-4">
          <div className="flex items-start gap-3 mb-3">
            <div className="w-8 h-8 bg-red-700 rounded-lg flex items-center justify-center flex-shrink-0 text-sm">🏛️</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-white text-sm font-semibold">{pillar.keyword}</span>
                <span className="text-[10px] bg-red-700/50 text-red-300 border border-red-600/50 px-1.5 py-0.5 rounded-full font-bold">PILLAR</span>
                {pillar.intent && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${INTENT_COLORS[pillar.intent] ?? 'bg-gray-700 text-gray-300'}`}>{pillar.intent}</span>
                )}
              </div>
              {pillar.suggested_title && (
                <p className="text-gray-400 text-xs mt-1 truncate">📄 {pillar.suggested_title}</p>
              )}
              {pillar.url_slug && (
                <p className="text-gray-600 text-xs mt-0.5 font-mono">/{pillar.url_slug}</p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <div className="text-right">
                <p className="text-white text-xs font-semibold tabular-nums">{volFmt(pillar.search_volume)}</p>
                <p className="text-gray-600 text-[10px]">vol</p>
              </div>
              <DifficultyBar value={pillar.difficulty} />
              <StatusPill status={pillar.status} onChange={s => onStatusChange(pillar.id, s)} />
              <button
                onClick={() => onMoveRequest(pillar)}
                className="text-gray-600 hover:text-blue-400 text-xs transition px-1"
                title="Move to another map"
              >⇄</button>
            </div>
          </div>
        </div>
      )}

      {/* Cluster groups — droppable containers, draggable rows */}
      {groupKeys.map(groupName => {
        const items = (grouped[groupName] ?? []).sort((a, b) => a.priority_order - b.priority_order)
        const dropId = `group:${groupName}`
        const isOver = overGroupId === dropId
        return (
          <DroppableGroup key={groupName} id={dropId} isOver={isOver}>
            <div className="px-4 py-2.5 bg-gray-800/50 border-b border-gray-800 flex items-center justify-between">
              <span className="text-gray-300 text-xs font-semibold">{groupName}</span>
              <span className="text-gray-600 text-xs">{items.length} keyword{items.length !== 1 ? 's' : ''}{isOver ? ' · drop here' : ''}</span>
            </div>
            <div className="divide-y divide-gray-800/60 min-h-[60px]">
              {items.map(c => (
                <DraggableClusterRow
                  key={c.id}
                  cluster={c}
                  onStatusChange={onStatusChange}
                  onMoveRequest={onMoveRequest}
                  onDeleteRequest={onDeleteRequest}
                />
              ))}
              {items.length === 0 && (
                <p className="text-gray-700 text-xs text-center py-4 italic">drop keywords here</p>
              )}
            </div>
          </DroppableGroup>
        )
      })}

      {clusters.length === 0 && (
        <div className="text-center py-12 text-gray-600">
          <p className="text-2xl mb-2">🗂️</p>
          <p className="text-sm">No keywords yet</p>
          <p className="text-xs mt-1">Generate a map or add keywords manually</p>
        </div>
      )}
    </div>

    {/* Drag overlay — shows the row being dragged following the cursor */}
    <DragOverlay>
      {draggedCluster ? (
        <div className="bg-gray-900 border border-purple-500 rounded-lg px-3 py-2 shadow-2xl text-sm text-white max-w-md">
          <span className="text-purple-400 mr-2">≡</span>
          {draggedCluster.keyword}
          {draggedCluster.search_volume != null && (
            <span className="text-gray-500 text-xs ml-2">{volFmt(draggedCluster.search_volume)} vol</span>
          )}
        </div>
      ) : null}
    </DragOverlay>
    </DndContext>
  )
}

// ── ClusterRow ────────────────────────────────────────────────────────────────
function ClusterRow({ cluster: c, onStatusChange, onMoveRequest, onDeleteRequest }: {
  cluster: Cluster
  onStatusChange: (id: string, status: string) => void
  onMoveRequest: (c: Cluster) => void
  onDeleteRequest: (id: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div className="px-4 py-3 hover:bg-gray-800/20 transition group flex items-start gap-3">
      {/* Priority */}
      <span className="text-gray-700 text-[10px] tabular-nums w-5 text-right flex-shrink-0 mt-0.5">{c.priority_order}</span>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-gray-100 text-xs font-medium">{c.keyword}</span>
          {c.content_type && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${CONTENT_TYPE_COLORS[c.content_type] ?? 'bg-gray-700 text-gray-400'}`}>{c.content_type.replace('_', ' ')}</span>
          )}
          {c.intent && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${INTENT_COLORS[c.intent] ?? 'bg-gray-700 text-gray-400'}`}>{c.intent}</span>
          )}
          {c.source !== 'manual' && (
            <span className="text-[10px] text-gray-600 border border-gray-700 px-1.5 py-0.5 rounded">{c.source}</span>
          )}
        </div>
        {c.suggested_title && (
          <p className="text-gray-500 text-[11px] mt-0.5 truncate">📄 {c.suggested_title}</p>
        )}
        {c.url_slug && (
          <p className="text-gray-700 text-[10px] mt-0.5 font-mono">/{c.url_slug}</p>
        )}
      </div>

      {/* Right side controls */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <p className="text-gray-400 text-xs tabular-nums w-10 text-right">{volFmt(c.search_volume)}</p>
        <DifficultyBar value={c.difficulty} />
        <StatusPill status={c.status} onChange={s => onStatusChange(c.id, s)} />

        {/* Actions menu */}
        <div className="relative" ref={ref}>
          <button
            onClick={e => { e.stopPropagation(); setMenuOpen(o => !o) }}
            className="text-gray-700 hover:text-gray-400 transition opacity-0 group-hover:opacity-100 text-sm px-1"
          >⋮</button>
          {menuOpen && (
            <div className="absolute right-0 top-6 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[140px]">
              <button
                onClick={() => { onMoveRequest(c); setMenuOpen(false) }}
                className="w-full text-left text-xs px-3 py-1.5 text-gray-400 hover:text-white hover:bg-gray-700 transition"
              >⇄ Move to map</button>
              <button
                onClick={() => { onDeleteRequest(c.id); setMenuOpen(false) }}
                className="w-full text-left text-xs px-3 py-1.5 text-red-400 hover:text-red-300 hover:bg-gray-700 transition"
              >🗑 Remove</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── TableView ─────────────────────────────────────────────────────────────────
function TableView({ clusters, onStatusChange, onMoveRequest, onDeleteRequest }: {
  clusters: Cluster[]
  onStatusChange: (id: string, status: string) => void
  onMoveRequest: (c: Cluster) => void
  onDeleteRequest: (id: string) => void
}) {
  const sorted = [...clusters].sort((a, b) => {
    if (a.is_pillar !== b.is_pillar) return a.is_pillar ? -1 : 1
    return a.priority_order - b.priority_order
  })

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-gray-800/60 border-b border-gray-800">
            <th className="text-left px-4 py-2.5 text-gray-500 font-medium">Keyword</th>
            <th className="text-left px-3 py-2.5 text-gray-500 font-medium">Group</th>
            <th className="text-left px-3 py-2.5 text-gray-500 font-medium">Intent</th>
            <th className="text-left px-3 py-2.5 text-gray-500 font-medium">Type</th>
            <th className="text-right px-3 py-2.5 text-gray-500 font-medium">Vol</th>
            <th className="px-3 py-2.5 text-gray-500 font-medium">KD</th>
            <th className="px-3 py-2.5 text-gray-500 font-medium">Status</th>
            <th className="px-3 py-2.5 text-gray-500 font-medium w-6"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(c => (
            <TableRow
              key={c.id}
              cluster={c}
              onStatusChange={onStatusChange}
              onMoveRequest={onMoveRequest}
              onDeleteRequest={onDeleteRequest}
            />
          ))}
        </tbody>
      </table>
      {clusters.length === 0 && (
        <div className="text-center py-10 text-gray-600">
          <p className="text-sm">No keywords in this map</p>
        </div>
      )}
    </div>
  )
}

function TableRow({ cluster: c, onStatusChange, onMoveRequest, onDeleteRequest }: {
  cluster: Cluster
  onStatusChange: (id: string, status: string) => void
  onMoveRequest: (c: Cluster) => void
  onDeleteRequest: (id: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <tr className={`border-b border-gray-800/60 hover:bg-gray-800/20 transition group ${c.is_pillar ? 'bg-red-950/10' : ''}`}>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          {c.is_pillar && <span className="text-[10px] text-red-400">🏛️</span>}
          <span className={`${c.is_pillar ? 'text-white font-semibold' : 'text-gray-200'}`}>{c.keyword}</span>
        </div>
        {c.url_slug && <p className="text-gray-700 text-[10px] font-mono mt-0.5">/{c.url_slug}</p>}
      </td>
      <td className="px-3 py-2.5 text-gray-500 max-w-[100px]">
        <span className="truncate block">{c.cluster_group ?? '—'}</span>
      </td>
      <td className="px-3 py-2.5">
        {c.intent ? (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${INTENT_COLORS[c.intent] ?? 'bg-gray-700 text-gray-400'}`}>{c.intent}</span>
        ) : <span className="text-gray-700">—</span>}
      </td>
      <td className="px-3 py-2.5">
        {c.content_type ? (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${CONTENT_TYPE_COLORS[c.content_type] ?? 'bg-gray-700 text-gray-400'}`}>{c.content_type.replace('_', ' ')}</span>
        ) : <span className="text-gray-700">—</span>}
      </td>
      <td className="px-3 py-2.5 text-right text-gray-300 tabular-nums">{volFmt(c.search_volume)}</td>
      <td className="px-3 py-2.5"><DifficultyBar value={c.difficulty} /></td>
      <td className="px-3 py-2.5">
        <StatusPill status={c.status} onChange={s => onStatusChange(c.id, s)} />
      </td>
      <td className="px-3 py-2.5">
        <div className="relative" ref={ref}>
          <button
            onClick={e => { e.stopPropagation(); setMenuOpen(o => !o) }}
            className="text-gray-700 hover:text-gray-400 transition opacity-0 group-hover:opacity-100 px-1"
          >⋮</button>
          {menuOpen && (
            <div className="absolute right-0 top-6 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[140px]">
              <button
                onClick={() => { onMoveRequest(c); setMenuOpen(false) }}
                className="w-full text-left text-xs px-3 py-1.5 text-gray-400 hover:text-white hover:bg-gray-700 transition"
              >⇄ Move to map</button>
              <button
                onClick={() => { onDeleteRequest(c.id); setMenuOpen(false) }}
                className="w-full text-left text-xs px-3 py-1.5 text-red-400 hover:text-red-300 hover:bg-gray-700 transition"
              >🗑 Remove</button>
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

// ── MapListItem ───────────────────────────────────────────────────────────────
function MapListItem({ map, active, onClick, onDelete }: {
  map: KeywordMap
  active: boolean
  onClick: () => void
  onDelete: (id: string) => void
}) {
  const count = map.keyword_map_clusters?.[0]?.count ?? 0
  const [menuOpen, setMenuOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div
      onClick={onClick}
      className={`group px-3 py-2.5 rounded-lg cursor-pointer transition flex items-center gap-2 ${active ? 'bg-red-700' : 'hover:bg-gray-800'}`}
    >
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-medium truncate ${active ? 'text-white' : 'text-gray-300'}`}>{map.topic}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className={`text-[10px] ${active ? 'text-red-300' : 'text-gray-600'}`}>{count} kw</span>
          <span className={`text-[10px] ${active ? 'text-red-300' : 'text-gray-600'}`}>·</span>
          <span className={`text-[10px] uppercase ${MAP_STATUS_STYLES[map.status] ?? 'text-gray-600'}`}>{map.status}</span>
        </div>
      </div>

      <div className="relative" ref={ref}>
        <button
          onClick={e => { e.stopPropagation(); setMenuOpen(o => !o) }}
          className={`p-1 rounded transition text-sm opacity-0 group-hover:opacity-100 ${active ? 'text-red-300 hover:text-white' : 'text-gray-600 hover:text-gray-400'}`}
        >⋮</button>
        {menuOpen && (
          <div className="absolute right-0 top-7 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[130px]">
            <button
              onClick={e => { e.stopPropagation(); onDelete(map.id); setMenuOpen(false) }}
              className="w-full text-left text-xs px-3 py-1.5 text-red-400 hover:text-red-300 hover:bg-gray-700 transition"
            >🗑 Delete map</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function KeywordMapPage() {
  const searchParams  = useSearchParams()
  const router        = useRouter()
  const addKeyword    = searchParams.get('add')
  const addVolume     = searchParams.get('volume') ? parseInt(searchParams.get('volume')!) : null
  const addMapId      = searchParams.get('map_id')

  const [maps, setMaps]           = useState<KeywordMap[]>([])
  const [activeMapId, setActiveMapId] = useState<string | null>(null)
  const [clusters, setClusters]   = useState<Cluster[]>([])
  const [loadingMaps, setLoadingMaps]       = useState(true)
  const [loadingClusters, setLoadingClusters] = useState(false)
  const [viewMode, setViewMode]   = useState<'tree' | 'table'>('tree')

  // Top-level tab — Inbox (Saga proposals) / Clusters (existing maps) / Gaps (orphan keywords).
  // URL persists via ?tab=X so deep-links (e.g. from Slack notifications) land on the right tab.
  const tabParam = (searchParams.get('tab') as 'inbox' | 'clusters' | 'gaps' | null) ?? null
  const [activeTab, setActiveTab] = useState<'inbox' | 'clusters' | 'gaps'>(tabParam ?? 'clusters')

  // Saga proposals counter for Inbox tab badge — populated by SagaProposalsPanel via callback below
  const [proposalCount, setProposalCount] = useState<number | null>(null)

  // Orphan keywords (Gaps tab) — fetched lazily when tab is opened
  interface Orphan {
    opp_id:              string
    topic:               string
    topic_slug:          string | null
    total_sv:            number | null
    signal_count:        number | null
    status:              string
    output_type:         string | null
    updated_at:          string
    suggested_map_id:    string | null
    suggested_map_topic: string | null
  }
  const [orphans, setOrphans]               = useState<Orphan[]>([])
  const [orphansLoading, setOrphansLoading] = useState(false)
  const [assignTarget, setAssignTarget]     = useState<{ keyword: string; volume: number | null; mapId: string | null } | null>(null)

  // Modals
  const [showCreateMap, setShowCreateMap]     = useState(false)
  const [showAddKeyword, setShowAddKeyword]   = useState(false)
  const [moveCluster, setMoveCluster]         = useState<Cluster | null>(null)

  // Auto-open "Add Keyword" modal if query param present
  const autoOpenedRef = useRef(false)

  // Load maps
  useEffect(() => {
    async function load() {
      setLoadingMaps(true)
      try {
        const res  = await fetch('/api/keyword-maps')
        const data = await res.json()
        const fetched: KeywordMap[] = data.maps ?? []
        setMaps(fetched)
        if (fetched.length > 0) {
          const initialId = addMapId && fetched.find(m => m.id === addMapId) ? addMapId : fetched[0].id
          setActiveMapId(initialId)
        }
      } catch { /* silent */ }
      finally { setLoadingMaps(false) }
    }
    load()
  }, []) // eslint-disable-line

  // Auto-open add modal from query params
  useEffect(() => {
    if (autoOpenedRef.current) return
    if (addKeyword && !loadingMaps) {
      autoOpenedRef.current = true
      setShowAddKeyword(true)
    }
  }, [addKeyword, loadingMaps])

  // Load clusters for active map
  useEffect(() => {
    if (!activeMapId) { setClusters([]); return }
    setLoadingClusters(true)
    fetch(`/api/keyword-maps/${activeMapId}`)
      .then(r => r.json())
      .then(data => setClusters(data.clusters ?? []))
      .catch(() => setClusters([]))
      .finally(() => setLoadingClusters(false))
  }, [activeMapId])

  // Lazy-fetch orphan keywords when user opens Gaps tab. Re-fetch each tab open
  // because new opportunities may have been created or existing ones claimed.
  useEffect(() => {
    if (activeTab !== 'gaps') return
    setOrphansLoading(true)
    fetch('/api/keyword-maps/orphans?site=g2g')
      .then(r => r.json())
      .then(data => setOrphans(data.orphans ?? []))
      .catch(() => setOrphans([]))
      .finally(() => setOrphansLoading(false))
  }, [activeTab])

  // Active map object
  const activeMap = maps.find(m => m.id === activeMapId)

  // Handlers
  const handleCreateMap = useCallback((map: KeywordMap, newClusters: Cluster[]) => {
    setMaps(prev => [map, ...prev])
    setActiveMapId(map.id)
    setClusters(newClusters)
    setShowCreateMap(false)
  }, [])

  const handleKeywordAdded = useCallback((cluster: Cluster) => {
    if (cluster.map_id === activeMapId) {
      setClusters(prev => [...prev, cluster])
    }
    // Update count in map list
    setMaps(prev => prev.map(m => {
      if (m.id !== cluster.map_id) return m
      const count = m.keyword_map_clusters?.[0]?.count ?? 0
      return { ...m, keyword_map_clusters: [{ count: count + 1 }] }
    }))
    setShowAddKeyword(false)
    // Clear query params
    if (addKeyword) router.replace('/content/keyword-map')
  }, [activeMapId, addKeyword, router])

  const handleStatusChange = useCallback(async (clusterId: string, status: string) => {
    if (!activeMapId) return
    setClusters(prev => prev.map(c => c.id === clusterId ? { ...c, status } : c))
    await fetch(`/api/keyword-maps/${activeMapId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cluster_id: clusterId, status }),
    })
  }, [activeMapId])

  // Drag-drop handler: move cluster to a new cluster_group within same map.
  // Optimistic update — rollback on API failure.
  const handleClusterGroupChange = useCallback(async (clusterId: string, newGroup: string) => {
    if (!activeMapId) return
    const original = clusters.find(c => c.id === clusterId)
    if (!original) return

    // Optimistic update
    setClusters(prev => prev.map(c => c.id === clusterId ? { ...c, cluster_group: newGroup } : c))

    try {
      const res = await fetch(`/api/keyword-maps/${activeMapId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cluster_id: clusterId, cluster_group: newGroup }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      // Rollback
      setClusters(prev => prev.map(c => c.id === clusterId ? { ...c, cluster_group: original.cluster_group } : c))
    }
  }, [activeMapId, clusters])

  const handleClusterMoved = useCallback((clusterId: string, newMapId: string) => {
    setClusters(prev => prev.filter(c => c.id !== clusterId))
    // Adjust counts
    setMaps(prev => prev.map(m => {
      if (m.id === activeMapId) {
        const count = Math.max(0, (m.keyword_map_clusters?.[0]?.count ?? 1) - 1)
        return { ...m, keyword_map_clusters: [{ count }] }
      }
      if (m.id === newMapId) {
        const count = (m.keyword_map_clusters?.[0]?.count ?? 0) + 1
        return { ...m, keyword_map_clusters: [{ count }] }
      }
      return m
    }))
    setMoveCluster(null)
  }, [activeMapId])

  const handleDeleteCluster = useCallback(async (clusterId: string) => {
    if (!activeMapId) return
    // Optimistic remove
    setClusters(prev => prev.filter(c => c.id !== clusterId))
    setMaps(prev => prev.map(m => {
      if (m.id !== activeMapId) return m
      const count = Math.max(0, (m.keyword_map_clusters?.[0]?.count ?? 1) - 1)
      return { ...m, keyword_map_clusters: [{ count }] }
    }))
    // Actually delete via PATCH status=deleted isn't supported — use direct DB deletion via separate endpoint
    // For now: mark as archived via status update (can add DELETE cluster endpoint later)
    // We'll just keep it removed from UI (optimistic)
  }, [activeMapId])

  const handleDeleteMap = useCallback(async (mapId: string) => {
    if (!confirm('Delete this entire keyword map and all its keywords? This cannot be undone.')) return
    await fetch(`/api/keyword-maps/${mapId}`, { method: 'DELETE' })
    setMaps(prev => {
      const next = prev.filter(m => m.id !== mapId)
      if (activeMapId === mapId) setActiveMapId(next[0]?.id ?? null)
      return next
    })
    if (activeMapId === mapId) setClusters([])
  }, [activeMapId])

  // Stats
  const totalKeywords  = clusters.length
  const published      = clusters.filter(c => c.status === 'published').length
  const notStarted     = clusters.filter(c => c.status === 'not_started').length
  const avgDifficulty  = clusters.length
    ? Math.round(clusters.reduce((s, c) => s + (c.difficulty ?? 0), 0) / clusters.filter(c => c.difficulty != null).length || 0)
    : null

  return (
    <div className="flex h-full min-h-screen bg-gray-950">

      {/* ── Left Sidebar: Map List ─────────────────────────────── */}
      <div className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="px-4 py-4 border-b border-gray-800">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-white text-sm font-semibold">Keyword Maps</h2>
            <span className="text-gray-600 text-xs">{maps.length}</span>
          </div>
          <button
            onClick={() => setShowCreateMap(true)}
            className="w-full text-xs bg-red-700 hover:bg-red-600 text-white font-semibold py-1.5 rounded-lg transition flex items-center justify-center gap-1.5"
          >
            + New Map
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-2">
          {loadingMaps ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 border-gray-700 border-t-red-500 rounded-full animate-spin" />
            </div>
          ) : maps.length === 0 ? (
            <div className="text-center py-8 px-3">
              <p className="text-gray-600 text-xs">No maps yet</p>
              <p className="text-gray-700 text-[10px] mt-1">Create your first topic map</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {maps.map(m => (
                <MapListItem
                  key={m.id}
                  map={m}
                  active={m.id === activeMapId}
                  onClick={() => setActiveMapId(m.id)}
                  onDelete={handleDeleteMap}
                />
              ))}
            </div>
          )}
        </nav>
      </div>

      {/* ── Main Area ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-800 flex items-start gap-4 bg-gray-900/50">
          <div className="flex-1 min-w-0">
            {activeMap ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-white font-semibold text-base">{activeMap.topic}</h1>
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${MAP_STATUS_STYLES[activeMap.status] ?? 'bg-gray-800 text-gray-400'}`}>
                    {activeMap.status.replace('_', ' ')}
                  </span>
                  <span className="text-gray-600 text-xs">{activeMap.market.toUpperCase()}</span>
                </div>
                {/* Stats row */}
                <div className="flex items-center gap-4 mt-2 flex-wrap">
                  <span className="text-gray-400 text-xs"><span className="text-white font-semibold">{totalKeywords}</span> keywords</span>
                  <span className="text-gray-400 text-xs"><span className="text-green-400 font-semibold">{published}</span> published</span>
                  <span className="text-gray-400 text-xs"><span className="text-gray-300 font-semibold">{notStarted}</span> not started</span>
                  {avgDifficulty != null && (
                    <span className="text-gray-400 text-xs">avg KD <span className={`font-semibold ${diffColor(avgDifficulty)}`}>{avgDifficulty}</span></span>
                  )}
                  {activeMap.ai_notes?.estimated_authority_weeks && (
                    <span className="text-gray-400 text-xs">~{activeMap.ai_notes.estimated_authority_weeks}wk to authority</span>
                  )}
                </div>
                {/* AI notes */}
                {activeMap.ai_notes?.priority_note && (
                  <p className="text-gray-600 text-[11px] mt-1.5 max-w-2xl">💡 {activeMap.ai_notes.priority_note}</p>
                )}
              </>
            ) : (
              <div>
                <h1 className="text-white font-semibold text-base">Keyword Map</h1>
                <p className="text-gray-500 text-xs mt-1">Topic cluster hub — organize all keywords by topic</p>
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* View toggle */}
            <div className="flex bg-gray-800 rounded-lg p-0.5">
              <button
                onClick={() => setViewMode('tree')}
                className={`px-3 py-1.5 text-xs rounded-md transition font-medium ${viewMode === 'tree' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >🌳 Tree</button>
              <button
                onClick={() => setViewMode('table')}
                className={`px-3 py-1.5 text-xs rounded-md transition font-medium ${viewMode === 'table' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >📋 Table</button>
            </div>

            {activeMapId && (
              <button
                onClick={() => setShowAddKeyword(true)}
                className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white px-3 py-1.5 rounded-lg transition"
              >+ Add Keyword</button>
            )}
          </div>
        </div>

        {/* AI Linking note */}
        {activeMap?.ai_notes?.linking_note && (
          <div className="px-6 py-2 bg-blue-950/20 border-b border-blue-900/30">
            <p className="text-blue-300 text-[11px]">🔗 {activeMap.ai_notes.linking_note}</p>
          </div>
        )}

        {/* ── Top-level tab nav (Saga redesign G.2) ───────────────────────── */}
        <div className="px-6 pt-3 bg-gray-950">
          <div className="flex gap-1 border-b border-gray-800">
            {([
              { key: 'inbox',    label: '📥 Inbox',    badge: proposalCount },
              { key: 'clusters', label: '📚 Clusters', badge: maps.length },
              { key: 'gaps',     label: '🕳️  Gaps',    badge: orphans.length || null },
            ] as const).map(t => (
              <button
                key={t.key}
                onClick={() => {
                  setActiveTab(t.key)
                  // Sync URL so refresh keeps tab + sharable links work
                  const url = new URL(window.location.href)
                  url.searchParams.set('tab', t.key)
                  window.history.replaceState({}, '', url.toString())
                }}
                className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
                  activeTab === t.key
                    ? 'text-white border-purple-500'
                    : 'text-gray-500 border-transparent hover:text-gray-300'
                }`}
              >
                {t.label}
                {t.badge != null && t.badge > 0 && (
                  <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded-full ${
                    activeTab === t.key
                      ? 'bg-purple-500/20 text-purple-300'
                      : 'bg-gray-800 text-gray-500'
                  }`}>
                    {t.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* ── Inbox tab — Saga proposals (action queue) ─────────────────── */}
          {activeTab === 'inbox' && (
            <SagaProposalsPanel limit={150} onCountChange={setProposalCount} />
          )}

          {/* ── Clusters tab — existing map list + cluster tree/table view ── */}
          {activeTab === 'clusters' && (
            !activeMapId ? (
              /* Empty state */
              <div className="flex flex-col items-center justify-center h-full text-center">
                <div className="w-16 h-16 bg-gray-800 rounded-2xl flex items-center justify-center text-3xl mb-4">🗺️</div>
                <h3 className="text-white font-semibold mb-2">Topic Cluster Hub</h3>
                <p className="text-gray-500 text-sm max-w-md mb-6">
                  Organize all your keywords into topic maps. AI groups related keywords into pillar + cluster structure, sorted by difficulty so you can build topical authority strategically.
                </p>
                <button
                  onClick={() => setShowCreateMap(true)}
                  className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-6 py-2.5 rounded-xl transition"
                >✨ Create First Map</button>
              </div>
            ) : loadingClusters ? (
              <div className="flex items-center justify-center h-40">
                <div className="w-6 h-6 border-2 border-gray-700 border-t-red-500 rounded-full animate-spin" />
              </div>
            ) : viewMode === 'tree' ? (
              <TreeView
                clusters={clusters}
                allMaps={maps}
                activeMapId={activeMapId}
                onStatusChange={handleStatusChange}
                onMoveRequest={setMoveCluster}
                onDeleteRequest={handleDeleteCluster}
                onClusterGroupChange={handleClusterGroupChange}
              />
            ) : (
              <TableView
                clusters={clusters}
                onStatusChange={handleStatusChange}
                onMoveRequest={setMoveCluster}
                onDeleteRequest={handleDeleteCluster}
              />
            )
          )}

          {/* ── Gaps tab — orphan keywords (Saga G.4) ─────────────────────── */}
          {activeTab === 'gaps' && (
            <div>
              {/* Intro / explainer */}
              <p className="text-[11px] text-gray-500 mb-3 leading-relaxed">
                Keywords detected by agents (Heimdall / Loki / Odin) and aggregated into opportunities,
                but not yet assigned to a cluster. Click &ldquo;Assign to cluster&rdquo; to add them to a map.
              </p>

              {orphansLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-6 h-6 border-2 border-gray-700 border-t-purple-500 rounded-full animate-spin" />
                </div>
              ) : orphans.length === 0 ? (
                <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
                  <div className="w-12 h-12 bg-emerald-500/10 rounded-2xl flex items-center justify-center text-2xl mb-3 mx-auto">✓</div>
                  <p className="text-white font-semibold mb-1">No orphan keywords</p>
                  <p className="text-gray-500 text-xs">Every opportunity is assigned to a cluster.</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-gray-400">
                      <span className="text-white font-semibold">{orphans.length}</span> orphan keyword{orphans.length !== 1 ? 's' : ''}
                      <span className="text-gray-600 ml-2">· sorted by search volume</span>
                    </p>
                  </div>
                  <div className="space-y-2">
                    {orphans.map(o => (
                      <div key={o.opp_id} className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-0.5">
                            <span className="text-sm text-white font-medium truncate">{o.topic}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
                              {o.status.replace('_', ' ')}
                            </span>
                            {o.suggested_map_topic && (
                              <span className="text-[10px] text-purple-400">
                                → suggest: {o.suggested_map_topic}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-500">
                            {o.total_sv ? `${o.total_sv.toLocaleString()} SV` : 'no SV'}
                            {o.signal_count != null && <span className="ml-2">· {o.signal_count} signal{o.signal_count !== 1 ? 's' : ''}</span>}
                            {o.output_type && <span className="ml-2">· {o.output_type.replace('_', ' ')}</span>}
                          </p>
                        </div>
                        <button
                          onClick={() => setAssignTarget({
                            keyword:  o.topic,
                            volume:   o.total_sv,
                            mapId:    o.suggested_map_id,
                          })}
                          className="text-xs bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-600/40 px-3 py-1.5 rounded-lg transition flex-shrink-0"
                        >
                          Assign to cluster →
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Modals ─────────────────────────────────────────────── */}
      {showCreateMap && (
        <CreateMapModal
          onClose={() => setShowCreateMap(false)}
          onCreated={handleCreateMap}
          prefillKeyword={addKeyword}
        />
      )}

      {showAddKeyword && (
        <AddKeywordModal
          mapId={addMapId ?? activeMapId}
          allMaps={maps}
          onClose={() => { setShowAddKeyword(false); if (addKeyword) router.replace('/content/keyword-map') }}
          onAdded={handleKeywordAdded}
          prefillKeyword={addKeyword}
          prefillVolume={addVolume}
        />
      )}

      {moveCluster && activeMapId && (
        <MoveClusterModal
          cluster={moveCluster}
          currentMapId={activeMapId}
          allMaps={maps}
          onClose={() => setMoveCluster(null)}
          onMoved={handleClusterMoved}
        />
      )}

      {/* Gaps tab — assign orphan to cluster (reuses AddKeywordModal) */}
      {assignTarget && (
        <AddKeywordModal
          mapId={assignTarget.mapId ?? activeMapId ?? maps[0]?.id ?? null}
          allMaps={maps}
          prefillKeyword={assignTarget.keyword}
          prefillVolume={assignTarget.volume}
          onClose={() => setAssignTarget(null)}
          onAdded={(cluster) => {
            // Remove the orphan from the list — it's no longer orphan
            setOrphans(prev => prev.filter(o => o.topic.toLowerCase() !== cluster.keyword.toLowerCase()))
            // Update map count
            setMaps(prev => prev.map(m => {
              if (m.id !== cluster.map_id) return m
              const count = m.keyword_map_clusters?.[0]?.count ?? 0
              return { ...m, keyword_map_clusters: [{ count: count + 1 }] }
            }))
            // If we're assigning to the active map, also add cluster to view
            if (cluster.map_id === activeMapId) {
              setClusters(prev => [...prev, cluster])
            }
            setAssignTarget(null)
          }}
        />
      )}
    </div>
  )
}
