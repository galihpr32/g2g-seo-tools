'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

// ─── Persistence keys ───────────────────────────────────────────────────────
const COMPLETED_KEY = 'onboarding-completed'
const ROLE_KEY      = 'onboarding-role'

// ─── Types ──────────────────────────────────────────────────────────────────
type Role = 'seo_manager' | 'writer' | 'executive'

interface ConnectionStatus {
  gsc: 'connected' | 'expired' | 'missing'
  ga4: 'connected' | 'missing'
}

// ─── Steps config ───────────────────────────────────────────────────────────
const TOTAL_STEPS = 6

// ─── Role cards ─────────────────────────────────────────────────────────────
const ROLES: { id: Role; label: string; icon: string; description: string }[] = [
  {
    id:          'seo_manager',
    label:       'SEO Manager',
    icon:        '🎯',
    description: 'Monitor rankings, run agents, review briefs, and manage the full pipeline.',
  },
  {
    id:          'writer',
    label:       'Content Writer',
    icon:        '✍️',
    description: 'Access your brief inbox, manage the editorial calendar, and publish content.',
  },
  {
    id:          'executive',
    label:       'Executive',
    icon:        '📊',
    description: 'Track performance at a glance — reports, ranking impact, and ROI.',
  },
]

// ─── Agent category data (mirrors AgentStatusPanel categories) ───────────────
const AGENT_CATEGORIES = [
  {
    label:       'Detection',
    step:        'Step 1',
    color:       'text-blue-400 border-blue-800/40 bg-blue-950/20',
    dot:         'bg-blue-400',
    cooldown:    '3h cooldown',
    description: 'Monitor, discover, and surface signals from GSC, competitors, and trending games.',
    connector:   null,
    agents: [
      { key: 'heimdall', name: 'Heimdall', desc: 'Ranking drops & click anomalies' },
      { key: 'odin',     name: 'Odin',     desc: 'Trending games & content gaps' },
      { key: 'loki',     name: 'Loki',     desc: 'Competitor keyword gaps & SOV' },
    ],
  },
  {
    label:       'Aggregation',
    step:        'Step 2',
    color:       'text-cyan-400 border-cyan-800/40 bg-cyan-950/20',
    dot:         'bg-cyan-400',
    cooldown:    'auto after detection',
    description: 'Groups signals by topic into Opportunities — your unified triage queue.',
    connector:   'signals grouped →',
    agents: [
      { key: 'saga', name: 'Saga', desc: 'Clusters signals into ranked Opportunities' },
    ],
  },
  {
    label:       'Execution',
    step:        'Step 3',
    color:       'text-green-400 border-green-800/40 bg-green-950/20',
    dot:         'bg-green-400',
    cooldown:    '1h cooldown',
    description: 'Act on approved Opportunities — draft briefs, find prospects, curate keyword maps.',
    connector:   'opportunity approved →',
    agents: [
      { key: 'bragi',  name: 'Bragi',  desc: 'Generates SEO content briefs from Opportunities' },
      { key: 'hermod', name: 'Hermod', desc: 'Finds outreach prospects & drafts emails' },
    ],
  },
  {
    label:       'Quality & Audit',
    step:        'Step 4',
    color:       'text-purple-400 border-purple-800/40 bg-purple-950/20',
    dot:         'bg-purple-400',
    cooldown:    '30min cooldown',
    description: 'Reviews briefs for quality; records daily pipeline stats.',
    connector:   'brief generated →',
    agents: [
      { key: 'tyr', name: 'Tyr', desc: 'Scores brief quality — passes, flags, or fails' },
      { key: 'vor', name: 'Vor', desc: 'Records daily stats & tunes agent thresholds' },
    ],
  },
]

// Role-specific quick links for the final step
const ROLE_LINKS: Record<Role, { label: string; href: string; icon: string }[]> = {
  seo_manager: [
    { label: 'Opportunities',  href: '/command-center/opportunities', icon: '🎯' },
    { label: 'Command Center', href: '/command-center',               icon: '🤖' },
    { label: 'Brief Library',  href: '/content/briefs',               icon: '📚' },
    { label: 'Weekly Pulse',   href: '/reports/weekly',               icon: '📊' },
  ],
  writer: [
    { label: 'Writer Inbox',       href: '/content/writer-inbox', icon: '✍️' },
    { label: 'Editorial Calendar', href: '/content/calendar',     icon: '📅' },
    { label: 'Content Studio',     href: '/content/studio',       icon: '📝' },
    { label: 'Brief Library',      href: '/content/briefs',       icon: '📚' },
  ],
  executive: [
    { label: 'Dashboard',       href: '/dashboard',               icon: '▦'  },
    { label: 'Weekly Pulse',    href: '/reports/weekly',          icon: '📊' },
    { label: 'Ranking Impact',  href: '/reports/ranking-impact',  icon: '📈' },
    { label: 'Content ROI',     href: '/reports/content-roi',     icon: '💰' },
  ],
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function OnboardingWizard() {
  const [open,       setOpen]       = useState(false)
  const [step,       setStep]       = useState(1)
  const [role,       setRole]       = useState<Role | null>(null)
  const [connStatus, setConnStatus] = useState<ConnectionStatus | null>(null)
  const [loadingConn, setLoadingConn] = useState(false)

  // Only show if not completed yet
  useEffect(() => {
    const done = localStorage.getItem(COMPLETED_KEY)
    if (!done) setOpen(true)
    const savedRole = localStorage.getItem(ROLE_KEY) as Role | null
    if (savedRole) setRole(savedRole)
  }, [])

  // Fetch connection status when on step 2
  useEffect(() => {
    if (step !== 2 || connStatus) return
    setLoadingConn(true)
    fetch('/api/system/health')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        const conn = data.connections ?? {}
        setConnStatus({
          gsc: conn.gsc_token_expired ? 'expired' : conn.gsc_connected ? 'connected' : 'missing',
          ga4: conn.ga4_connected ? 'connected' : 'missing',
        })
      })
      .catch(() => { /* silent */ })
      .finally(() => setLoadingConn(false))
  }, [step, connStatus])

  function selectRole(r: Role) {
    setRole(r)
    localStorage.setItem(ROLE_KEY, r)
  }

  function next() {
    if (step < TOTAL_STEPS) setStep(s => s + 1)
    else complete()
  }

  function back() {
    if (step > 1) setStep(s => s - 1)
  }

  function complete() {
    localStorage.setItem(COMPLETED_KEY, 'true')
    setOpen(false)
  }

  function skip() {
    complete()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={skip}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-2xl bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-800 flex-shrink-0">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-500 mb-0.5">
              Step {step} of {TOTAL_STEPS}
            </p>
            <h2 className="text-white font-semibold text-lg leading-tight">
              {stepTitle(step)}
            </h2>
          </div>
          <button
            onClick={skip}
            className="text-gray-500 hover:text-gray-300 transition text-sm"
            title="Skip setup"
          >
            Skip
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-0.5 bg-gray-800 flex-shrink-0">
          <div
            className="h-full bg-red-600 transition-all duration-300"
            style={{ width: `${(step / TOTAL_STEPS) * 100}%` }}
          />
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 1 && <Step1 role={role} onSelectRole={selectRole} />}
          {step === 2 && <Step2 status={connStatus} loading={loadingConn} />}
          {step === 3 && <Step3 />}
          {step === 4 && <Step4 />}
          {step === 5 && <Step5 role={role} />}
          {step === 6 && <Step6 role={role} onDone={complete} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-800 flex-shrink-0">
          <button
            onClick={back}
            disabled={step === 1}
            className="text-sm text-gray-400 hover:text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ← Back
          </button>

          {step < TOTAL_STEPS ? (
            <button
              onClick={next}
              disabled={step === 1 && !role}
              className="px-5 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition"
            >
              {step === 1 ? 'Continue →' : 'Next →'}
            </button>
          ) : null /* Step 6 has its own CTA */}
        </div>
      </div>
    </div>
  )
}

// ─── Step title helper ────────────────────────────────────────────────────────
function stepTitle(step: number) {
  switch (step) {
    case 1: return 'Welcome — who are you?'
    case 2: return 'Connect your data'
    case 3: return 'Meet your AI agents'
    case 4: return 'The Approval Queue'
    case 5: return 'The content pipeline'
    case 6: return "You're all set 🎉"
    default: return ''
  }
}

// ─── Step 1: Role picker ──────────────────────────────────────────────────────
function Step1({ role, onSelectRole }: { role: Role | null; onSelectRole: (r: Role) => void }) {
  return (
    <div className="space-y-4">
      <p className="text-gray-400 text-sm leading-relaxed">
        G2G SEO Tools is built around your workflow. Tell us your primary role so we can
        highlight the most relevant features throughout this tour.
      </p>
      <div className="grid grid-cols-1 gap-3 mt-2">
        {ROLES.map(r => (
          <button
            key={r.id}
            onClick={() => onSelectRole(r.id)}
            className={`flex items-start gap-4 px-4 py-4 rounded-xl border text-left transition ${
              role === r.id
                ? 'border-red-600 bg-red-950/30 ring-1 ring-red-600/50'
                : 'border-gray-700 bg-gray-800/40 hover:border-gray-600 hover:bg-gray-800/70'
            }`}
          >
            <span className="text-2xl mt-0.5 flex-shrink-0">{r.icon}</span>
            <div>
              <p className={`text-sm font-semibold leading-tight ${role === r.id ? 'text-white' : 'text-gray-200'}`}>
                {r.label}
              </p>
              <p className="text-gray-400 text-xs mt-1 leading-relaxed">{r.description}</p>
            </div>
            {role === r.id && (
              <svg className="w-4 h-4 text-red-400 ml-auto flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Step 2: Data connections ─────────────────────────────────────────────────
function ConnectionBadge({ status }: { status?: 'connected' | 'expired' | 'missing' }) {
  if (status === 'connected') {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-green-400">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
        Connected
      </span>
    )
  }
  if (status === 'expired') {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
        Token expired
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
      <span className="w-1.5 h-1.5 rounded-full bg-gray-600 flex-shrink-0" />
      Not connected
    </span>
  )
}

function Step2({ status, loading }: { status: ConnectionStatus | null; loading: boolean }) {
  const allConnected = status?.gsc === 'connected' && status?.ga4 === 'connected'

  // If everything is connected — show a clean "all good" state
  if (!loading && allConnected) {
    return (
      <div className="space-y-5">
        <div className="flex flex-col items-center justify-center py-6 text-center gap-3">
          <div className="w-14 h-14 rounded-full bg-green-900/30 border border-green-700/40 flex items-center justify-center">
            <svg className="w-7 h-7 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className="text-white font-semibold">Both data sources are connected</p>
            <p className="text-gray-400 text-sm mt-1">
              Google Search Console and GA4 are live. Tokens are refreshed automatically — nothing to do here.
            </p>
          </div>
        </div>
        <div className="space-y-2">
          {[
            { icon: '🔍', label: 'Google Search Console', desc: 'Rankings, clicks, impressions, index coverage' },
            { icon: '📈', label: 'Google Analytics 4',     desc: 'Organic traffic, sessions, content performance' },
          ].map(item => (
            <div key={item.label} className="flex items-center gap-3 px-4 py-3 bg-green-950/20 border border-green-800/30 rounded-xl">
              <span className="text-xl">{item.icon}</span>
              <div>
                <p className="text-sm font-medium text-gray-200">{item.label}</p>
                <p className="text-xs text-gray-500">{item.desc}</p>
              </div>
              <span className="ml-auto flex items-center gap-1.5 text-xs font-medium text-green-400 flex-shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                Connected
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-600 text-center">
          Reconnect anytime from <Link href="/settings" className="text-gray-500 hover:text-gray-300 underline underline-offset-2">Settings</Link>.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <p className="text-gray-400 text-sm leading-relaxed">
        Most features pull live data from Google Search Console and Google Analytics 4.
        Connect both once — the system keeps tokens refreshed automatically.
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          Checking connection status…
        </div>
      )}

      {!loading && (
        <div className="space-y-3">
          {/* GSC */}
          <div className="flex items-center justify-between p-4 bg-gray-800/40 border border-gray-700 rounded-xl">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center flex-shrink-0">
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="#4285F4"/>
                  <path d="M12 6l-4 8h2.5l.5-1h2l.5 1H16L12 6zm0 3.5l.75 1.5h-1.5L12 9.5z" fill="white"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-200">Google Search Console</p>
                <p className="text-xs text-gray-500 mt-0.5">Rankings, clicks, impressions, index coverage</p>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <ConnectionBadge status={status?.gsc} />
              {status?.gsc !== 'connected' && (
                <a
                  href="/api/auth/google"
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition"
                >
                  Connect
                </a>
              )}
            </div>
          </div>

          {/* GA4 */}
          <div className="flex items-center justify-between p-4 bg-gray-800/40 border border-gray-700 rounded-xl">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-orange-500 rounded-lg flex items-center justify-center flex-shrink-0">
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="white">
                  <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-200">Google Analytics 4</p>
                <p className="text-xs text-gray-500 mt-0.5">Organic traffic, sessions, content performance</p>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <ConnectionBadge status={status?.ga4} />
              {status?.ga4 !== 'connected' && (
                <Link
                  href="/settings"
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition"
                >
                  Configure
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="p-3 bg-gray-800/30 border border-gray-700/50 rounded-lg">
        <p className="text-xs text-gray-500 leading-relaxed">
          <span className="text-gray-400 font-medium">Tip:</span> You can connect or reconnect at any time from{' '}
          <Link href="/settings" className="text-blue-400 hover:underline">Settings</Link>.
          Tokens are refreshed daily by the background sync — you won't need to reconnect again.
        </p>
      </div>
    </div>
  )
}

// ─── Step 3: Agents ───────────────────────────────────────────────────────────
// Pipeline connector between category groups
function PipelineArrow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1 pl-2">
      <div className="flex flex-col items-center gap-0.5">
        <div className="w-0.5 h-2 bg-gray-700" />
        <svg className="w-3 h-3 text-gray-600" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 3a1 1 0 01.707.293l7 7a1 1 0 010 1.414l-7 7a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293A1 1 0 0110 3z" clipRule="evenodd" />
        </svg>
        <div className="w-0.5 h-2 bg-gray-700" />
      </div>
      <span className="text-[10px] text-gray-600 font-medium uppercase tracking-wider">{label}</span>
    </div>
  )
}

function Step3() {
  return (
    <div className="space-y-4">
      <p className="text-gray-400 text-sm leading-relaxed">
        Eight agents run in four ordered stages. Detection runs first and feeds the Opportunities triage queue — nothing jumps ahead.
      </p>

      <div>
        {AGENT_CATEGORIES.map((cat, i) => (
          <div key={cat.label}>
            {/* Inter-stage connector */}
            {cat.connector && <PipelineArrow label={cat.connector} />}

            {/* Category header */}
            <div className={`flex items-center justify-between px-3 py-2 rounded-lg border mb-2 ${cat.color}`}>
              <div>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold uppercase tracking-widest ${cat.color.split(' ')[0]}`}>
                    {cat.step}
                  </span>
                  <span className="text-gray-600 text-[10px]">·</span>
                  <span className={`text-[11px] font-bold uppercase tracking-widest ${cat.color.split(' ')[0]}`}>
                    {cat.label}
                  </span>
                </div>
                <p className="text-gray-400 text-xs mt-0.5">{cat.description}</p>
              </div>
              <span className="text-[11px] text-gray-500 font-medium flex-shrink-0 ml-3">{cat.cooldown}</span>
            </div>

            {/* Agent pills */}
            <div className="flex flex-wrap gap-2 pl-1 mb-1">
              {cat.agents.map(agent => (
                <div key={agent.key} className="flex items-start gap-2 px-3 py-2 bg-gray-800/40 border border-gray-700 rounded-lg flex-1 min-w-[140px]">
                  <span className={`w-1.5 h-1.5 rounded-full ${cat.dot} mt-1.5 flex-shrink-0`} />
                  <div>
                    <p className="text-xs font-semibold text-gray-200">{agent.name}</p>
                    <p className="text-[11px] text-gray-500 leading-relaxed mt-0.5">{agent.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Small spacer between categories (not after last) */}
            {i < AGENT_CATEGORIES.length - 1 && !AGENT_CATEGORIES[i + 1].connector && (
              <div className="h-1" />
            )}
          </div>
        ))}
      </div>

      <div className="p-3 bg-gray-800/30 border border-gray-700/50 rounded-lg">
        <p className="text-xs text-gray-500 leading-relaxed">
          <span className="text-gray-400 font-medium">Command Center →</span> Run individual agents or click <em>Run Detection</em> to trigger the whole first stage.
          After detection completes, Saga auto-aggregates signals into your <span className="text-gray-400 font-medium">Opportunities</span> queue.
        </p>
      </div>
    </div>
  )
}

// ─── Step 4: Approval Queue ───────────────────────────────────────────────────
function Step4() {
  const FLOW = [
    { icon: '🎯', label: 'Opportunities surface', desc: 'Saga groups Heimdall + Loki + Odin signals by topic into a ranked triage queue.' },
    { icon: '👀', label: 'You triage', desc: 'Review each opportunity. One click to Queue Brief — Bragi generates it in the background.' },
    { icon: '⚖️', label: 'Tyr scores the brief', desc: 'Tyr reviews Bragi\'s output. Scores ≥ 80 auto-promote; lower scores flag for your review.' },
    { icon: '✍️', label: 'Writer picks it up', desc: 'Approved briefs land in Writer Inbox. Writers draft and mark done.' },
    { icon: '🚀', label: 'Published & tracked', desc: 'Mark Published → Ranking Impact starts capturing GSC before/after data.' },
  ]

  return (
    <div className="space-y-5">
      <p className="text-gray-400 text-sm leading-relaxed">
        The pipeline is human-in-the-loop at two points: Opportunity triage and Brief quality review.
        Everything else runs automatically.
      </p>

      {/* Flow diagram */}
      <div className="flex flex-col gap-0">
        {FLOW.map((item, i) => (
          <div key={item.label} className="flex items-start gap-3">
            <div className="flex flex-col items-center flex-shrink-0">
              <div className="w-9 h-9 rounded-xl bg-gray-800 border border-gray-700 flex items-center justify-center text-lg">
                {item.icon}
              </div>
              {i < FLOW.length - 1 && (
                <div className="w-0.5 h-4 bg-gray-700 my-1" />
              )}
            </div>
            <div className="pt-1.5 pb-4">
              <p className="text-sm font-medium text-gray-200">{item.label}</p>
              <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 bg-green-950/20 border border-green-800/30 rounded-lg">
          <p className="text-[11px] font-bold uppercase tracking-wider text-green-400 mb-1">Auto-promoted</p>
          <p className="text-xs text-gray-400 leading-relaxed">Briefs scoring ≥ 80 skip the queue and go straight to Writer Inbox.</p>
        </div>
        <div className="p-3 bg-amber-950/20 border border-amber-800/30 rounded-lg">
          <p className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mb-1">Needs review</p>
          <p className="text-xs text-gray-400 leading-relaxed">Borderline briefs surface in the Brief Library with Tyr's feedback. Regenerate with one click.</p>
        </div>
      </div>
    </div>
  )
}

// ─── Step 5: Content Pipeline ─────────────────────────────────────────────────
function Step5({ role }: { role: Role | null }) {
  const PIPELINE = [
    {
      step:  '1',
      icon:  '🎯',
      label: 'Opportunities',
      href:  '/command-center/opportunities',
      desc:  'Detection agents surface signals; Saga groups them by topic. Triage here and queue briefs in one click.',
      highlight: role === 'seo_manager',
    },
    {
      step:  '2',
      icon:  '📚',
      label: 'Brief Library',
      href:  '/content/briefs',
      desc:  'Bragi generates keyword-targeted briefs. Tyr scores each one. Review, regenerate, or override directly on the brief page.',
      highlight: role === 'writer' || role === 'seo_manager',
    },
    {
      step:  '3',
      icon:  '✍️',
      label: 'Writer Inbox',
      href:  '/content/writer-inbox',
      desc:  'Approved briefs land here. Writers pick them up, draft, and mark done.',
      highlight: role === 'writer',
    },
    {
      step:  '4',
      icon:  '📅',
      label: 'Editorial Calendar',
      href:  '/content/calendar',
      desc:  'Timeline view of all in-flight and published content, auto-populated from briefs.',
      highlight: role === 'seo_manager' || role === 'writer',
    },
    {
      step:  '5',
      icon:  '📈',
      label: 'Ranking Impact',
      href:  '/reports/ranking-impact',
      desc:  'Published briefs are tracked automatically. See before/after ranking changes for every piece of content.',
      highlight: role === 'seo_manager' || role === 'executive',
    },
  ]

  return (
    <div className="space-y-4">
      <p className="text-gray-400 text-sm leading-relaxed">
        Content moves through a five-stage pipeline — from detected opportunity to measurable
        ranking improvement. Each stage is tracked automatically.
      </p>

      <div className="space-y-2">
        {PIPELINE.map((item, i) => (
          <div key={item.label} className="flex items-start gap-3">
            {/* Step indicator + connector */}
            <div className="flex flex-col items-center flex-shrink-0">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                item.highlight
                  ? 'bg-red-700 text-white'
                  : 'bg-gray-800 text-gray-500 border border-gray-700'
              }`}>
                {item.step}
              </div>
              {i < PIPELINE.length - 1 && (
                <div className="w-0.5 h-3 bg-gray-700 my-1" />
              )}
            </div>

            {/* Card */}
            <Link
              href={item.href}
              className={`flex-1 flex items-start gap-3 px-3 py-2.5 rounded-lg border transition mb-2 ${
                item.highlight
                  ? 'border-red-800/40 bg-red-950/10 hover:bg-red-950/20'
                  : 'border-gray-700/50 bg-gray-800/20 hover:bg-gray-800/40'
              }`}
            >
              <span className="text-xl leading-none mt-0.5">{item.icon}</span>
              <div>
                <p className={`text-sm font-medium ${item.highlight ? 'text-gray-100' : 'text-gray-300'}`}>
                  {item.label}
                  {item.highlight && (
                    <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-red-400">
                      your workflow
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{item.desc}</p>
              </div>
            </Link>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Step 6: Done ─────────────────────────────────────────────────────────────
function Step6({ role, onDone }: { role: Role | null; onDone: () => void }) {
  const links = ROLE_LINKS[role ?? 'seo_manager']

  return (
    <div className="space-y-5">
      <div className="text-center py-2">
        <div className="text-4xl mb-3">🎉</div>
        <p className="text-gray-300 text-sm leading-relaxed max-w-md mx-auto">
          Setup complete. Your agents are running, data is connected, and the pipeline is live.
          Here are the best places to start based on your role.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {links.map(link => (
          <Link
            key={link.href}
            href={link.href}
            onClick={onDone}
            className="flex items-center gap-2.5 px-4 py-3 bg-gray-800/50 border border-gray-700 hover:border-gray-600 hover:bg-gray-800 rounded-xl transition group"
          >
            <span className="text-xl leading-none">{link.icon}</span>
            <span className="text-sm text-gray-300 group-hover:text-white transition font-medium">{link.label}</span>
          </Link>
        ))}
      </div>

      <div className="p-3 bg-gray-800/30 border border-gray-700/50 rounded-lg">
        <p className="text-xs text-gray-500 leading-relaxed">
          <span className="text-gray-400 font-medium">Ask Mimir</span> — the AI assistant in
          the bottom-right corner — if you ever need help navigating a feature or understanding
          agent output.
        </p>
      </div>

      <button
        onClick={onDone}
        className="w-full py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-xl transition"
      >
        Open Dashboard →
      </button>
    </div>
  )
}
