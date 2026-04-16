import { getCompetitors, getDomainOverview } from '@/lib/semrush/client'

export const dynamic = 'force-dynamic'

const TARGET_DOMAIN = 'g2g.com'
const DB = 'id'

export default async function CompetitorTrackingPage() {
  const hasKey = !!process.env.SEMRUSH_API_KEY

  let competitors: Awaited<ReturnType<typeof getCompetitors>> = []
  let overview: Awaited<ReturnType<typeof getDomainOverview>> = null
  let fetchError: string | null = null

  if (hasKey) {
    try {
      ;[competitors, overview] = await Promise.all([
        getCompetitors(TARGET_DOMAIN, DB, 15),
        getDomainOverview(TARGET_DOMAIN, DB),
      ])
    } catch (e) {
      fetchError = String(e)
    }
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">👁️ Competitor Tracking</h1>
        <p className="text-gray-400 text-sm mt-1">
          Top organic competitors of <span className="text-white font-medium">{TARGET_DOMAIN}</span>
        </p>
      </div>

      {!hasKey && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-6">
          <p className="text-yellow-400 font-medium">SEMrush API key not configured</p>
          <p className="text-gray-400 text-sm mt-1">
            Add <code className="text-gray-300 bg-gray-800 px-1 rounded">SEMRUSH_API_KEY</code> to Vercel environment variables.
          </p>
        </div>
      )}

      {fetchError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-red-400 text-sm">
          ⚠️ {fetchError}
        </div>
      )}

      {/* G2G overview row */}
      {overview && (
        <div className="bg-red-700/20 border border-red-700/40 rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-white font-bold">{TARGET_DOMAIN}</span>
              <span className="text-xs text-red-400 bg-red-700/20 px-2 py-0.5 rounded-full">You</span>
            </div>
            <div className="flex items-center gap-6 text-sm">
              <span className="text-gray-400">Keywords: <span className="text-white font-medium">{overview.organicKeywords.toLocaleString()}</span></span>
              <span className="text-gray-400">Traffic/mo: <span className="text-white font-medium">{overview.organicTraffic.toLocaleString()}</span></span>
              <span className="text-gray-400">Est. value: <span className="text-white font-medium">${overview.organicCost.toLocaleString()}</span></span>
            </div>
          </div>
        </div>
      )}

      {competitors.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left text-gray-500 font-medium px-5 py-3">#</th>
                <th className="text-left text-gray-500 font-medium px-5 py-3">Competitor</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Organic Keywords</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Est. Traffic/mo</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Est. Value</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">vs G2G Traffic</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {competitors.map((c, i) => {
                const trafficRatio = overview && overview.organicTraffic > 0
                  ? ((c.organicTraffic / overview.organicTraffic) * 100).toFixed(0)
                  : null
                return (
                  <tr key={c.domain} className="hover:bg-gray-800/50 transition">
                    <td className="px-5 py-3.5 text-gray-500">{i + 1}</td>
                    <td className="px-5 py-3.5">
                      <a
                        href={`https://${c.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 font-medium"
                      >
                        {c.domain}
                      </a>
                    </td>
                    <td className="px-5 py-3.5 text-right text-gray-300">{c.organicKeywords.toLocaleString()}</td>
                    <td className="px-5 py-3.5 text-right text-gray-300">{c.organicTraffic.toLocaleString()}</td>
                    <td className="px-5 py-3.5 text-right text-gray-400">${c.organicCost.toLocaleString()}</td>
                    <td className="px-5 py-3.5 text-right">
                      {trafficRatio && (
                        <span className={`font-medium ${parseInt(trafficRatio) > 100 ? 'text-red-400' : 'text-green-400'}`}>
                          {parseInt(trafficRatio) > 100 ? '▲' : '▼'} {Math.abs(parseInt(trafficRatio) - 100)}%
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
