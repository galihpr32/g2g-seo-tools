'use client'

import { useState, useEffect, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────
type Status = 'pending' | 'generating' | 'generated' | 'uploading' | 'uploaded' | 'failed'

interface ProductItem {
  id:                    string
  relation_id:           string
  product_name:          string
  category:              string
  url:                   string
  sheet_row:             number
  request_date:          string | null
  main_keyword:          string | null
  secondary_keywords:    string | null
  /** Legacy — was Google Doc URL. Always null in the new sheet-as-database flow. */
  google_doc_url:        string | null
  meta_title:            string | null
  meta_description:      string | null
  meta_keywords:         string | null
  marketing_title:       string | null
  /** Lead paragraph between H1 and the first H2 section (new flow). */
  marketing_intro:       string | null
  /** Legacy single-blob HTML — replaced by marketing_sections in the new flow. */
  marketing_description: string | null
  /** Structured marketing body — 8 HTML strings, one per H2 section (new flow). */
  marketing_sections:    string[] | null
  /** Q/A pairs, 5-7 entries (new flow). */
  faqs:                  Array<{ q: string; a: string }> | null
  status:                Status
  cms_seo_status:        string | null
  cms_mkt_status:        string | null
  cms_seo_error:         string | null
  cms_mkt_error:         string | null
  generation_error:      string | null
  id_generation_error:   string | null
  id_status:             Status | null
  id_google_doc_url:     string | null
  id_marketing_sections: string[] | null
  id_faqs:               Array<{ q: string; a: string }> | null
  generated_at:          string | null
  uploaded_at:           string | null
  updated_at:            string
}

interface QueueStats {
  total:      number
  pending:    number
  generating: number
  generated:  number
  uploading:  number
  uploaded:   number
  failed:     number
}

// ── Status helpers ────────────────────────────────────────────────────────────
const STATUS_COLORS: Record<Status, string> = {
  pending:    'bg-gray-700 text-gray-300',
  generating: 'bg-blue-900 text-blue-300',
  generated:  'bg-yellow-900 text-yellow-300',
  uploading:  'bg-purple-900 text-purple-300',
  uploaded:   'bg-green-900 text-green-300',
  failed:     'bg-red-900 text-red-300',
}

const STATUS_ICONS: Record<Status, string> = {
  pending:    '⏳',
  generating: '🤖',
  generated:  '✅',
  uploading:  '📤',
  uploaded:   '🚀',
  failed:     '❌',
}

function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status]}`}>
      {STATUS_ICONS[status]} {status}
    </span>
  )
}

// ── Preview modal ─────────────────────────────────────────────────────────────
function PreviewModal({ item, onClose }: { item: ProductItem; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-white font-semibold">{item.product_name}</h2>
            <p className="text-gray-400 text-xs mt-0.5">Relation ID: {item.relation_id}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">✕</button>
        </div>

        <div className="p-5 space-y-5">
          {/* Failure details — surfaces the exact reason content gen / Drive
               doc creation failed. Most common causes: Drive API not enabled,
               GOOGLE_DRIVE_FOLDER_ID missing or service-account-without-access.
               Show whenever an error column is populated, regardless of status —
               that way stale "generated" rows that have a leftover error from a
               prior attempt still surface it instead of silently looking fine. */}
          {(item.generation_error || item.id_generation_error) && (
            <section className="bg-red-900/20 border border-red-800/40 rounded-lg p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-2">⚠ Why this row failed</h3>
              {item.generation_error && (
                <div className="mb-2">
                  <p className="text-[10px] uppercase text-red-300/70 mb-1">EN generation</p>
                  <p className="text-xs text-red-100 bg-red-950/40 rounded px-2 py-1.5 font-mono break-all">{item.generation_error}</p>
                </div>
              )}
              {item.id_generation_error && (
                <div>
                  <p className="text-[10px] uppercase text-red-300/70 mb-1">ID translation</p>
                  <p className="text-xs text-red-100 bg-red-950/40 rounded px-2 py-1.5 font-mono break-all">{item.id_generation_error}</p>
                </div>
              )}
              <p className="text-[10px] text-red-300/60 mt-2 italic">
                Common fixes: enable Drive API in GCP, set <code className="bg-red-950/40 px-1 rounded">GOOGLE_DRIVE_FOLDER_ID</code> in Vercel env, share that folder with the service account as Editor.
              </p>
            </section>
          )}

          {/* Keywords */}
          {(item.main_keyword || item.secondary_keywords) && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Keywords</h3>
              <div className="space-y-2">
                {item.main_keyword && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Main Keyword</label>
                    <p className="text-sm text-white bg-gray-800 rounded-lg px-3 py-2">{item.main_keyword}</p>
                  </div>
                )}
                {item.secondary_keywords && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Secondary Keywords</label>
                    <p className="text-sm text-white bg-gray-800 rounded-lg px-3 py-2">{item.secondary_keywords}</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* SEO fields */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">SEO Fields</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Meta Title <span className={`ml-1 ${(item.meta_title?.length ?? 0) > 60 ? 'text-red-400' : 'text-gray-500'}`}>({item.meta_title?.length ?? 0}/60)</span></label>
                <p className="text-sm text-white bg-gray-800 rounded-lg px-3 py-2">{item.meta_title || <span className="text-gray-500 italic">—</span>}</p>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Meta Description <span className={`ml-1 ${(item.meta_description?.length ?? 0) > 110 ? 'text-red-400' : 'text-gray-500'}`}>({item.meta_description?.length ?? 0}/110)</span></label>
                <p className="text-sm text-white bg-gray-800 rounded-lg px-3 py-2">{item.meta_description || <span className="text-gray-500 italic">—</span>}</p>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Meta Keywords</label>
                <p className="text-sm text-white bg-gray-800 rounded-lg px-3 py-2">{item.meta_keywords || <span className="text-gray-500 italic">—</span>}</p>
              </div>
            </div>
          </section>

          {/* Marketing fields — H1 + 8 structured H2 sections (new flow) */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Marketing Content</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">H1 (Marketing Title)</label>
                <p className="text-sm text-white bg-gray-800 rounded-lg px-3 py-2">{item.marketing_title || <span className="text-gray-500 italic">—</span>}</p>
              </div>
              {item.marketing_intro && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Lead paragraph (after H1)</label>
                  <p className="text-sm text-gray-200 bg-gray-800 rounded-lg px-3 py-2 leading-relaxed">{item.marketing_intro}</p>
                </div>
              )}
              {item.marketing_sections && item.marketing_sections.length > 0 ? (
                item.marketing_sections.map((s, i) => (
                  s ? (
                    <div key={i}>
                      <label className="block text-xs text-gray-500 mb-1">Section {i + 1}</label>
                      <div
                        className="text-sm text-gray-200 bg-gray-800 rounded-lg px-3 py-2 max-h-48 overflow-y-auto prose prose-invert prose-sm max-w-none"
                        dangerouslySetInnerHTML={{ __html: s }}
                      />
                    </div>
                  ) : null
                ))
              ) : item.marketing_description ? (
                // Backward compat: render legacy single-blob HTML if no sections yet
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Marketing Description (legacy)</label>
                  <div
                    className="text-sm text-gray-300 bg-gray-800 rounded-lg px-3 py-2 max-h-80 overflow-y-auto prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: item.marketing_description }}
                  />
                </div>
              ) : (
                <p className="text-sm text-gray-500 italic px-2">No marketing content generated yet.</p>
              )}
            </div>
          </section>

          {/* FAQs — 5-7 Q/A pairs (new flow) */}
          {item.faqs && item.faqs.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">FAQs ({item.faqs.length})</h3>
              <div className="space-y-2">
                {item.faqs.map((f, i) => (
                  <div key={i} className="bg-gray-800 rounded-lg px-3 py-2">
                    <p className="text-sm text-white font-medium mb-1">Q{i + 1}: {f.q}</p>
                    <p className="text-sm text-gray-300">{f.a}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* CMS status */}
          {(item.cms_seo_status || item.cms_mkt_status) && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">CMS Upload Status</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-gray-800 rounded-lg p-3">
                  <p className="text-xs text-gray-400 mb-1">SEO endpoint</p>
                  <p className={`text-sm font-medium ${item.cms_seo_status === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
                    {item.cms_seo_status === 'ok' ? '✓ Success' : `✗ ${item.cms_seo_error ?? 'Error'}`}
                  </p>
                </div>
                <div className="bg-gray-800 rounded-lg p-3">
                  <p className="text-xs text-gray-400 mb-1">Marketing endpoint</p>
                  <p className={`text-sm font-medium ${item.cms_mkt_status === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
                    {item.cms_mkt_status === 'ok' ? '✓ Success' : `✗ ${item.cms_mkt_error ?? 'Error'}`}
                  </p>
                </div>
              </div>
            </section>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-800 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Sheet config modal ────────────────────────────────────────────────────────
function SheetConfigModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [sheetUrl, setSheetUrl] = useState('')
  const [sheetName, setSheetName] = useState('Sheet1')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    if (!sheetUrl.trim()) { setError('Sheet URL is required'); return }
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/products/sheet-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_url: sheetUrl.trim(), sheet_name: sheetName.trim() || 'Sheet1' }),
      })
      if (!res.ok) {
        const d = await res.json()
        setError(d.error ?? 'Failed to save')
        return
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-white font-semibold">Configure Google Sheet</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-400">
            Share your Google Sheet with the service account email (<strong className="text-gray-300">Editor</strong> permission for write-back), then paste the URL below.
          </p>
          <div className="bg-gray-800 rounded-lg p-3 text-xs text-gray-400 font-mono">
            A: Brand Name &nbsp;|&nbsp; B: Category &nbsp;|&nbsp; C: Relation ID<br/>
            D: Main Keyword &nbsp;|&nbsp; E: Secondary Keyword &nbsp;|&nbsp; F: EN File Name &nbsp;|&nbsp; G: Status
          </div>
          <p className="text-xs text-gray-500">
            The agent reads rows where Status = &quot;To Do&quot; and writes back keywords, Google Doc URL, and status when done.
          </p>
          <div>
            <label className="block text-sm text-gray-300 mb-1.5">Google Sheet URL</label>
            <input
              type="url"
              value={sheetUrl}
              onChange={e => setSheetUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-300 mb-1.5">Sheet Tab Name</label>
            <input
              type="text"
              value={sheetName}
              onChange={e => setSheetName(e.target.value)}
              placeholder="Sheet1"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>
        <div className="px-5 py-4 border-t border-gray-800 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm rounded-lg transition"
          >
            {saving ? 'Saving…' : 'Save Configuration'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ProductContentPage() {
  const [items, setItems]             = useState<ProductItem[]>([])
  const [stats, setStats]             = useState<QueueStats | null>(null)
  const [loading, setLoading]         = useState(true)
  const [syncing, setSyncing]         = useState(false)
  const [uploading, setUploading]     = useState(false)
  const [selected, setSelected]       = useState<Set<string>>(new Set())
  const [filterStatus, setFilterStatus] = useState<Status | 'all'>('all')
  const [search, setSearch]           = useState('')
  const [preview, setPreview]         = useState<ProductItem | null>(null)
  const [showSheetConfig, setShowSheetConfig] = useState(false)
  const [syncResult, setSyncResult]   = useState<{ synced: number; failed: number; message?: string | null } | null>(null)
  const [lastSynced, setLastSynced]   = useState<string | null>(null)
  const [page, setPage]               = useState(1)
  const PAGE_SIZE = 50

  // ── CSV import state ────────────────────────────────────────────────────
  interface CsvRow {
    brand_name:         string
    category:           string
    relation_id:        string
    main_keyword:       string
    secondary_keywords: string
    en_file_url:        string
    status:             string
  }
  interface ImportPreview {
    rowCount:  number
    new:       Array<{ csv: CsvRow }>
    unchanged: Array<{ csv: CsvRow; db: CsvRow }>
    conflicts: Array<{ csv: CsvRow; db: CsvRow; fieldDiffs: Record<string, { csv: string; db: string }> }>
    warnings:  string[]
  }
  const [csvFile, setCsvFile]                 = useState<File | null>(null)
  const [importPreview, setImportPreview]     = useState<ImportPreview | null>(null)
  const [importPreviewLoading, setImportPreviewLoading] = useState(false)
  const [importError, setImportError]         = useState<string | null>(null)
  const [conflictResolutions, setConflictResolutions]   = useState<Record<string, 'use_csv' | 'keep_db' | 'skip'>>({})
  const [applying, setApplying]               = useState(false)
  const [importHistory, setImportHistory]     = useState<Array<{
    id: string; source: string; source_file: string | null; imported_at: string
    rows_total: number; rows_new: number; rows_updated: number; rows_skipped: number; rows_conflicts: number
  }>>([])
  const [showHistory, setShowHistory]         = useState(false)

  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })
      if (filterStatus !== 'all') params.set('status', filterStatus)
      if (search.trim()) params.set('q', search.trim())

      const res = await fetch(`/api/products/queue?${params}`)
      if (res.ok) {
        const data = await res.json()
        setItems(data.items ?? [])
        setStats(data.stats ?? null)
        setLastSynced(data.lastSynced ?? null)
      }
    } catch { /* silent */ }
    setLoading(false)
  }, [page, filterStatus, search])

  useEffect(() => { fetchItems() }, [fetchItems])

  async function handleSync() {
    // "Run All Pending" — scans the Google Sheet for rows where col E
    // ("Create now?") = "yes" and processes each one. Writes structured
    // content back to the sheet (EN + ID tabs) and updates col E to
    // "Generated" or "Error: <stage-tagged>" per row.
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/products/auto-content/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const data = await res.json() as { processed?: number; succeeded?: number; failed?: number; skipped?: number; message?: string; error?: string }
      setSyncResult({
        synced:  data.succeeded ?? 0,
        failed:  data.failed ?? 0,
        message: data.message ?? data.error ?? null,
      })
      await fetchItems()
    } catch { /* silent */ }
    setSyncing(false)
  }

  // ── CSV export / template / import handlers ─────────────────────────────
  function downloadFile(url: string) {
    const a = document.createElement('a')
    a.href = url
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  async function handlePickCsv(file: File) {
    setCsvFile(file)
    setImportError(null)
    setImportPreview(null)
    setConflictResolutions({})
    setImportPreviewLoading(true)
    try {
      const text = await file.text()
      const res = await fetch('/api/products/auto-content/csv-import', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ csv: text }),
      })
      const data = await res.json() as ImportPreview & { error?: string }
      if (!res.ok || data.error) {
        setImportError(data.error ?? `HTTP ${res.status}`)
        return
      }
      setImportPreview(data)
      // Default conflict resolution: use_csv (most common intent on import)
      const initial: Record<string, 'use_csv' | 'keep_db' | 'skip'> = {}
      for (const c of data.conflicts) initial[c.csv.relation_id] = 'use_csv'
      setConflictResolutions(initial)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImportPreviewLoading(false)
    }
  }

  async function applyImport() {
    if (!importPreview) return
    setApplying(true)
    setImportError(null)
    try {
      const toInsert = importPreview.new.map(r => r.csv)
      const toUpdate: Array<{ relation_id: string; fields: Partial<CsvRow> }> = []
      const skipped: string[] = []
      for (const c of importPreview.conflicts) {
        const choice = conflictResolutions[c.csv.relation_id] ?? 'use_csv'
        if (choice === 'use_csv') {
          // Send only the changed fields
          const fields: Partial<CsvRow> = {}
          for (const f of Object.keys(c.fieldDiffs) as Array<keyof CsvRow>) {
            fields[f] = c.csv[f]
          }
          toUpdate.push({ relation_id: c.csv.relation_id, fields })
        } else if (choice === 'skip') {
          skipped.push(c.csv.relation_id)
        }
        // 'keep_db' = no-op
      }

      const res = await fetch('/api/products/auto-content/csv-import/apply', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ toInsert, toUpdate, skipped, fileName: csvFile?.name ?? null }),
      })
      const data = await res.json() as { ok?: boolean; inserted?: number; updated?: number; skipped?: number; error?: string }
      if (!res.ok || !data.ok) {
        setImportError(data.error ?? `HTTP ${res.status}`)
        return
      }
      setSyncResult({
        synced:  (data.inserted ?? 0) + (data.updated ?? 0),
        failed:  0,
        message: `Imported via CSV: ${data.inserted ?? 0} new, ${data.updated ?? 0} updated, ${data.skipped ?? 0} skipped`,
      })
      // Reset
      setCsvFile(null)
      setImportPreview(null)
      setConflictResolutions({})
      await fetchItems()
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Apply failed')
    } finally {
      setApplying(false)
    }
  }

  async function loadImportHistory() {
    try {
      const res = await fetch('/api/products/auto-content/imports')
      const data = await res.json()
      setImportHistory(data.imports ?? [])
    } catch { /* silent */ }
  }

  useEffect(() => { if (showHistory) loadImportHistory() }, [showHistory])

  async function handleUpload(uploadAll = false) {
    setUploading(true)
    try {
      const body = uploadAll
        ? { upload_all: true }
        : { relation_ids: Array.from(selected) }

      const res = await fetch('/api/products/auto-content/upload', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      if (res.ok) {
        setSelected(new Set())
        await fetchItems()
      }
    } catch { /* silent */ }
    setUploading(false)
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAllGenerated() {
    const ids = items.filter(i => i.status === 'generated').map(i => i.relation_id)
    setSelected(new Set(ids))
  }

  const filteredItems = items  // already filtered server-side via API

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Product Content</h1>
          <p className="text-gray-400 text-sm mt-1">
            Auto-generate and publish product descriptions from Google Sheets to the CMS.
            {lastSynced && (
              <span className="ml-2 text-gray-500">Last synced: {new Date(lastSynced).toLocaleString()}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowSheetConfig(true)}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition flex items-center gap-2"
          >
            ⚙️ Sheet Config
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            title='Scan the Google Sheet for rows with col E "Create now?" = "yes" and generate content for each. Writes structured output back to the sheet (EN + ID tabs).'
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition flex items-center gap-2"
          >
            {syncing ? (
              <><span className="animate-spin">⟳</span> Running…</>
            ) : (
              <>▶ Run All Pending</>
            )}
          </button>

          {/* Vertical separator */}
          <span className="text-gray-700 mx-1">|</span>

          {/* CSV ops — template / export / import */}
          <button
            onClick={() => downloadFile('/api/products/auto-content/csv-export?mode=template')}
            title="Download blank CSV template with the correct columns"
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition"
          >
            📋 Template
          </button>
          <button
            onClick={() => downloadFile('/api/products/auto-content/csv-export?mode=data')}
            title="Export current queue as CSV (with generated_at + uploaded_at dates)"
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition"
          >
            📥 Export CSV
          </button>
          <label className="px-3 py-2 bg-emerald-700 hover:bg-emerald-600 text-white text-sm rounded-lg transition cursor-pointer">
            📤 Import CSV
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handlePickCsv(f) }}
            />
          </label>
          <button
            onClick={() => setShowHistory(o => !o)}
            title="Import history audit trail"
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition"
          >
            📜 History
          </button>
          <button
            onClick={async () => {
              if (!confirm('Clear ALL pending/generating/failed product rows? Already-uploaded rows are protected. This is irreversible.')) return
              const res = await fetch('/api/products/auto-content/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
              const data = await res.json().catch(() => ({}))
              if (!res.ok) { alert(`Clear failed: ${data.error ?? res.status}`); return }
              alert(`Cleared ${data.deleted ?? 0} rows. ${data.kept ? `${data.kept} uploaded rows kept.` : ''} Re-import or re-sync to start fresh.`)
              await fetchItems()
            }}
            title="Wipe all queue rows except already-uploaded ones, so you can restart fresh"
            className="px-3 py-2 bg-red-900/40 hover:bg-red-900/60 text-red-200 text-sm rounded-lg transition border border-red-800/40"
          >
            🗑 Clear All
          </button>
        </div>
      </div>

      {/* ── Workflow info banner (sheet-as-database flow) ─────────────── */}
      <div className="mb-4 bg-blue-900/15 border border-blue-800/40 rounded-lg px-4 py-2.5 flex items-start gap-3 text-xs">
        <span className="text-blue-400 text-base leading-tight">⚡</span>
        <div className="flex-1 text-blue-100 space-y-1">
          <p>
            <span className="font-semibold">Auto-processing is on.</span> BDT types <code className="bg-blue-950/50 px-1 rounded">yes</code> in col E (&quot;Create now?&quot;), and the AI picks it up within ~5 minutes automatically.
          </p>
          <p className="text-blue-200/80">
            For urgent pushes, click <strong>▶ Run All Pending</strong> manually. AI generates Meta + Marketing (8 H2 sections) + 5-7 FAQs across cols F-AG. Indonesian translations land in a separate <code className="bg-blue-950/50 px-1 rounded">ID</code> sheet tab (auto-created).
            Col E updates to <code className="bg-blue-950/50 px-1 rounded">Generated</code> on success or <code className="bg-blue-950/50 px-1 rounded">Error: &lt;reason&gt;</code> on failure (not retriggerable).
          </p>
        </div>
      </div>

      {/* ── Import History panel ──────────────────────────────────────── */}
      {showHistory && (
        <div className="mb-4 bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-white font-semibold text-sm">📜 Import History</h3>
            <button onClick={() => setShowHistory(false)} className="text-gray-500 hover:text-white text-sm">✕</button>
          </div>
          {importHistory.length === 0 ? (
            <p className="text-xs text-gray-500">No imports yet.</p>
          ) : (
            <div className="space-y-1.5">
              {importHistory.map(h => (
                <div key={h.id} className="flex items-center justify-between text-xs bg-gray-950/50 border border-gray-800 rounded-lg px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium">
                      {h.source === 'csv' ? '📤' : '🔄'} {h.source.toUpperCase()}
                      {h.source_file && <span className="text-gray-500 ml-2">{h.source_file}</span>}
                    </p>
                    <p className="text-gray-500 text-[10px] mt-0.5">
                      {new Date(h.imported_at).toLocaleString('id-ID')} ·
                      {' '}{h.rows_total} rows · {h.rows_new} new · {h.rows_updated} updated · {h.rows_skipped} skipped
                      {h.rows_conflicts > 0 && <span className="text-amber-400 ml-1">· {h.rows_conflicts} conflicts resolved</span>}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── CSV Import Preview Modal ───────────────────────────────────── */}
      {(csvFile && (importPreview || importPreviewLoading || importError)) && (
        <div className="fixed inset-0 bg-black/70 z-40 flex items-center justify-center p-6" onClick={() => { if (!applying) { setCsvFile(null); setImportPreview(null) } }}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl max-w-4xl w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h3 className="text-white font-semibold">📤 Import CSV — Preview</h3>
                <p className="text-xs text-gray-500 mt-0.5">{csvFile.name}</p>
              </div>
              <button onClick={() => { setCsvFile(null); setImportPreview(null) }} disabled={applying} className="text-gray-500 hover:text-white disabled:opacity-50">✕</button>
            </div>

            <div className="p-5 overflow-y-auto flex-1">
              {importPreviewLoading && <p className="text-sm text-gray-400 animate-pulse">Validating CSV…</p>}
              {importError && <p className="text-sm text-red-400">⚠️ {importError}</p>}

              {importPreview && (
                <div className="space-y-5">
                  {/* Summary */}
                  <div className="grid grid-cols-4 gap-3 text-xs">
                    <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3">
                      <p className="text-emerald-300 font-bold text-lg">{importPreview.new.length}</p>
                      <p className="text-gray-400">New</p>
                    </div>
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                      <p className="text-amber-300 font-bold text-lg">{importPreview.conflicts.length}</p>
                      <p className="text-gray-400">Conflicts</p>
                    </div>
                    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                      <p className="text-gray-300 font-bold text-lg">{importPreview.unchanged.length}</p>
                      <p className="text-gray-400">Unchanged</p>
                    </div>
                    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                      <p className="text-gray-300 font-bold text-lg">{importPreview.warnings.length}</p>
                      <p className="text-gray-400">Warnings</p>
                    </div>
                  </div>

                  {importPreview.warnings.length > 0 && (
                    <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-3 text-xs text-yellow-300 max-h-32 overflow-y-auto">
                      {importPreview.warnings.map((w, i) => <p key={i}>⚠️ {w}</p>)}
                    </div>
                  )}

                  {/* Per-row conflict resolution */}
                  {importPreview.conflicts.length > 0 && (
                    <div>
                      <h4 className="text-white font-semibold text-sm mb-2">Conflicts — pick a resolution per row</h4>
                      <div className="space-y-3 max-h-96 overflow-y-auto">
                        {importPreview.conflicts.map(c => {
                          const choice = conflictResolutions[c.csv.relation_id] ?? 'use_csv'
                          return (
                            <div key={c.csv.relation_id} className="bg-gray-950 border border-amber-500/30 rounded-lg p-3">
                              <div className="flex items-start justify-between gap-3 mb-2">
                                <div className="flex-1 min-w-0">
                                  <p className="text-white text-sm font-medium truncate">{c.csv.brand_name}</p>
                                  <p className="text-[10px] text-gray-500 font-mono">{c.csv.relation_id}</p>
                                </div>
                                <div className="flex gap-1 flex-shrink-0">
                                  {(['use_csv', 'keep_db', 'skip'] as const).map(opt => (
                                    <button
                                      key={opt}
                                      onClick={() => setConflictResolutions(prev => ({ ...prev, [c.csv.relation_id]: opt }))}
                                      className={`px-2 py-0.5 text-[10px] rounded border transition ${
                                        choice === opt
                                          ? opt === 'use_csv'  ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                                          : opt === 'keep_db'  ? 'bg-blue-500/20 border-blue-500/40 text-blue-300'
                                          :                      'bg-gray-700 border-gray-600 text-gray-300'
                                          : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300'
                                      }`}
                                    >
                                      {opt === 'use_csv' ? '📤 Use CSV' : opt === 'keep_db' ? '📚 Keep DB' : '⊘ Skip'}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              <div className="text-[11px] space-y-1">
                                {Object.entries(c.fieldDiffs).map(([field, diff]) => (
                                  <div key={field} className="grid grid-cols-[100px,1fr,1fr] gap-2 items-start">
                                    <span className="text-gray-500 font-mono">{field}:</span>
                                    <span className="text-emerald-300 truncate">CSV: {diff.csv || <em className="text-gray-700">empty</em>}</span>
                                    <span className="text-blue-300 truncate">DB: {diff.db || <em className="text-gray-700">empty</em>}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* New rows preview (collapsed) */}
                  {importPreview.new.length > 0 && (
                    <div>
                      <h4 className="text-white font-semibold text-sm mb-2">New rows ({importPreview.new.length})</h4>
                      <div className="bg-gray-950 border border-gray-800 rounded-lg max-h-32 overflow-y-auto p-2 space-y-0.5 text-[10px] font-mono text-gray-400">
                        {importPreview.new.slice(0, 30).map(r => (
                          <p key={r.csv.relation_id} className="truncate">{r.csv.brand_name} · {r.csv.category} · {r.csv.relation_id}</p>
                        ))}
                        {importPreview.new.length > 30 && <p className="text-gray-600">+ {importPreview.new.length - 30} more…</p>}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t border-gray-800 flex items-center justify-between">
              <p className="text-xs text-gray-500">
                {importPreview && `${importPreview.new.length} insert + ${importPreview.conflicts.filter(c => (conflictResolutions[c.csv.relation_id] ?? 'use_csv') === 'use_csv').length} update + ${importPreview.conflicts.filter(c => conflictResolutions[c.csv.relation_id] === 'skip').length} skip`}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => { setCsvFile(null); setImportPreview(null) }}
                  disabled={applying}
                  className="px-3 py-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-50 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={applyImport}
                  disabled={applying || !importPreview || (importPreview.new.length === 0 && importPreview.conflicts.length === 0)}
                  className="px-4 py-1.5 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition"
                >
                  {applying ? 'Applying…' : '✓ Apply Import'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sync result toast — also surfaces diagnostics when synced=0
           (e.g., "Sheet has 50 rows but none are 'To Do'…"), so users know
           why nothing was generated. */}
      {syncResult && (
        <div className={`mb-4 px-4 py-3 rounded-lg text-sm flex items-start justify-between gap-3 ${
          syncResult.failed > 0       ? 'bg-yellow-900/50 text-yellow-300 border border-yellow-700' :
          syncResult.synced === 0     ? 'bg-yellow-900/40 text-yellow-200 border border-yellow-700/60' :
          'bg-green-900/50 text-green-300 border border-green-700'
        }`}>
          <div className="flex-1 min-w-0">
            <p>
              Sync complete — <strong>{syncResult.synced}</strong> generated
              {syncResult.failed > 0 && <>, <strong>{syncResult.failed}</strong> failed</>}
            </p>
            {syncResult.message && syncResult.synced === 0 && (
              <p className="text-xs mt-1 opacity-90">⚠️ {syncResult.message}</p>
            )}
          </div>
          <button onClick={() => setSyncResult(null)} className="text-current opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* Stats bar */}
      {stats && (
        <div className="grid grid-cols-7 gap-3 mb-6">
          {(Object.entries(stats) as [string, number][]).map(([key, val]) => (
            <button
              key={key}
              onClick={() => { setFilterStatus(key === 'total' ? 'all' : key as Status); setPage(1) }}
              className={`bg-gray-900 border rounded-xl p-3 text-center transition hover:border-gray-600 ${
                (key === 'total' ? filterStatus === 'all' : filterStatus === key)
                  ? 'border-red-500'
                  : 'border-gray-800'
              }`}
            >
              <p className="text-xl font-bold text-white">{val}</p>
              <p className="text-xs text-gray-500 capitalize mt-0.5">{key}</p>
            </button>
          ))}
        </div>
      )}

      {/* Actions + filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
          placeholder="Search products…"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 w-56"
        />

        {/* Bulk actions */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-sm text-gray-400">{selected.size} selected</span>
            {/* Process selected — runs the auto-content generator on all picked
                 rows immediately (instead of waiting for the 5-min cron tick).
                 Visible whenever the selection contains any pending/failed rows. */}
            {filteredItems.some(i => selected.has(i.relation_id) && (i.status === 'pending' || i.status === 'failed')) && (
              <button
                onClick={async () => {
                  const targetIds = filteredItems
                    .filter(i => selected.has(i.relation_id) && (i.status === 'pending' || i.status === 'failed'))
                    .map(i => i.id)
                  if (targetIds.length === 0) return
                  if (targetIds.length > 7 && !confirm(`Process ${targetIds.length} rows now? This may take ~${Math.ceil(targetIds.length * 0.25)} min and could hit the 60s function ceiling. Recommended max per click: 5-7.`)) return
                  const res = await fetch('/api/products/auto-content/process-row', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: targetIds }),
                  })
                  const d = await res.json().catch(() => ({}))
                  if (!res.ok) alert(`Process failed: ${d.error ?? res.status}`)
                  else alert(`Processed: ${d.succeeded ?? 0} succeeded · ${d.failed ?? 0} failed`)
                  setSelected(new Set())
                  await fetchItems()
                }}
                className="px-3 py-1.5 bg-purple-700 hover:bg-purple-600 text-white text-sm rounded-lg transition"
              >
                ⚡ Process Selected
              </button>
            )}
            <button
              onClick={() => handleUpload(false)}
              disabled={uploading}
              className="px-3 py-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm rounded-lg transition"
            >
              {uploading ? 'Uploading…' : `📤 Upload Selected`}
            </button>
            <button onClick={() => setSelected(new Set())} className="text-gray-400 hover:text-white text-sm">Clear</button>
          </div>
        )}

        {selected.size === 0 && (stats?.generated ?? 0) > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={selectAllGenerated}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition"
            >
              Select All Generated ({stats?.generated})
            </button>
            <button
              onClick={() => handleUpload(true)}
              disabled={uploading}
              className="px-3 py-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm rounded-lg transition"
            >
              {uploading ? 'Uploading…' : '📤 Upload All Generated'}
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-gray-500">Loading…</div>
        ) : filteredItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-500 gap-3">
            <p className="text-4xl">📦</p>
            <p className="text-sm">No products found. Sync from your Google Sheet to get started.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="w-8 px-3 py-3"></th>
                <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Product</th>
                <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Category</th>
                <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Status</th>
                <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">CMS</th>
                <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Generated</th>
                <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Doc</th>
                <th className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item, i) => (
                <tr
                  key={item.id}
                  className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition ${i % 2 === 0 ? '' : 'bg-gray-900/50'}`}
                >
                  {/* Checkbox — selectable for any non-uploading status so the
                       multi-select bulk action works for pending rows too. */}
                  <td className="px-3 py-2.5">
                    {item.status !== 'uploading' && item.status !== 'generating' && (
                      <input
                        type="checkbox"
                        checked={selected.has(item.relation_id)}
                        onChange={() => toggleSelect(item.relation_id)}
                        className="w-4 h-4 accent-red-600 cursor-pointer"
                      />
                    )}
                  </td>

                  {/* Product name */}
                  <td className="px-3 py-2.5">
                    <p className="text-white font-medium leading-tight line-clamp-1">{item.product_name}</p>
                    <p className="text-gray-500 text-xs mt-0.5">{item.relation_id}</p>
                  </td>

                  {/* Category */}
                  <td className="px-3 py-2.5">
                    <span className="text-gray-400 text-xs">{item.category || '—'}</span>
                  </td>

                  {/* Status */}
                  <td className="px-3 py-2.5">
                    <StatusBadge status={item.status} />
                  </td>

                  {/* CMS status */}
                  <td className="px-3 py-2.5">
                    {item.cms_seo_status || item.cms_mkt_status ? (
                      <div className="flex items-center gap-1">
                        <span className={`text-xs ${item.cms_seo_status === 'ok' ? 'text-green-400' : 'text-red-400'}`} title="SEO endpoint">
                          SEO {item.cms_seo_status === 'ok' ? '✓' : '✗'}
                        </span>
                        <span className="text-gray-600">·</span>
                        <span className={`text-xs ${item.cms_mkt_status === 'ok' ? 'text-green-400' : 'text-red-400'}`} title="Marketing endpoint">
                          Mkt {item.cms_mkt_status === 'ok' ? '✓' : '✗'}
                        </span>
                      </div>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </td>

                  {/* Generated at */}
                  <td className="px-3 py-2.5">
                    <span className="text-gray-500 text-xs">
                      {item.generated_at
                        ? new Date(item.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                        : '—'}
                    </span>
                  </td>

                  {/* Google Doc link */}
                  <td className="px-3 py-2.5">
                    {item.google_doc_url ? (
                      <a
                        href={item.google_doc_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 text-xs transition"
                        title="Open Google Doc"
                      >
                        📄 Doc
                      </a>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </td>

                  {/* Actions */}
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {item.status === 'generated' && (
                        <>
                          <button
                            onClick={() => setPreview(item)}
                            className="px-2 py-1 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-900/30 rounded transition"
                          >
                            Preview
                          </button>
                          <button
                            onClick={() => { setSelected(new Set([item.relation_id])); handleUpload(false) }}
                            disabled={uploading}
                            className="px-2 py-1 text-xs text-green-400 hover:text-green-300 hover:bg-green-900/30 rounded transition disabled:opacity-50"
                          >
                            Upload
                          </button>
                        </>
                      )}
                      {item.status === 'uploaded' && (
                        <button
                          onClick={() => setPreview(item)}
                          className="px-2 py-1 text-xs text-gray-400 hover:text-gray-300 hover:bg-gray-700 rounded transition"
                        >
                          View
                        </button>
                      )}
                      {item.status === 'failed' && (
                        <button
                          onClick={() => setPreview(item)}
                          className="px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded transition"
                        >
                          Details
                        </button>
                      )}
                      {/* Per-row "Generate now" — manual trigger for pending/failed rows.
                           Cron picks them up automatically every 5 min, but this lets
                           users push individual rows to the front of the queue. */}
                      {(item.status === 'pending' || item.status === 'failed') && (
                        <button
                          onClick={async () => {
                            const res = await fetch('/api/products/auto-content/process-row', {
                              method: 'POST', headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ ids: [item.id] }),
                            })
                            const d = await res.json().catch(() => ({}))
                            if (!res.ok) alert(`Failed: ${d.error ?? res.status}`)
                            await fetchItems()
                          }}
                          className="px-2 py-1 text-xs text-purple-400 hover:text-purple-300 hover:bg-purple-900/30 rounded transition"
                          title="Generate this row now (skip the cron wait)"
                        >
                          ⚡ Generate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {(items.length === PAGE_SIZE || page > 1) && (
        <div className="flex items-center justify-center gap-3 mt-4">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-white text-sm rounded-lg transition"
          >
            ← Prev
          </button>
          <span className="text-gray-400 text-sm">Page {page}</span>
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={items.length < PAGE_SIZE}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-white text-sm rounded-lg transition"
          >
            Next →
          </button>
        </div>
      )}

      {/* Modals */}
      {preview && <PreviewModal item={preview} onClose={() => setPreview(null)} />}
      {showSheetConfig && (
        <SheetConfigModal
          onClose={() => setShowSheetConfig(false)}
          onSaved={() => fetchItems()}
        />
      )}
    </div>
  )
}
