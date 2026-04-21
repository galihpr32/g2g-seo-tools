'use client'

import { useState, useEffect } from 'react'

interface AgentAction {
  id: string
  agent_key: string
  action_type: string
  title: string
  description: string | null
  priority: string
  status: string
  created_at: string
}

const AGENT_COLORS: Record<string, string> = {
  'pak-rt': 'bg-red-500/20 text-red-300 border-red-500/30',
  'mas-gacor': 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  'intel-bakso': 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  'anak-intern': 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  'kang-cilok': 'bg-green-500/20 text-green-300 border-green-500/30',
}

const AGENT_LABELS: Record<string, string> = {
  'pak-rt': 'Pak RT (Watchdog)',
  'mas-gacor': 'Mas Gacor (Trends)',
  'intel-bakso': 'Intel Bakso',
  'anak-intern': 'Anak Intern',
  'kang-cilok': 'Kang Cilok',
}

const PRIORITY_COLORS: Record<string, string> = {
  high: 'bg-red-600 text-white',
  medium: 'bg-yellow-600 text-white',
  low: 'bg-gray-600 text-white',
}

interface ApprovalQueueWidgetProps {
  userId: string
}

export default function ApprovalQueueWidget({ userId }: ApprovalQueueWidgetProps) {
  const [actions, setActions] = useState<AgentAction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [processingId, setProcessingId] = useState<string | null>(null)

  const fetchActions = async () => {
    try {
      setLoading(true)
      const response = await fetch('/api/agents/actions?status=pending')
      if (!response.ok) throw new Error('Failed to fetch actions')
      const data = await response.json()
      setActions(data.actions || [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchActions()
    const interval = setInterval(fetchActions, 30000) // Refresh every 30s
    return () => clearInterval(interval)
  }, [])

  const handleApprove = async (actionId: string) => {
    setProcessingId(actionId)
    try {
      const response = await fetch('/api/agents/actions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: actionId, status: 'approved' }),
      })
      if (!response.ok) throw new Error('Failed to approve action')
      setActions(actions.filter(a => a.id !== actionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setProcessingId(null)
    }
  }

  const handleReject = async (actionId: string) => {
    setProcessingId(actionId)
    try {
      const response = await fetch('/api/agents/actions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: actionId, status: 'rejected' }),
      })
      if (!response.ok) throw new Error('Failed to reject action')
      setActions(actions.filter(a => a.id !== actionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setProcessingId(null)
    }
  }

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center">
        <p className="text-gray-400 text-sm">Loading pending actions...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-gray-900 border border-red-800/30 rounded-xl p-6 text-center">
        <p className="text-red-300 text-sm">{error}</p>
      </div>
    )
  }

  if (!actions.length) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center">
        <p className="text-gray-400 text-sm">No pending actions. All good!</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {actions.map(action => {
        const agentLabel = AGENT_LABELS[action.agent_key] || action.agent_key
        const agentColorClass = AGENT_COLORS[action.agent_key] || 'bg-gray-500/20 text-gray-300 border-gray-500/30'
        const priorityColorClass = PRIORITY_COLORS[action.priority] || PRIORITY_COLORS.medium
        const isProcessing = processingId === action.id

        return (
          <div
            key={action.id}
            className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition"
          >
            <div className="flex items-start justify-between gap-4 mb-3">
              <div className="flex items-start gap-3 flex-1">
                <span className={`px-2.5 py-1 rounded text-xs font-semibold border ${agentColorClass} flex-shrink-0`}>
                  {action.agent_key.toUpperCase()}
                </span>
                <div className="flex-1">
                  <h3 className="text-white font-semibold text-sm">{action.title}</h3>
                  {action.description && (
                    <p className="text-gray-400 text-xs mt-1">{action.description}</p>
                  )}
                </div>
              </div>
              <span className={`px-2.5 py-1 rounded text-xs font-semibold flex-shrink-0 ${priorityColorClass}`}>
                {action.priority}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <span className="px-2 py-1 rounded text-xs bg-gray-800 text-gray-300">
                  {action.action_type}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleReject(action.id)}
                  disabled={isProcessing}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-gray-800 text-gray-300 hover:bg-gray-700 transition disabled:opacity-50"
                >
                  {isProcessing ? '...' : 'Reject'}
                </button>
                <button
                  onClick={() => handleApprove(action.id)}
                  disabled={isProcessing}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-green-600 text-white hover:bg-green-700 transition disabled:opacity-50"
                >
                  {isProcessing ? '...' : 'Approve'}
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
