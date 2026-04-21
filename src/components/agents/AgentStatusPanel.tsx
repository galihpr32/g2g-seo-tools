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

const AGENT_NAMES: Record<string, string> = {
  'pak-rt': 'Pak RT (Watchdog)',
  'mas-gacor': 'Mas Gacor (Trends)',
  'intel-bakso': 'Intel Bakso',
  'anak-intern': 'Anak Intern',
  'kang-cilok': 'Kang Cilok',
}

const AGENT_DESCRIPTIONS: Record<string, string> = {
  'pak-rt': 'Detects ranking drops and queues action items',
  'mas-gacor': 'Identifies trending games and suggests content',
  'intel-bakso': 'Competitive intelligence (coming soon)',
  'anak-intern': 'Content creation assistant (coming soon)',
  'kang-cilok': 'Outreach automation (coming soon)',
}

interface AgentStatusPanelProps {
  userId: string
}

export default function AgentStatusPanel({ userId }: AgentStatusPanelProps) {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<Set<string>>(new Set())

  const fetchStatus = async () => {
    try {
      setLoading(true)
      const response = await fetch('/api/agents/status')
      if (!response.ok) throw new Error('Failed to fetch status')
      const data = await response.json()
      setStatus(data)
    } catch (err) {
      console.error('Failed to fetch agent status:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 30000)
    return () => clearInterval(interval)
  }, [])

  const handleRunAgent = async (key: string) => {
    setRunning(prev => new Set([...prev, key]))
    try {
      const response = await fetch(`/api/agents/${key}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site: 'g2g' }),
      })
      if (response.ok) {
        // Refresh status after a short delay
        setTimeout(fetchStatus, 2000)
      }
    } catch (err) {
      console.error('Failed to run agent:', err)
    } finally {
      setRunning(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const allAgents = [
    'pak-rt',
    'mas-gacor',
    'intel-bakso',
    'anak-intern',
    'kang-cilok',
  ]

  const agentMap = new Map(
    (status?.agents || []).map(a => [a.key, a])
  )

  const formatTimeAgo = (isoString: string | null) => {
    if (!isoString) return 'Never'
    const date = new Date(isoString)
    const now = new Date()
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)

    if (seconds < 60) return 'just now'
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    return `${Math.floor(seconds / 86400)}d ago`
  }

  const getStatusIcon = (runStatus: string | null) => {
    if (!runStatus) return '⏳'
    if (runStatus === 'success') return '✅'
    if (runStatus === 'error') return '❌'
    return '⏳'
  }

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center">
        <p className="text-gray-400 text-sm">Loading agent status...</p>
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

        return (
          <div
            key={key}
            className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition"
          >
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <h3 className="text-white font-semibold">{AGENT_NAMES[key]}</h3>
                  {!isImplemented && (
                    <span className="px-2 py-0.5 rounded text-xs bg-gray-800 text-gray-400">
                      Coming soon
                    </span>
                  )}
                  {pendingCount > 0 && (
                    <span className="px-2 py-0.5 rounded text-xs bg-blue-900/50 text-blue-300">
                      {pendingCount} pending
                    </span>
                  )}
                </div>
                <p className="text-gray-400 text-xs mt-1">{AGENT_DESCRIPTIONS[key]}</p>
                {agent && (
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                    <span>{getStatusIcon(agent.lastRunStatus)} {agent.lastRunStatus || 'pending'}</span>
                    <span>Last run: {formatTimeAgo(agent.lastRunAt)}</span>
                    {agent.lastRunSummary && (
                      <span title={agent.lastRunSummary} className="text-gray-600 truncate max-w-xs">
                        {agent.lastRunSummary}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {isImplemented && (
                <button
                  onClick={() => handleRunAgent(key)}
                  disabled={isRunning}
                  className="px-4 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-50 flex-shrink-0"
                >
                  {isRunning ? 'Running...' : 'Run Now'}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
