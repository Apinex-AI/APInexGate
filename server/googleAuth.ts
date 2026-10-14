import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const GOOGLE_OAUTH_STATE_COOKIE = 'oauth_state'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim())
}

export function googleClientId() {
  return process.env.GOOGLE_CLIENT_ID?.trim() ?? ''
}

function googleClientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() ?? ''
}

export function siteBaseUrl() {
  return (process.env.SITE_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '')
}

export function googleRedirectUri() {
  const explicit = process.env.GOOGLE_REDIRECT_URI?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  return `${siteBaseUrl()}/api/user/auth/google/callback`
}

export function createOAuthState() {
  return randomBytes(24).toString('hex')
}

export function statesMatch(expected: string | undefined, actual: string | undefined) {
  if (!expected || !actual) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function buildGoogleAuthorizeUrl(state: string) {
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  })
  return `${GOOGLE_AUTH_URL}?${params.toString()}`
}

export type GoogleProfile = {
  sub: string
  email: string
  emailVerified: boolean
  name: string
}

/** Consumer Gmail only — blocks Workspace / custom domains / other providers via Google. */
export const GOOGLE_LOGIN_ALLOWED_DOMAIN = 'gmail.com'

export function isAllowedGoogleLoginEmail(email: string) {
  const value = String(email ?? '')
    .trim()
    .toLowerCase()
  const at = value.lastIndexOf('@')
  if (at <= 0) return false
  return value.slice(at + 1) === GOOGLE_LOGIN_ALLOWED_DOMAIN
}

export const GOOGLE_GMAIL_ONLY_MESSAGE =
  'Login is available only with gmail.com accounts'

export async function exchangeGoogleCode(code: string): Promise<GoogleProfile> {
  const body = new URLSearchParams({
    code,
    client_id: googleClientId(),
    client_secret: googleClientSecret(),
    redirect_uri: googleRedirectUri(),
    grant_type: 'authorization_code',
  })

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const tokenData = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string
    error?: string
    error_description?: string
  }
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(tokenData.error_description || tokenData.error || 'Google token exchange failed')
  }

  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const userData = (await userRes.json().catch(() => ({}))) as {
    sub?: string
    email?: string
    email_verified?: boolean
    name?: string
    given_name?: string
    error?: string
  }
  if (!userRes.ok || !userData.sub || !userData.email) {
    throw new Error(userData.error || 'Failed to load Google profile')
  }

  const email = userData.email.trim().toLowerCase()
  if (!isAllowedGoogleLoginEmail(email)) {
    throw new Error(GOOGLE_GMAIL_ONLY_MESSAGE)
  }
  const name =
    userData.name?.trim() ||
    userData.given_name?.trim() ||
    email.split('@')[0] ||
    'User'

  return {
    sub: userData.sub,
    email,
    emailVerified: Boolean(userData.email_verified),
    name,
  }
}

/** Stable opaque error codes for redirect query (no PII). */
export function oauthErrorToken(message: string) {
  return createHash('sha256').update(message).digest('hex').slice(0, 8)
}

const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo'
const GOOGLE_ISS_ALLOW = new Set(['https://accounts.google.com', 'accounts.google.com'])

/**
 * Verify a Google ID token from Android Credential Manager / GIS.
 * Uses Google tokeninfo + audience check against our web client id.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
  const token = String(idToken ?? '').trim()
  if (!token || token.length < 20 || token.length > 4096) {
    throw new Error('Invalid Google ID token')
  }
  if (!googleConfigured()) {
    throw new Error('Google sign-in is not configured')
  }

  const url = `${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(token)}`
  const res = await fetch(url)
  const data = (await res.json().catch(() => ({}))) as {
    aud?: string
    azp?: string
    iss?: string
    sub?: string
    email?: string
    email_verified?: string | boolean
    name?: string
    given_name?: string
    exp?: string
    error?: string
    error_description?: string
  }

  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error || 'Google ID token verification failed')
  }

  const clientId = googleClientId()
  const aud = String(data.aud ?? '')
  const azp = String(data.azp ?? '')
  if (aud !== clientId && azp !== clientId) {
    throw new Error('Google ID token audience mismatch')
  }
  if (data.iss && !GOOGLE_ISS_ALLOW.has(String(data.iss))) {
    throw new Error('Google ID token issuer mismatch')
  }
  if (!data.sub || !data.email) {
    throw new Error('Google ID token missing profile fields')
  }

  const exp = Number(data.exp ?? 0)
  if (Number.isFinite(exp) && exp > 0 && exp * 1000 < Date.now() - 30_000) {
    throw new Error('Google ID token expired')
  }

  const emailVerified =
    data.email_verified === true ||
    data.email_verified === 'true' ||
    data.email_verified === '1'
  if (!emailVerified) {
    throw new Error('Your Google email is not verified')
  }

  const email = String(data.email).trim().toLowerCase()
  if (!isAllowedGoogleLoginEmail(email)) {
    throw new Error(GOOGLE_GMAIL_ONLY_MESSAGE)
  }

  const name =
    data.name?.trim() ||
    data.given_name?.trim() ||
    email.split('@')[0] ||
    'User'

  return {
    sub: String(data.sub),
    email,
    emailVerified: true,
    name,
  }
}
