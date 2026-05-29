import { NextResponse } from 'next/server'
import { classifyAuditFinding, type AuditFinding } from '@/lib/site-audit-severity'

export const maxDuration = 10

/**
 * POST /api/semrush/site-audit/classify
 * Body: { findings: AuditFinding[] }
 *
 * Stateless — given a list of audit findings, returns the same list with
 * severity / reason / category fields appended. Used by the UI when it
 * wants to re-classify on-demand (e.g. after a new audit run) or by future
 * cron jobs that pre-compute severities at fetch time.
 *
 * Pure rules-based via classifyAuditFinding; no DB writes, no Anthropic.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { findings } = body

  if (!Array.isArray(findings)) {
    return NextResponse.json({ error: 'findings array required' }, { status: 400 })
  }

  const classified = (findings as AuditFinding[])
    .filter(f => f && typeof f.check_key === 'string' && typeof f.pages_count === 'number')
    .map(f => ({
      ...f,
      ...classifyAuditFinding(f),
    }))

  // Aggregate counts for the UI summary
  const counts = {
    critical:  classified.filter(c => c.severity === 'critical').length,
    important: classified.filter(c => c.severity === 'important').length,
    minor:     classified.filter(c => c.severity === 'minor').length,
  }

  return NextResponse.json({ ok: true, findings: classified, counts })
}
