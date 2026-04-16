import { getDomainKeywords, clusterKeywords } from '@/lib/semrush/client'

export const dynamic = 'force-dynamic'

const TARGET_DOMAIN = 'g2g.com'
const DB = 'id'

export default async function KeywordClusteringPage() {
  const hasKey = !!process.env.SEMRUSH_API_KEY

  let clusters: Map<string, Awaited<ReturnType<typeof getDomainKeywords>>> = new Map()
  let fetchError: string | null = null

  if (hasKey) {
    try {
      const keywords = await getDomainKeywords(TARGET_DOMAIN, DB, 500)
      clusters = clusterKeywords(keywords)
    } catch (e) {
      fetchError = String(e)
    }
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">🗂️ Keyword Clustering</h1>
        <p className="text-gray-400 text-sm mt-1">Keywords grouped by topic — identify content gaps and opportunities</p>
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

      {clusters.size > 0 && (
        <div className="space-y-4">
          {[...clusters.entries()].map(([topic, kws]) => {
            const avgPosition = kws.reduce((s, k) => s + k.position, 0) / kws.length
            const totalVolume = kws.reduce((s, k) => s + k.searchVolume, 0)
            return (
              <div key={topic} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-gray-800 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <p className="text-white font-semibold capitalize">{topic}</p>
                    <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">{kws.length} keywords</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gray-400">
                    <span>Avg pos: <span className="text-white font-medium">{avgPosition.toFixed(1)}</span></span>
                    <span>Vol: <span className="text-white font-medium">{totalVolume.toLocaleString()}</span></span>
                  </div>
                </div>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-800">
                    {kws.slice(0, 5).map((kw, i) => (
                      <tr key={i} className="hover:bg-gray-800/30 transition">
                        <td className="px-5 py-2.5 text-gray-300">{kw.keyword}</td>
                        <td className="px-5 py-2.5 text-right">
                          <span className={`font-medium ${kw.position <= 10 ? 'text-green-400' : kw.position <= 20 ? 'text-yellow-400' : 'text-gray-400'}`}>
                            #{kw.position}
                          </span>
                        </td>
                        <td className="px-5 py-2.5 text-right text-gray-400">{kw.searchVolume.toLocaleString()} vol</td>
                      </tr>
                    ))}
                    {kws.length > 5 && (
                      <tr>
                        <td colSpan={3} className="px-5 py-2 text-xs text-gray-500">
                          +{kws.length - 5} more keywords in this cluster
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
