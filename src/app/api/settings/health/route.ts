import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const maxDuration = 30

type ServiceResult = {
  ok: boolean
  label: string
  detail?: string
  balance?: string
  latency_ms?: number
}

async function checkWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs = 8000
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    ),
  ])
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const results: Record<string, ServiceResult> = {}

  // ── DataForSEO ─────────────────────────────────────────────────────────────
  const dfsLogin    = process.env.DATAFORSEO_LOGIN
  const dfsPassword = process.env.DATAFORSEO_PASSWORD
  if (!dfsLogin || !dfsPassword) {
    results.dataforseo = { ok: false, label: 'DataForSEO', detail: 'Credentials not set in env' }
  } else {
    const t0 = Date.now()
    try {
      const res = await checkWithTimeout(() =>
        fetch('https://api.dataforseo.com/v3/appendix/user_data', {
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${dfsLogin}:${dfsPassword}`).toString('base64'),
            'Content-Type': 'application/json',
          },
        })
      )
      const data = await res.json()
      if (res.ok && data.status_code === 20000) {
        const money = data.tasks?.[0]?.result?.[0]?.money ?? null
        results.dataforseo = {
          ok: true,
          label: 'DataForSEO',
          latency_ms: Date.now() - t0,
          balance: money !== null ? `$${Number(money).toFixed(2)} balance` : undefined,
        }
      } else {
        results.dataforseo = {
          ok: false,
          label: 'DataForSEO',
          latency_ms: Date.now() - t0,
          detail: data.status_message ?? `HTTP ${res.status}`,
        }
      }
    } catch (err) {
      results.dataforseo = { ok: false, label: 'DataForSEO', detail: String(err) }
    }
  }

  // ── Firecrawl ──────────────────────────────────────────────────────────────
  const fcKey = process.env.FIRECRAWL_API_KEY
  if (!fcKey) {
    results.firecrawl = { ok: false, label: 'Firecrawl', detail: 'API key not set in env' }
  } else {
    const t0 = Date.now()
    try {
      const res = await checkWithTimeout(() =>
        fetch('https://api.firecrawl.dev/v1/team/credits', {
          headers: { Authorization: `Bearer ${fcKey}` },
        })
      )
      if (res.ok) {
        const data = await res.json()
        results.firecrawl = {
          ok: true,
          label: 'Firecrawl',
          latency_ms: Date.now() - t0,
          balance: data.remaining_credits !== undefined
            ? `${data.remaining_credits.toLocaleString()} credits remaining`
            : undefined,
        }
      } else {
        results.firecrawl = {
          ok: false,
          label: 'Firecrawl',
          latency_ms: Date.now() - t0,
          detail: `HTTP ${res.status}`,
        }
      }
    } catch (err) {
      results.firecrawl = { ok: false, label: 'Firecrawl', detail: String(err) }
    }
  }

  // ── Anthropic ──────────────────────────────────────────────────────────────
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    results.anthropic = { ok: false, label: 'Anthropic', detail: 'API key not set in env' }
  } else {
    const t0 = Date.now()
    try {
      // Send smallest possible request to validate key
      const res = await checkWithTimeout(() =>
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          }),
        })
      )
      if (res.ok || res.status === 400) {
        // 400 = bad request but key is valid; 200 = all good
        results.anthropic = {
          ok: res.ok,
          label: 'Anthropic',
          latency_ms: Date.now() - t0,
          detail: res.ok ? undefined : 'Key valid but request returned 400',
        }
      } else if (res.status === 401) {
        results.anthropic = { ok: false, label: 'Anthropic', latency_ms: Date.now() - t0, detail: 'Invalid API key' }
      } else {
        results.anthropic = { ok: false, label: 'Anthropic', latency_ms: Date.now() - t0, detail: `HTTP ${res.status}` }
      }
    } catch (err) {
      results.anthropic = { ok: false, label: 'Anthropic', detail: String(err) }
    }
  }

  // ── SEMrush ────────────────────────────────────────────────────────────────
  const semrushKey = process.env.SEMRUSH_API_KEY
  if (!semrushKey) {
    results.semrush = { ok: false, label: 'SEMrush', detail: 'API key not set in env' }
  } else {
    const t0 = Date.now()
    try {
      const res = await checkWithTimeout(() =>
        fetch(`https://api.semrush.com/analytics/v1/?type=account_info&key=${semrushKey}`)
      )
      const text = await res.text()
      if (res.ok && !text.startsWith('ERROR')) {
        // SEMrush returns CSV-style account info; extract units balance
        const lines = text.trim().split('\n')
        const header = lines[0]?.split(';') ?? []
        const values = lines[1]?.split(';') ?? []
        const unitsIdx = header.indexOf('account_limits')
        const balance = unitsIdx >= 0 ? values[unitsIdx] : undefined
        results.semrush = {
          ok: true,
          label: 'SEMrush',
          latency_ms: Date.now() - t0,
          balance: balance ? `${Number(balance).toLocaleString()} units` : undefined,
        }
      } else {
        results.semrush = {
          ok: false,
          label: 'SEMrush',
          latency_ms: Date.now() - t0,
          detail: text.startsWith('ERROR') ? text.slice(0, 80) : `HTTP ${res.status}`,
        }
      }
    } catch (err) {
      results.semrush = { ok: false, label: 'SEMrush', detail: String(err) }
    }
  }

  // ── Slack ──────────────────────────────────────────────────────────────────
  const slackUrl = process.env.SLACK_WEBHOOK_URL
  results.slack = slackUrl
    ? { ok: true,  label: 'Slack', detail: 'Webhook URL configured' }
    : { ok: false, label: 'Slack', detail: 'Webhook URL not set in env' }

  // ── GSC (OAuth token check via DB) ─────────────────────────────────────────
  const { data: gscConn } = await supabase
    .from('gsc_connections')
    .select('site_url, access_token, expires_at')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!gscConn) {
    results.gsc = { ok: false, label: 'Google Search Console', detail: 'Not connected — OAuth required' }
  } else {
    const expired = gscConn.expires_at && new Date(gscConn.expires_at) < new Date()
    results.gsc = {
      ok: !expired,
      label: 'Google Search Console',
      detail: expired ? 'OAuth token expired — reconnect' : `Active property: ${gscConn.site_url}`,
    }
  }

  return NextResponse.json({ results, checked_at: new Date().toISOString() })
}
