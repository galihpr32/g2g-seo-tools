// ─── G2G Market Country Config ────────────────────────────────────────────────
// Maps G2G's key markets to SEMrush database codes and DataForSEO location codes.
// DataForSEO location codes: https://docs.dataforseo.com/v3/appendix/google/locations/

export interface CountryPreset {
  code: string           // internal key (ISO2)
  label: string          // display name
  flag: string           // emoji flag
  semrushDb: string      // SEMrush database code
  dfsLocationCode: number // DataForSEO location_code
  dfsLanguageCode: string // DataForSEO language_code
}

export const SERP_COUNTRIES: CountryPreset[] = [
  { code: 'id', label: 'Indonesia',      flag: '🇮🇩', semrushDb: 'id', dfsLocationCode: 2360, dfsLanguageCode: 'id' },
  { code: 'my', label: 'Malaysia',       flag: '🇲🇾', semrushDb: 'my', dfsLocationCode: 2458, dfsLanguageCode: 'ms' },
  { code: 'sg', label: 'Singapore',      flag: '🇸🇬', semrushDb: 'sg', dfsLocationCode: 2702, dfsLanguageCode: 'en' },
  { code: 'ph', label: 'Philippines',    flag: '🇵🇭', semrushDb: 'ph', dfsLocationCode: 2608, dfsLanguageCode: 'en' },
  { code: 'th', label: 'Thailand',       flag: '🇹🇭', semrushDb: 'th', dfsLocationCode: 2764, dfsLanguageCode: 'th' },
  { code: 'vn', label: 'Vietnam',        flag: '🇻🇳', semrushDb: 'vn', dfsLocationCode: 2704, dfsLanguageCode: 'vi' },
  { code: 'us', label: 'United States',  flag: '🇺🇸', semrushDb: 'us', dfsLocationCode: 2840, dfsLanguageCode: 'en' },
  { code: 'gb', label: 'United Kingdom', flag: '🇬🇧', semrushDb: 'uk', dfsLocationCode: 2826, dfsLanguageCode: 'en' },
  { code: 'au', label: 'Australia',      flag: '🇦🇺', semrushDb: 'au', dfsLocationCode: 2036, dfsLanguageCode: 'en' },
  { code: 'br', label: 'Brazil',         flag: '🇧🇷', semrushDb: 'br', dfsLocationCode: 2076, dfsLanguageCode: 'pt' },
  { code: 'de', label: 'Germany',        flag: '🇩🇪', semrushDb: 'de', dfsLocationCode: 2276, dfsLanguageCode: 'de' },
  { code: 'fr', label: 'France',         flag: '🇫🇷', semrushDb: 'fr', dfsLocationCode: 2250, dfsLanguageCode: 'fr' },
  { code: 'tr', label: 'Turkey',         flag: '🇹🇷', semrushDb: 'tr', dfsLocationCode: 2792, dfsLanguageCode: 'tr' },
  { code: 'kr', label: 'South Korea',    flag: '🇰🇷', semrushDb: 'kr', dfsLocationCode: 2410, dfsLanguageCode: 'ko' },
]

export const DEFAULT_COUNTRY = SERP_COUNTRIES[0] // Indonesia

/** Look up a preset by its code (case-insensitive). Falls back to Indonesia. */
export function getCountryPreset(code: string): CountryPreset {
  return SERP_COUNTRIES.find(c => c.code === code.toLowerCase()) ?? DEFAULT_COUNTRY
}

/**
 * Map a language code (from detectPageLanguage) to the best-matching country preset.
 * Used to auto-select the SERP country from the page URL language.
 */
export function countryFromLanguageCode(langCode: string): CountryPreset {
  const map: Record<string, string> = {
    id: 'id',
    ms: 'my',
    th: 'th',
    vi: 'vn',
    pt: 'br',
    de: 'de',
    fr: 'fr',
    tr: 'tr',
    ko: 'kr',
    // English-default markets — fall back to US if no better signal
    en: 'us',
  }
  return getCountryPreset(map[langCode] ?? 'id')
}
