/**
 * Pure-function smoke tests for the new agent helpers and parsers.
 *
 * Run from repo root:
 *   npx tsx scripts/test-agent-helpers.ts
 *
 * No DB / no network — exercises only the deterministic logic. If anything
 * here fails, your agents are about to misbehave on production data.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { normalizeUrl, slugify, buildCategoryUrl } from '../src/lib/agents/site-helpers'

// ── site-helpers: normalizeUrl ───────────────────────────────────────────────
test('normalizeUrl: strips protocol + www + trailing slash', () => {
  assert.equal(normalizeUrl('https://www.g2g.com/categories/wow-gold/'), 'g2g.com/categories/wow-gold')
  assert.equal(normalizeUrl('http://g2g.com/categories/wow-gold'), 'g2g.com/categories/wow-gold')
  assert.equal(normalizeUrl('//g2g.com/x/'), '//g2g.com/x')   // not http(s):// → leaves intact-ish
  assert.equal(normalizeUrl(''), '')
  assert.equal(normalizeUrl(null), '')
  assert.equal(normalizeUrl(undefined), '')
})

test('normalizeUrl: dedup absolute vs relative path', () => {
  // Same canonical key for both
  const a = normalizeUrl('/categories/wow-gold')
  const b = normalizeUrl('https://g2g.com/categories/wow-gold')
  // a is path-only, b is host+path — these should NOT be equal (different
  // pages on different hosts), so the function returns different keys.
  // The agents always pre-resolve to absolute before calling normalizeUrl,
  // so this asymmetry is intentional.
  assert.notEqual(a, b)
})

test('normalizeUrl: case-insensitive host, case-sensitive path', () => {
  assert.equal(normalizeUrl('https://G2G.COM/Categories/WoW-Gold'), 'g2g.com/Categories/WoW-Gold')
})

// ── site-helpers: slugify ────────────────────────────────────────────────────
test('slugify: handles punctuation, accents, multi-space', () => {
  assert.equal(slugify('World of Warcraft: Cataclysm'), 'world-of-warcraft-cataclysm')
  assert.equal(slugify('Pokémon Legends'),               'pokemon-legends')
  assert.equal(slugify('  trailing  spaces  '),          'trailing-spaces')
  assert.equal(slugify('CS:GO 2'),                        'cs-go-2')
})

// ── site-helpers: buildCategoryUrl ──────────────────────────────────────────
test('buildCategoryUrl: produces clean canonical URLs', () => {
  assert.equal(
    buildCategoryUrl('https://g2g.com', 'World of Warcraft'),
    'https://g2g.com/categories/world-of-warcraft'
  )
  // Strips trailing slash from siteUrl
  assert.equal(
    buildCategoryUrl('https://g2g.com/', 'WoW Gold'),
    'https://g2g.com/categories/wow-gold'
  )
})

// ── brief-generator: validateAndCoerce (extracted in spirit) ────────────────
// We re-implement the validator inline here so we can test it without
// importing the full module (which loads Anthropic SDK). The contract
// is: reject empty/short outlines so the retry loop kicks in.
function validateBrief(raw: Record<string, unknown>, keyword: string) {
  const arr = (v: unknown) => Array.isArray(v) ? v : []
  const str = (v: unknown) => typeof v === 'string' ? v : ''

  const outline = arr(raw.contentOutline).map(s => {
    const sec = s as Record<string, unknown>
    return {
      heading: str(sec.heading),
      points:  arr(sec.points).map(p => String(p)),
    }
  }).filter(s => s.heading)

  if (!outline.length || outline.length < 2) {
    throw new Error(`Brief outline too short (${outline.length} sections); retrying`)
  }

  const targetKws = arr(raw.targetKeywords).map(k => String(k)).slice(0, 8)
  if (!targetKws.includes(keyword)) targetKws.unshift(keyword)
  return { outline, targetKws }
}

test('brief-generator validator: rejects outline < 2 sections (triggers retry)', () => {
  assert.throws(() => validateBrief({ contentOutline: [] }, 'wow gold'), /too short/)
  assert.throws(() => validateBrief({ contentOutline: [{ heading: 'X', points: [] }] }, 'wow gold'), /too short/)
})

test('brief-generator validator: accepts 2+ sections, prepends keyword if missing', () => {
  const out = validateBrief({
    contentOutline: [
      { heading: 'A', points: ['p1'] },
      { heading: 'B', points: ['p2'] },
    ],
    targetKeywords: ['buy stuff', 'cheap stuff'],
  }, 'wow gold')
  assert.equal(out.outline.length, 2)
  assert.equal(out.targetKws[0], 'wow gold')   // keyword prepended
  assert.equal(out.targetKws.length, 3)
})

// ── Loki: branded-keyword detection ──────────────────────────────────────────
// Re-implement the new whole-word matcher to verify it doesn't overblock.
function isBranded(kw: string, brandTokens: string[]): boolean {
  const k = kw.toLowerCase()
  for (const t of brandTokens) {
    if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`).test(k)) return true
  }
  return false
}

test('loki branded blocklist: blocks whole-word brand match', () => {
  // Old logic (substring) would block "fivegames" everywhere.
  // New logic (whole-word) only blocks at word boundaries.
  const brandTokens = ['g2g', 'fivegames']
  assert.equal(isBranded('fivegames discount',      brandTokens), true)
  assert.equal(isBranded('cheap fivegames items',   brandTokens), true)
  assert.equal(isBranded('g2g coupon',              brandTokens), true)
  // Should NOT block: substrings inside other tokens
  assert.equal(isBranded('fivegames-style economy', brandTokens), true)   // hyphen IS a word boundary
  assert.equal(isBranded('the five games of 2024',  brandTokens), false)  // separate words, no exact match
  assert.equal(isBranded('steamhide',               ['steam']),    false)  // no boundary
  assert.equal(isBranded('steam library',           ['steam']),    true)   // boundary
})

// ── Heimdall: date-bucketing ────────────────────────────────────────────────
// Reproduce the date-split logic. The new code partitions by date, not row count.
function bucketByDate(
  rows: { snapshot_date: string; clicks_now: number; position: number; page: string }[],
  sevenDaysAgoIso: string
) {
  const prev = new Map<string, { clicks: number; positions: number[] }>()
  const now  = new Map<string, { clicks: number; positions: number[] }>()
  for (const r of rows) {
    const bucket = r.snapshot_date < sevenDaysAgoIso ? prev : now
    const w = bucket.get(r.page) ?? { clicks: 0, positions: [] }
    w.clicks += r.clicks_now
    if (r.position > 0) w.positions.push(r.position)
    bucket.set(r.page, w)
  }
  return { prev, now }
}

test('heimdall date-bucket: handles uneven snapshots correctly', () => {
  // Realistic case: 7 daily snapshots in old window, 5 in new window
  // (weekend gap). Old midpoint-by-row split would put 6/6, dragging
  // the boundary into mid-week and corrupting the "previous week" total.
  const rows = [
    // Previous window (8 days ago → 14 days ago): 7 snapshots
    { snapshot_date: '2026-04-12', clicks_now: 100, position: 5, page: '/x' },
    { snapshot_date: '2026-04-13', clicks_now: 110, position: 5, page: '/x' },
    { snapshot_date: '2026-04-14', clicks_now: 105, position: 5, page: '/x' },
    { snapshot_date: '2026-04-15', clicks_now:  95, position: 5, page: '/x' },
    { snapshot_date: '2026-04-16', clicks_now: 120, position: 5, page: '/x' },
    { snapshot_date: '2026-04-17', clicks_now:  80, position: 5, page: '/x' },
    { snapshot_date: '2026-04-18', clicks_now: 100, position: 5, page: '/x' },
    // New window (last 7d): only 5 snapshots (weekend gap)
    { snapshot_date: '2026-04-21', clicks_now:  20, position: 12, page: '/x' },
    { snapshot_date: '2026-04-22', clicks_now:  25, position: 12, page: '/x' },
    { snapshot_date: '2026-04-23', clicks_now:  18, position: 12, page: '/x' },
    { snapshot_date: '2026-04-24', clicks_now:  22, position: 12, page: '/x' },
    { snapshot_date: '2026-04-25', clicks_now:  15, position: 12, page: '/x' },
  ]
  const { prev, now } = bucketByDate(rows, '2026-04-19')

  const prevTotal = prev.get('/x')!.clicks
  const nowTotal  = now.get('/x')!.clicks
  assert.equal(prevTotal, 710)   // 100+110+105+95+120+80+100
  assert.equal(nowTotal,  100)    // 20+25+18+22+15

  // Drop is 610 / 710 = 85.9% — easily flagged as significant.
  // Old midpoint code (slice by row count) would have put 2 days from "old"
  // into the "new" bucket, badly understating the drop. Validate that.
  const drop = prevTotal - nowTotal
  const dropPct = (drop / prevTotal) * 100
  assert.ok(dropPct > 80, `expected drop% > 80, got ${dropPct.toFixed(1)}`)
})

test('heimdall date-bucket: ignores pages that only appear in one window', () => {
  const rows = [
    { snapshot_date: '2026-04-12', clicks_now: 100, position: 5, page: '/old-only' },
    { snapshot_date: '2026-04-22', clicks_now:  50, position: 5, page: '/new-only' },
  ]
  const { prev, now } = bucketByDate(rows, '2026-04-19')
  // Both pages bucketed correctly
  assert.ok(prev.has('/old-only'))
  assert.ok(now.has('/new-only'))
  // Neither has data in the other bucket → not "significant drop" candidates
  assert.ok(!prev.has('/new-only'))
  assert.ok(!now.has('/old-only'))
})
