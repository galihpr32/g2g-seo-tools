// ─────────────────────────────────────────────────────────────────────────────
// Language detection for G2G page URLs
// G2G uses path-segment locale prefixes, e.g. /id/, /ms/, /pt/, /th/, /vi/
// ─────────────────────────────────────────────────────────────────────────────

export interface PageLanguage {
  code:   string   // ISO 639-1 code
  name:   string   // Human-readable name for prompts
  instruction: string  // Full instruction block for AI prompts
}

const LOCALE_MAP: Record<string, Omit<PageLanguage, 'instruction'>> = {
  id: { code: 'id', name: 'Bahasa Indonesia' },
  ms: { code: 'ms', name: 'Bahasa Melayu (Malay)' },
  pt: { code: 'pt', name: 'Portuguese (Brazilian)' },
  th: { code: 'th', name: 'Thai' },
  vi: { code: 'vi', name: 'Vietnamese' },
  zh: { code: 'zh', name: 'Chinese (Simplified)' },
  de: { code: 'de', name: 'German' },
  fr: { code: 'fr', name: 'French' },
  es: { code: 'es', name: 'Spanish' },
  tr: { code: 'tr', name: 'Turkish' },
  ko: { code: 'ko', name: 'Korean' },
  ja: { code: 'ja', name: 'Japanese' },
  ar: { code: 'ar', name: 'Arabic' },
  ru: { code: 'ru', name: 'Russian' },
  pl: { code: 'pl', name: 'Polish' },
}

const ENGLISH: PageLanguage = {
  code: 'en',
  name: 'English',
  instruction: '',   // no special instruction needed — English is the default
}

/**
 * Detect the language of a G2G page from its URL.
 *
 * G2G locale URL patterns:
 *   https://www.g2g.com/id/categories/mobile-legends-diamonds  →  id
 *   https://www.g2g.com/ms/offer/...                           →  ms
 *   https://www.g2g.com/categories/fortnite-items              →  en (no prefix)
 *   ?lang=id query param fallback
 */
export function detectPageLanguage(url: string): PageLanguage {
  try {
    const parsed = new URL(url)

    // 1. Check first path segment for locale
    const segments = parsed.pathname.split('/').filter(Boolean)
    const first = segments[0]?.toLowerCase() ?? ''
    if (first in LOCALE_MAP) {
      return buildLang(LOCALE_MAP[first])
    }

    // 2. Check ?lang= query param
    const langParam = parsed.searchParams.get('lang')?.toLowerCase() ?? ''
    if (langParam && langParam in LOCALE_MAP) {
      return buildLang(LOCALE_MAP[langParam])
    }

    // 3. Check subdomain (e.g. id.g2g.com)
    const subdomain = parsed.hostname.split('.')[0].toLowerCase()
    if (subdomain in LOCALE_MAP) {
      return buildLang(LOCALE_MAP[subdomain])
    }
  } catch {
    // Invalid URL — fall back to English
  }
  return ENGLISH
}

function buildLang(base: Omit<PageLanguage, 'instruction'>): PageLanguage {
  return {
    ...base,
    instruction: `LANGUAGE REQUIREMENT: Write ALL output in ${base.name} (${base.code}). This applies to:
- Every section heading and label
- All analysis text, bullet points, and summaries
- The complete content draft and FAQ answers
- Meta title and meta description
Do NOT switch to English at any point. The target audience reads ${base.name}.`,
  }
}
