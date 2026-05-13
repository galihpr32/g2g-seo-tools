// ─── Site Audit severity classifier ────────────────────────────────────────
//
// DataForSEO Site Audit returns a long list of issues. Asst Manager has to
// triage critical / important / nice-to-have. This module applies rule-based
// classification first; UI surfaces a Haiku second-opinion button for cases
// the rules can't decide.
//
// Pure rules — fast, no API calls. Used both client-side (classify on page
// render) and server-side (classify before storing).

export type AuditSeverity = 'critical' | 'important' | 'minor'

export interface AuditFinding {
  /** DFS check key like "no_h1_tag", "duplicate_title", etc. */
  check_key:     string
  /** How many pages affected */
  pages_count:   number
  /** Optional category from DFS (e.g. 'links', 'meta', 'security') */
  category?:     string
  /** Optional sample URL */
  example_url?:  string
}

export interface SeverityResult {
  severity:    AuditSeverity
  reason:      string
  /** Human-readable category for grouping in UI */
  category:    string
}

// ─── Severity rules ──────────────────────────────────────────────────────────
//
// CRITICAL — blocks indexing, breaks user trust, kills traffic
// IMPORTANT — affects ranking quality across many pages
// MINOR    — nice-to-have polish

const CRITICAL_KEYS = new Set([
  'is_4xx_code', 'is_5xx_code',
  'is_broken',
  'no_robots_txt',
  'is_redirect_loop',
  'high_loading_time',           // CWV blocker
  'is_https',                     // missing HTTPS
  'no_doctype',
  'duplicate_title',              // when affecting many pages
  'duplicate_description',
  'is_orphan_page',               // many-pages variant becomes critical
  'broken_links',
])

const IMPORTANT_KEYS = new Set([
  'no_title', 'no_description', 'no_h1_tag',
  'no_image_alt',
  'no_image_title',
  'large_page_size',
  'low_content_rate',
  'redirect_chain',
  'has_render_blocking_resources',
  'no_favicon',
  'low_readability_rate',
])

const MINOR_KEYS = new Set([
  'irrelevant_description',
  'short_title',
  'short_description',
  'has_meta_refresh',
  'has_html_doctype',
  'no_image_dimensions',
])

const CATEGORY_MAP: Record<string, string> = {
  is_4xx_code:  'broken-pages',
  is_5xx_code:  'broken-pages',
  no_h1_tag:    'on-page',
  no_title:     'on-page',
  no_description: 'on-page',
  duplicate_title: 'on-page',
  duplicate_description: 'on-page',
  no_image_alt: 'on-page',
  is_https:     'security',
  no_robots_txt: 'crawling',
  high_loading_time: 'performance',
  has_render_blocking_resources: 'performance',
  large_page_size: 'performance',
  redirect_chain: 'crawling',
  is_redirect_loop: 'crawling',
  broken_links: 'broken-pages',
  is_orphan_page: 'crawling',
  low_content_rate: 'on-page',
  no_image_title: 'on-page',
  no_favicon:   'on-page',
}

export function classifyAuditFinding(f: AuditFinding): SeverityResult {
  const key = f.check_key
  const pages = f.pages_count

  // Special case: duplicate titles/descriptions become CRITICAL when many
  // pages affected (>10 pages duplicate = canonical mess)
  if ((key === 'duplicate_title' || key === 'duplicate_description') && pages > 10) {
    return {
      severity: 'critical',
      reason:   `${pages} pages share the same ${key.replace('duplicate_', '')} — canonical signal is broken at scale.`,
      category: 'on-page',
    }
  }

  // 4xx/5xx becomes critical regardless of page count if affecting any
  if (CRITICAL_KEYS.has(key)) {
    return {
      severity: 'critical',
      reason:   `${prettyKey(key)} on ${pages} page${pages > 1 ? 's' : ''} — blocks indexing or breaks user trust.`,
      category: CATEGORY_MAP[key] ?? 'general',
    }
  }

  if (IMPORTANT_KEYS.has(key)) {
    // Demote to minor if very few pages affected
    if (pages <= 2) {
      return {
        severity: 'minor',
        reason:   `${prettyKey(key)} on only ${pages} page${pages > 1 ? 's' : ''} — affects ranking quality but limited blast radius.`,
        category: CATEGORY_MAP[key] ?? 'general',
      }
    }
    return {
      severity: 'important',
      reason:   `${prettyKey(key)} on ${pages} pages — affects ranking quality across the site.`,
      category: CATEGORY_MAP[key] ?? 'general',
    }
  }

  if (MINOR_KEYS.has(key)) {
    return {
      severity: 'minor',
      reason:   `${prettyKey(key)} — polish item, low priority.`,
      category: CATEGORY_MAP[key] ?? 'polish',
    }
  }

  // Unknown keys default to important if many pages, else minor
  return {
    severity: pages > 5 ? 'important' : 'minor',
    reason:   `${prettyKey(key)} on ${pages} page${pages > 1 ? 's' : ''} — unknown check, conservative default.`,
    category: CATEGORY_MAP[key] ?? 'general',
  }
}

function prettyKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export const SEVERITY_STYLES: Record<AuditSeverity, { label: string; class: string; emoji: string }> = {
  critical:  { label: 'CRITICAL',  class: 'bg-red-500/15 text-red-300 border-red-500/30',         emoji: '🚨' },
  important: { label: 'IMPORTANT', class: 'bg-amber-500/15 text-amber-300 border-amber-500/30',   emoji: '⚠️' },
  minor:     { label: 'MINOR',     class: 'bg-gray-700/40 text-gray-400 border-gray-700',          emoji: '📝' },
}
