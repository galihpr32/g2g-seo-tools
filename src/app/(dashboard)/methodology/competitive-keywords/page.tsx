'use client'

import Link from 'next/link'

/**
 * /methodology/competitive-keywords
 *
 * Sprint METHODOLOGY — explainer page for the "Most Competitive Keyword"
 * score. Boss asked: "kenapa keyword ini disebut paling competitive?"
 * This page is the documented answer — formula, examples, edge cases.
 *
 * Score = weighted blend of three signals (each normalized 0-100):
 *   1. Search volume        — how big is the prize
 *   2. Keyword density      — how saturated is the SERP (proxy for difficulty)
 *   3. Intent alignment     — commercial / transactional > info > nav
 *
 * Default weights (tunable per workspace later):
 *   SV: 50%  ·  Density: 30%  ·  Intent: 20%
 */

export default function CompetitiveKeywordMethodologyPage() {
  return (
    <div className="p-6 md:p-10 max-w-4xl mx-auto">
      <Link href="/" className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 mb-3">
        ← Dashboard
      </Link>
      <h1 className="text-3xl font-bold text-white mb-2">Methodology — Most Competitive Keyword</h1>
      <p className="text-sm text-gray-400 mb-8 leading-relaxed">
        How the platform decides which keyword in a cluster is &quot;the one to fight for&quot;.
        Single formula, three inputs, transparent weighting. This is the answer to
        <em className="text-gray-300"> &quot;kenapa ini paling competitive?&quot;</em>
      </p>

      {/* TL;DR */}
      <section className="bg-emerald-900/15 border border-emerald-700/40 rounded-xl p-5 mb-6">
        <h2 className="text-sm font-bold uppercase tracking-wider text-emerald-300 mb-2">TL;DR</h2>
        <p className="text-gray-100 leading-relaxed">
          A keyword wins the &quot;most competitive&quot; label when it has the highest blended score of
          <strong className="text-white"> volume × difficulty × intent</strong>. Volume tells us the prize
          is worth chasing. Density tells us the SERP is contested (otherwise it&apos;s a free win, not competitive).
          Intent tells us a #1 here actually converts.
        </p>
      </section>

      {/* Formula */}
      <section className="mb-8">
        <h2 className="text-xl font-bold text-white mb-3">The Formula</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 font-mono text-sm text-gray-100 leading-relaxed">
          score = (SV<sub className="text-amber-400">norm</sub> × 0.50)
          {'  +  '}
          (Density<sub className="text-amber-400">norm</sub> × 0.30)
          {'  +  '}
          (Intent<sub className="text-amber-400">norm</sub> × 0.20)
        </div>
        <p className="text-xs text-gray-500 mt-2">
          All three inputs are normalized to 0-100 within the current cluster
          before weighting. Result is a 0-100 score; highest wins.
        </p>
      </section>

      {/* Inputs */}
      <section className="mb-8">
        <h2 className="text-xl font-bold text-white mb-3">The Three Inputs</h2>

        <Card
          title="1. Search Volume (SV)"
          weight="50%"
          color="#f59e0b"
        >
          <p className="mb-2">
            Monthly search volume from DataForSEO Keyword Data API (US + ID markets,
            depending on keyword language). Pulled once per month and cached.
          </p>
          <Bullet>
            <strong className="text-white">Why 50%:</strong> No traffic = no point. Volume is the prize
            ceiling; everything else just decides whether you can reach it.
          </Bullet>
          <Bullet>
            <strong className="text-white">Normalization:</strong> Within a cluster of N keywords, the
            highest SV becomes 100; the lowest becomes 0; everything else is linearly scaled.
          </Bullet>
          <Bullet>
            <strong className="text-white">Edge case:</strong> If SV is missing (new keyword, niche market),
            we fall back to <code className="text-amber-300">SV<sub>norm</sub> = 50</code> so it doesn&apos;t
            artificially zero out the score.
          </Bullet>
        </Card>

        <Card
          title="2. Keyword Density (Difficulty proxy)"
          weight="30%"
          color="#3b82f6"
        >
          <p className="mb-2">
            How many distinct competitor domains appear in the top 10 SERP. High density means
            the SERP is contested by many strong domains — i.e. genuinely competitive.
          </p>
          <Bullet>
            <strong className="text-white">Why 30%:</strong> Difficulty alone can lie (a one-domain
            monopoly is easy to challenge), but combined with volume it explains <em>why</em> a keyword
            isn&apos;t already won.
          </Bullet>
          <Bullet>
            <strong className="text-white">Computation:</strong> count unique 2nd-level domains in top 10
            from <code className="text-amber-300">tier_serp_snapshots.top_10</code>, divide by 10,
            multiply by 100.
          </Bullet>
          <Bullet>
            <strong className="text-white">Edge case:</strong> If no SERP snapshot exists yet for the keyword,
            density defaults to 50 (mid). The score is best-effort until DataForSEO catches up.
          </Bullet>
        </Card>

        <Card
          title="3. Intent Alignment"
          weight="20%"
          color="#10b981"
        >
          <p className="mb-2">
            Search intent classification (commercial / transactional / informational / navigational).
            We weight commercial+transactional highest because that&apos;s where G2G/OG monetize.
          </p>
          <Bullet>
            <strong className="text-white">Mapping:</strong>
            <code className="text-amber-300 ml-1">transactional → 100</code>,
            <code className="text-amber-300 ml-1">commercial → 80</code>,
            <code className="text-amber-300 ml-1">informational → 50</code>,
            <code className="text-amber-300 ml-1">navigational → 30</code>.
          </Bullet>
          <Bullet>
            <strong className="text-white">Why 20%:</strong> Intent matters but doesn&apos;t override
            volume. A high-volume informational keyword still earns its place because it builds topical
            authority that lifts transactional siblings.
          </Bullet>
          <Bullet>
            <strong className="text-white">Source:</strong> Haiku classification on the keyword + top-3
            SERP snippets, cached in <code className="text-amber-300">keyword_intent</code>.
          </Bullet>
        </Card>
      </section>

      {/* Worked example */}
      <section className="mb-8">
        <h2 className="text-xl font-bold text-white mb-3">Worked Example — Genshin Impact cluster</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/40 text-gray-400 text-[10px] uppercase tracking-wider">
              <tr>
                <th className="text-left  px-3 py-2">Keyword</th>
                <th className="text-right px-3 py-2">SV (mo)</th>
                <th className="text-right px-3 py-2">SV<sub>norm</sub></th>
                <th className="text-right px-3 py-2">Density</th>
                <th className="text-right px-3 py-2">Intent</th>
                <th className="text-right px-3 py-2 bg-amber-500/10">Score</th>
              </tr>
            </thead>
            <tbody className="text-gray-200">
              <Row label="genshin impact top up"            sv="40,500" svN="100" den="90" intent="100 (trans)" score="94" winner />
              <Row label="buy genshin impact genesis crystals" sv="9,900"  svN="62"  den="80" intent="100 (trans)" score="75" />
              <Row label="genshin impact account for sale"  sv="6,600"  svN="48"  den="70" intent="80 (com)"     score="61" />
              <Row label="genshin impact tier list"         sv="33,100" svN="86"  den="60" intent="50 (info)"    score="71" />
              <Row label="genshin impact wiki"              sv="22,200" svN="73"  den="30" intent="30 (nav)"     score="51" />
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500 mt-3 italic">
          🏆 <strong className="text-amber-300">&quot;genshin impact top up&quot;</strong> wins not because it has the
          highest volume alone (tier list is close), but because it pairs that volume with a saturated SERP
          (density 90) AND transactional intent (100). All three signals stack.
        </p>
      </section>

      {/* Edge cases */}
      <section className="mb-8">
        <h2 className="text-xl font-bold text-white mb-3">Edge Cases &amp; Footnotes</h2>
        <ul className="space-y-2 text-sm text-gray-300 leading-relaxed">
          <Bullet>
            <strong className="text-white">DMCA-restricted products</strong> (e.g. Genshin/Honkai post-HoYoverse
            takedowns) still score normally — the score reflects opportunity. Whether we can <em>execute</em> is
            a separate flag on the product (<code className="text-amber-300">restriction_type</code>).
          </Bullet>
          <Bullet>
            <strong className="text-white">Brand-new keywords</strong> with no SV yet get
            <code className="text-amber-300 mx-1">SV<sub>norm</sub> = 50</code> until DataForSEO returns a value.
            They&apos;re marked &quot;provisional&quot; in the UI.
          </Bullet>
          <Bullet>
            <strong className="text-white">ID vs EN markets</strong> are evaluated independently — the ID
            cluster has its own &quot;most competitive&quot; winner. Cross-market comparison is not meaningful
            because SERP density differs systematically.
          </Bullet>
          <Bullet>
            <strong className="text-white">Re-computation cadence:</strong> recomputed weekly after the SERP
            snapshot job (<code className="text-amber-300">/api/cron/tier-serp-weekly</code>). Intent is
            re-classified only when a keyword first enters a cluster or is manually flagged for re-eval.
          </Bullet>
        </ul>
      </section>

      {/* Why we picked this */}
      <section className="bg-gray-900/40 border border-gray-800 rounded-xl p-5">
        <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2">Why this formula, not Semrush KD?</h2>
        <p className="text-gray-300 text-sm leading-relaxed">
          Generic Keyword Difficulty scores treat &quot;competitive&quot; as a property of the keyword in isolation.
          We&apos;re a gaming/digital-goods marketplace — what&apos;s &quot;competitive&quot; for us depends on whether
          the keyword <em>monetizes</em>. By baking intent into the score (20% weight), we surface keywords that
          are both hard-to-win <em>and</em> worth winning. Semrush KD gets folded into the density input as a
          secondary signal where available, but it&apos;s not the primary lens.
        </p>
      </section>

      <p className="text-[11px] text-gray-600 mt-8 text-center">
        Last updated: Sprint METHODOLOGY · Galih&apos;s SEO Ops · Weights are tunable via env vars
        (<code>SCORE_WEIGHT_SV</code>, <code>SCORE_WEIGHT_DENSITY</code>, <code>SCORE_WEIGHT_INTENT</code>).
      </p>
    </div>
  )
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function Card({ title, weight, color, children }: {
  title:    string
  weight:   string
  color:    string
  children: React.ReactNode
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-3 relative overflow-hidden">
      <div className="absolute top-0 left-0 bottom-0 w-1" style={{ backgroundColor: color }} />
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-white font-semibold">{title}</h3>
        <span className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">
          Weight: <span style={{ color }}>{weight}</span>
        </span>
      </div>
      <div className="text-sm text-gray-300 leading-relaxed space-y-1">
        {children}
      </div>
    </div>
  )
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-gray-600 mt-0.5">▸</span>
      <div className="flex-1">{children}</div>
    </div>
  )
}

function Row({ label, sv, svN, den, intent, score, winner }: {
  label: string; sv: string; svN: string; den: string; intent: string; score: string; winner?: boolean
}) {
  return (
    <tr className={`border-t border-gray-800 ${winner ? 'bg-amber-500/5' : ''}`}>
      <td className="px-3 py-2">{winner && '🏆 '}{label}</td>
      <td className="px-3 py-2 text-right font-mono">{sv}</td>
      <td className="px-3 py-2 text-right font-mono">{svN}</td>
      <td className="px-3 py-2 text-right font-mono">{den}</td>
      <td className="px-3 py-2 text-right font-mono text-[11px]">{intent}</td>
      <td className={`px-3 py-2 text-right font-mono font-bold ${winner ? 'text-amber-300' : 'text-gray-300'} bg-amber-500/5`}>{score}</td>
    </tr>
  )
}
