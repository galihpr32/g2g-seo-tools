import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const maxDuration = 30

// ── GET /api/costs/balance — live API balance check ───────────────────────────
// Returns remaining credits/units for DataForSEO and SEMrush.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [dfsBalance, semrushBalance] = await Promise.all([
    fetchDataForSeoBalance(),
    fetchSemrushBalance(),
  ])

  return NextResponse.json({
    dataforseo: dfsBalance,
    semrush:    semrushBalance,
    checked_at: new Date().toISOString(),
  })
}

// ── DataForSEO: GET /v3/appendix/user_data ────────────────────────────────────
async function fetchDataForSeoBalance(): Promise<{
  money_balance: number | null
  api_calls_today: number | null
  api_calls_total: number | null
  error?: string
}> {
  const login = process.env.DATAFORSEO_LOGIN ?? ''
  const pass  = process.env.DATAFORSEO_PASSWORD ?? ''

  if (!login || !pass) {
    return { money_balance: null, api_calls_today: null, api_calls_total: null, error: 'Credentials not set' }
  }

  try {
    const auth = 'Basic ' + Buffer.from(`${login}:${pass}`).toString('base64')
    const res  = await fetch('https://api.dataforseo.com/v3/appendix/user_data', {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      return { money_balance: null, api_calls_today: null, api_calls_total: null, error: `HTTP ${res.status}` }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as any
    const result = json?.tasks?.[0]?.result?.[0]

    return {
      money_balance:   result?.money_balance   ?? null,
      api_calls_today: result?.api_calls_count_today ?? null,
      api_calls_total: result?.api_calls_count_total ?? null,
    }
  } catch (err) {
    return { money_balance: null, api_calls_today: null, api_calls_total: null, error: String(err) }
  }
}

// ── SEMrush: GET api_units ────────────────────────────────────────────────────
async function fetchSemrushBalance(): Promise<{
  units_remaining: number | null
  error?: string
}> {
  const key = process.env.SEMRUSH_API_KEY ?? ''
  if (!key) return { units_remaining: null, error: 'API key not set in environment variables' }
  if (key === 'placeholder' || key.length < 10) {
    return { units_remaining: null, error: 'SEMRUSH_API_KEY is a placeholder — add your real key in Vercel environment variables' }
  }

  try {
    const url = `https://api.semrush.com/?type=api_units&key=${encodeURIComponent(key)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { units_remaining: null, error: `HTTP ${res.status}${body ? `: ${body.slice(0, 100)}` : ''}` }
    }

    const text = (await res.text()).trim()
    const units = parseInt(text, 10)

    if (isNaN(units)) {
      // SEMrush returns error messages as plain text e.g. "ERROR 10 :: WRONG API KEY"
      return { units_remaining: null, error: text.slice(0, 120) }
    }

    return { units_remaining: units }
  } catch (err) {
    return { units_remaining: null, error: String(err) }
  }
}
