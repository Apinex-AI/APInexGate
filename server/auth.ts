import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db, nowIso, touchUserLastSeen } from './db.js'

export const ADMIN_SESSION_COOKIE = 'admin_session'
export const USER_SESSION_COOKIE = 'user_session'
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Customer sessions do not auto-expire (persist until logout). */
export const USER_SESSION_EXPIRES_AT = '9999-12-31T23:59:59.000Z'

function cookieDomain(): string | undefined {
  // Share customer sessions across the public site hosts.
  // Admin cookies stay host-only (no domain) so they never leak to public sites.
  const explicit = process.env.COOKIE_DOMAIN?.trim()
  if (explicit) return explicit
  if (process.env.NODE_ENV !== 'production') return undefined
  const site = process.env.SITE_URL?.trim() || process.env.SITE_URL?.trim()
  if (!site) return undefined
  try {
    const host = new URL(site).hostname.replace(/^www\./, '')
    if (!host || host === 'localhost' || host === '127.0.0.1') return undefined
    return host.startsWith('.') ? host : `.${host}`
  } catch {
    return undefined
  }
}

const cookieBase = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
}

const userCookieBase = {
  ...cookieBase,
  ...(cookieDomain() ? { domain: cookieDomain() } : {}),
}

/** OAuth CSRF cookie must be readable on callback */
export function oauthStateCookieOptions(maxAgeSec = 10 * 60) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSec,
    ...(cookieDomain() ? { domain: cookieDomain() } : {}),
  }
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string) {
  const [salt, storedHash] = stored.split(':')
  if (!salt || !storedHash) return false
  const hash = scryptSync(password, salt, 64)
  const expected = Buffer.from(storedHash, 'hex')
  return expected.length === hash.length && timingSafeEqual(expected, hash)
}

export function createAdminSession(adminId: string) {
  const sessionId = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  ).run(sessionId, adminId, expiresAt, nowIso())
  return { sessionId, expiresAt }
}

export function createUserSession(userId: string) {
  const sessionId = randomBytes(32).toString('hex')
  const expiresAt = USER_SESSION_EXPIRES_AT
  db.prepare(
    'INSERT INTO user_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  ).run(sessionId, userId, expiresAt, nowIso())
  return { sessionId, expiresAt }
}

export function destroyAdminSession(sessionId: string) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
}

export function destroyUserSession(sessionId: string) {
  db.prepare('DELETE FROM user_sessions WHERE id = ?').run(sessionId)
}

export function getAdminSessionUser(request: FastifyRequest) {
  const sessionId = request.cookies[ADMIN_SESSION_COOKIE]
  if (!sessionId) return null
  const session = db
    .prepare(`
      SELECT s.id, s.expires_at, u.id AS user_id, u.email, u.role
      FROM sessions s
      JOIN admin_users u ON u.id = s.user_id
      WHERE s.id = ?
    `)
    .get(sessionId) as
    | { id: string; expires_at: string; user_id: string; email: string; role: string }
    | undefined

  if (!session || Date.parse(session.expires_at) <= Date.now()) {
    destroyAdminSession(sessionId)
    return null
  }

  return {
    sessionId: session.id,
    id: session.user_id,
    email: session.email,
    role: session.role,
    expiresAt: session.expires_at,
  }
}

function readCustomerSessionId(request: FastifyRequest) {
  const cookie = request.cookies[USER_SESSION_COOKIE]
  if (cookie) return cookie

  // Android WebView shell may lose host cookies after process death.
  // JS keeps the token in localStorage / native SharedPreferences and
  // sends it on every API call.
  const header =
    request.headers['x-session-id'] ??
    request.headers['x-session-id'] ??
    request.headers.authorization
  if (typeof header === 'string' && header.trim()) {
    const raw = header.trim()
    if (raw.toLowerCase().startsWith('bearer ')) return raw.slice(7).trim()
    return raw
  }
  if (Array.isArray(header) && header[0]) {
    const raw = String(header[0]).trim()
    if (raw.toLowerCase().startsWith('bearer ')) return raw.slice(7).trim()
    return raw
  }
  return null
}

export function getCustomerSessionUser(request: FastifyRequest) {
  const sessionId = readCustomerSessionId(request)
  if (!sessionId) return null
  const session = db
    .prepare(`
      SELECT s.id, s.expires_at,
             u.id AS user_id, u.email, u.name, u.plan, u.status, u.balance_tokens,
             u.solana_wallet, u.auth_method, u.password_hash, u.google_sub,
             u.telegram_id, u.telegram_username, u.telegram_verified_at
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
    `)
    .get(sessionId) as
    | {
        id: string
        expires_at: string
        user_id: string
        email: string
        name: string
        plan: string
        status: string
        balance_tokens: number
        solana_wallet: string | null
        auth_method: string | null
        password_hash: string | null
        google_sub: string | null
        telegram_id: string | null
        telegram_username: string | null
        telegram_verified_at: string | null
      }
    | undefined

  if (!session) {
    destroyUserSession(sessionId)
    return null
  }

  if (session.status === 'suspended' || session.status === 'pending') {
    destroyUserSession(sessionId)
    return null
  }

  touchUserLastSeen(session.user_id)

  return {
    sessionId: session.id,
    id: session.user_id,
    email: session.email,
    name: session.name,
    plan: session.plan,
    status: session.status,
    balanceTokens: session.balance_tokens,
    expiresAt: session.expires_at,
    solanaWallet: session.solana_wallet,
    authMethod: session.auth_method,
    passwordHash: session.password_hash,
    googleSub: session.google_sub,
    telegramId: session.telegram_id,
    telegramUsername: session.telegram_username,
    telegramVerifiedAt: session.telegram_verified_at,
  }
}

export function setAdminSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: string) {
  reply.setCookie(ADMIN_SESSION_COOKIE, sessionId, {
    ...cookieBase,
    expires: new Date(expiresAt),
  })
}

export function clearAdminSessionCookie(reply: FastifyReply) {
  reply.clearCookie(ADMIN_SESSION_COOKIE, cookieBase)
}

export function setUserSessionCookie(reply: FastifyReply, sessionId: string, _expiresAt?: string) {
  reply.setCookie(USER_SESSION_COOKIE, sessionId, {
    ...userCookieBase,
    // Persistent until explicit logout (browsers may clamp maxAge).
    expires: new Date(USER_SESSION_EXPIRES_AT),
  })
}

export function clearUserSessionCookie(reply: FastifyReply) {
  reply.clearCookie(USER_SESSION_COOKIE, userCookieBase)
  // Also clear legacy host-only cookie if present.
  reply.clearCookie(USER_SESSION_COOKIE, cookieBase)
}

/** @deprecated aliases for older imports */
export const SESSION_COOKIE = ADMIN_SESSION_COOKIE
export const createSession = createAdminSession
export const destroySession = destroyAdminSession
export const getSessionUser = getAdminSessionUser
export const setSessionCookie = setAdminSessionCookie
export const clearSessionCookie = clearAdminSessionCookie
