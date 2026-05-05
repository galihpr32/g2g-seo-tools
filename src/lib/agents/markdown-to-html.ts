/**
 * markdown-to-html.ts
 *
 * Lightweight markdown → HTML converter used to transform Bragi-generated
 * `final_content` (markdown) into CMS-ready HTML using the brand-specific
 * tag wrappers stored in `knowledge_base_items.brand.data.html_format`.
 *
 * This is intentionally a small bespoke converter (not a full markdown lib
 * like marked) because:
 *   - Bragi output is constrained — only headings, paragraphs, lists, bold,
 *     italic, links. No tables, no code blocks, no nested blockquotes.
 *   - We need granular control over per-tag wrapping (G2G uses Quasar
 *     classes; another brand might use Tailwind prose; etc).
 *   - Avoids adding a 50KB dependency for a 100-line transform.
 *
 * Used by:
 *   - FinalContentPanel "HTML" / "Preview" view modes
 *   - Public copy-as-HTML endpoint (future)
 */

export interface BrandHtmlFormat {
  h1?:     string
  h2?:     string
  h3?:     string
  h4?:     string
  p?:      string
  ul?:     string
  ol?:     string
  li?:     string
  strong?: string
  em?:     string
  a?:      string
}

export const DEFAULT_HTML_FORMAT: Required<BrandHtmlFormat> = {
  h1:     '<h1 class="text-h4 q-ma-none">{text}</h1>',
  h2:     '<h2 class="text-h4 q-ma-none">{text}</h2>',
  h3:     '<h3 class="text-h6 q-ma-none">{text}</h3>',
  h4:     '<h4 class="text-subtitle1 q-ma-none">{text}</h4>',
  p:      '{text}<br><br>',
  ul:     '<ul>{text}</ul>',
  ol:     '<ol>{text}</ol>',
  li:     '<li>{text}</li>',
  strong: '<strong>{text}</strong>',
  em:     '<em>{text}</em>',
  a:      '<a href="{href}">{text}</a>',
}

/**
 * Wrap text using a template containing {text} (and optionally {href}).
 * Returns inner text unchanged if the template is missing or invalid.
 */
function wrap(template: string | undefined, text: string, href?: string): string {
  if (!template) return text
  let out = template.replace(/\{text\}/g, text)
  if (href !== undefined) out = out.replace(/\{href\}/g, escapeAttr(href))
  return out
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Inline transforms applied to every line/paragraph: bold, italic, links. */
function applyInline(line: string, fmt: Required<BrandHtmlFormat>): string {
  // Links: [text](url)  — process before bold/italic to avoid mis-matching brackets
  let out = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, href) =>
    wrap(fmt.a, applyInline(txt, fmt), String(href).trim()),
  )
  // Bold: **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, t) => wrap(fmt.strong, t))
  // Italic: *text* (but not inside bold leftovers)
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, t) => wrap(fmt.em, t))
  return out
}

/**
 * Convert a markdown string into HTML using the supplied brand format.
 * Empty/missing format falls back to vanilla HTML defaults.
 */
export function markdownToHtml(
  markdown: string,
  brandFormat?: BrandHtmlFormat | null,
): string {
  const fmt: Required<BrandHtmlFormat> = { ...DEFAULT_HTML_FORMAT, ...(brandFormat ?? {}) }

  const lines = markdown.split(/\r?\n/)
  const out: string[] = []

  // Buffer for the current paragraph being assembled (so we can flush as one wrap).
  let paraBuf: string[] = []
  // Buffer for list items currently being collected.
  let listItems: string[] = []
  let listType: 'ul' | 'ol' | null = null

  const flushParagraph = () => {
    if (paraBuf.length === 0) return
    const joined = paraBuf.map(l => applyInline(l, fmt)).join(' ')
    out.push(wrap(fmt.p, joined))
    paraBuf = []
  }

  const flushList = () => {
    if (listItems.length === 0 || !listType) return
    const inner = listItems.map(item => wrap(fmt.li, applyInline(item, fmt))).join('')
    out.push(wrap(fmt[listType], inner))
    listItems = []
    listType  = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    // Blank line: end of any open paragraph or list
    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }

    // Headings (# H1, ## H2, ### H3, #### H4)
    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length as 1 | 2 | 3 | 4
      const tag   = (`h${level}` as 'h1' | 'h2' | 'h3' | 'h4')
      out.push(wrap(fmt[tag], applyInline(heading[2], fmt)))
      continue
    }

    // Unordered list item: - text  or  * text
    const ul = line.match(/^[-*]\s+(.+)$/)
    if (ul) {
      flushParagraph()
      if (listType && listType !== 'ul') flushList()
      listType = 'ul'
      listItems.push(ul[1])
      continue
    }

    // Ordered list item: 1. text
    const ol = line.match(/^\d+\.\s+(.+)$/)
    if (ol) {
      flushParagraph()
      if (listType && listType !== 'ol') flushList()
      listType = 'ol'
      listItems.push(ol[1])
      continue
    }

    // Default: paragraph text
    flushList()
    paraBuf.push(line)
  }

  flushParagraph()
  flushList()

  return out.join('\n')
}
