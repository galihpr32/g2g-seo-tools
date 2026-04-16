import { createClient } from '@/lib/supabase/server'

const taskSummary = [
  { label: 'Ready to Build', count: 4, color: 'text-green-400', bg: 'bg-green-400/10 border-green-400/20' },
  { label: 'In Progress', count: 2, color: 'text-yellow-400', bg: 'bg-yellow-400/10 border-yellow-400/20' },
  { label: 'Ideas', count: 9, color: 'text-blue-400', bg: 'bg-blue-400/10 border-blue-400/20' },
  { label: 'Live', count: 0, color: 'text-purple-400', bg: 'bg-purple-400/10 border-purple-400/20' },
]

const upcomingTasks = [
  { id: 1, title: 'GSC Ranking Drop Alert', frequency: 'Daily', priority: '★★★', status: 'Ready to Build', statusColor: 'text-green-400' },
  { id: 2, title: 'Index Coverage Check', frequency: 'Daily', priority: '★★★', status: 'Idea', statusColor: 'text-blue-400' },
  { id: 3, title: 'Core Web Vitals Monitoring', frequency: 'Daily', priority: '★★☆', status: 'Idea', statusColor: 'text-blue-400' },
  { id: 6, title: 'Content Brief Generation', frequency: 'Weekly', priority: '★★★', status: 'In Progress', statusColor: 'text-yellow-400' },
  { id: 11, title: 'GA4 Organic Traffic Analysis', frequency: 'Weekly', priority: '★★☆', status: 'Idea', statusColor: 'text-blue-400' },
]

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const firstName = user?.email?.split('@')[0] ?? 'there'

  return (
    <div className="p-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">
          Good morning, {firstName} 👋
        </h1>
        <p className="text-gray-400 mt-1 text-sm">
          Here&apos;s your SEO automation overview for today.
        </p>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {taskSummary.map(item => (
          <div key={item.label} className={`rounded-xl border p-4 ${item.bg}`}>
            <p className={`text-3xl font-bold ${item.color}`}>{item.count}</p>
            <p className="text-gray-400 text-sm mt-1">{item.label}</p>
          </div>
        ))}
      </div>

      {/* Phase 1 Banner */}
      <div className="bg-red-900/20 border border-red-800/30 rounded-xl p-5 mb-8">
        <div className="flex items-start gap-3">
          <span className="text-2xl">🚀</span>
          <div>
            <p className="text-white font-semibold">Phase 1 — Building now</p>
            <p className="text-gray-400 text-sm mt-1">
              GSC + GA4 integrations are being built first. Tasks 1, 2, 3 and 11 will be live within 2 weeks.
            </p>
          </div>
        </div>
      </div>

      {/* Task Queue */}
      <div>
        <h2 className="text-white font-semibold mb-4">Build Queue — Week 1 & 2</h2>
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left text-gray-500 font-medium px-5 py-3">#</th>
                <th className="text-left text-gray-500 font-medium px-5 py-3">Task</th>
                <th className="text-left text-gray-500 font-medium px-5 py-3">Frequency</th>
                <th className="text-left text-gray-500 font-medium px-5 py-3">Impact</th>
                <th className="text-left text-gray-500 font-medium px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {upcomingTasks.map(task => (
                <tr key={task.id} className="hover:bg-gray-800/50 transition">
                  <td className="px-5 py-3.5 text-gray-500">{task.id}</td>
                  <td className="px-5 py-3.5 text-white font-medium">{task.title}</td>
                  <td className="px-5 py-3.5 text-gray-400">{task.frequency}</td>
                  <td className="px-5 py-3.5 text-yellow-400">{task.priority}</td>
                  <td className={`px-5 py-3.5 font-medium ${task.statusColor}`}>{task.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
