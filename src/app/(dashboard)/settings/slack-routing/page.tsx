'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

// ─── Slack multi-channel routing settings ───────────────────────────────────
// One screen, one table — pick a notification type + (optional) brand, paste a
// webhook URL, test it, save it. Falls back to SLACK_WEBHOOK_URL env when no
// row exists, so leaving everything blank preserves the current behaviour.

// ── Force-fire types ────────────────────────────────────────────────────────
interface FireCron {
  key:               string
  label:             string
  notification_type: string
  path:              string
  description:       string
}
interface FireResult {
  key:               string
  label:             string
  notification_type: string
  http_status:       number | null
  latency_ms:        number
  outcome:           'slack_fired' | 'skipped_no_data' | 'no_webhook' | 'slack_post_failed' | 'cron_error' | 'partial'
  per_target?:       Array<{ target: string; outcome: string; note?: string }>
  raw_response:      unknown
  error_reason:      string | null
  suggestion:        string | null
}
interface FireResponse {
  summary: {
    total: number; fired: number; partial: number; skipped_no_data: number
    no_webhook: number; slack_post_failed: number; cron_error: number
    total_duration_ms: number
  }
  results: FireResult[]
}

interface RoutingRow {
  id?:                 string
  owner_user_id?:      string
  site_slug:           string | null    // null = brand-agnostic
  notification_type:   string
  webhook_url:         string
  slack_channel_id?:   string | null    // Sprint FRIDAY.KPI.GRAPH.5 — for files.upload
  channel_label:       string | null
  enabled:             boolean
  updated_at?:         string
}

const TYPE_INFO: Record<string, { title: string; desc: string }> = {
  agent_performance: { title: 'Agent performance digest',  desc: 'Weekly AI agent activity & cost vs savings (Mon 09:00 WIB).' },
  tier_summary:      { title: 'Tier rankings summary',     desc: 'Monday positive scorecard across all Tier 1+2 keywords.' },
  weekly_report:     { title: 'Weekly performance report', desc: 'GSC + GA4 deck + PPTX download (Mon 08:00 WIB).' },
  // Sprint FRIDAY.KPI — combined G2G + OG dashboard, Friday afternoon
  friday_kpi:        { title: 'Friday KPI digest',         desc: 'Combined G2G + OG weekly KPI wrap with SERP rankings + GSC traffic per market (Fri 15:00 WIB).' },
  daily_alerts:      { title: 'Daily alerts',              desc: 'Tier-1 drops ≥3 pos, Tier-2 falls out of top-10, GSC clicks/CWV/index drops, stale tech-debt.' },
  cms_alerts:        { title: 'CMS upload alerts',         desc: 'JWT-expired notices when auto-upload is paused.' },
  bug_reports:       { title: 'In-app bug reports',        desc: 'New feedback submissions from the in-app bug button.' },
  general:           { title: 'General',                   desc: 'Catch-all bucket — anything not explicitly routed above.' },
}

const SITE_OPTIONS = [
  { value: '',         label: '(brand-agnostic)' },
  { value: 'g2g',      label: 'G2G' },
  { value: 'offgamers',label: 'OffGamers' },
]

export default function SlackRoutingPage() {
  const [rows,    setRows]    = useState<RoutingRow[]>([])
  const [types,   setTypes]   = useState<string[]>([])
  const [envFb,   setEnvFb]   = useState(false)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [migrationMissing, setMigrationMissing] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testRes, setTestRes] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const res = await fetch('/api/settings/slack-routing')
        const data = await res.json()
        if (cancelled) return
        // Always render form templates — even on soft errors (e.g. migration
        // not applied), use VALID_TYPES from response or local TYPE_INFO map.
        setRows(data.configs ?? [])
        setTypes(data.notification_types ?? Object.keys(TYPE_INFO))
        setEnvFb(!!data.env_fallback_set)
        setMigrationMissing(!!data.migration_missing)
        if (data.error) setError(data.error)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setTypes(Object.keys(TYPE_INFO))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const grouped = useMemo(() => {
    const m: Record<string, RoutingRow[]> = {}
    for (const t of types) m[t] = []
    for (const r of rows) {
      m[r.notification_type] ??= []
      m[r.notification_type].push(r)
    }
    return m
  }, [rows, types])

  function setDraft(type: string, patch: Partial<RoutingRow>) {
    setRows(prev => {
      const draftIdx = prev.findIndex(r => r.notification_type === type && r.id === undefined)
      if (draftIdx >= 0) {
        const next = [...prev]
        next[draftIdx] = { ...next[draftIdx], ...patch }
        return next
      }
      return [...prev, {
        site_slug:         null,
        notification_type: type,
        webhook_url:       '',
        channel_label:     '',
        enabled:           true,
        ...patch,
      }]
    })
  }

  function updateRow(id: string, patch: Partial<RoutingRow>) {
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r))
  }

  async function save(row: RoutingRow) {
    setError(null)
    setSavedId(null)
    try {
      const res = await fetch('/api/settings/slack-routing', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id:                row.id,
          site_slug:         row.site_slug || null,
          notification_type: row.notification_type,
          webhook_url:       row.webhook_url,
          slack_channel_id:  row.slack_channel_id ?? null,
          channel_label:     row.channel_label,
          enabled:           row.enabled,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Save failed'); return }
      // Replace draft / existing row with the saved one (now has id).
      setRows(prev => {
        const others = prev.filter(r => r !== row && r.id !== data.config.id)
        return [...others, data.config].sort((a, b) =>
          a.notification_type.localeCompare(b.notification_type) ||
          ((a.site_slug ?? '') as string).localeCompare((b.site_slug ?? '') as string)
        )
      })
      setSavedId(data.config.id)
      setTimeout(() => setSavedId(null), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this routing row? Notifications will fall back to the next-level webhook.')) return
    setError(null)
    try {
      const res = await fetch(`/api/settings/slack-routing?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error ?? 'Delete failed'); return }
      setRows(prev => prev.filter(r => r.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function test(row: RoutingRow, key: string) {
    setTesting(key)
    setTestRes(prev => ({ ...prev, [key]: '' }))
    try {
      const res = await fetch('/api/settings/slack-routing/test', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhook_url:       row.webhook_url,
          notification_type: row.notification_type,
          channel_label:     row.channel_label,
        }),
      })
      const data = await res.json()
      setTestRes(prev => ({
        ...prev,
        [key]: data.ok ? '✓ Sent — check Slack' : `✗ ${data.error ?? `HTTP ${data.status}`}`,
      }))
    } catch (e) {
      setTestRes(prev => ({ ...prev, [key]: `✗ ${e instanceof Error ? e.message : String(e)}` }))
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">🔀 Slack channel routing</h1>
          <p className="text-sm text-gray-400 mt-1">
            Send each kind of automated Slack post to a different channel. Leave any type unconfigured to fall back to the global <code className="text-blue-300">SLACK_WEBHOOK_URL</code> env var.
          </p>
        </div>
        <Link href="/settings" className="text-sm text-gray-400 hover:text-white">← Settings</Link>
      </div>

      {migrationMissing && (
        <div className="rounded-lg border border-red-700/40 bg-red-500/5 p-4 text-sm text-red-200 space-y-2">
          <div className="font-semibold">⚠ Migration not applied — saving will fail until you run this</div>
          <ol className="list-decimal pl-5 space-y-1 text-red-100/90">
            <li>Open Supabase → SQL Editor → New query</li>
            <li>Paste contents of <code className="text-pink-300">supabase/migrations/add_slack_routing_config.sql</code></li>
            <li>Click Run, then reload this page</li>
          </ol>
          <p className="text-xs text-red-300/80">You can still draft routes below — they just won&apos;t persist until the table exists.</p>
        </div>
      )}

      <div className={`rounded-lg border p-3 text-sm ${envFb ? 'border-emerald-700/40 bg-emerald-500/5 text-emerald-200' : 'border-amber-700/40 bg-amber-500/5 text-amber-200'}`}>
        {envFb
          ? '✓ Global default webhook is set (SLACK_WEBHOOK_URL env var). Anything you leave unconfigured below will use it.'
          : '⚠ No SLACK_WEBHOOK_URL env var set. Without per-type routes below, automated Slack posts will be skipped.'}
      </div>

      <ForceFireSection />

      <details className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 text-sm text-gray-300">
        <summary className="cursor-pointer font-medium text-white">How routing resolves</summary>
        <ol className="list-decimal pl-5 mt-3 space-y-1.5">
          <li><strong>Brand-specific row</strong> for (owner × site_slug × notification_type) — wins first.</li>
          <li><strong>Brand-agnostic row</strong> for (owner × null × notification_type) — second priority.</li>
          <li><strong>Env fallback</strong>: <code className="text-blue-300">SLACK_WEBHOOK_URL</code> if nothing matched.</li>
          <li>If all three are empty → message is computed but <strong>not delivered</strong> (logged, never thrown).</li>
        </ol>
        <p className="mt-3 text-xs text-gray-400">Create a Slack incoming webhook at: <a className="text-blue-300 hover:underline" href="https://api.slack.com/apps" target="_blank" rel="noreferrer">api.slack.com/apps → Incoming Webhooks</a>. Each URL is bound to one channel.</p>
      </details>

      {loading && <div className="text-center py-12 text-gray-500">Loading…</div>}

      {!loading && types.map(t => {
        const info = TYPE_INFO[t] ?? { title: t, desc: '' }
        const list = grouped[t] ?? []
        const hasDraft = list.some(r => !r.id)
        return (
          <section key={t} className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-white">{info.title}</h2>
                <p className="text-xs text-gray-400 mt-0.5">{info.desc}</p>
              </div>
              <code className="text-[10px] text-gray-500">{t}</code>
            </div>

            {list.length === 0 && (
              <div className="text-xs text-gray-500 italic">No route configured — falls back to env default.</div>
            )}

            {list.map((row, idx) => {
              const rowKey = row.id ?? `draft-${t}-${idx}`
              const isDirty = !row.id || (row.updated_at && Date.now() - new Date(row.updated_at).getTime() < 4000)
              return (
                <div key={rowKey} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-start border border-gray-800/60 rounded-md p-3 bg-gray-950/40">
                  <div className="md:col-span-2">
                    <label className="block text-[11px] text-gray-400 mb-1">Brand scope</label>
                    <select
                      value={row.site_slug ?? ''}
                      onChange={e => row.id
                        ? updateRow(row.id, { site_slug: e.target.value || null })
                        : setDraft(t, { site_slug: e.target.value || null })}
                      className="w-full bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-200"
                    >
                      {SITE_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
                  <div className="md:col-span-5">
                    <label className="block text-[11px] text-gray-400 mb-1">Webhook URL</label>
                    <input
                      type="url"
                      value={row.webhook_url}
                      placeholder="https://hooks.slack.com/services/T0…"
                      onChange={e => row.id
                        ? updateRow(row.id, { webhook_url: e.target.value })
                        : setDraft(t, { webhook_url: e.target.value })}
                      className="w-full bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-xs font-mono text-gray-200"
                    />
                  </div>
                  <div className="md:col-span-3">
                    <label className="block text-[11px] text-gray-400 mb-1">Label (channel name)</label>
                    <input
                      type="text"
                      value={row.channel_label ?? ''}
                      placeholder="#team-marketing"
                      onChange={e => row.id
                        ? updateRow(row.id, { channel_label: e.target.value })
                        : setDraft(t, { channel_label: e.target.value })}
                      className="w-full bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-200"
                    />
                  </div>
                  {/* Sprint FRIDAY.KPI.GRAPH.5 — channel ID enables PNG file uploads (Friday KPI). Optional. */}
                  <div className="md:col-span-12">
                    <label className="block text-[11px] text-gray-400 mb-1">
                      Channel ID <span className="text-gray-600">(optional — enables PNG/file uploads, requires SLACK_BOT_TOKEN)</span>
                    </label>
                    <input
                      type="text"
                      value={row.slack_channel_id ?? ''}
                      placeholder="C01234ABCDE"
                      onChange={e => row.id
                        ? updateRow(row.id, { slack_channel_id: e.target.value })
                        : setDraft(t, { slack_channel_id: e.target.value })}
                      className="w-full bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-xs font-mono text-gray-200"
                    />
                  </div>
                  <div className="md:col-span-2 flex flex-col gap-1">
                    <label className="flex items-center gap-1.5 text-xs text-gray-300">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={e => row.id
                          ? updateRow(row.id, { enabled: e.target.checked })
                          : setDraft(t, { enabled: e.target.checked })}
                      />
                      Enabled
                    </label>
                  </div>

                  <div className="md:col-span-12 flex flex-wrap items-center gap-2 pt-1">
                    <button
                      onClick={() => save(row)}
                      disabled={!row.webhook_url}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs rounded-md"
                    >
                      {row.id ? 'Save changes' : 'Create route'}
                    </button>
                    <button
                      onClick={() => test(row, rowKey)}
                      disabled={!row.webhook_url || testing === rowKey}
                      className="px-3 py-1.5 border border-gray-700 hover:bg-gray-800 disabled:opacity-40 text-gray-200 text-xs rounded-md"
                    >
                      {testing === rowKey ? 'Testing…' : '🔔 Send test ping'}
                    </button>
                    {row.id && (
                      <button
                        onClick={() => remove(row.id!)}
                        className="px-3 py-1.5 border border-red-700/40 hover:bg-red-500/10 text-red-300 text-xs rounded-md"
                      >
                        Delete
                      </button>
                    )}
                    {testRes[rowKey] && (
                      <span className={`text-xs ${testRes[rowKey].startsWith('✓') ? 'text-emerald-300' : 'text-red-300'}`}>
                        {testRes[rowKey]}
                      </span>
                    )}
                    {savedId && savedId === row.id && (
                      <span className="text-xs text-emerald-300">✓ Saved</span>
                    )}
                    {!row.id && isDirty && (
                      <span className="text-xs text-amber-300">Unsaved draft</span>
                    )}
                  </div>
                </div>
              )
            })}

            {!hasDraft && (
              <button
                onClick={() => setDraft(t, {})}
                className="text-xs text-blue-300 hover:text-blue-200 underline-offset-2 hover:underline"
              >
                + Add route for {info.title.toLowerCase()}
              </button>
            )}
          </section>
        )
      })}

      {error && <div className="rounded-md border border-red-700/40 bg-red-500/5 p-3 text-sm text-red-300">⚠ {error}</div>}
    </div>
  )
}

// ─── Force-fire-all-notifications section ───────────────────────────────────
// Smoke-tests the 6 cron-driven Slack posts in parallel + returns analysis.
// cms_alerts (JWT expiry) + bug_reports are event-driven — for those, use the
// per-row "Send test ping" button in the routing config below.
function ForceFireSection() {
  const [crons,    setCrons]    = useState<FireCron[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [firing,   setFiring]   = useState(false)
  const [response, setResponse] = useState<FireResponse | null>(null)
  const [error,    setError]    = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/admin/fire-all-notifications')
        const data = await res.json()
        if (cancelled) return
        if (res.ok) {
          setCrons(data.crons ?? [])
          setSelected(new Set((data.crons ?? []).map((c: FireCron) => c.key)))   // default: all selected
        } else {
          setError(data.error ?? 'Failed to load cron list')
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  function toggle(key: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else                next.add(key)
      return next
    })
  }
  function selectAll() { setSelected(new Set(crons.map(c => c.key))) }
  function selectNone() { setSelected(new Set()) }

  async function fire() {
    if (selected.size === 0) return
    setFiring(true)
    setError(null)
    setResponse(null)
    try {
      const res = await fetch('/api/admin/fire-all-notifications', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ types: Array.from(selected) }),
      })
      // Sprint OG.SLACK.FIX — Vercel can return HTML on function timeout
      // (e.g. weekly_report blocks past 300s). Use text() + safe parse so
      // we surface the real cause instead of "JSON.parse unexpected character".
      const text = await res.text()
      let data: { error?: string; summary?: FireResponse['summary']; results?: FireResponse['results'] } | null = null
      try { data = JSON.parse(text) } catch { /* HTML response */ }
      if (!res.ok || !data) {
        const isHtml = text.toLowerCase().includes('<!doctype') || text.toLowerCase().includes('<html')
        if (isHtml) {
          setError(`Function timed out or crashed (HTTP ${res.status}). The endpoint returned HTML, not JSON. Likely cause: one of the selected crons exceeded Vercel's 300s timeout. Try un-selecting "Weekly performance report" (slowest) and retry.`)
        } else {
          setError(data?.error ?? text.slice(0, 300) ?? `HTTP ${res.status}`)
        }
        return
      }
      setResponse(data as FireResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFiring(false)
    }
  }

  const outcomeStyle = (o: FireResult['outcome']) => {
    switch (o) {
      case 'slack_fired':       return { color: 'text-emerald-300', bg: 'bg-emerald-500/10 border-emerald-700/40', icon: '✓', label: 'Slack fired'        }
      case 'skipped_no_data':   return { color: 'text-amber-300',   bg: 'bg-amber-500/10 border-amber-700/40',   icon: '○', label: 'Skipped — no data' }
      case 'no_webhook':        return { color: 'text-orange-300',  bg: 'bg-orange-500/10 border-orange-700/40', icon: '⚠', label: 'No webhook'        }
      case 'partial':           return { color: 'text-yellow-300',  bg: 'bg-yellow-500/10 border-yellow-700/40', icon: '◐', label: 'Partial'            }
      case 'slack_post_failed': return { color: 'text-red-300',     bg: 'bg-red-500/10 border-red-700/40',       icon: '✗', label: 'Slack post failed' }
      case 'cron_error':        return { color: 'text-red-400',     bg: 'bg-red-500/10 border-red-700/40',       icon: '✗', label: 'Cron error'        }
    }
  }

  return (
    <section className="rounded-lg border border-pink-700/40 bg-gradient-to-br from-pink-500/5 to-gray-900 p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">🔥 Force-fire notifications (smoke test)</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Trigger any of the 6 cron-based Slack notifications right now, in parallel.
            Returns per-channel analysis: success, skipped-due-to-no-data, no-webhook, or error reason.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs">
        <button onClick={selectAll}  className="text-blue-300 hover:text-blue-200 underline-offset-2 hover:underline">Select all</button>
        <button onClick={selectNone} className="text-gray-400 hover:text-gray-300 underline-offset-2 hover:underline">Clear</button>
        <span className="text-gray-500">·</span>
        <span className="text-gray-400">{selected.size}/{crons.length} selected</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {crons.map(c => (
          <label
            key={c.key}
            className={`flex items-start gap-2.5 p-2.5 rounded-md border cursor-pointer transition ${
              selected.has(c.key) ? 'border-pink-700/40 bg-pink-500/5' : 'border-gray-800 bg-gray-950/40 hover:border-gray-700'
            }`}
          >
            <input
              type="checkbox"
              checked={selected.has(c.key)}
              onChange={() => toggle(c.key)}
              className="mt-1"
            />
            <div className="min-w-0">
              <div className="text-sm text-white font-medium">{c.label}</div>
              <div className="text-[11px] text-gray-400 mt-0.5">{c.description}</div>
              <div className="text-[10px] text-pink-300/70 mt-0.5 font-mono">→ {c.notification_type}</div>
            </div>
          </label>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={fire}
          disabled={firing || selected.size === 0}
          className="px-4 py-2 bg-pink-600 hover:bg-pink-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md"
        >
          {firing ? '🔥 Firing… (can take up to 60s if weekly_report selected)' : `🔥 Fire ${selected.size} notification${selected.size === 1 ? '' : 's'}`}
        </button>
        <p className="text-[11px] text-gray-500">
          <code className="text-pink-300">cms_alerts</code> &amp; <code className="text-pink-300">bug_reports</code> are event-driven — use the per-row test ping below for those.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-700/40 bg-red-500/5 p-3 text-sm text-red-300">⚠ {error}</div>
      )}

      {response && (
        <div className="space-y-3 pt-2">
          {/* Summary tally */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2 py-1 rounded-full bg-gray-800 text-gray-200">Total: <strong>{response.summary.total}</strong></span>
            {response.summary.fired              > 0 && <span className="px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-700/40">✓ Fired {response.summary.fired}</span>}
            {response.summary.partial            > 0 && <span className="px-2 py-1 rounded-full bg-yellow-500/15 text-yellow-300 border border-yellow-700/40">◐ Partial {response.summary.partial}</span>}
            {response.summary.skipped_no_data    > 0 && <span className="px-2 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-700/40">○ Skipped {response.summary.skipped_no_data}</span>}
            {response.summary.no_webhook         > 0 && <span className="px-2 py-1 rounded-full bg-orange-500/15 text-orange-300 border border-orange-700/40">⚠ No webhook {response.summary.no_webhook}</span>}
            {response.summary.slack_post_failed  > 0 && <span className="px-2 py-1 rounded-full bg-red-500/15 text-red-300 border border-red-700/40">✗ Slack failed {response.summary.slack_post_failed}</span>}
            {response.summary.cron_error         > 0 && <span className="px-2 py-1 rounded-full bg-red-500/15 text-red-400 border border-red-700/40">✗ Cron error {response.summary.cron_error}</span>}
            <span className="ml-auto text-gray-500">Took {(response.summary.total_duration_ms / 1000).toFixed(1)}s</span>
          </div>

          {/* Per-result cards */}
          <div className="space-y-2">
            {response.results.map(r => {
              const s = outcomeStyle(r.outcome)
              return (
                <div key={r.key} className={`rounded-md border p-3 ${s.bg}`}>
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-sm font-semibold ${s.color}`}>{s.icon} {r.label}</span>
                        <code className="text-[10px] text-gray-400">{r.notification_type}</code>
                        <span className="text-[10px] text-gray-500">HTTP {r.http_status ?? '—'} · {r.latency_ms}ms</span>
                      </div>
                      <div className={`text-xs mt-1 ${s.color}`}>{s.label}</div>
                      {r.error_reason && (
                        <div className="text-xs text-gray-300 mt-1">→ {r.error_reason}</div>
                      )}
                      {r.suggestion && (
                        <div className="text-[11px] text-gray-400 mt-1 italic">Suggestion: {r.suggestion}</div>
                      )}
                      {r.per_target && r.per_target.length > 0 && (
                        <div className="mt-2 space-y-0.5">
                          {r.per_target.map((t, i) => (
                            <div key={i} className="text-[11px] text-gray-300 font-mono pl-3 border-l-2 border-gray-700">
                              {t.target}: <span className={t.outcome === 'fired' ? 'text-emerald-300' : t.outcome === 'no_webhook' ? 'text-orange-300' : t.outcome === 'error' ? 'text-red-300' : 'text-gray-400'}>{t.outcome}</span>
                              {t.note && <span className="text-gray-500"> — {t.note}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <details className="mt-2">
                    <summary className="text-[10px] text-gray-500 cursor-pointer hover:text-gray-400">raw response</summary>
                    <pre className="mt-1 text-[10px] text-gray-400 bg-gray-950/60 p-2 rounded overflow-x-auto max-h-40">{JSON.stringify(r.raw_response, null, 2)}</pre>
                  </details>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
