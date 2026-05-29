import { NextResponse } from 'next/server'

export const maxDuration = 5

/**
 * POST /api/priority-products/run-baseline
 *
 * Sprint SERP.CHUNKED — legacy single-shot endpoint deprecated.
 * Use /run-baseline/start + /run-baseline/tick + /run-baseline/status instead.
 *
 * This shim returns 410 Gone so any stale frontend caller gets a clear
 * signal to migrate instead of silently hitting a no-op.
 */
export async function POST() {
  return NextResponse.json({
    ok:    false,
    error: 'Endpoint deprecated. Use POST /api/priority-products/run-baseline/start, then POST /tick repeatedly, then GET /status to poll progress.',
  }, { status: 410 })
}
