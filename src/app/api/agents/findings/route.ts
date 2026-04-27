import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * GET /api/agents/findings
 *
 * Reads from `agent_findings` — the unified discovery feed each agent
 * writes on every run (whether or not an approval action was queued).
 *
 * Query params:
 *   - agent       (string)  — filter by agent_key (e.g. 'loki')
 *   - type        (string)  — filter by finding_type (e.g. 'keyword_gap')
 *                            Multiple types comma-separated: 'keyword_gap,sov_snapshot'
 *   - subject     (string)  — substring match on subject (case-insensitive)
 *   - severity    (string)  — comma-separated: 'high,medium'
 *   - run_id      (uuid)    — only findings from a specific run
 *   - since       (ISO-date)— only findings observed_at >= since
 *   - limit       (number)  — default 100, max 500
 *
 * Returns: { findings: AgentFinding[], total: number }
 *
 * Auth: requires logged-in user; results scoped to their effective owner.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const url     = new URL(req.url)

  const agent     = url.searchParams.get('agent')
  const typeParam = url.searchParams.get('type')
  const subject   = url.searchParams.get('subject')
  const sevParam  = url.searchParams.get('severity')
  const runId     = url.searchParams.get('run_id')
  const since     = url.searchParams.get('since')
  const limitRaw  = url.searchParams.get('limit')
  const limit     = Math.min(500, Math.max(1, Number(limitRaw) || 100))

  const db = createServiceClient()
  let q = db
    .from('agent_findings')
    .select('id, agent_key, run_id, finding_type, subject, severity, data, observed_at', { count: 'exact' })
    .eq('owner_user_id', ownerId)
    .order('observed_at', { ascending: false })
    .limit(limit)

  if (agent)   q = q.eq('agent_key', agent)
  if (typeParam) {
    const types = typeParam.split(',').map(s => s.trim()).filter(Boolean)
    if (types.length === 1) q = q.eq('finding_type', types[0])
    else if (types.length > 1) q = q.in('finding_type', types)
  }
  if (subject) q = q.ilike('subject', `%${subject}%`)
  if (sevParam) {
    const sevs = sevParam.split(',').map(s => s.trim()).filter(Boolean)
    if (sevs.length === 1) q = q.eq('severity', sevs[0])
    else if (sevs.length > 1) q = q.in('severity', sevs)
  }
  if (runId) q = q.eq('run_id', runId)
  if (since) q = q.gte('observed_at', since)

  const { data, error, count } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ findings: data ?? [], total: count ?? 0 })
}
