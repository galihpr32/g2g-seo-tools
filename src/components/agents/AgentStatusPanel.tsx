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
}

const AGENT_NAMES: Record<string, string> = {
  'pak-rt': 'Pak RT',
  'mas-gacor': 'Mas Gacor',
  'intel-bakso': 'Intel Bakso',
  'anak-intern': 'Anak Intern',
  'kang-cilok': 'Kang Cilok',
}

const AGENT_ROLES: Record<string, string> = {
  'pak-rt': 'Watchdog — detects ranking drops & triages',
  'mas-gacor': 'Trend Spotter — finds trending games & suggests content',
  'intel-bakso': 'Competitive Intel — coming soon',
  'anak-intern': 'On-page Agent — coming soon',
  'kang-cilok': 'Off-page Agent — coming soon',
}

const AGENT_EMOJI: Record<string, string> = {
  'pak-rt': '🔍',
  'mas-gacor': '📈',
  'intel-bakso': '🕵️',
  'anak-intern': '✍️',
  'kang-cilok': '🤝',
}

interface AgentStatusPanelProps {
  userId: string
}

export default function AgentStatusPanel({ userId: _ }: AgentStatusPanelProps) {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [expandedSettings, setExpandedSettings] = useState<string | null>(null)

  // Pak RT config state
  const [pakRTConfig, setPakRTConfig] = useState<PakRTConfig>({
    maxDropsPerDay: 10,
    minClicksDrop: 5,
    minPctDrop: 20,
  })
  const [savingConfig, setSavingConfig] = useState(false)
  const [configSaved, setConfigSaved] = useState(false)

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
      const res = await fetch('/api/agents/pak-rt/config')
      if (!res.ok) return
      const data = await res.json() as { config: Partial<PakRTConfig> }
      if (data.config && Object.keys(data.config).length > 0) {
        setPakRTConfig(prev => ({ ...prev, ...data.config }))
      }
    } catch {
      // use defaults
    }
  }

  useEffect(() => {
    fetchStatus()
    fetchPakRTConfig()
    const interval = setInterval(fetchStatus, 30000)
    return () => clearInterval(interval)
  }, [])

  const handleRunAgent = async (key: string) => {
    setRunning(prev => new Set([...prev, key]))
    try {
      const res = await fetch(`/api/agents/${key}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site: 'g2g' }),
      })
      if (res.ok) setTimeout(fetchStatus, 2000)
    } catch (err) {
      console.error('Failed to run agent:', err)
    } finally {
      setRunning(prev => { const n = new Set(prev); n.delete(key); return n })
    }
  }

  const handleSavePakRTConfig = async () => {
    setSavingConfig(true)
    try {
      await fetch('/api/agents/pak-rt/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: pakRTConfig }),
      })
      setConfigSaved(true)
      setTimeout(() => setConfigSaved(false), 2000)
    } catch (err) {
      console.error('Failed to save config:', err)
    } finally {
      setSavingConfig(false)
    }
  }

  const allAgents = ['pak-rt', 'mas-gacor', 'intel-bakso', 'anak-intern', 'kang-cilok']
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
    s === 'success' ? '✅' : s === 'error' ? '❌' : s === 'running' ? '⏳' : '—'

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center">
        <p className="text-gray-400 text-sm">Loading agents...</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {allAgents.map(key => {
        const agent = agentMap.get(key)
        const pendingCount = status?.actionsByAgent[key] ?? 0
        const isImplemented = ['pak-rt', 'mas-gacor'].includes(key)
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
                    <span>{statusIcon(agent.lastRunStatus)} {agent.lastRunStatus ?? 'never run'}</span>
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
                {/* Settings gear — only for implemented agents */}
                {isImplemented && key === 'pak-rt' && (
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
                    className="px-4 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-50"
                  >
                    {isRunning ? 'Running...' : 'Run Now'}
                  </button>
                )}
              </div>
            </div>

            {/* Settings panel — Pak RT */}
            {settingsOpen && key === 'pak-rt' && (
              <div className="border-t border-gray-800 bg-gray-950 px-5 py-4">
                <p className="text-xs text-gray-400 mb-3 font-medium uppercase tracking-wider">Pak RT Settings</p>
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
          </div>
        )
      })}
    </div>
  )
}
