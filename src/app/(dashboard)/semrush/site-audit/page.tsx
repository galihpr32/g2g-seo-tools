export const revalidate = 3600

export default function SiteAuditPage() {
  const hasKey = !!process.env.SEMRUSH_API_KEY

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">🔧 Site Audit Digest</h1>
        <p className="text-gray-400 text-sm mt-1">Technical SEO issues summary from SEMrush Site Audit</p>
      </div>

      {!hasKey ? (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-6">
          <p className="text-yellow-400 font-medium">SEMrush API key not configured</p>
          <p className="text-gray-400 text-sm mt-1">
            Add <code className="text-gray-300 bg-gray-800 px-1 rounded">SEMRUSH_API_KEY</code> to Vercel environment variables.
          </p>
        </div>
      ) : (
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-8 text-center">
          <p className="text-blue-400 text-lg font-semibold">🚧 Coming soon</p>
          <p className="text-gray-400 text-sm mt-2">
            Site Audit Digest requires a SEMrush Project ID to be configured.<br />
            Once set up, this page will show errors, warnings, and crawl health over time.
          </p>
          <div className="mt-6 text-left max-w-md mx-auto bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-white text-sm font-medium mb-2">To enable:</p>
            <ol className="text-gray-400 text-sm space-y-1 list-decimal list-inside">
              <li>Create a Site Audit project in SEMrush for g2g.com</li>
              <li>Get the Project ID from the URL</li>
              <li>Add <code className="text-gray-300 bg-gray-800 px-1 rounded">SEMRUSH_PROJECT_ID</code> to Vercel env vars</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  )
}
