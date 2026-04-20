'use client'

export default function PageAnalyzerPage() {
  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold text-white mb-2">🔎 Page Analyzer</h1>
      <p className="text-gray-400 text-sm mb-6">
        Analyze any competitor page — title, meta, heading structure, keyword density, and internal links — for on-page benchmarking.
      </p>
      <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
        <p className="text-3xl mb-3">🚧</p>
        <p className="text-white font-semibold mb-1">Coming soon</p>
        <p className="text-gray-400 text-sm">
          Page Analyzer will crawl any URL and extract on-page SEO signals for comparison against G2G pages.
        </p>
      </div>
    </div>
  )
}
