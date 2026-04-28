'use client'

import { useState, useEffect } from 'react'

interface AgentStatus {
  key: string
  isActive: boolean
  lastRunAt: string | null
  lastRunStatus: string | null
  lastRunSummary: string | null
}

interface StatusResponse {
  agents: AgentStatus[]
  pendingActions: number
  actionsByAgent: Record<string, number>
}

interface PakRTConfig {
  maxDropsPerDay: number
  minClicksDrop: number
  minPctDrop: number
  urlMustInclude: string    // comma-separated; stored as string in UI, array in backend
  urlMustExclude: string    // comma-separated
}

const AGENT_NAMES: Record<string, string> = {
  'heimdall': 'Heimdall',
  'odin': 'Odin',
  'loki': 'Loki',
  'bragi': 'Bragi',
  'hermod': 'Hermod',
  'tyr':    'Tyr',
  'vor':    'Vor',
  'saga':   'Saga',
}

const AGENT_ROLES: Record<string, string> = {
  'heimdall': 'Watchdog — detects ranking drops & triages',
  'odin': 'Trend Spotter — finds trending games & suggests content',
  'loki': 'Competitive Intel — keyword gaps, SOV, competitor pages',
  'bragi': 'Content Drafter — turns approved trends & gaps into brief drafts',
  'hermod': 'Outreach Agent — finds prospects from keyword gaps, drafts pitches',
  'tyr':    'Quality Reviewer — scores generated briefs, auto-promotes or flags for revision',
  'vor':    'Config Tuner — proposes threshold adjustments based on your approval patterns',
  'saga':   'Universe Curator — maintains keyword map: proposes clusters, archives decay, surfaces coverage gaps',
}

const AGENT_EMOJI: Record<string, string> = {
  'heimdall': '👁️',
  'odin': '🔮',
  'loki': '🕵️',
  'bragi': '✍️',
  'hermod': '🤝',
  'tyr':    '⚖️',
  'vor':    '🦉',
  'saga':   '📜',
}

// Button label when idle (start state)
const AGENT_START_LABEL: Record<string, string> = {
  'heimdall': 'Start Patrolling',
  'odin':     'Seek Trends',
  'loki':     'Gather Intel',
  'bragi':    'Start Writing',
  'hermod':   'Find Prospect',
  'tyr':      'Review Briefs',
  'vor':      'Tune Configs',
  'saga':     'Curate Universe',
}

// Button label while the agent is actively running
const AGENT_RUNNING_LABEL: Record<string, string> = {
  'heimdall': 'Patrolling...',
  'odin':     'Trend Surfing...',
  'loki':     'Spying...',
  'bragi':    'Writing...',
  'hermod':   'Reaching Out...',
  'tyr':      'Judging...',
  'vor':      'Watching...',
  'saga':     'Chronicling...',
}

interface AgentStatusPanelProps {
  userId: string
}

// ── Extra agents (Tyr/Vor/Saga) settings schema ─────────────────────────────
// Heimdall keeps its existing dedicated UI below. These are the new agents
// that need schema-driven settings — each field becomes a numeric input.
interface FieldSpec {
  key:   string
  label: string
  min:   number
  max:   number
  help:  string
}
type ExtraConfig = Record<string, number>

const EXTRA_CONFIG_SCHEMA: Record<string, FieldSpec[]> = {
  tyr: [
    { key: 'minScore',         label: 'Auto-promote score (≥)', min: 50, max: 100, help: 'Brief score that auto-promotes to "reviewed". Lower = more lenient.' },
    { key: 'borderlineWindow', label: 'Borderline window',       min: 0,  max: 30,  help: 'Score range below threshold treated as "borderline" (revert to draft + notes).' },
    { key: 'maxBriefsPerDay',  label: 'Max briefs / day',        min: 1,  max: 200, help: 'Daily quota — Claude calls capped to control cost.' },
  ],
  vor: [
    { key: 'windowDays',           label: 'Lookback window (days)', min: 7,  max: 90,    help: 'How far back Vor reads agent_actions to compute approval rates.' },
    { key: 'minSampleSize',        label: 'Min sample size',         min: 5,  max: 100,   help: 'Skip suggestion if fewer than N actions in window — avoids tuning on noise.' },
    { key: 'approvalRateThresh',   label: 'Tighten threshold (0-1)', min: 0,  max: 1,     help: 'Reject rate above this triggers a "tighten" suggestion. Default 0.5.' },
    { key: 'highConfidenceThresh', label: 'Loosen threshold (0-1)',  min: 0,  max: 1,     help: 'Approve rate above this triggers a "loosen" suggestion. Default 0.85.' },
  ],
  saga: [
    { key: 'windowDays',           label: 'Lookback window (days)',     min: 7,  max: 90,  help: 'How far back to scan agent_actions for cluster candidates.' },
    { key: 'minKeywordsForTopic',  label: 'Min keywords for new topic', min: 2,  max: 10,  help: 'How many candidate keywords needed to propose a brand-new topic_map.' },
    { key: 'archiveAgeDays',       label: 'Archive age (days)',         min: 30, max: 365, help: 'Cluster inactive this long becomes archive candidate.' },
    { key: 'maxProposalsPerRun',   label: 'Max proposals / run',        min: 1,  max: 50,  help: 'Total cap (cluster + archive + coverage combined).' },
    { key: 'coverageThresholdPct', label: 'Coverage alert below (%)',   min: 10, max: 90,  help: 'Topics below this completion get a coverage_review action.' },
  ],
}

const EXTRA_CONFIG_DEFAULTS: Record<string, ExtraConfig> = {
  tyr:  { minScore: 80, borderlineWindow: 10, maxBriefsPerDay: 30 },
  vor:  { windowDays: 30, minSampleSize: 10, approvalRateThresh: 0.5, highConfidenceThresh: 0.85 },
  saga: { windowDays: 30, minKeywordsForTopic: 3, archiveAgeDays: 90, maxProposalsPerRun: 15, coverageThresholdPct: 50 },
}

export default function AgentStatusPanel({ userId: _ }: AgentStatusPanelProps) {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [expandedSettings, setExpandedSettings] = useState<string | null>(null)

  // Heimdall config state
  const [pakRTConfig, setPakRTConfig] = useState<PakRTConfig>({
    maxDropsPerDay: 10,
    minClicksDrop: 5,
    minPctDrop: 20,
    urlMustInclude: '/categories/',
    urlMustExclude: '/offer/',
  })
  const [savingConfig, setSavingConfig] = useState(false)
  const [configSaved, setConfigSaved] = useState(false)

  // Tyr/Vor/Saga config state — schema-driven
  const [extraConfigs, setExtraConfigs] = useState<Record<string, ExtraConfig>>({
    tyr:  EXTRA_CONFIG_DEFAULTS.tyr,
    vor:  EXTRA_CONFIG_DEFAULTS.vor,
    saga: EXTRA_CONFIG_DEFAULTS.saga,
  })
  const [savingExtra, setSavingExtra] = useState<string | null>(null)
  const [extraSaved, setExtraSaved] = useState<string | null>(null)

  const fetchStatus = async () => {
    try {
      setLoading(true)
      const res = await fetch('/api/agents/status')
      if (!res.ok) throw new Error('Failed to fetch status')
      setStatus(await res.json())
    } catch (err) {
      console.error('Failed to fetch agent status:', err)
    } finally {
      setLoading(false)
    }
  }

  const fetchPakRTConfig = async () => {
    try {
      const res = await fetch('/api/agents/heimdall/config')
      if (!res.ok) return
      const data = await res.json() as { config: Record<string, unknown> }
      if (data.config && Object.keys(data.config).length > 0) {
        // Convert stored arrays back to comma-separated strings for the UI
        const inc = data.config.urlMustInclude
        const exc = data.config.urlMustExclude
        setPakRTConfig(prev => ({
          ...prev,
          maxDropsPerDay: typeof data.config.maxDropsPerDay === 'number' ? data.config.maxDropsPerDay : prev.maxDropsPerDay,
          minClicksDrop:  typeof data.config.minClicksDrop  === 'number' ? data.config.minClicksDrop  : prev.minClicksDrop,
          minPctDrop:     typeof data.config.minPctDrop     === 'number' ? data.config.minPctDrop     : prev.minPctDrop,
          urlMustInclude: Array.isArray(inc) ? inc.join(', ') : typeof inc === 'string' ? inc : prev.urlMustInclude,
          urlMustExclude: Array.isArray(exc) ? exc.join(', ') : typeof exc === 'string' ? exc : prev.urlMustExclude,
        }))
      }
    } catch {
      // use defaults
    }
  }

  const fetchExtraConfigs = async () => {
    const next: Record<string, ExtraConfig> = { ...extraConfigs }
    for (const key of Object.keys(EXTRA_CONFIG_SCHEMA)) {
      try {
        const res = await fetch(`/api/agents/${key}/config`)
        if (!res.ok) continue
        const data = await res.json() as { config?: Record<string, unknown> }
        if (data.config) {
          const merged = { ...EXTRA_CONFIG_DEFAULTS[key] }
          for (const f of EXTRA_CONFIG_SCHEMA[key]) {
            const v = data.config[f.key]
            if (typeof v === 'number') merged[f.key] = v
          }
          next[key] = merged
        }
      } catch { /* defaults */ }
    }
    setExtraConfigs(next)
  }

  useEffect(() => {
    fetchStatus()
    fetchPakRTConfig()
    fetchExtraConfigs()
    const interval = setInterval(fetchStatus, 30000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSaveExtraConfig = async (agentKey: string) => {
    setSavingExtra(agentKey)
    try {
      await fetch(`/api/agents/${agentKey}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: extraConfigs[agentKey] }),
      })
      setExtraSaved(agentKey)
      setTimeout(() => setExtraSaved(null), 2000)
    } catch (err) {
      console.error(`Failed to save ${agentKey} config:`, err)
    } finally {
      setSavingExtra(null)
    }
  }

  const updateExtraField = (agentKey: string, field: string, raw: string) => {
    const spec = EXTRA_CONFIG_SCHEMA[agentKey]?.find(f => f.key === field)
    if (!spec) return
    const num  = parseFloat(raw)
    if (Number.isNaN(num)) return
    const clamped = Math.max(spec.min, Math.min(spec.max, num))
    setExtraConfigs(prev => ({
      ...prev,
      [agentKey]: { ...prev[agentKey], [field]: clamped },
    }))
  }

  const handleRunAgent = async (key: string) => {
    setRunning(prev => new Set([...prev, key]))
    try {
      const res = await fetch(`/api/agents/${key}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site: 'g2g' }),
      })
      if (res.ok) {
        // Poll every 3s until the agent is no longer running (up to 2 minutes)
        let polls = 0
        const poll = async () => {
          polls++
          await fetchStatus()
          // Read fresh status from the API directly to avoid stale closure
          try {
            const statusRes = await fetch('/api/agents/status')
            if (statusRes.ok) {
              const data: StatusResponse = await statusRes.json()
              const agent = data.agents?.find(a => a.key === key)
              const stillRunning = agent?.lastRunStatus === 'running'
              if (stillRunning && polls < 40) {
                setTimeout(poll, 3000)
                return
              }
            }
          } catch { /* silent */ }
          // Agent done or timed out — clear running state
          setRunning(prev => { const n = new Set(prev); n.delete(key); return n })
          fetchStatus()
        }
        setTimeout(poll, 2000)
        return // don't fall through to finally-clear
      }
    } catch (err) {
      console.error('Failed to run agent:', err)
    }
    // Only clear here on error / non-ok response
    setRunning(prev => { const n = new Set(prev); n.delete(key); return n })
  }

  const handleRunCategory = async (agents: string[]) => {
    await Promise.all(agents.map(key => handleRunAgent(key)))
  }

  // Parse comma-separated pattern string → array of trimmed non-empty strings
  const parsePatterns = (raw: string) =>
    raw.split(',').map(s => s.trim()).filter(Boolean)

  const handleSavePakRTConfig = async () => {
    setSavingConfig(true)
    try {
      await fetch('/api/agents/heimdall/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            maxDropsPerDay: pakRTConfig.maxDropsPerDay,
            minClicksDrop:  pakRTConfig.minClicksDrop,
            minPctDrop:     pakRTConfig.minPctDrop,
            urlMustInclude: parsePatterns(pakRTConfig.urlMustInclude),
            urlMustExclude: parsePatterns(pakRTConfig.urlMustExclude),
            filterRegionCodes: true,
          },
        }),
      })
      setConfigSaved(true)
      setTimeout(() => setConfigSaved(false), 2000)
    } catch (err) {
      console.error('Failed to save config:', err)
    } finally {
      setSavingConfig(false)
    }
  }

  // Correct pipeline order: Detection → Triage → Execution → Audit
  const AGENT_CATEGORIES: {
    label: string; description: string; pipelineNote: string
    cooldown: string; color: string; btnColor: string; agents: string[]
    runLabel: string
  }[] = [
    {
      label:        'Detection',
      description:  'Monitor, discover, and surface opportunities.',
      pipelineNote: 'Step 1 — fills the action queue for Triage to review',
      cooldown:     '3h cooldown',
      color:        'text-blue-400 border-blue-800/40 bg-blue-950/20',
      btnColor:     'bg-blue-700 hover:bg-blue-600',
      agents:       ['heimdall', 'odin', 'loki'],
      runLabel:     'Run Detection',
    },
    {
      label:        'Triage',
      description:  'Validate the action queue before execution agents act on it.',
      pipelineNote: 'Step 2 — Tyr scores & gates what reaches Execution',
      cooldown:     '30min cooldown',
      color:        'text-amber-400 border-amber-800/40 bg-amber-950/20',
      btnColor:     'bg-amber-700 hover:bg-amber-600',
      agents:       ['tyr'],
      runLabel:     'Run Triage',
    },
    {
      label:        'Execution',
      description:  'Act on Triage-approved signals — draft content, outreach, curate keyword maps.',
      pipelineNote: 'Step 3 — runs after Tyr has validated the queue',
      cooldown:     '1h cooldown',
      color:        'text-green-400 border-green-800/40 bg-green-950/20',
      btnColor:     'bg-green-700 hover:bg-green-600',
      agents:       ['bragi', 'hermod', 'saga'],
      runLabel:     'Run Execution',
    },
    {
      label:        'Audit',
      description:  'Post-execution quality gate — tunes thresholds based on what worked.',
      pipelineNote: 'Step 4 — runs last, after Execution agents have produced output',
      cooldown:     '30min cooldown',
      color:        'text-purple-400 border-purple-800/40 bg-purple-950/20',
      btnColor:     'bg-purple-700 hover:bg-purple-600',
      agents:       ['vor'],
      runLabel:     'Run Audit',
    },
  ]

  const agentMap = new Map((status?.agents || []).map(a => [a.key, a]))

  const formatTimeAgo = (iso: string | null) => {
    if (!iso) return 'Never'
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
  }

  const statusIcon = (s: string | null) =>
    s === 'success' ? '✅'
    : s === 'partial' ? '⚠️'
    : s === 'error' ? '❌'
    : s === 'running' ? '⏳'
    : '—'

  const statusLabelClass = (s: string | null) =>
    s === 'success' ? 'text-green-400'
    : s === 'partial' ? 'text-amber-400'
    : s === 'error' ? 'text-red-400'
    : s === 'running' ? 'text-blue-400'
    : 'text-gray-500'

  // Only show full loading screen on the very first fetch (status === null).
  // Subsequent auto-refreshes keep the existing cards visible — no blipping.
  if (loading && !status) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center">
        <p className="text-gray-400 text-sm">Loading agents...</p>
      </div>
    )
  }

  function renderAgentCard(key: string) {
        const agent = agentMap.get(key)
        const pendingCount = status?.actionsByAgent[key] ?? 0
        const isImplemented = ['heimdall', 'odin', 'loki', 'bragi', 'hermod', 'tyr', 'vor', 'saga'].includes(key)
        const isRunning = running.has(key)
        const settingsOpen = expandedSettings === key

        return (
          <div key={key} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden hover:border-gray-700 transition">
            {/* Main row */}
            <div className="p-4 flex items-center justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-lg">{AGENT_EMOJI[key]}</span>
                  <h3 className="text-white font-semibold">{AGENT_NAMES[key]}</h3>
                  {!isImplemented && (
                    <span className="px-2 py-0.5 rounded text-xs bg-gray-800 text-gray-500">Coming soon</span>
                  )}
                  {pendingCount > 0 && (
                    <span className="px-2 py-0.5 rounded text-xs bg-blue-900/50 text-blue-300">
                      {pendingCount} pending
                    </span>
                  )}
                </div>
                <p className="text-gray-400 text-xs mt-0.5">{AGENT_ROLES[key]}</p>
                {agent && (
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500">
                    <span className={statusLabelClass(agent.lastRunStatus)}>
                      {statusIcon(agent.lastRunStatus)} {agent.lastRunStatus ?? 'never run'}
                    </span>
                    <span>·</span>
                    <span>Last run: {formatTimeAgo(agent.lastRunAt)}</span>
                    {agent.lastRunSummary && (
                      <span className="text-gray-600 truncate max-w-xs hidden sm:block" title={agent.lastRunSummary}>
                        · {agent.lastRunSummary}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                {/* Settings gear — Heimdall + any agent with EXTRA_CONFIG_SCHEMA */}
                {isImplemented && (key === 'heimdall' || EXTRA_CONFIG_SCHEMA[key]) && (
                  <button
                    onClick={() => setExpandedSettings(settingsOpen ? null : key)}
                    className={`p-2 rounded text-sm transition ${settingsOpen ? 'text-white bg-gray-700' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
                    title="Settings"
                  >
                    ⚙️
                  </button>
                )}
                {isImplemented && (
                  <button
                    onClick={() => handleRunAgent(key)}
                    disabled={isRunning}
                    className="px-4 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-50 whitespace-nowrap"
                  >
                    {isRunning
                      ? (AGENT_RUNNING_LABEL[key] ?? 'Running...')
                      : (AGENT_START_LABEL[key]   ?? 'Run Now')}
                  </button>
                )}
              </div>
            </div>

            {/* Settings panel — Heimdall */}
            {settingsOpen && key === 'heimdall' && (
              <div className="border-t border-gray-800 bg-gray-950 px-5 py-4">
                <p className="text-xs text-gray-400 mb-3 font-medium uppercase tracking-wider">Heimdall Settings</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {/* Max drops per day */}
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      Max URLs per run
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={pakRTConfig.maxDropsPerDay}
                      onChange={e => setPakRTConfig(p => ({ ...p, maxDropsPerDay: Math.max(1, parseInt(e.target.value) || 1) }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                    />
                    <p className="text-xs text-gray-600 mt-1">Worst drops are prioritised first</p>
                  </div>

                  {/* Min clicks drop */}
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      Min click drop (absolute)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={pakRTConfig.minClicksDrop}
                      onChange={e => setPakRTConfig(p => ({ ...p, minClicksDrop: Math.max(1, parseInt(e.target.value) || 1) }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                    />
                    <p className="text-xs text-gray-600 mt-1">Skip if drop is less than this</p>
                  </div>

                  {/* Min % drop */}
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      Min drop threshold (%)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={pakRTConfig.minPctDrop}
                      onChange={e => setPakRTConfig(p => ({ ...p, minPctDrop: Math.max(1, parseInt(e.target.value) || 1) }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                    />
                    <p className="text-xs text-gray-600 mt-1">Skip if % drop is less than this</p>
                  </div>
                </div>

                {/* URL scope filters */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 pt-4 border-t border-gray-800">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      Track only URLs containing
                    </label>
                    <input
                      type="text"
                      value={pakRTConfig.urlMustInclude}
                      onChange={e => setPakRTConfig(p => ({ ...p, urlMustInclude: e.target.value }))}
                      placeholder="/categories/"
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                    />
                    <p className="text-xs text-gray-600 mt-1">Comma-separated. Only pages matching any of these are tracked.</p>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">
                      Always skip URLs containing
                    </label>
                    <input
                      type="text"
                      value={pakRTConfig.urlMustExclude}
                      onChange={e => setPakRTConfig(p => ({ ...p, urlMustExclude: e.target.value }))}
                      placeholder="/offer/, /sg/"
                      className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                    />
                    <p className="text-xs text-gray-600 mt-1">Comma-separated. Region codes (/sg/, /my/, etc.) are also auto-skipped.</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 mt-4">
                  <button
                    onClick={handleSavePakRTConfig}
                    disabled={savingConfig}
                    className="px-4 py-1.5 rounded text-sm font-medium bg-green-700 text-white hover:bg-green-600 transition disabled:opacity-50"
                  >
                    {savingConfig ? 'Saving...' : configSaved ? '✅ Saved' : 'Save Settings'}
                  </button>
                  <p className="text-xs text-gray-500">Changes apply on next run</p>
                </div>
              </div>
            )}

            {/* Settings panel — schema-driven for Tyr / Vor / Saga */}
            {settingsOpen && EXTRA_CONFIG_SCHEMA[key] && (
              <div className="border-t border-gray-800 bg-gray-950 px-5 py-4">
                <p className="text-xs text-gray-400 mb-3 font-medium uppercase tracking-wider">{AGENT_NAMES[key]} Settings</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {EXTRA_CONFIG_SCHEMA[key].map(field => (
                    <div key={field.key}>
                      <label className="block text-xs text-gray-400 mb-1">{field.label}</label>
                      <input
                        type="number"
                        step={field.max <= 1 ? 0.05 : 1}
                        min={field.min}
                        max={field.max}
                        value={extraConfigs[key]?.[field.key] ?? EXTRA_CONFIG_DEFAULTS[key][field.key]}
                        onChange={e => updateExtraField(key, field.key, e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500"
                      />
                      <p className="text-xs text-gray-600 mt-1">{field.help}</p>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3 mt-4">
                  <button
                    onClick={() => handleSaveExtraConfig(key)}
                    disabled={savingExtra === key}
                    className="px-4 py-1.5 rounded text-sm font-medium bg-green-700 text-white hover:bg-green-600 transition disabled:opacity-50"
                  >
                    {savingExtra === key ? 'Saving...' : extraSaved === key ? '✅ Saved' : 'Save Settings'}
                  </button>
                  <p className="text-xs text-gray-500">Changes apply on next run</p>
                </div>
              </div>
            )}
          </div>
        )
  }

  return (
    <div className="space-y-8">
      {AGENT_CATEGORIES.map(cat => (
        <div key={cat.label}>
          {/* Category header */}
          <div className={`flex items-center justify-between px-4 py-2.5 rounded-xl border mb-3 ${cat.color}`}>
            <div className="flex-1 min-w-0">
              <span className={`text-xs font-bold uppercase tracking-widest ${cat.color.split(' ')[0]}`}>
                {cat.label}
              </span>
              <p className="text-gray-400 text-xs mt-0.5">{cat.description}</p>
              <p className="text-gray-600 text-[11px] mt-0.5 italic">{cat.pipelineNote}</p>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0 ml-4">
              <span className="text-[11px] text-gray-500 font-medium">{cat.cooldown}</span>
              <button
                onClick={() => handleRunCategory(cat.agents)}
                disabled={cat.agents.some(k => running.has(k))}
                className={`px-3 py-1.5 rounded text-xs font-semibold text-white transition disabled:opacity-50 whitespace-nowrap ${cat.btnColor}`}
              >
                {cat.agents.some(k => running.has(k)) ? 'Running...' : cat.runLabel}
              </button>
            </div>
          </div>

          {/* Agent cards in this category */}
          <div className="space-y-2">
            {cat.agents.map(key => renderAgentCard(key))}
          </div>
        </div>
      ))}
    </div>
  )
}
