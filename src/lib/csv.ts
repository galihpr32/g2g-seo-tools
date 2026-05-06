/**
 * Tiny RFC-4180 CSV utilities — no external deps.
 *
 * Used by /api/products/auto-content/csv-* endpoints. Handles:
 *   - Quoted fields with commas, newlines, and escaped double-quotes
 *   - UTF-8 BOM at start (some Excel exports add one)
 *   - Trailing newlines / CR LF / LF
 *
 * Not a general-purpose CSV lib — keep imports lightweight.
 */

export function escapeCsvCell(value: string): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  // Quote when value contains comma, quote, CR, LF, or leading/trailing whitespace
  if (/[",\r\n]|^\s|\s$/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

export function buildCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const headerLine = headers.map(escapeCsvCell).join(',')
  const bodyLines  = rows.map(r => headers.map(h => escapeCsvCell(String(r[h] ?? ''))).join(','))
  return [headerLine, ...bodyLines].join('\n') + '\n'
}

/**
 * Parse a single CSV line, respecting quoted fields. Returns an array of
 * cell strings. NOTE: returns null when the line is unterminated (open
 * quote spanning to next physical line) — caller should buffer and continue.
 */
function parseCsvLine(line: string, startIdx = 0): { cells: string[] | null; nextStart: number } {
  const cells: string[] = []
  let i      = startIdx
  let buf    = ''
  let inQuotes = false

  while (i < line.length) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { buf += '"'; i += 2; continue }   // escaped quote
        inQuotes = false; i++; continue
      }
      buf += c; i++; continue
    }
    if (c === '"' && buf.length === 0) { inQuotes = true; i++; continue }
    if (c === ',')                       { cells.push(buf); buf = ''; i++; continue }
    buf += c
    i++
  }
  if (inQuotes) return { cells: null, nextStart: line.length }   // multi-line cell
  cells.push(buf)
  return { cells, nextStart: i }
}

export function parseCsv(text: string): string[][] {
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)

  // Normalise line endings
  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  const out: string[][] = []
  let pending = ''
  for (const rawLine of normalised.split('\n')) {
    const merged = pending ? pending + '\n' + rawLine : rawLine
    const result = parseCsvLine(merged)
    if (result.cells === null) {
      pending = merged
    } else {
      out.push(result.cells)
      pending = ''
    }
  }

  // Drop trailing empty lines
  while (out.length > 0) {
    const last = out[out.length - 1]
    const isEmpty = last.length === 0 || (last.length === 1 && last[0].trim() === '')
    if (!isEmpty) break
    out.pop()
  }

  return out
}

/**
 * Convert a parsed CSV (with header row) to an array of objects keyed by
 * header. Strict mode: throws if any required header is missing.
 */
export function csvRowsToObjects(
  parsed: string[][],
  required: string[] = [],
): Array<Record<string, string>> {
  if (parsed.length === 0) return []
  const headers = parsed[0].map(h => h.trim())

  for (const req of required) {
    if (!headers.some(h => h.toLowerCase() === req.toLowerCase())) {
      throw new Error(`Missing required column "${req}". Found: ${headers.join(', ') || '(none)'}`)
    }
  }

  return parsed.slice(1).map(row => {
    const obj: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = (row[i] ?? '').trim()
    }
    return obj
  })
}
