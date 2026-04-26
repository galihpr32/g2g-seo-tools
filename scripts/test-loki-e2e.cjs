/**
 * End-to-end smoke test for runLoki (CJS variant).
 *
 * Why CJS? tsx defaults to CJS for .ts files when package.json lacks
 * "type": "module". That means agent imports go through Node's CJS
 * `require()` cache, which we CAN manipulate (unlike ESM read-only exports).
 *
 * Run from repo root:
 *   node scripts/test-loki-e2e.cjs
 *
 * What it verifies:
 *  1. Happy path: gap detected + branded blocklist + status='success'
 *  2. DataForSEO total failure → status='partial' (no more silent success)
 *  3. Per-competitor failure isolated → partial with competitor named
 *  4. No competitors → clean 'success'
 */

require('tsx/cjs')   // enable TypeScript loading via require()
const Module = require('module')
const path   = require('path')
const assert = require('node:assert').strict

process.env.NEXT_PUBLIC_SUPABASE_URL    = 'http://fake.local'
process.env.SUPABASE_SERVICE_ROLE_KEY   = 'fake-service-role-key'
process.env.NEXT_PUBLIC_APP_URL         = 'http://fake.local'
process.env.CRON_SECRET                 = 'fake-cron'
process.env.ANTHROPIC_API_KEY           = 'fake-anthropic'

// ── Build in-memory fake Supabase ───────────────────────────────────────────
const tables = {}
const tbl = (name) => tables[name] ?? (tables[name] = { rows: [] })

function applyFilters(rows, f) {
  return rows.filter(r => {
    for (const [k, v] of f.eqs)  if (r[k] !== v) return false
    for (const [k, v] of f.ins)  if (!v.includes(r[k])) return false
    for (const [k, v] of f.gtes) if (typeof r[k] === 'string' && r[k] < v) return false
    for (const [k, v] of f.lts)  if (typeof r[k] === 'string' && r[k] >= v) return false
    return true
  })
}

class FakeQuery {
  constructor(name) {
    this.tableName = name
    this.mode = 'select'
    this.filters = { eqs: [], ins: [], gtes: [], lts: [] }
    this.toInsert = null
    this.toUpdate = null
    this.resolveSingle = false
    this.resolveMaybeSingle = false
  }
  select() { this.mode = 'select'; return this }
  insert(row) { this.mode = 'insert'; this.toInsert = row; return this }
  update(row) { this.mode = 'update'; this.toUpdate = row; return this }
  eq(c, v) { this.filters.eqs.push([c, v]); return this }
  in(c, v) { this.filters.ins.push([c, v]); return this }
  gte(c, v) { this.filters.gtes.push([c, v]); return this }
  lt(c, v) { this.filters.lts.push([c, v]); return this }
  ilike() { return this }
  filter() { return this }
  order() { return this }
  limit() { return this }
  range() { return this }
  single() { this.resolveSingle = true; return this.exec() }
  maybeSingle() { this.resolveMaybeSingle = true; return this.exec() }
  then(onF, onR) { return this.exec().then(onF, onR) }
  exec() {
    const t = tbl(this.tableName)
    let data = null
    if (this.mode === 'select') {
      const m = applyFilters(t.rows, this.filters)
      data = (this.resolveSingle || this.resolveMaybeSingle) ? (m[0] ?? null) : m
    } else if (this.mode === 'insert' && this.toInsert) {
      const row = { ...this.toInsert, id: this.toInsert.id ?? `row-${t.rows.length + 1}` }
      t.rows.push(row); data = row
    } else if (this.mode === 'update' && this.toUpdate) {
      const m = applyFilters(t.rows, this.filters)
      for (const r of m) Object.assign(r, this.toUpdate); data = m
    }
    return Promise.resolve({ data, error: null })
  }
}

const fakeClient = { from: (t) => new FakeQuery(t), auth: { getUser: async () => ({ data: { user: null } }) } }

// ── Patch @supabase/supabase-js BEFORE loki module is loaded ────────────────
const supabasePath = require.resolve('@supabase/supabase-js')
const realSupabase = require(supabasePath)
require.cache[supabasePath].exports = {
  ...realSupabase,
  createClient: () => fakeClient,
}

// ── Patch dataforseo client similarly ───────────────────────────────────────
let dfsBehavior = 'happy'
const dfsCalls = []
const dfsPath = require.resolve(path.resolve(__dirname, '../src/lib/dataforseo/client.ts'))
require(dfsPath)   // force load so cache entry exists
require.cache[dfsPath].exports = {
  getDomainRankedKeywords: async (domain) => {
    dfsCalls.push({ domain })
    if (dfsBehavior === 'fail-all') throw new Error('DFS down: 503 from upstream')
    if (dfsBehavior === 'fail-competitor' && domain !== 'g2g.com') throw new Error('DFS quota exceeded')
    if (domain === 'g2g.com') {
      return [{ keyword: 'boring keyword', position: 8, url: 'https://g2g.com/x', volume: 500 }]
    }
    return [
      { keyword: 'wow gold cheap',   position: 3, url: 'https://comp.com/wow', volume: 8000 },
      { keyword: 'fivegames coupon', position: 5, url: 'https://comp.com/fg',  volume: 1500 },
    ]
  },
  // No-op exports for any other named imports
  getSerpData:              async () => null,
  getKeywordSuggestions:    async () => [],
  getKeywordDifficulty:     async () => null,
  getGoogleTrends:          async () => [],
  getCompetitorDomainsDFS:  async () => [],
  getDomainOverviewDFS:     async () => null,
  getBulkKeywordDifficulty: async () => [],
  startOnPageCrawl:         async () => null,
  getOnPageSummary:         async () => null,
  getOnPagePages:           async () => [],
  getOnPageLinks:           async () => [],
  pollOnPageTask:           async () => null,
  batchSerpData:            async () => [],
}

// ── Now load the agent (will use the patched modules) ───────────────────────
const lokiPath = path.resolve(__dirname, '../src/lib/agents/loki.ts')
const { runLoki } = require(lokiPath)

function resetState() {
  for (const k of Object.keys(tables)) tables[k].rows = []
  tbl('site_configs').rows.push({ slug: 'g2g', favicon_domain: 'g2g.com', gsc_property: 'https://www.g2g.com/', is_active: true })
  tbl('agent_runs').rows.push({ id: 'run-1', status: 'running' })
  tbl('agents').rows.push({ owner_user_id: 'u1', agent_key: 'loki' })
  dfsCalls.length = 0
}

async function scenario1Happy() {
  resetState()
  tbl('competitors').rows.push({ owner_user_id: 'u1', domain: 'fivegames.com', active: true })
  dfsBehavior = 'happy'
  const result = await runLoki('u1', 'g2g', 'run-1')

  assert.ok(result.actionsQueued >= 1, `expected ≥1 action, got ${result.actionsQueued}`)
  const queuedKws = tbl('agent_actions').rows.map(a => a.data?.keyword)
  assert.ok(!queuedKws.includes('fivegames coupon'), `branded leaked: ${queuedKws.join(', ')}`)
  assert.ok(queuedKws.includes('wow gold cheap'),    `gap missing: ${queuedKws.join(', ')}`)
  const run = tbl('agent_runs').rows.find(r => r.id === 'run-1')
  assert.equal(run?.status, 'success', `expected success, got ${run?.status}`)
  console.log('  ✓ scenario 1: happy path → success + branded filter + gap queued')
}

async function scenario2DfsDown() {
  resetState()
  tbl('competitors').rows.push({ owner_user_id: 'u1', domain: 'fivegames.com', active: true })
  dfsBehavior = 'fail-all'
  const result = await runLoki('u1', 'g2g', 'run-1')

  assert.equal(result.actionsQueued, 0)
  const run = tbl('agent_runs').rows.find(r => r.id === 'run-1')
  assert.equal(run?.status, 'partial', `expected partial when DFS down, got ${run?.status}`)
  assert.ok(run?.error_message?.toLowerCase().includes('dataforseo'),
    `error_message should mention DataForSEO, got: ${run?.error_message}`)
  assert.ok(run?.summary?.includes('⚠'), `summary should signal degradation: ${run?.summary}`)
  console.log('  ✓ scenario 2: DFS down → partial + error_message populated (no silent success)')
}

async function scenario3OneCompetitorFails() {
  resetState()
  tbl('competitors').rows.push({ owner_user_id: 'u1', domain: 'fivegames.com', active: true })
  dfsBehavior = 'fail-competitor'
  await runLoki('u1', 'g2g', 'run-1')
  const run = tbl('agent_runs').rows.find(r => r.id === 'run-1')
  assert.equal(run?.status, 'partial')
  assert.ok(run?.error_message?.includes('fivegames.com'),
    `expected comp.com in error_message: ${run?.error_message}`)
  console.log('  ✓ scenario 3: per-competitor failure isolated → partial with competitor named')
}

async function scenario4NoCompetitors() {
  resetState()
  await runLoki('u1', 'g2g', 'run-1')
  const run = tbl('agent_runs').rows.find(r => r.id === 'run-1')
  assert.equal(run?.status, 'success', `expected clean success, got ${run?.status}`)
  assert.ok(run?.summary?.includes('No active competitors'))
  console.log('  ✓ scenario 4: no competitors → clean success (not partial)')
}

;(async () => {
  console.log('Running Loki end-to-end smoke tests…\n')
  await scenario1Happy()
  await scenario2DfsDown()
  await scenario3OneCompetitorFails()
  await scenario4NoCompetitors()
  console.log('\nAll Loki end-to-end smoke tests passed.')
})().catch(err => {
  console.error('\nFAILED:', err)
  process.exit(1)
})
