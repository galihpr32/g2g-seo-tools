// ─── Steam / SteamSpy client ──────────────────────────────────────────────────
// Uses SteamSpy public API (no key required) for trending game data.
// Docs: https://steamspy.com/about

const STEAMSPY_BASE = 'https://steamspy.com/api.php'
const STEAM_CDN     = 'https://cdn.akamai.steamstatic.com/steam'

export interface SteamGame {
  appid:           number
  name:            string
  developer:       string
  publisher:       string
  genre:           string
  players2weeks:   number   // concurrent players in past 2 weeks
  playersForever:  number
  avgPlaytime2w:   number   // minutes
  positive:        number   // positive reviews
  negative:        number   // negative reviews
  price:           number   // in cents; 0 = free
  imageUrl:        string
}

// Fetch top 100 games by players in past 2 weeks
export async function getTopGamesByPlayers(limit = 50): Promise<SteamGame[]> {
  try {
    const res = await fetch(`${STEAMSPY_BASE}?request=top100in2weeks`, {
      signal: AbortSignal.timeout(10_000),
      next: { revalidate: 3600 }, // cache 1h at Next.js layer
    })
    if (!res.ok) throw new Error(`SteamSpy ${res.status}`)
    const raw = await res.json() as Record<string, any>

    return Object.values(raw)
      .slice(0, limit)
      .map(g => ({
        appid:          g.appid,
        name:           g.name,
        developer:      g.developer ?? '',
        publisher:      g.publisher ?? '',
        genre:          g.genre ?? '',
        players2weeks:  parseInt(g.players_2weeks ?? g.average_2weeks ?? 0) || 0,
        playersForever: parseInt(g.owners?.split('..')[0].replace(/,/g, '') ?? 0) || 0,
        avgPlaytime2w:  parseInt(g.average_2weeks ?? 0) || 0,
        positive:       parseInt(g.positive ?? 0) || 0,
        negative:       parseInt(g.negative ?? 0) || 0,
        price:          parseInt(g.price ?? 0) || 0,
        imageUrl:       `${STEAM_CDN}/apps/${g.appid}/header.jpg`,
      }))
      .filter(g => g.name)
  } catch (e) {
    console.warn('[steam] getTopGamesByPlayers failed:', e)
    return []
  }
}

// Fetch newly released / just trending games (past week)
export async function getNewReleasesTrending(limit = 30): Promise<SteamGame[]> {
  try {
    const res = await fetch(`${STEAMSPY_BASE}?request=top100forever`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`SteamSpy ${res.status}`)
    const raw = await res.json() as Record<string, any>

    return Object.values(raw)
      .slice(0, limit)
      .map(g => ({
        appid:          g.appid,
        name:           g.name,
        developer:      g.developer ?? '',
        publisher:      g.publisher ?? '',
        genre:          g.genre ?? '',
        players2weeks:  parseInt(g.average_2weeks ?? 0) || 0,
        playersForever: parseInt(g.owners?.split('..')[0].replace(/,/g, '') ?? 0) || 0,
        avgPlaytime2w:  parseInt(g.average_2weeks ?? 0) || 0,
        positive:       parseInt(g.positive ?? 0) || 0,
        negative:       parseInt(g.negative ?? 0) || 0,
        price:          parseInt(g.price ?? 0) || 0,
        imageUrl:       `${STEAM_CDN}/apps/${g.appid}/header.jpg`,
      }))
      .filter(g => g.name)
  } catch (e) {
    console.warn('[steam] getNewReleasesTrending failed:', e)
    return []
  }
}

// Get current concurrent player count from Steam Web API
export async function getCurrentPlayers(appid: number): Promise<number> {
  try {
    const res = await fetch(
      `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`,
      { signal: AbortSignal.timeout(5_000) }
    )
    if (!res.ok) return 0
    const data = await res.json()
    return data?.response?.player_count ?? 0
  } catch { return 0 }
}
