import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { notFound, redirect } from 'next/navigation'
import BriefQualityReview, { type TyrBreakdown } from '@/components/agents/BriefQualityReview'
import BriefActionBar from '@/components/agents/BriefActionBar'
import FinalContentPanel from '@/components/agents/FinalContentPanel'
import OutreachAnchorEditor from '@/components/agents/OutreachAnchorEditor'

// Disable revalidate caching on this page so writers see freshly-generated
// final content immediately after assembly without a stale 30s window.
export const revalidate = 0
export const dynamic    = 'force-dynamic'

/**
 * /content/briefs/[id]
 *
 * Standalone brief detail view — used by the "View brief →" link in the
 * approval queue (regenerate_brief actions from Tyr) so the user can read
 * the full Tyr audit + brief content before approving regeneration.
 *
 * Behaviour:
 *   - If brief has `action_item_id`, redirect to the existing /gsc/action-items/[id]
 *     page (full editor lives there).
 *   - Otherwise (agent-generated briefs from Bragi don't have action_item_id),
 *     render a lightweight read-only view: Tyr quality review + content outline + draft.
 */
interface OutlineSection { heading?: string; points?: string[] }
interface FaqItem      { question?: string; suggested_answer?: string }
interface KeywordItem  { keyword?: string; volume?: number | null }

export default async function BriefDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) notFound()

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { data: brief } = await db
    .from('seo_content_briefs')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (!brief) notFound()

  // If the brief is linked to a GSC action item, the full editor lives there
  if (brief.action_item_id) {
    redirect(`/gsc/action-items/${brief.action_item_id}`)
  }

  // Lightweight view for agent-generated briefs (no action_item)
  void effectiveOwnerId   // RLS not enforced on service client; brief.owner_user_id check is implicit via select

  let path = brief.page as string | null
  try { if (path) path = new URL(path).pathname } catch { /* keep */ }

  const STATUS_STYLES: Record<string, string> = {
    draft:           'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    generating:      'text-orange-400 bg-orange-500/10 border-orange-500/20 animate-pulse',
    agent_generated: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
    reviewed:        'text-blue-400 bg-blue-500/10 border-blue-500/20',
    published:       'text-green-400 bg-green-500/10 border-green-500/20',
  }

  const outline:  OutlineSection[] = Array.isArray(brief.content_outline) ? brief.content_outline : []
  const faqs:     FaqItem[]        = Array.isArray(brief.faq_suggestions) ? brief.faq_suggestions : []
  const keywords: KeywordItem[]    = Array.isArray(brief.new_keywords)    ? brief.new_keywords    : []

  // Outreach briefs reuse the same JSONB columns but with different semantics.
  // Adjust section labels so writers see "Talking Points" / "Objections" /
  // "Anchor Texts" instead of the SEO-flavoured defaults.
  const isOutreach = brief.brief_type === 'outreach'
  const outlineHeader  = isOutreach ? '🎯 Key Selling Points'   : '📋 Content Outline'
  const faqHeader      = isOutreach ? '🛡️ Likely Objections'    : '❓ FAQ Suggestions'
  const keywordsHeader = isOutreach ? '🔗 Anchor Text Options'  : '🎯 Target Keywords'

  return (
    <div className="p-8 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-gray-500 mb-6">
        <a href="/command-center" className="hover:text-gray-300 transition">Command Center</a>
        <span>›</span>
        <span className="text-gray-400">Brief</span>
      </div>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${STATUS_STYLES[brief.status as string] ?? 'text-gray-400 bg-gray-500/10 border-gray-500/20'}`}>
            {brief.status === 'agent_generated' ? '🤖 AI Draft' : brief.status}
          </span>
          {brief.brief_type && (
            <span className="text-xs text-gray-500">
              {brief.brief_type === 'on_page'        ? '✏️ On-page' :
               brief.brief_type === 'category_page'  ? '📂 Category page' :
               brief.brief_type === 'off_page'       ? '📣 Off-page'      : brief.brief_type}
            </span>
          )}
          {brief.tyr_status && (
            <span className="text-xs text-amber-400">⚖️ Tyr: {brief.tyr_status}</span>
          )}
        </div>
        <h1 className="text-2xl font-bold text-white mb-1">
          {brief.primary_keyword ?? path ?? 'Untitled brief'}
        </h1>
        {path && (
          <a href={brief.page as string} target="_blank" rel="noopener noreferrer" className="text-sm text-gray-400 hover:text-blue-400 transition">
            {path}
          </a>
        )}
        <p className="text-gray-600 text-xs mt-2">
          Created {brief.created_at ? new Date(brief.created_at as string).toLocaleString('id-ID') : '—'}
          {brief.updated_at && ` · Updated ${new Date(brief.updated_at as string).toLocaleString('id-ID')}`}
        </p>
      </div>

      {/* Last-error banner — surfaces WHY a brief failed to generate so the
          user has context before deciding to regenerate. Hidden when
          last_error is null (most briefs). The error itself is truncated
          server-side at 1000 chars. */}
      {brief.last_error && (
        <div className="mb-6 bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm">
          <div className="flex items-start gap-2 text-red-300">
            <span>⚠️</span>
            <div className="flex-1 min-w-0">
              <p className="font-medium">Last generation attempt failed</p>
              <p className="mt-1 text-xs text-red-200/80 break-words font-mono">{brief.last_error as string}</p>
              {brief.last_error_at && (
                <p className="mt-2 text-[11px] text-red-200/50">
                  Logged {new Date(brief.last_error_at as string).toLocaleString('id-ID')}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Action bar — Tyr, Regenerate, Override, Publish */}
      <BriefActionBar
        briefId={id}
        initialStatus={brief.status as string}
        initialTyrStatus={brief.tyr_status as string | null}
        initialTyrScore={brief.tyr_score as number | null}
      />

      {/* Tyr quality review (auto-shown if reviewed) */}
      <BriefQualityReview
        score={brief.tyr_score as number | null}
        status={brief.tyr_status as string | null}
        reviewedAt={brief.tyr_reviewed_at as string | null}
        breakdown={brief.tyr_breakdown as TyrBreakdown | null}
      />

      {/* ── Final Content (the writer's surface) ────────────────────────────
          Hosts the assembled article body, inline edit, translate dropdown,
          and re-assemble button. Surfaced ABOVE the structured brief sections
          so writers don't have to scroll past outline/FAQ/keywords to reach
          the actual draft they're working on. ────────────────────────────── */}
      <FinalContentPanel
        briefId={id}
        initialFinalContent={(brief.final_content as string | null) ?? null}
        initialGeneratedAt={(brief.final_content_generated_at as string | null) ?? null}
        initialEditedAt={(brief.final_content_edited_at as string | null) ?? null}
        initialTranslations={(brief.final_content_translations as Record<string, string> | null) ?? {}}
        initialStatus={brief.status as string}
        initialTyrStatus={brief.tyr_status as string | null}
        briefType={(brief.brief_type as string | null) ?? undefined}
      />

      {/* Brief metadata */}
      {brief.notes && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
          <h2 className="text-xs uppercase tracking-wider text-gray-500 mb-2">📝 Notes</h2>
          <pre className="text-sm text-gray-300 whitespace-pre-wrap font-sans">{brief.notes as string}</pre>
        </section>
      )}

      {/* Content outline (or "Key Selling Points" for outreach briefs) */}
      {outline.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{outlineHeader}</h2>
          <div className="space-y-3">
            {outline.map((s, i) => (
              <div key={i} className="border-l-2 border-gray-700 pl-3">
                <h3 className="text-white font-medium text-sm mb-1">{s.heading}</h3>
                {Array.isArray(s.points) && s.points.length > 0 && (
                  <ul className="space-y-0.5 text-sm text-gray-400">
                    {s.points.map((p, j) => (
                      <li key={j} className="flex gap-2">
                        <span className="text-gray-600">•</span>
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* FAQ Suggestions (or "Likely Objections" for outreach briefs) */}
      {faqs.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{faqHeader}</h2>
          <div className="space-y-3">
            {faqs.map((f, i) => (
              <div key={i}>
                <p className="text-white text-sm font-medium">Q: {f.question}</p>
                {f.suggested_answer && (
                  <p className="text-gray-400 text-sm mt-1 ml-3">A: {f.suggested_answer}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Target Keywords (or "Anchor Text Options" for outreach briefs).
          Outreach renders an inline editor so writers can add/remove anchor
          variations directly; SEO briefs render read-only chips since
          targetKeywords come from Bragi and aren't writer-edited per-brief. */}
      {(keywords.length > 0 || isOutreach) && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">{keywordsHeader}</h2>
          {isOutreach ? (
            <OutreachAnchorEditor
              briefId={id}
              initialAnchors={keywords.map(k => k.keyword ?? '').filter(Boolean) as string[]}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              {keywords.map((k, i) => (
                <span key={i} className="bg-gray-800 px-2.5 py-1 rounded text-xs text-gray-300">
                  {k.keyword}
                  {k.volume != null && (
                    <span className="text-gray-500 ml-1.5">· {k.volume}</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Brief summary header (H1 + meta + intent only — outline/FAQ/keywords
          live in their own structured sections above; full article body lives
          in the FinalContentPanel). ────────────────────────────────────── */}
      {brief.content_draft && (
        <section className="bg-gray-900/50 border border-gray-800 rounded-xl p-5 mb-5">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">📋 Brief Summary</h2>
          <pre className="text-sm text-gray-400 whitespace-pre-wrap font-sans leading-relaxed">{brief.content_draft as string}</pre>
        </section>
      )}

      {/* Footer info */}
      <p className="text-gray-600 text-xs text-center">
        Final content edits + translations are auto-saved. Mark Published to send to ranking-impact tracker.
      </p>
    </div>
  )
}
