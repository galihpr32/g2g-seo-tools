import { google } from 'googleapis'

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
]

export function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/google/callback`
  )
}

export function getAuthUrl(stateSiteSlug?: string) {
  const oauth2Client = getOAuthClient()
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    ...(stateSiteSlug ? { state: stateSiteSlug } : {}),
  })
}

export async function getTokensFromCode(code: string) {
  const oauth2Client = getOAuthClient()
  const { tokens } = await oauth2Client.getToken(code)
  return tokens
}

export type RefreshedClientFull = {
  client: ReturnType<typeof getOAuthClient>
  /** Non-null when the access token was refreshed — caller should persist to DB */
  newCredentials: { accessToken: string; expiresAt: string } | null
}

/**
 * Returns the OAuth2 client AND new credentials if a token refresh occurred.
 * Use this in cron jobs / server-side code that can persist the new token to DB.
 * All other callers should use the lightweight `getRefreshedClient` wrapper below.
 */
export async function getRefreshedClientFull(
  accessToken: string,
  refreshToken: string,
  expiresAt: string,
): Promise<RefreshedClientFull> {
  const oauth2Client = getOAuthClient()
  oauth2Client.setCredentials({
    access_token:  accessToken,
    refresh_token: refreshToken,
    expiry_date:   new Date(expiresAt).getTime(),
  })

  const now    = Date.now()
  const expiry = new Date(expiresAt).getTime()
  if (expiry < now + 60_000) {
    const { credentials } = await oauth2Client.refreshAccessToken()
    oauth2Client.setCredentials(credentials)
    return {
      client: oauth2Client,
      newCredentials: {
        accessToken: credentials.access_token ?? accessToken,
        expiresAt:   credentials.expiry_date
          ? new Date(credentials.expiry_date).toISOString()
          : new Date(now + 3_600_000).toISOString(),
      },
    }
  }

  return { client: oauth2Client, newCredentials: null }
}

/**
 * Lightweight wrapper — refreshes in-memory if expired, returns the client.
 * Does NOT persist the new token. Suitable for user-facing read routes;
 * the gsc-daily cron handles DB persistence of refreshed tokens.
 */
export async function getRefreshedClient(
  accessToken: string,
  refreshToken: string,
  expiresAt: string,
) {
  const { client } = await getRefreshedClientFull(accessToken, refreshToken, expiresAt)
  return client
}
