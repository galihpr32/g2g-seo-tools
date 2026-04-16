import { getDomainKeywords, getDomainOverview } from '@/lib/semrush/client'

export const dynamic = 'force-dynamic'

const TARGET_DOMAIN = 'g2g.com'
const DB = 'id'

export default async function KeywordRankingsPage() {
  const hasKey = !!process.env.SEMRUSH_API_KEY

  let keywords: Awaited<ReturnType<typeof getDomainKeywords>> = []
  let overview: Awaited<ReturnType<typeof getDomainOverview>> = null
  let fetchError: string | null = null

  if (hasKey) {
    try {
      ;[keywords, overview] = await Promise.all([
        getDomainKeywords(TARGET_DOMAIN, DB, 100),
        getDomainOverview(TARGET_DOMAIN, DB),
      ])
    } catch (e) {
      fetchError = String(e)
    }
  }

  const improved = keywords.filter(k => k.positionDiff < 0).length
  const declined = keywords.filter(k => k.positionDiff > 0).length
  const top10 = keywords.filter(k => k.position <= 10).length

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">🎯 Keyword Rankings</h1>
          <p className="text-gray-400 text-sm mt-1">
            Organic keyword positions for <span className="text-white font-medium">{TARGET_DOMAIN}</span> · Database: {DB.toUpperCase()}
          </p>
        </div>
      </div>

      {!hasKey && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-6 mb-6">
          <p className="text-yellow-400 font-medium">SEMrush API key not configured</p>
          <p className="text-gray-400 text-sm mt-1">
            Add <code className="text-gray-300 bg-gray-800 px-1 rounded">SEMRUSH_API_KEY</code> to your Vercel environment variables to enable this feature.
          </p>
        </div>
      )}

      {fetchError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-red-400 text-sm">
          ⚠️ {fetchError}
        </div>
      )}

      {/* Domain Overview */}
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-3xl font-bold text-white">{overview.organicKeywords.toLocaleString()}</p>
            <p className="text-gray-400 text-sm mt-1">Organic keywords</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-3xl font-bold text-white">{overview.organicTraffic.toLocaleString()}</p>
            <p className="text-gray-400 text-sm mt-1">Est. organic traffic/mo</p>
          </div>
          <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4">
            <p className="text-3xl font-bold text-green-400">{improved}</p>
            <p className="text-gray-400 text-sm mt-1">Improved (↑)</p>
          </div>
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
            <p className="text-3xl font-bold text-red-400">{declined}</p>
            <p className="text-gray-400 text-sm mt-1">Declined (↓)</p>
          </div>
        </div>
      )}

      {/* Top 10 badge */}
      {keywords.length > 0 && (
        <div className="flex gap-3 mb-6">
          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-2.5 flex items-center gap-2">
            <span className="text-blue-400 font-bold text-lg">{top10}</span>
            <span className="text-gray-400 text-sm">keywords in Top 10</span>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 flex items-center gap-2">
            <span className="text-white font-bold text-lg">{keywords.length}</span>
            <span className="text-gray-400 text-sm">keywords shown (top 100)</span>
          </div>
        </div>
      )}

      {/* Keywords Table */}
      {keywords.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left text-gray-500 font-medium px-5 py-3">Keyword</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Pos.</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Prev</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Δ</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Vol/mo</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">CPC</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Traffic %</th>
                <th className="text-left text-gray-500 font-medium px-5 py-3">Landing Page</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {keywords.map((kw, i) => {
                let pathname = kw.url
                try { pathname = new URL(kw.url).pathname } catch { /* keep */ }
                return (
                  <tr key={i} className="hover:bg-gray-800/50 transition">
                    <td className="px-5 py-3 text-white font-medium max-w-xs">
                      <span className="block truncate" title={kw.keyword}>{kw.keyword}</span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <span className={`font-bold ${kw.position <= 3 ? 'text-green-400' : kw.position <= 10 ? 'text-blue-400' : kw.position <= 20 ? 'text-yellow-400' : 'text-gray-400'}`}>
                        {kw.position}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right text-gray-400">{kw.previousPosition || '—'}</td>
                    <td className="px-5 py-3 text-right font-semibold">
                      {kw.positionDiff === 0 ? (
                        <span className="text-gray-500">—</span>
                      ) : kw.positionDiff < 0 ? (
                        <span className="text-green-400">▲ {Math.abs(kw.positionDiff)}</span>
                      ) : (
                        <span className="text-red-400">▼ {kw.positionDiff}</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-300">{kw.searchVolume.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-gray-400">${kw.cpc.toFixed(2)}</td>
                    <td className="px-5 py-3 text-right text-gray-400">{kw.trafficPercent.toFixed(2)}%</td>
                    <td className="px-5 py-3 max-w-xs">
                      <a
                        href={kw.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 text-xs truncate block"
                        title={kw.url}
                      >
                        {pathname}
                      </a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasKey && !fetchError && keywords.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
          <p className="text-gray-400">No keyword data found for {TARGET_DOMAIN}</p>
        </div>
      )}
    </div>
  )
}
