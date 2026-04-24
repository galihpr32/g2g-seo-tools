import { getDomainRankedKeywords } from '@/lib/dataforseo/client'

export const revalidate = 3600

const TARGET_DOMAIN = 'g2g.com'

interface ClusterKeyword {
  keyword: string
  position: number
  searchVolume: number
  url: string
}

/** Group keywords by their first meaningful word (simple topic clustering) */
function clusterKeywords(
  keywords: ClusterKeyword[]
): Map<string, ClusterKeyword[]> {
  const stopWords = new Set([
    'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
    'buy', 'sell', 'get', 'how', 'what', 'where', 'best', 'cheap',
  ])
  const clusters = new Map<string, ClusterKeyword[]>()

  for (const kw of keywords) {
    const words = kw.keyword.toLowerCase().split(/\s+/)
    const topic = words.find(w => !stopWords.has(w) && w.length > 2) ?? words[0]
    if (!clusters.has(topic)) clusters.set(topic, [])
    clusters.get(topic)!.push(kw)
  }

  // Sort clusters by total volume desc
  return new Map(
    [...clusters.entries()]
      .sort((a, b) => {
        const volA = a[1].reduce((s, k) => s + (k.searchVolume ?? 0), 0)
        const volB = b[1].reduce((s, k) => s + (k.searchVolume ?? 0), 0)
        return volB - volA
      })
  )
}

export default async function KeywordClusteringPage() {
  const hasCredentials = !!(
    process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD
  )

  let clusters: Map<string, ClusterKeyword[]> = new Map()
  let fetchError: string | null = null

  if (hasCredentials) {
    try {
      const raw = await getDomainRankedKeywords(TARGET_DOMAIN, 2840, 'en', 500)
      const keywords: ClusterKeyword[] = raw.map(k => ({
        keyword: k.keyword ?? '',
        position: k.position ?? 0,
        searchVolume: k.volume ?? 0,
        url: k.url ?? '',
      })).filter(k => k.keyword)
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

      {!hasCredentials && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-6">
          <p className="text-yellow-400 font-medium">DataForSEO credentials not configured</p>
          <p className="text-gray-400 text-sm mt-1">
            Add <code className="text-gray-300 bg-gray-800 px-1 rounded">DATAFORSEO_LOGIN</code> and{' '}
            <code className="text-gray-300 bg-gray-800 px-1 rounded">DATAFORSEO_PASSWORD</code> to your environment variables.
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
