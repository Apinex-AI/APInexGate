import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  clearSessionCookie,
  clearUserSessionCookie,
  createAdminSession,
  createUserSession,
  destroySession,
  destroyUserSession,
  getCustomerSessionUser,
  getSessionUser,
  setSessionCookie,
  setUserSessionCookie,
  verifyPassword,
  oauthStateCookieOptions,
  ADMIN_SESSION_COOKIE,
  USER_SESSION_COOKIE,
} from './auth.js'
import { db, getMinTopupCents, id, nextUserDisplayId, nowIso, setSetting, touchUserLastSeen } from './db.js'
import { BLOCKED_EMAIL_MESSAGE, isEmailBlocked } from './blockedEmails.js'

import { getSiteLinks, saveSiteLinks } from './siteLinks.js'
import { brandSlug, publicBrand } from '../shared/brand.js'
import { buildAdminStatisticsOffThread, buildModelUsageStatsOffThread } from './adminStatisticsJob.js'
import { ackLevelCelebration, getAccountLevel, getLevelSettings, saveLevelSettings } from './accountLevels.js'
import {
  createProviderKey,
  deleteProviderKey,
  familyFromUpstreamId,
  fetchCatalogModels,
  importApinexCatalogModels,
  isDecisionCatalogModelId,
  listProviderKeys,
  MODEL_CATEGORIES,
  providerBalanceTotals,
  providerForTokenWeight,
  publicProviderKey,
  syncAllProviderKeys,
  syncProviderKey,
  type ModelCategory,
} from './providerKeys.js'
import { isValidModelId, isValidModelName } from '../shared/modelValidation.js'
import { isUpstreamProvider } from '../shared/providers.js'
import { ALLOWED_EMAIL_DOMAINS_HINT, isAllowedEmailDomain } from '../shared/allowedEmailDomains.js'
import { isAdminConsoleHost, requestHostname } from '../shared/adminHosts.js'
import {
  activateSubscription,
  getActiveSubscription,
  getAdminActiveSubscriptions,
  getAdminSubscriptionStats,
  getAdminUserAllowances,
  getFreeTierAccess,
  getSubscriptionHistory,
  getSubscriptionSettings,
  revokeActiveSubscription,
  updateSubscriptionSettings,
} from './subscriptions.js'
import { applyOfferCents, getActiveSubscriptionOffer } from './subscriptionOffers.js'
import { applyCombinedSubscriptionBonus } from './promoBonus.js'
import {
  getSubscriptionPaymentPublic,
  quoteSubscription,
  subscriptionPayMethods,
  subscriptionSolanaPayConfigured,
  verifyAndCreditSubscriptionPayment,
} from './subscriptionPayments.js'
import { isSubscriptionPlanKey, nextUtcResetIso } from '../shared/subscriptions.js'
import {
  adminRpmUser,
  getRpmCatalog,
  getRpmPaymentPublic,
  publicRpmPlans,
  saveRpmCatalog,
  setUserRpmGrant,
  userRpmState,
} from './rpmPlans.js'
import { logUserActivity } from './userActivityLog.js'

import {
  tokensFromUsdCents,
  TOKENS_PER_USD,
  usdFromTokens,
} from '../shared/billing.js'
import { normalizeProviderName } from '../shared/providers.js'

function catalogPrices(row: { provider: string; id: string; input_price_micros: number; output_price_micros?: number }) {
  const free = row.provider === 'Free' || row.provider.trim().toLowerCase() === 'free' || row.id.startsWith('free/')
  if (free) return { dollarsPer1M: 0, inputDollarsPer1M: 0, outputDollarsPer1M: 0 }
  const input = Math.max(0, Number(row.input_price_micros) || 0) / 1_000_000
  const storedOutput = Math.max(0, Number(row.output_price_micros) || 0) / 1_000_000
  const isJev =
    normalizeProviderName(row.provider) === 'Jev Group' ||
    isDecisionCatalogModelId(row.id)
  const output = storedOutput > 0 ? storedOutput : isJev ? 0 : input
  return { dollarsPer1M: input, inputDollarsPer1M: input, outputDollarsPer1M: output }
}
import { getAdminPromoEvent, getPublicPromoEvent, grantPromoAccess, liveDiscountMap, saveAdminPromoEvent } from './promoEvents.js'

import {
  isOpenPaymentStatus,
  normalizePaymentUiStatus,
  paymentStatusLabel,
} from '../shared/paymentStatus.js'
import {
  applyReferralCode,
  bindReferrerOnSignup,
  ensureUserReferralCode,
  getReferralSettings,
  setReferralSettings,
  userReferralStats,
} from './referrals.js'
import {
  getGatewayFairnessSettings,
  setGatewayFairnessSettings,
} from './gatewayFairness.js'
import { dispatchQueueStats } from './dispatchQueue.js'
import {
  createPromoCode,
  deletePromoCode,
  generatePromoCodeLocal,
  listPromoCodes,
  redeemPromoCode,
  updatePromoCode,
} from './promo.js'
import {
  getActivePromoBonus,
  getPromoBonusPct,
} from './promoBonus.js'
import { registerGatewayRoutes } from './gateway.js'

import {
  buildGoogleAuthorizeUrl,
  createOAuthState,
  exchangeGoogleCode,
  GOOGLE_GMAIL_ONLY_MESSAGE,
  googleConfigured,
  GOOGLE_OAUTH_STATE_COOKIE,
  isAllowedGoogleLoginEmail,
  siteBaseUrl,
  statesMatch,
} from './googleAuth.js'
import { enforceRateLimit, rateLimitKey, RL } from './rateLimit.js'

import {
  buildInstallScript,
  installMeta,
  isInstallTool,
  resolveInstallOs,
} from './installScripts.js'

import { parseSafeInt } from './db.js'

function hashApiKey(secret: string) {
  return createHash('sha256').update(secret).digest('hex')
}

function generateApiKeySecret() {
  const secret = `sk-${randomBytes(32).toString('hex')}`
  const prefix = `${secret.slice(0, 8)}…${secret.slice(-4)}`
  return { secret, prefix, secretHash: hashApiKey(secret) }
}

export function publicApiKey(row: {
  id: string
  name: string
  prefix: string
  secret?: string | null
  spend_limit_tokens: number | null
  spent_tokens: number
  status: string
  created_at: string
  last_used_at: string | null
}) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    // Customer convenience: dashboard can copy the full key after creation.
    secret: null,
    spendLimitTokens: row.spend_limit_tokens,
    spentTokens: row.spent_tokens ?? 0,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

function requireAdminHost(request: FastifyRequest, reply: FastifyReply) {
  const host = requestHostname(request.headers)
  if (!isAdminConsoleHost(host)) {
    reply.code(404).send({ error: 'Not found' })
    return false
  }
  return true
}

function devAdminAccessTokenUser(request: FastifyRequest) {
  // A local-development convenience only: never accept this header on production release.
  if (process.env.NODE_ENV === 'production') return null
  const site = String(process.env.SITE_URL ?? '').toLowerCase()
  if (!site.includes('localhost') && !site.includes('127.0.0.1') && !site.includes('dev.')) return null
  const expected = String(process.env.DEV_ADMIN_ACCESS_TOKEN ?? '').trim()
  const supplied = request.headers['x-admin-access-token']
  const token = typeof supplied === 'string' ? supplied.trim() : Array.isArray(supplied) ? String(supplied[0] ?? '').trim() : ''
  if (!expected || !token || token.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return null
  return { id: 'dev_access_token', email: 'dev-access-token@local', role: 'owner', expiresAt: '9999-12-31T23:59:59.000Z' }
}

function extractApiSecretFromRequest(request: FastifyRequest) {
  const header = request.headers.authorization
  if (header) {
    const [scheme, token] = header.split(' ')
    if (scheme && token && scheme.toLowerCase() === 'bearer') return token.trim()
  }
  const xKey = request.headers['x-api-key']
  if (typeof xKey === 'string' && xKey.trim()) return xKey.trim()
  if (Array.isArray(xKey) && xKey[0]?.trim()) return xKey[0].trim()
  return null
}

function resolveCustomerOrApiKeyUser(request: FastifyRequest) {
  const customer = getCustomerSessionUser(request)
  if (customer) {
    if (customer.status !== 'active') return null
    return customer.id
  }

  const secret = extractApiSecretFromRequest(request)
  if (secret) {
    const row = db
      .prepare(`
        SELECT k.user_id, k.status AS key_status, u.status AS user_status
        FROM api_keys k
        JOIN users u ON u.id = k.user_id
        WHERE k.secret_hash = ?
      `)
      .get(hashApiKey(secret)) as { user_id: string; key_status: string; user_status: string } | undefined
    if (row && row.key_status === 'active' && row.user_status === 'active') return row.user_id
  }
  return null
}

function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAdminHost(request, reply)) return null
  const user = getSessionUser(request) ?? devAdminAccessTokenUser(request)
  if (!user) {
    reply.code(401).send({ error: 'Unauthorized' })
    return null
  }
  return user
}

function requireCustomer(request: FastifyRequest, reply: FastifyReply) {
  const user = getCustomerSessionUser(request)
  if (!user) {
    reply.code(401).send({ error: 'Unauthorized' })
    return null
  }
  touchUserLastSeen(user.id)
  return user
}

function parseJson<T>(value: unknown, fallback: T = [] as unknown as T): T {
  try {
    return value ? (JSON.parse(String(value)) as T) : fallback
  } catch {
    return fallback
  }
}

function safeParseTags(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

function publicUser(user: {
  id: string
  email: string
  name: string
  status: string
  balanceTokens: number
  passwordHash?: string | null
  googleSub?: string | null
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    balanceTokens: user.balanceTokens,
    authMethod: 'email',
    loginEmail: user.email.includes('@') ? user.email : null,
    hasPassword: Boolean(user.passwordHash),
    googleLinked: Boolean(user.googleSub),
    level: getAccountLevel(user.id),
  }
}

function loadPublicUserById(userId: string) {
  const row = db
    .prepare(
      `SELECT id, name, email, status, balance_tokens, password_hash, google_sub
       FROM users WHERE id = ?`,
    )
    .get(userId) as
    | {
        id: string
        name: string
        email: string
        status: string
        balance_tokens: number
        password_hash: string | null
        google_sub: string | null
      }
    | undefined
  if (!row) return null
  return publicUser({
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    balanceTokens: row.balance_tokens,
    passwordHash: row.password_hash,
    googleSub: row.google_sub,
  })
}

function resolveAdminRecipient(
  recipientRaw: string,
):
  | { ok: true; userId: string }
  | { ok: false; status: 404 | 409; error: string } {
  const emailCandidate = recipientRaw.toLowerCase()
  const matches = db
    .prepare(
      `SELECT id FROM users
       WHERE lower(email) = ?
          OR id = ?
       LIMIT 5`,
    )
    .all(
      emailCandidate,
      recipientRaw,
    ) as Array<{ id: string }>

  if (matches.length === 0) {
    return { ok: false, status: 404, error: 'User not found for that email or ID' }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      status: 409,
      error: 'Multiple users matched that recipient. Use a more specific email.',
    }
  }
  return { ok: true, userId: matches[0].id }
}

export async function registerRoutes(app: FastifyInstance) {
  const retiredCustomerAuthPaths = new Set([
    '/api/user/register',
    '/api/user/login',
    '/api/user/verify-email',
    '/api/user/resend-verification',
    '/api/user/forgot-password',
    '/api/user/reset-password',
    '/api/user/bridge/email/start',
    '/api/user/bridge/email/confirm',
  ])
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0]
    if (request.method === 'POST' && path && retiredCustomerAuthPaths.has(path)) {
      return reply.code(410).send({ error: 'Email and password authentication has been retired. Continue with Google.' })
    }
  })

  app.get('/api/health', async () => ({ ok: true, service: 'api', ts: nowIso() }))

  /** Public model uptime from customer traffic. No synthetic probes. */
  app.get('/api/public/status', async (request, reply) => {
    if (
      !enforceRateLimit(
        reply,
        rateLimitKey(['public-status', request.ip]),
        RL.publicStatusIp.limit,
        RL.publicStatusIp.windowMs,
        'Too many status checks. Slow down.',
      )
    ) {
      return
    }

    const { buildModelUptime } = await import('./modelUptime.js')
    return buildModelUptime()
  })

  app.get('/api/install/meta', async () => installMeta())

  async function catalogHealthById() {
    const { getModelStatusMap, getModelStatusMeta, refreshAllModelStatuses, rematchCachedStatuses } =
      await import('./modelStatusPoller.js')
    if (!getModelStatusMeta().checkedAt) {
      await refreshAllModelStatuses(true)
    } else {
      rematchCachedStatuses()
    }
    return {
      health: getModelStatusMap(),
      healthCheckedAt: getModelStatusMeta().checkedAt,
    }
  }

  app.get('/api/public/brand', async () => publicBrand())

  app.get('/api/public/links', async () => getSiteLinks())

  app.get('/api/public/rate-limits', async () => {
    const plans = publicRpmPlans()
    const free = plans.find((plan) => plan.key === 'free')
    const paid = plans.filter((plan) => plan.key === 'standard' || plan.key === 'high')
    return {
      plans,
      supportUrl: getSiteLinks().telegramSupport,
      rpmFree: free?.rpm ?? 5,
      rpmSubscription: paid[0]?.rpm ?? 30,
      subscriberPriority: getGatewayFairnessSettings().subscriberPriority,
    }
  })

  app.get('/api/public/levels', async () => {
    const levels = getLevelSettings()
    return {
      levels,
      totalToMaxUsd: levels.reduce((sum, row) => sum + (row.level === 1 ? 0 : row.topupUsd), 0),
    }
  })

  app.get('/api/public/models', async () => {
    const rows = db
      .prepare(
        `SELECT id, provider, name, context_window, COALESCE(token_weight, 1) AS token_weight,
                COALESCE(input_price_micros, 0) AS input_price_micros,
                COALESCE(output_price_micros, 0) AS output_price_micros,
                COALESCE(sort_order, 0) AS sort_order, tags_json
         FROM model_catalog
         WHERE status = 'active'
         ORDER BY COALESCE(sort_order, 0) ASC, name ASC`,
      )
      .all() as Array<{
      id: string
      provider: string
      name: string
      context_window: string
      token_weight: number
      input_price_micros: number
      output_price_micros: number
      sort_order: number
      tags_json: string
    }>
    const { health, healthCheckedAt } = await catalogHealthById()
    const models = rows.map((row) => ({
      id: row.id,
      provider: normalizeProviderName(row.provider),
      name: row.name,
      contextWindow: row.context_window,
      weight: null,
      levelWeight: row.provider === 'Free' || row.id.startsWith('free/'),
      ...catalogPrices(row),
      tags: parseJson<string[]>(row.tags_json),
      health: health[row.id] ?? 'no_data',
    }))
    const paidPrices = models.map((model) => model.dollarsPer1M).filter((price) => price > 0)
    return {
      models,
      fromDollarsPer1M: paidPrices.length ? Math.min(...paidPrices) : 0,
      healthCheckedAt,
    }
  })

  app.get('/api/public/promo-event', async () => getPublicPromoEvent())

  const handlePublicTokens = async () => {
    const settings = getSubscriptionSettings()
    return {
      freeDailyTokens: settings.freeDailyTokens,
      plans: settings.plans
        .filter((plan) => plan.enabled)
        .map((plan) => ({
          key: plan.key,
          label: plan.label,
          days: plan.days,
          kind: plan.kind,
          tokenLimit: plan.kind === 'unlimited' ? null : plan.tokenLimit,
          priceCents: plan.priceCents,
          priceUsd: plan.priceCents / 100,
          isFeatured: Boolean(plan.isFeatured),
        })),
    }
  }
  app.get('/api/public/subscriptions', handlePublicTokens)

  app.get('/i', async (request, reply) => {
    if (
      !enforceRateLimit(
        reply,
        rateLimitKey(['install', request.ip]),
        RL.installIp.limit,
        RL.installIp.windowMs,
        'Too many install script requests',
      )
    ) {
      return
    }
    const query = request.query as { tool?: string; os?: string }
    const toolRaw = (query.tool ?? 'cursor').toLowerCase()
    if (!isInstallTool(toolRaw)) {
      return reply.code(400).send({
        error: 'Unknown tool. Use tool=cursor|opencode|codex|claude|claude-desktop|kimi',
      })
    }
    const os = resolveInstallOs(query.os, request.headers['user-agent'])
    const script = buildInstallScript(toolRaw, os)
    const filename =
      os === 'windows' ? `${brandSlug()}-${toolRaw}.ps1` : `${brandSlug()}-${toolRaw}.sh`
    reply.header('Content-Type', 'text/plain; charset=utf-8')
    reply.header('Content-Disposition', `inline; filename="${filename}"`)
    reply.header('Cache-Control', 'no-store')
    return reply.send(script)
  })

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (request, reply) => {
    if (!requireAdminHost(request, reply)) return
    if (
      !enforceRateLimit(
        reply,
        rateLimitKey(['admin-login', request.ip]),
        RL.adminLoginIp.limit,
        RL.adminLoginIp.windowMs,
        'Too many login attempts. Try again later.',
      )
    ) {
      return
    }
    const password = request.body.password ?? ''
    if (!password) return reply.code(400).send({ error: 'Password is required' })

    // Single-owner console: match password only (no email field).
    const admins = db
      .prepare('SELECT id, email, password_hash, role FROM admin_users ORDER BY created_at ASC')
      .all() as Array<{ id: string; email: string; password_hash: string; role: string }>
    const admin = admins.find((row) => verifyPassword(password, row.password_hash))
    if (!admin) {
      return reply.code(401).send({ error: 'Invalid password' })
    }

    const session = createAdminSession(admin.id)

    db.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(nowIso(), admin.id)
    db.prepare(
      'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id('audit'),
      admin.email,
      'auth.login',
      admin.id,
      '{}',
      nowIso(),
    )
    setSessionCookie(reply, session.sessionId, session.expiresAt)
    return {
      pending: false as const,
      user: { id: admin.id, email: admin.email, role: admin.role },
      expiresAt: session.expiresAt,
    }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    if (!requireAdminHost(request, reply)) return
    if (
      !enforceRateLimit(
        reply,
        rateLimitKey(['admin-logout', request.ip]),
        RL.logoutIp.limit,
        RL.logoutIp.windowMs,
        'Too many logout requests. Try again shortly.',
      )
    ) {
      return
    }
    const user = getSessionUser(request)
    const sessionId = request.cookies[ADMIN_SESSION_COOKIE]
    if (sessionId) destroySession(sessionId)
    clearSessionCookie(reply)
    if (user) {
      db.prepare(
        'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id('audit'), user.email, 'auth.logout', user.id, '{}', nowIso())
    }
    return { ok: true }
  })

  app.get('/api/auth/me', async (request, reply) => {
    const user = requireAuth(request, reply)
    if (!user) return
    return { user: { id: user.id, email: user.email, role: user.role }, expiresAt: user.expiresAt }
  })

  app.get('/api/user/auth/challenge', async (request, reply) => {
    if (
      !enforceRateLimit(
        reply,
        rateLimitKey(['auth-challenge', request.ip]),
        RL.challengeIp.limit,
        RL.challengeIp.windowMs,
      )
    ) {
      return
    }
    return {
      enabled: false,
      siteKey: null,
      emailConfigured: false,
      googleEnabled: googleConfigured(),
    }
  })

  app.get('/api/user/auth/google', async (request, reply) => {
    if (!googleConfigured()) {
      return reply.code(503).send({ error: 'Google sign-in is not configured' })
    }

    if (
      !enforceRateLimit(
        reply,
        rateLimitKey(['google-start', request.ip]),
        RL.googleStartIp.limit,
        RL.googleStartIp.windowMs,
        'Too many Google sign-in attempts. Try again later.',
      )
    ) {
      return
    }

    const state = createOAuthState()
    reply.setCookie(GOOGLE_OAUTH_STATE_COOKIE, state, oauthStateCookieOptions())
    return reply.redirect(buildGoogleAuthorizeUrl(state))
  })

  app.get<{
    Querystring: { code?: string; state?: string; error?: string; error_description?: string }
  }>('/api/user/auth/google/callback', async (request, reply) => {
    const site = siteBaseUrl()
    const fail = (message: string) =>
      reply.redirect(
        `${site}/login?auth_error=${encodeURIComponent(message)}`,
      )

    const oauthCookie = oauthStateCookieOptions()
    reply.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, oauthCookie)
    // Clear host-only legacy cookie if present.
    reply.clearCookie(GOOGLE_OAUTH_STATE_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    })

    if (!googleConfigured()) return fail('Google sign-in is not configured')
    if (request.query.error) {
      return fail(request.query.error_description || request.query.error || 'Google sign-in cancelled')
    }

    const code = request.query.code
    const state = request.query.state
    const expectedState = request.cookies[GOOGLE_OAUTH_STATE_COOKIE]
    if (!code || !statesMatch(expectedState, state)) {
      return fail('Invalid Google sign-in state. Try again.')
    }

    let profile
    try {
      profile = await exchangeGoogleCode(code)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google sign-in failed'
      return fail(msg)
    }

    if (!profile.emailVerified) {
      return fail('Your Google email is not verified')
    }
    if (!isAllowedGoogleLoginEmail(profile.email)) {
      return fail(GOOGLE_GMAIL_ONLY_MESSAGE)
    }

    const now = nowIso()

    // --- Normal Google login / register ---
    const existingBySub = db
      .prepare(
        `SELECT id, email, name, plan, status, balance_tokens, google_sub
         FROM users WHERE google_sub = ?`,
      )
      .get(profile.sub) as
      | {
          id: string
          email: string
          name: string
          plan: string
          status: string
          balance_tokens: number
          google_sub: string | null
        }
      | undefined

    const existingByEmail = db
      .prepare(
        `SELECT id, email, name, plan, status, balance_tokens, google_sub
         FROM users WHERE email = ?`,
      )
      .get(profile.email) as
      | {
          id: string
          email: string
          name: string
          plan: string
          status: string
          balance_tokens: number
          google_sub: string | null
        }
      | undefined

    if (
      existingBySub &&
      existingByEmail &&
      existingBySub.id !== existingByEmail.id
    ) {
      return fail('This Google account is already linked to another user')
    }

    if (existingByEmail?.google_sub && existingByEmail.google_sub !== profile.sub) {
      return fail('This email is already linked to a different Google account')
    }

    let user = existingBySub ?? existingByEmail
    const isNewUser = !user

    if (user) {
      if (isEmailBlocked(profile.email)) {
        return fail(BLOCKED_EMAIL_MESSAGE)
      }
      if (user.status === 'suspended') {
        return fail('This account is suspended')
      }
      db.prepare(
        `UPDATE users
         SET google_sub = ?, name = COALESCE(NULLIF(?, ''), name),
             status = 'active', email_verified_at = COALESCE(email_verified_at, ?),
             last_seen_at = ?
         WHERE id = ?`,
      ).run(profile.sub, profile.name, now, now, user.id)

      user = {
        ...user,
        name: profile.name || user.name,
        status: 'active',
        google_sub: profile.sub,
      }
    } else {
      if (isEmailBlocked(profile.email)) {
        return fail(BLOCKED_EMAIL_MESSAGE)
      }
      if (!isAllowedEmailDomain(profile.email)) {
        return fail(ALLOWED_EMAIL_DOMAINS_HINT)
      }
      const userId = id('user')
      let displayId = nextUserDisplayId()
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          db.prepare(`
            INSERT INTO users
              (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at, last_seen_at,
               password_hash, email_verified_at, google_sub, display_id, auth_method)
            VALUES (?, ?, ?, 'default', 'active', 0, 0, 0, ?, ?, NULL, ?, ?, ?, 'email')
          `).run(
            userId,
            profile.name,
            profile.email,
            now,
            now,
            now,
            profile.sub,
            displayId,
          )
          break
        } catch (err: any) {
          if (
            attempt < 4 &&
            (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
              err?.code === 'SQLITE_CONSTRAINT' ||
              String(err?.message).includes('display_id'))
          ) {
            displayId = Math.max(nextUserDisplayId(), displayId + 1)
            continue
          }
          throw err
        }
      }
      user = {
        id: userId,
        email: profile.email,
        name: profile.name,
        plan: 'default',
        status: 'active',
        balance_tokens: 0,
        google_sub: profile.sub,
      }
    }

    const session = createUserSession(user.id)
    setUserSessionCookie(reply, session.sessionId, session.expiresAt)
    ensureUserReferralCode(user.id)
    const refCookie = request.cookies.ref_code
    bindReferrerOnSignup(user.id, refCookie)
    reply.clearCookie('ref_code', { path: '/' })
    return reply.redirect(`${site}/overview${isNewUser ? '?signed_up=1' : ''}`)
  })

  app.post('/api/user/logout', async (request, reply) => {
    if (
      !enforceRateLimit(
        reply,
        rateLimitKey(['user-logout', request.ip]),
        RL.logoutIp.limit,
        RL.logoutIp.windowMs,
        'Too many logout requests. Try again shortly.',
      )
    ) {
      return
    }
    const sessionId = request.cookies[USER_SESSION_COOKIE]
    if (sessionId) destroyUserSession(sessionId)
    clearUserSessionCookie(reply)
    return { ok: true }
  })

  app.get('/api/user/me', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return
    const pub = loadPublicUserById(user.id) ?? publicUser(user)
    return {
      user: pub,
      expiresAt: user.expiresAt,
    }
  })

  app.post('/api/user/level/ack', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return
    return { level: ackLevelCelebration(user.id) }
  })

  app.get('/api/admin/levels', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    return { levels: getLevelSettings() }
  })

  app.patch<{ Body: { levels?: unknown } }>('/api/admin/levels', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    try {
      const levels = saveLevelSettings(request.body?.levels)
      db.prepare(
        `INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at)
         VALUES (?, ?, 'levels.updated', 'account_levels', ?, ?)`,
      ).run(id('audit'), actor.email, JSON.stringify(levels), nowIso())
      return { ok: true, levels }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not save levels' })
    }
  })

  app.get('/api/admin/promo-event', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    return getAdminPromoEvent()
  })

  app.put<{ Body: Record<string, unknown> }>('/api/admin/promo-event', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    try {
      const saved = saveAdminPromoEvent(request.body ?? {})
      db.prepare(
        `INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at)
         VALUES (?, ?, 'promo_event.updated', 'promo_event', ?, ?)`,
      ).run(id('audit'), actor.email, JSON.stringify(saved.event), nowIso())
      return { ok: true, ...saved }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not save the event' })
    }
  })

  app.post<{ Body: { email?: string } }>('/api/admin/promo-event/grant', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    try {
      const result = grantPromoAccess(request.body?.email ?? '')
      db.prepare(
        `INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at)
         VALUES (?, ?, 'promo_event.granted', ?, ?, ?)`,
      ).run(id('audit'), actor.email, result.email, JSON.stringify({ email: result.email }), nowIso())
      return result
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Could not grant access' })
    }
  })

  app.all('/api/user/settings/low-balance-alert', async (_request, reply) => {
    return reply.code(410).send({ error: 'Low-balance alerts have been retired' })
  })

  app.all('/api/user/alerts/low-balance', async (_request, reply) => {
    return reply.code(410).send({ error: 'Low-balance alerts have been retired' })
  })



  app.get('/api/user/rewards', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return
    const stats = userReferralStats(user.id)
    const referral = getReferralSettings()
    return {
      referral: {
        enabled: referral.enabled,
        code: stats.code,
        invited: stats.invited,
        rewarded: stats.rewarded,
        earnedUsd: stats.earnedUsd,
        referredByCode: stats.referredByCode,
        hasReferrer: stats.hasReferrer,
        rewardGranted: stats.rewardGranted,
        minPurchaseDollars: referral.minPurchaseCents / 100,
        referrerRewardUsd: referral.referrerRewardCents / 100,
        refereeRewardUsd: referral.refereeRewardCents / 100,
      },
    }
  })

  app.post<{ Body: { code?: string } }>('/api/user/rewards/apply', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return
    if (
      !enforceRateLimit(
        reply,
        rateLimitKey(['referral-apply', user.id]),
        10,
        60_000,
        'Too many referral attempts. Try again shortly.',
      )
    ) {
      return
    }
    try {
      const applied = applyReferralCode(user.id, request.body?.code)
      const stats = userReferralStats(user.id)
      const referral = getReferralSettings()
      logUserActivity({
        action: 'referral.apply',
        userId: user.id,
        target: applied.referredByCode,
        meta: { rewardGranted: stats.rewardGranted || applied.rewardGranted },
      })
      return {
        ok: true,
        referral: {
          enabled: referral.enabled,
          code: stats.code,
          invited: stats.invited,
          rewarded: stats.rewarded,
          earnedUsd: stats.earnedUsd,
          referredByCode: stats.referredByCode,
          hasReferrer: stats.hasReferrer,
          rewardGranted: stats.rewardGranted,
          minPurchaseDollars: referral.minPurchaseCents / 100,
          referrerRewardUsd: referral.referrerRewardCents / 100,
          refereeRewardUsd: referral.refereeRewardCents / 100,
        },
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not apply referral code'
      const status =
        reason && typeof reason === 'object' && 'statusCode' in reason
          ? Number((reason as { statusCode?: number }).statusCode) || 400
          : 400
      return reply.code(status).send({ error: message })
    }
  })

  app.post<{ Body: { code?: string } }>(
    '/api/user/promo/redeem',
    async (request, reply) => {
      const user = requireCustomer(request, reply)
      if (!user) return
      if (
        !enforceRateLimit(
          reply,
          rateLimitKey(['promo-redeem', user.id]),
          RL.promoRedeemUser.limit,
          RL.promoRedeemUser.windowMs,
          'Too many promo attempts. Try again shortly.',
        )
      ) {
        return
      }

      try {
        const result = redeemPromoCode({
          userId: user.id,
          code: request.body.code ?? '',
        })
        const updatedUser = loadPublicUserById(user.id) ?? publicUser(user)
        const freeTier = getFreeTierAccess(user.id)
        return {
          ok: true,
          type: result.type,
          usd: result.usd,
          tokens: result.tokens,
          code: result.code,
          bonusPercent: result.bonusPercent,
          bonusTarget: result.bonusTarget,
          planLabel: result.planLabel ?? null,
          offerLabel: result.offerLabel ?? null,
          expiresAt: result.expiresAt ?? null,
          extended: result.extended ?? false,
          redeemedAt: result.redeemedAt,
          user: updatedUser,
          freeTier,
        }
      } catch (reason) {
        return reply.code(400).send({
          error: reason instanceof Error ? reason.message : 'Could not redeem promo code',
        })
      }
    },
  )

  /**
   * Dedicated Voucher Redemption endpoint (for web or API).
   * Authenticated via Customer session or API key (Bearer sk-... / x-api-key).
   * Atomically redeems code and prevents double credit.
   */
  app.post<{ Body: { code?: string; voucher?: string } }>(
    '/api/vouchers/redeem',
    async (request, reply) => {
      const userId = resolveCustomerOrApiKeyUser(request)
      if (!userId) {
        return reply.code(401).send({
          error: 'Unauthorized. Log in or provide API key via Bearer token or x-api-key header.',
        })
      }

      if (
        !enforceRateLimit(
          reply,
          rateLimitKey(['voucher-redeem-user', userId]),
          RL.voucherRedeemUser.limit,
          RL.voucherRedeemUser.windowMs,
          'Too many voucher attempts for this account. Please wait a minute before trying again.',
        )
      ) {
        return
      }

      const codeRaw = (request.body?.code ?? request.body?.voucher ?? '').trim()
      if (!codeRaw) {
        return reply.code(400).send({ error: 'Voucher code is required' })
      }

      try {
        const result = redeemPromoCode({
          userId,
          code: codeRaw,
        })
        const updatedUser = loadPublicUserById(userId)
        return {
          ok: true,
          code: result.code,
          status: 'Redeemed',
          creditedUsd: result.usd,
          creditedTokens: result.tokens,
          redeemedTimestamp: result.redeemedAt,
          balanceTokens: updatedUser?.balanceTokens,
          balanceUsd: updatedUser ? updatedUser.balanceTokens / TOKENS_PER_USD : undefined,
        }
      } catch (reason) {
        return reply.code(400).send({
          error: reason instanceof Error ? reason.message : 'Could not redeem voucher',
        })
      }
    },
  )

  app.get('/api/user/keys', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return
    const rows = db
      .prepare(
        `SELECT id, name, prefix, spend_limit_tokens, spent_tokens, status, created_at, last_used_at
         FROM api_keys
         WHERE user_id = ? AND status = 'active' AND name != '__playground'
         ORDER BY datetime(created_at) DESC`,
      )
      .all(user.id) as Array<{
      id: string
      name: string
      prefix: string
      spend_limit_tokens: number | null
      spent_tokens: number
      status: string
      created_at: string
      last_used_at: string | null
    }>
    return { keys: rows.map((row) => publicApiKey(row)) }
  })

  app.post<{
    Body: { name?: string; spendLimitTokens?: number | null; spendLimitDollars?: number | null }
  }>('/api/user/keys', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return


    if (
      !enforceRateLimit(
        reply,
        rateLimitKey(['keys-create', user.id]),
        RL.keysCreateUser.limit,
        RL.keysCreateUser.windowMs,
        'Too many API keys created. Try again later.',
      )
    ) {
      return
    }

    const name = request.body.name?.trim() || 'Untitled key'
    const spendLimitTokens: number | null = null

    const { secret, prefix, secretHash } = generateApiKeySecret()
    const keyId = id('key')
    const createdAt = nowIso()
    db.prepare(
      `INSERT INTO api_keys
        (id, user_id, name, prefix, secret_hash, secret, spend_limit_tokens, spent_tokens, status, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 'active', ?, NULL)`,
    ).run(keyId, user.id, name, prefix, secretHash, spendLimitTokens, createdAt)

    logUserActivity({
      action: 'api_key.created',
      userId: user.id,
      target: keyId,
      meta: { name, prefix, spendLimitTokens },
    })

    return {
      key: publicApiKey({
        id: keyId,
        name,
        prefix,
        spend_limit_tokens: spendLimitTokens,
        spent_tokens: 0,
        status: 'active',
        created_at: createdAt,
        last_used_at: null,
      }),
      secret,
    }
  })

  app.post<{ Params: { id: string } }>('/api/user/keys/:id/revoke', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return

    const existing = db
      .prepare(`SELECT id, status FROM api_keys WHERE id = ? AND user_id = ?`)
      .get(request.params.id, user.id) as { id: string; status: string } | undefined

    if (!existing) {
      return reply.code(404).send({ error: 'API key not found' })
    }
    if (existing.status === 'revoked') {
      return { ok: true }
    }

    db.prepare(`UPDATE api_keys SET status = 'revoked' WHERE id = ? AND user_id = ?`).run(
      request.params.id,
      user.id,
    )
    logUserActivity({
      action: 'api_key.revoked',
      userId: user.id,
      target: request.params.id,
    })
    return { ok: true }
  })

  app.get('/api/user/models', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return
    const rows = db
      .prepare(
        `SELECT id, provider, name, context_window, COALESCE(token_weight, 1) AS token_weight,
                COALESCE(input_price_micros, 0) AS input_price_micros,
                COALESCE(output_price_micros, 0) AS output_price_micros,
                COALESCE(sort_order, 0) AS sort_order, tags_json
         FROM model_catalog
         WHERE status = 'active'
         ORDER BY COALESCE(sort_order, 0) ASC, name ASC`,
      )
      .all() as Array<{
      id: string
      provider: string
      name: string
      context_window: string
      token_weight: number
      input_price_micros: number
      output_price_micros: number
      sort_order: number
      tags_json: string
    }>
    const { health, healthCheckedAt } = await catalogHealthById()
    const discounts = liveDiscountMap(user.id)
    const models = rows.map((row) => ({
      id: row.id,
      provider: normalizeProviderName(row.provider),
      name: row.name,
      contextWindow: row.context_window,
      weight: null,
      levelWeight: row.provider === 'Free' || row.id.startsWith('free/'),
      ...catalogPrices(row),
      eventDiscountPct: discounts.get(row.id) ?? null,
      tags: parseJson<string[]>(row.tags_json),
      health: health[row.id] ?? 'no_data',
    }))
    return { models, healthCheckedAt }
  })

  app.get<{
    Querystring: {
      keyId?: string
      status?: string
      limit?: string
      offset?: string
    }
  }>('/api/user/usage', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return

    const keyId = String(request.query.keyId ?? '').trim()
    const statusRaw = String(request.query.status ?? 'all').trim().toLowerCase()
    const status = statusRaw === 'ok' || statusRaw === 'error' ? statusRaw : 'all'
    const limit = parseSafeInt(request.query.limit, 50, 1, 100)
    const offset = parseSafeInt(request.query.offset, 0, 0, 1_000_000)

    if (keyId) {
      const owns = db
        .prepare(`SELECT id FROM api_keys WHERE id = ? AND user_id = ?`)
        .get(keyId, user.id)
      if (!owns) return reply.code(404).send({ error: 'API key not found' })
    }

    const where = ['e.user_id = ?']
    const params: Array<string | number> = [user.id]
    if (keyId) {
      where.push('e.api_key_id = ?')
      params.push(keyId)
    }
    if (status !== 'all') {
      where.push('e.status = ?')
      params.push(status)
    }
    const whereSql = where.join(' AND ')

    const total = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM usage_events e WHERE ${whereSql}`)
        .get(...params) as { c: number }
    ).c

    const rows = db
      .prepare(
        `SELECT e.id, e.model_id, e.provider, e.input_tokens, e.output_tokens, e.cost_tokens,
                CASE WHEN COALESCE(e.allowance_weight, 0) > 0 THEN e.allowance_weight ELSE COALESCE(m.token_weight, 1) END AS token_weight,
                e.latency_ms, e.status, e.created_at, e.api_key_id,
                k.prefix AS key_prefix, k.name AS key_name
         FROM usage_events e
         LEFT JOIN api_keys k ON k.id = e.api_key_id
         LEFT JOIN model_catalog m ON m.id = e.model_id
         WHERE ${whereSql}
         ORDER BY datetime(e.created_at) DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<{
      id: string
      model_id: string | null
      provider: string
      input_tokens: number
      output_tokens: number
      cost_tokens: number
      token_weight: number
      latency_ms: number
      status: string
      created_at: string
      api_key_id: string | null
      key_prefix: string | null
      key_name: string | null
    }>

    const keys = db
      .prepare(
        `SELECT id, name, prefix FROM api_keys
         WHERE user_id = ? AND status = 'active' AND name != '__playground'
         ORDER BY datetime(created_at) DESC`,
      )
      .all(user.id) as Array<{ id: string; name: string; prefix: string }>

    return {
      total,
      limit,
      offset,
      keys: keys.map((key) => ({ id: key.id, name: key.name, prefix: key.prefix })),
      events: rows.map((row) => ({
        id: row.id,
        modelId: row.model_id,
        provider: row.provider,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costTokens: row.cost_tokens,
        tokenWeight: row.token_weight,
        freeModel: String(row.provider).toLowerCase() === 'free',
        costUsd: usdFromTokens(row.cost_tokens),
        latencyMs: row.latency_ms,
        status: row.status,
        createdAt: row.created_at,
        apiKeyId: row.api_key_id,
        keyPrefix: row.key_prefix,
        keyName: row.key_name,
      })),
    }
  })

  app.get('/api/user/stats', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return

    const monthStart = new Date()
    monthStart.setUTCDate(1)
    monthStart.setUTCHours(0, 0, 0, 0)
    const monthIso = monthStart.toISOString()

    const spendMonth = db
      .prepare(
        `SELECT COALESCE(SUM(
            CASE
              WHEN lower(COALESCE(m.provider, e.provider)) = 'free'
                OR lower(COALESCE(e.model_id, '')) LIKE 'free/%'
              THEN (e.input_tokens + e.output_tokens) * (
                CASE
                  WHEN COALESCE(e.allowance_weight, 0) > 0 THEN e.allowance_weight
                  WHEN COALESCE(m.token_weight, 0) > 0 THEN m.token_weight
                  ELSE 1
                END
              )
              ELSE COALESCE(e.cost_tokens, 0)
            END
          ), 0) AS tokens
         FROM usage_events e
         LEFT JOIN model_catalog m ON m.id = e.model_id
         WHERE e.user_id = ?
           AND e.status = 'ok'
           AND e.created_at >= ?`,
      )
      .get(user.id, monthIso) as { tokens: number }

    const requestsMonth = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM usage_events
         WHERE user_id = ? AND datetime(created_at) >= datetime(?)`,
      )
      .get(user.id, monthIso) as { count: number }

    const requestsTotal = db
      .prepare(`SELECT COUNT(*) AS count FROM usage_events WHERE user_id = ?`)
      .get(user.id) as { count: number }

    const activeKeys = db
      .prepare(`SELECT COUNT(*) AS count FROM api_keys WHERE user_id = ? AND status = 'active'`)
      .get(user.id) as { count: number }

    const topupRow = db
      .prepare(
        `SELECT 1 AS ok FROM crypto_payments
         WHERE user_id = ? AND credited_at IS NOT NULL
         LIMIT 1`,
      )
      .get(user.id) as { ok: number } | undefined

    const weeklyRaw = db
      .prepare(
        `SELECT DATE(e.created_at) AS day,
                COALESCE(SUM(e.input_tokens + e.output_tokens), 0) AS spend_tokens,
                COUNT(*) AS requests
         FROM usage_events e
         WHERE e.user_id = ?
           AND e.status = 'ok'
           AND datetime(e.created_at) >= datetime('now', '-6 days')
         GROUP BY DATE(e.created_at)
         ORDER BY day ASC`,
      )
      .all(user.id) as Array<{ day: string; spend_tokens: number; requests: number }>

    const weeklyMap = new Map(weeklyRaw.map((row) => [row.day, row]))
    const weekly: Array<{ day: string; spend_tokens: number; requests: number }> = []
    const now = new Date()
    for (let offset = 6; offset >= 0; offset -= 1) {
      // Match SQLite DATE(created_at) which is UTC for ISO timestamps.
      const key = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset))
        .toISOString()
        .slice(0, 10)
      weekly.push(weeklyMap.get(key) ?? { day: key, spend_tokens: 0, requests: 0 })
    }

    const recent = db
      .prepare(
        `SELECT e.id, e.model_id, e.provider, e.input_tokens, e.output_tokens, e.cost_tokens, e.latency_ms, e.status, e.created_at,
                k.prefix AS key_prefix
         FROM usage_events e
         LEFT JOIN api_keys k ON k.id = e.api_key_id
         WHERE e.user_id = ?
         ORDER BY datetime(e.created_at) DESC
         LIMIT 50`,
      )
      .all(user.id) as Array<{
      id: string
      model_id: string | null
      provider: string
      input_tokens: number
      output_tokens: number
      cost_tokens: number
      latency_ms: number
      status: string
      created_at: string
      key_prefix: string | null
    }>

    return {
      spendMonthTokens: spendMonth.tokens,
      requestsMonth: requestsMonth.count,
      requestsTotal: requestsTotal.count,
      activeKeys: activeKeys.count,
      hasTopup: Boolean(topupRow),
      telegramVerified: true,
      // Free-model allowance shown next to the balance on Overview.
      freeTier: getFreeTierAccess(user.id),
      weekly,
      recent: recent.map((row) => ({
        id: row.id,
        modelId: row.model_id,
        provider: row.provider,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costTokens: row.cost_tokens,
        latencyMs: row.latency_ms,
        status: row.status,
        createdAt: row.created_at,
        keyPrefix: row.key_prefix,
      })),
    }
  })

  /** Subscription plans and the caller's current free-model allowance. */
  const handleUserTokens = async (request: any, reply: any) => {
    const user = requireCustomer(request, reply)
    if (!user) return
    const settings = getSubscriptionSettings()
    const methods = subscriptionPayMethods()
    const promoBoost = getActivePromoBonus(user.id)
    const promoBonusPct = getPromoBonusPct(user.id, 'subscription')
    const offer = getActiveSubscriptionOffer(user.id)
    const fairness = getGatewayFairnessSettings()
    const plans = settings.plans
      .filter((plan) => plan.enabled)
      .map((plan) => {
        const listCents = Math.max(0, Math.round(plan.priceCents))
        const amountCents = applyOfferCents(listCents, offer)
        const bonus = applyCombinedSubscriptionBonus(user.id, plan.kind === 'unlimited' ? 0 : plan.tokenLimit)
        return {
          key: plan.key,
          label: plan.label,
          days: plan.days,
          kind: plan.kind,
          tokenLimit: plan.kind === 'unlimited' ? null : bonus.tokens,
          baseTokenLimit: plan.kind === 'unlimited' ? null : plan.tokenLimit,
          bonusTokens: bonus.bonusTokens,
          bonusPct: bonus.totalBonusPct,
          promoBonusPct: bonus.promoBonusPct,
          priceCents: amountCents,
          priceUsd: amountCents / 100,
          listPriceCents: listCents,
          listPriceUsd: listCents / 100,
          isFeatured: Boolean(plan.isFeatured),
        }
      })
    return {
      access: getFreeTierAccess(user.id),
      subscription: getActiveSubscription(user.id),
      freeDailyTokens: settings.freeDailyTokens,
      resetsAt: nextUtcResetIso(),
      rpmFree: fairness.rpmFree,
      rpmSubscription: fairness.rpmSubscription,
      plans,
      history: getSubscriptionHistory(user.id),
      promoBoost:
        promoBonusPct > 0 && promoBoost
          ? {
              bonusPct: promoBonusPct,
              target: promoBoost.target,
              expiresAt: promoBoost.expiresAt,
            }
          : null,
      cardEnabled: false,
      offer,
      payMethods: methods,
      solanaEnabled: false,
    }
  }
  app.get('/api/user/subscriptions', handleUserTokens)

  app.get('/api/user/rpm', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return
    return userRpmState(user.id)
  })

  app.post<{ Body: { plan?: string } }>('/api/user/rpm/purchase', async (_request, reply) => {
    return reply.code(400).send({ error: 'Crypto RPM checkout is currently disabled' })
  })

  app.get<{ Querystring: { paymentId?: string } }>('/api/user/rpm/payment-status', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return
    const paymentId = String(request.query.paymentId ?? '').trim()
    if (!paymentId) return reply.code(400).send({ error: 'paymentId required' })
    const pub = getRpmPaymentPublic(paymentId, user.id)
    if (!pub) return reply.code(404).send({ error: 'Payment not found' })
    return {
      ...pub,
      confirming: !pub.credited && (pub.status === 'confirming' || pub.status === 'sending' || pub.status === 'confirmed'),
      rpm: userRpmState(user.id),
    }
  })

  const handleTokenQuote = async (request: any, reply: any) => {
    const user = requireCustomer(request, reply)
    if (!user) return
    try {
      const planKey = String(request.query.plan ?? '').trim()
      if (!isSubscriptionPlanKey(planKey)) return reply.code(400).send({ error: 'Invalid plan' })
      const tokens = request.query.tokens != null ? Number(request.query.tokens) : undefined
      return await quoteSubscription({ planKey, asset: 'CRYPTO', userId: user.id, tokens })
    } catch (reason) {
      return reply
        .code(400)
        .send({ error: reason instanceof Error ? reason.message : 'Could not quote' })
    }
  }
  app.get('/api/user/subscriptions/quote', handleTokenQuote)

  const handleTokenPurchase = async (_request: any, reply: any) => {
    return reply.code(400).send({ error: 'Crypto payments are currently disabled' })
  }
  app.post('/api/user/subscriptions/purchase', handleTokenPurchase)

  app.post('/api/user/subscriptions/card', async (_request, reply) => {
    return reply.code(400).send({ error: 'Card payments are currently disabled' })
  })

  const handleTokenSubmit = async (_request: any, reply: any) => {
    return reply.code(400).send({ error: 'Direct blockchain submissions are disabled' })
  }
  app.post('/api/user/subscriptions/submit', handleTokenSubmit)

  const handleTokenPaymentStatus = async (request: any, reply: any) => {
    const user = requireCustomer(request, reply)
    if (!user) return
    const paymentId = String(request.query.paymentId ?? '').trim()
    if (!paymentId) return reply.code(400).send({ error: 'paymentId required' })
    try {
      const pub = getSubscriptionPaymentPublic(paymentId, user.id)
      if (!pub) return reply.code(404).send({ error: 'Payment not found' })
      if (pub.credited) {
        return {
          credited: true as const,
          already: true as const,
          status: pub.status,
          access: getFreeTierAccess(user.id),
          subscription: getActiveSubscription(user.id),
        }
      }
      if (pub.provider === 'crypto') {
        return {
          credited: false as const,
          status: pub.status,
          confirming: pub.status === 'confirming' || pub.status === 'confirmed' || pub.status === 'sending',
        }
      }
      return await verifyAndCreditSubscriptionPayment(paymentId)
    } catch (reason) {
      return reply
        .code(400)
        .send({ error: reason instanceof Error ? reason.message : 'Status check failed' })
    }
  }
  app.get('/api/user/subscriptions/payment-status', handleTokenPaymentStatus)

  app.get('/api/user/billing/config', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return
    const minTopupCents = getMinTopupCents()
    const presets = [5, 10, 20, 50]
      .map((dollars) => dollars * 100)
      .filter((cents) => cents >= minTopupCents)
    const promoBoost = getActivePromoBonus(user.id)
    const promoBonusPct = getPromoBonusPct(user.id, 'topup')
    return {
      minTopupCents,
      presets,
      configured: false,
      currency: 'USD',
      method: 'card',
      provider: null,
      tokensPerUsd: TOKENS_PER_USD,
      card: {
        enabled: false,
      },
      promoBoost:
        promoBonusPct > 0 && promoBoost
          ? {
              bonusPct: promoBonusPct,
              target: promoBoost.target,
              expiresAt: promoBoost.expiresAt,
            }
          : null,
      solana: {
        enabled: false,
        treasury: null,
        skrMint: null,
        assets: [],
      },
      crypto: {
        enabled: false,
      },
    }
  })

  app.get('/api/user/billing/payments', async (request, reply) => {
    const user = requireCustomer(request, reply)
    if (!user) return

    // Unpaid invoices older than 1 hour become expired and lose Open invoice.
    db.prepare(
      `UPDATE crypto_payments
       SET status = 'expired', raw_status = COALESCE(raw_status, status), updated_at = ?
       WHERE user_id = ?
         AND credited_at IS NULL
         AND lower(status) IN ('waiting', 'created', 'pending', 'confirming', 'sending', 'partially_paid')
         AND datetime(created_at) <= datetime('now', '-1 hour')`,
    ).run(nowIso(), user.id)

    const rows = db
      .prepare(
        `SELECT id, provider, amount_cents, currency, status, invoice_id, invoice_url, payment_id, pay_currency,
                pay_amount, order_id, raw_status, credited_usd_cents, created_at, credited_at
         FROM crypto_payments
         WHERE user_id = ?
         ORDER BY datetime(created_at) DESC
         LIMIT 30`,
      )
      .all(user.id) as Array<{
      id: string
      provider: string
      amount_cents: number
      currency: string
      status: string
      invoice_id: string | null
      invoice_url: string | null
      payment_id: string | null
      pay_currency: string | null
      pay_amount: string | null
      order_id: string
      raw_status: string | null
      credited_usd_cents: number | null
      created_at: string
      credited_at: string | null
    }>
    return {
      payments: rows.map((row) => {
        const creditedCents = row.credited_usd_cents ?? row.amount_cents
        const tokensCredited = tokensFromUsdCents(creditedCents)
        const effectiveStatus = row.credited_at ? 'finished' : row.status
        const uiStatus = normalizePaymentUiStatus(effectiveStatus)
        const open =
          Boolean(row.invoice_url) &&
          !row.credited_at &&
          isOpenPaymentStatus(row.status) &&
          uiStatus !== 'expired' &&
          uiStatus !== 'failed'
        return {
          id: row.id,
          provider: row.provider,
          amountCents: row.amount_cents,
          amountUsd: row.amount_cents / 100,
          creditedUsdCents: row.credited_at ? creditedCents : null,
          creditedUsd: row.credited_at ? creditedCents / 100 : null,
          currency: row.currency,
          status: effectiveStatus,
          statusLabel: paymentStatusLabel(effectiveStatus),
          uiStatus,
          invoiceId: row.invoice_id,
          invoiceUrl: row.invoice_url,
          paymentId: row.payment_id,
          orderId: row.order_id,
          payCurrency: row.pay_currency,
          payAmount: row.pay_amount,
          tokensCredited,
          createdAt: row.created_at,
          creditedAt: row.credited_at,
          canOpenInvoice: open,
        }
      }),
    }
  })

  app.post<{ Body: { amountDollars?: number } }>('/api/user/billing/topup', async (_request, reply) => {
    return reply.code(400).send({ error: 'Crypto top-up is currently disabled' })
  })

  app.post('/api/user/billing/card', async (_request, reply) => {
    return reply.code(400).send({ error: 'Card payments are currently disabled' })
  })

  app.get('/api/admin/overview', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const users = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
    const activeUsers = db.prepare("SELECT COUNT(*) AS count FROM users WHERE status = 'active'").get() as { count: number }
    const keys = db.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE status = 'active'").get() as { count: number }
    const requests = db.prepare('SELECT COALESCE(SUM(requests), 0) AS count FROM users').get() as { count: number }
    const revenue = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM balance_transactions WHERE type = 'top_up' AND status = 'completed'").get() as { cents: number }
    const usageSince = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString()
    const usageRaw = db.prepare(`
      SELECT
        substr(created_at, 1, 10) AS day,
        COUNT(*) AS requests,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(SUM(CASE WHEN (input_tokens + output_tokens) > 0 THEN (input_tokens + output_tokens) ELSE cost_tokens END), 0) AS spend_tokens,
        COALESCE(SUM(CASE WHEN lower(provider) = 'free' OR lower(COALESCE(model_id, '')) LIKE 'free/%' THEN (CASE WHEN (input_tokens + output_tokens) > 0 THEN (input_tokens + output_tokens) ELSE cost_tokens END) ELSE 0 END), 0) AS free_tokens,
        COALESCE(SUM(CASE WHEN NOT (lower(provider) = 'free' OR lower(COALESCE(model_id, '')) LIKE 'free/%') THEN (CASE WHEN (input_tokens + output_tokens) > 0 THEN (input_tokens + output_tokens) ELSE cost_tokens END) ELSE 0 END), 0) AS paid_tokens
      FROM usage_events
      WHERE created_at >= ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY day ASC
    `).all(usageSince) as Array<{ day: string; requests: number; errors: number; spend_tokens: number; free_tokens: number; paid_tokens: number }>
    const usageMap = new Map(usageRaw.map((row) => [row.day, row]))
    const usage: Array<{ day: string; requests: number; spend_tokens: number; free_tokens: number; paid_tokens: number }> = []
    const usageNow = new Date()
    for (let offset = 6; offset >= 0; offset -= 1) {
      const key = new Date(Date.UTC(usageNow.getUTCFullYear(), usageNow.getUTCMonth(), usageNow.getUTCDate() - offset))
        .toISOString()
        .slice(0, 10)
      const existing = usageMap.get(key)
      usage.push(existing ?? { day: key, requests: 0, spend_tokens: 0, free_tokens: 0, paid_tokens: 0 })
    }
    const activity = db.prepare(`
      SELECT u.id, u.display_id AS displayId, u.email, u.status, u.created_at AS createdAt
      FROM users u ORDER BY datetime(u.created_at) DESC LIMIT 5
    `).all()
    const provider = providerBalanceTotals()
    const providerKeys = listProviderKeys().keys
    const apinex = provider.byProvider?.apinex ?? { keyCount: 0, balanceTokens: 0, balanceUsdCents: 0 }
    return {
      stats: {
        users: users.count,
        activeUsers: activeUsers.count,
        activeKeys: keys.count,
        requests: requests.count,
        revenueCents: revenue.cents,
        spendTokens: usage.reduce((sum, row) => sum + row.spend_tokens, 0),
        errorRate: (() => {
          const total = usageRaw.reduce((sum, row) => sum + row.requests, 0)
          const errors = usageRaw.reduce((sum, row) => sum + row.errors, 0)
          return total ? (errors / total) * 100 : 0
        })(),
      },
      provider: {
        keyCount: provider.keyCount,
        balanceTokens: apinex.balanceTokens,
        balanceUsdCents: apinex.balanceUsdCents,
        byProvider: provider.byProvider ?? {},
      },
      providerKeys,
      usage,
      activity,
    }
  })

  app.get<{
    Querystring: { limit?: string; offset?: string; q?: string; sort?: string; dir?: string }
  }>('/api/admin/users', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit || '100', 10) || 100))
    const offset = Math.max(0, Number.parseInt(request.query.offset || '0', 10) || 0)
    const query = String(request.query.q || '').trim()
    const sort = ['listNo', 'balance_tokens', 'requests', 'created_at'].includes(request.query.sort || '')
      ? request.query.sort!
      : 'listNo'
    const direction = request.query.dir === 'asc' ? 'ASC' : 'DESC'
    const orderBy = {
      listNo: 'COALESCE(display_id, 0)',
      balance_tokens: 'balance_tokens',
      requests: 'requests',
      created_at: 'datetime(created_at)',
    }[sort as 'listNo' | 'balance_tokens' | 'requests' | 'created_at']
    const where = query
      ? `WHERE lower(email) LIKE @q OR lower(name) LIKE @q OR lower(COALESCE(telegram_username, '')) LIKE @q
          OR lower(status) LIKE @q
          OR id IN (
            SELECT r.user_id FROM promo_redemptions r
            JOIN promo_codes p ON p.id = r.promo_id
            WHERE lower(p.code) LIKE @q
            UNION
            SELECT b.user_id FROM user_promo_bonuses b
            JOIN promo_codes p ON p.id = b.promo_id
            WHERE lower(p.code) LIKE @q
          )`
      : ''
    const params = { q: `%${query.toLowerCase()}%` }
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(params) as { n: number }).n
    const rows = db
      .prepare(
        `WITH ranked_users AS (
           SELECT id, display_id, name, email, status, balance_tokens, requests,
                  created_at, last_seen_at,
                  telegram_id, telegram_username, auth_method,
                  ROW_NUMBER() OVER (
                    ORDER BY COALESCE(display_id, 0) ASC, datetime(created_at) ASC, id ASC
                  ) AS list_no
           FROM users
         )
         SELECT * FROM ranked_users ${where}
         ORDER BY ${orderBy} ${direction}, datetime(created_at) DESC, id ASC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset }) as Array<{
      id: string
      display_id: number | null
      list_no: number
      name: string
      email: string
      status: string
      balance_tokens: number
      requests: number
      created_at: string
      last_seen_at: string | null
      telegram_id: string | null
      telegram_username: string | null
      auth_method: string | null
    }>

    const allowances = getAdminUserAllowances()

    const userIds = rows.map((r) => r.id)
    const userPromosMap = new Map<string, string[]>()
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => '?').join(',')
      try {
        const promoRows = db.prepare(
          `SELECT DISTINCT r.user_id, p.code
           FROM promo_redemptions r
           JOIN promo_codes p ON p.id = r.promo_id
           WHERE r.user_id IN (${placeholders})
           UNION
           SELECT DISTINCT b.user_id, p.code
           FROM user_promo_bonuses b
           JOIN promo_codes p ON p.id = b.promo_id
           WHERE b.user_id IN (${placeholders})`,
        ).all(...userIds, ...userIds) as Array<{ user_id: string; code: string }>

        for (const pr of promoRows) {
          const list = userPromosMap.get(pr.user_id) ?? []
          if (!list.includes(pr.code)) {
            list.push(pr.code)
            userPromosMap.set(pr.user_id, list)
          }
        }
      } catch {
        /* ignore if promo tables not ready */
      }
    }

    return {
      total,
      offset,
      limit,
      hasMore: offset + rows.length < total,
      users: rows.map((row) => {
        const allowance = allowances.get(row.id) ?? null
        return {
          id: row.id,
          displayId: row.list_no,
          promo_codes: userPromosMap.get(row.id) ?? [],
          // Free-model allowance for the Subscription / Limits columns.
          subscription_plan: allowance?.planLabel ?? null,
          subscription_kind: allowance?.kind ?? null,
          subscription_expires_at: allowance?.expiresAt ?? null,
          allowance_unlimited: allowance?.unlimited ?? false,
          allowance_used: allowance?.used ?? 0,
          allowance_limit: allowance?.limit ?? null,
          allowance_percent: allowance?.percentUsed ?? null,
          email: row.email,
          status: row.status === 'trial' ? 'active' : row.status,
          balance_tokens: row.balance_tokens,
          requests: row.requests,
          created_at: row.created_at,
          last_seen_at: row.last_seen_at,
          telegram_username: row.telegram_username
            ? `@${row.telegram_username.replace(/^@/, '')}`
            : row.telegram_id
              ? row.telegram_id
              : null,
          auth_method: row.auth_method || 'email',
        }
      }),
    }
  })


  app.post<{ Body: { email?: string; balanceUsd?: number; balanceTokens?: number } }>('/api/admin/users', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const email = request.body.email?.trim().toLowerCase()
    // Balance is specified in USD; legacy token-based clients are converted at the fixed rate.
    const balanceTokens = Math.round(
      request.body.balanceUsd != null
        ? Number(request.body.balanceUsd) * TOKENS_PER_USD
        : Number(request.body.balanceTokens ?? 0),
    )
    if (!email) return reply.code(400).send({ error: 'Email is required' })
    if (isEmailBlocked(email)) return reply.code(403).send({ error: BLOCKED_EMAIL_MESSAGE })
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    if (existing) return reply.code(409).send({ error: 'User with this email already exists' })
    const userId = id('user')
    const createdAt = nowIso()
    const name = email.split('@')[0] || 'User'
    const tokens = Number.isFinite(balanceTokens) && balanceTokens > 0 ? balanceTokens : 0
    let displayId = nextUserDisplayId()
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        db.prepare(`
          INSERT INTO users
            (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at, last_seen_at,
             password_hash, email_verified_at, display_id)
          VALUES (?, ?, ?, 'default', 'active', 0, ?, 0, ?, NULL, NULL, ?, ?)
        `).run(userId, name, email, tokens, createdAt, createdAt, displayId)
        break
      } catch (err: any) {
        if (
          attempt < 4 &&
          (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
            err?.code === 'SQLITE_CONSTRAINT' ||
            String(err?.message).includes('display_id'))
        ) {
          displayId = Math.max(nextUserDisplayId(), displayId + 1)
          continue
        }
        throw err
      }
    }
    if (tokens > 0) {
      db.prepare(`
        INSERT INTO balance_transactions
          (id, user_id, type, amount_cents, amount_tokens, note, status, created_at)
        VALUES (?, ?, 'adjustment', ?, ?, 'Initial balance', 'completed', ?)
      `).run(id('txn'), userId, Math.round((tokens / TOKENS_PER_USD) * 100), tokens, createdAt)
    }
    db.prepare('INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id('audit'), actor.email, 'user.created', userId, JSON.stringify({ email, balanceUsd: tokens / TOKENS_PER_USD, displayId }), createdAt,
    )
    return { ok: true, id: userId, displayId }
  })

  app.patch<{ Params: { id: string }; Body: { status?: string } }>('/api/admin/users/:id', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const status = request.body.status?.trim()
    if (status !== 'active' && status !== 'suspended') {
      return reply.code(400).send({ error: 'Status must be active or suspended' })
    }
    db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(status, request.params.id)
    db.prepare('INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id('audit'), actor.email, 'user.updated', request.params.id, JSON.stringify({ status }), nowIso(),
    )
    return { ok: true }
  })

  app.get('/api/admin/providers', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    return listProviderKeys()
  })

  app.post<{
    Body: {
      provider?: string
      email?: string
      secret?: string
    }
  }>('/api/admin/providers/keys', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    try {
      const keyId = createProviderKey({
        provider: request.body.provider ?? 'apinex',
        email: request.body.email ?? '',
        secret: request.body.secret ?? '',
      })
      const synced = await syncProviderKey(keyId)
      db.prepare(
        'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id('audit'),
        actor.email,
        'provider_key.created',
        keyId,
        JSON.stringify({
          email: request.body.email,
          provider: request.body.provider ?? 'apinex',
        }),
        nowIso(),
      )
      return { ok: true, key: synced ? publicProviderKey(synced) : null, ...providerBalanceTotals() }
    } catch (reason) {
      return reply.code(400).send({ error: reason instanceof Error ? reason.message : 'Unable to add key' })
    }
  })

  app.post<{ Body: { id?: string; direction?: 'up' | 'down' } }>('/api/admin/providers/keys/reorder', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const keyId = String(request.body.id ?? '').trim()
    const direction = request.body.direction
    if (!keyId || (direction !== 'up' && direction !== 'down')) {
      return reply.code(400).send({ error: 'id and direction (up|down) are required' })
    }
    const current = db.prepare(`SELECT id, provider, priority FROM provider_keys WHERE id = ?`).get(keyId) as
      | { id: string; provider: string; priority: number }
      | undefined
    if (!current) return reply.code(404).send({ error: 'Provider key not found' })
    const group = db.prepare(
      `SELECT id, priority FROM provider_keys WHERE provider = ? ORDER BY COALESCE(priority, 100) ASC, created_at ASC, id ASC`,
    ).all(current.provider) as Array<{ id: string; priority: number }>
    const index = group.findIndex((row) => row.id === keyId)
    const otherIndex = direction === 'up' ? index - 1 : index + 1
    if (index < 0 || otherIndex < 0 || otherIndex >= group.length) return { ok: true, moved: false }
    const reordered = group.slice()
    const [moved] = reordered.splice(index, 1)
    reordered.splice(otherIndex, 0, moved)
    const tx = db.transaction(() => {
      const update = db.prepare(`UPDATE provider_keys SET priority = ? WHERE id = ?`)
      reordered.forEach((row, orderIndex) => update.run((orderIndex + 1) * 10, row.id))
    })
    tx()
    db.prepare('INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id('audit'), actor.email, 'provider_key.moved', keyId, JSON.stringify({ direction, swapWith: group[otherIndex].id }), nowIso(),
    )
    return { ok: true, moved: true }
  })

  app.delete<{ Params: { id: string } }>('/api/admin/providers/keys/:id', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    deleteProviderKey(request.params.id)
    db.prepare(
      'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id('audit'), actor.email, 'provider_key.deleted', request.params.id, '{}', nowIso())
    return listProviderKeys()
  })

  app.post('/api/admin/providers/sync', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    return syncAllProviderKeys()
  })

  app.post<{ Params: { id: string } }>('/api/admin/providers/keys/:id/sync', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    const synced = await syncProviderKey(request.params.id)
    if (!synced) return reply.code(404).send({ error: 'Key not found' })
    return { key: publicProviderKey(synced), ...providerBalanceTotals() }
  })

  app.get<{ Querystring: { category?: string; upstreamProvider?: string } }>('/api/admin/providers/catalog', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    const category = request.query.category as ModelCategory
    const rawUpstream = String(request.query.upstreamProvider ?? '').trim()
    const upstreamProvider = isUpstreamProvider(rawUpstream) ? rawUpstream : 'apinex'
    if (!MODEL_CATEGORIES.includes(category)) {
      return reply.code(400).send({ error: 'Invalid category' })
    }
    try {
      const models = await fetchCatalogModels(category, upstreamProvider)
      return { models }
    } catch (reason) {
      return reply.code(400).send({ error: reason instanceof Error ? reason.message : 'Unable to load models' })
    }
  })

  app.patch<{ Params: { id: string }; Body: { status?: string } }>('/api/admin/providers/:id', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    db.prepare('UPDATE provider_accounts SET status = ? WHERE id = ?').run(request.body.status, request.params.id)
    db.prepare('INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id('audit'), actor.email, 'provider.updated', request.params.id, JSON.stringify({ status: request.body.status }), nowIso(),
    )
    return { ok: true }
  })

  app.get('/api/admin/models', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    const { getModelStatusMap, getModelStatusMeta, refreshAllModelStatuses, rematchCachedStatuses } =
      await import('./modelStatusPoller.js')
    if (!getModelStatusMeta().checkedAt) await refreshAllModelStatuses(true)
    else rematchCachedStatuses()
    const health = getModelStatusMap()
    const healthCheckedAt = getModelStatusMeta().checkedAt
    const models = db.prepare(`
      SELECT m.*, p.input_multiplier AS inputMultiplier, p.output_multiplier AS outputMultiplier
      FROM model_catalog m LEFT JOIN pricing_rules p ON p.model_id = m.id
      ORDER BY COALESCE(m.sort_order, 0) ASC, m.name ASC
    `).all() as Array<Record<string, unknown> & { tags_json: string; provider: string; sort_order?: number; name: string; id: string }>
    const routesForModel = db.prepare(`
      SELECT position, upstream_provider, upstream_id
      FROM model_upstream_routes WHERE model_id = ? ORDER BY position ASC
    `)
    return {
      models: models.map((model) => {
        const routes = routesForModel.all(model.id) as Array<{
          position: number
          upstream_provider: string
          upstream_id: string
        }>
        // The gateway resolves the effective upstream from model_upstream_routes
        // (position 1). Reflect that here so the admin table never shows a stale
        // model_catalog.upstream_id after direct DB edits or route changes.
        const primary = routes.find((route) => route.position === 1) ?? routes[0]
        const effectiveUpstreamId = primary ? primary.upstream_id : model.upstream_id
        const effectiveUpstreamProvider = primary ? primary.upstream_provider : model.upstream_provider
        return {
          ...model,
          upstream_id: effectiveUpstreamId,
          upstream_provider: effectiveUpstreamProvider,
          provider: normalizeProviderName(String(model.provider ?? '')),
          tags: parseJson<string[]>(model.tags_json),
          health: health[String(model.id)] ?? 'no_data',
          healthOverride:
            model.health_override === 'live' || model.health_override === 'partial' || model.health_override === 'unavailable'
              ? (model.health_override as 'live' | 'partial' | 'unavailable')
              : null,
          healthCheckedAt,
          upstream_routes: routes,
        }
      }),
    }
  })

  app.post<{ Params: { id: string }; Body: { status?: 'live' | 'partial' | 'unavailable' | 'auto' } }>(
    '/api/admin/models/:id/set-status',
    async (request, reply) => {
      const actor = requireAuth(request, reply)
      if (!actor) return
      const modelId = request.params.id
      const model = db.prepare(`SELECT id FROM model_catalog WHERE id = ?`).get(modelId) as { id: string } | undefined
      if (!model) return reply.code(404).send({ error: 'Model not found' })
      const raw = String(request.body?.status ?? '').trim().toLowerCase()
      if (!['live', 'partial', 'unavailable', 'auto'].includes(raw)) {
        return reply.code(400).send({ error: 'status must be live, partial, unavailable or auto' })
      }
      const { setModelHealthOverride } = await import('./modelStatusPoller.js')
      const applied = setModelHealthOverride(modelId, raw === 'auto' ? null : (raw as 'live' | 'partial' | 'unavailable'))
      db.prepare(
        'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id('audit'), actor.email, 'model.health_override', modelId, JSON.stringify({ status: raw }), nowIso())
      return { ok: true, id: modelId, health: applied ?? 'auto' }
    },
  )

  app.post<{ Params: { id: string } }>('/api/admin/models/:id/refresh-status', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    const model = db
      .prepare(`SELECT id, upstream_provider FROM model_catalog WHERE id = ?`)
      .get(request.params.id) as { id: string; upstream_provider: string | null } | undefined
    if (!model) return reply.code(404).send({ error: 'Model not found' })

    const { refreshModelStatuses, rematchCachedStatuses, getModelStatusMap, getModelStatusMeta } =
      await import('./modelStatusPoller.js')
    await refreshModelStatuses(true)
    rematchCachedStatuses()
    return {
      ok: true,
      health: getModelStatusMap()[model.id] ?? 'no_data',
      healthCheckedAt: getModelStatusMeta().checkedAt,
    }
  })

  app.post<{ Body: { id?: string; direction?: 'up' | 'down'; providerFilter?: string } }>('/api/admin/models/reorder', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const modelId = String(request.body.id ?? '').trim()
    const direction = request.body.direction
    const providerFilter = request.body.providerFilter ? String(request.body.providerFilter).trim() : null
    if (!modelId || (direction !== 'up' && direction !== 'down')) {
      return reply.code(400).send({ error: 'id and direction (up|down) are required' })
    }

    const current = db
      .prepare(
        `SELECT id, provider, name, COALESCE(sort_order, 0) AS sort_order
         FROM model_catalog WHERE id = ?`,
      )
      .get(modelId) as { id: string; provider: string; name: string; sort_order: number } | undefined
    if (!current) return reply.code(404).send({ error: 'Model not found' })

    const catalog = (
      providerFilter
        ? db
            .prepare(
              `SELECT id, provider, name, COALESCE(sort_order, 0) AS sort_order
               FROM model_catalog
               WHERE provider = ?
               ORDER BY COALESCE(sort_order, 0) ASC, name ASC`,
            )
            .all(providerFilter)
        : db
            .prepare(
              `SELECT id, provider, name, COALESCE(sort_order, 0) AS sort_order
               FROM model_catalog
               ORDER BY COALESCE(sort_order, 0) ASC, name ASC`,
            )
            .all()
    ) as Array<{ id: string; provider: string; name: string; sort_order: number }>

    const index = catalog.findIndex((row) => row.id === modelId)
    const swapWith = direction === 'up' ? index - 1 : index + 1
    if (index < 0 || swapWith < 0 || swapWith >= catalog.length) {
      return { ok: true, moved: false }
    }

    const reordered = catalog.slice()
    const [moved] = reordered.splice(index, 1)
    reordered.splice(swapWith, 0, moved)

    db.transaction(() => {
      const update = db.prepare(`UPDATE model_catalog SET sort_order = ? WHERE id = ?`)
      reordered.forEach((row, orderIndex) => update.run((orderIndex + 1) * 10, row.id))
    })()

    db.prepare(
      'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id('audit'),
      actor.email,
      'model_reorder',
      modelId,
      JSON.stringify({ direction, newOrder: swapWith + 1, scope: providerFilter || 'all' }),
      nowIso(),
    )

    return { ok: true, moved: true }
  })

  app.post<{
    Body: {
      routes?: Array<{ upstreamProvider?: string; upstreamId?: string }>
    }
  }>('/api/admin/models/bulk-free-routes', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const body = request.body ?? {}
    if (!Array.isArray(body.routes) || body.routes.length === 0) {
      return reply.code(400).send({ error: 'At least 1 route (Primary) is required' })
    }

    const cleanRoutes = body.routes
      .slice(0, 5)
      .map((r) => ({
        provider: String(r?.upstreamProvider ?? '').trim(),
        modelId: String(r?.upstreamId ?? '').trim(),
      }))
      .filter((r) => isUpstreamProvider(r.provider) && isValidModelId(r.modelId))

    if (cleanRoutes.length === 0) {
      return reply.code(400).send({ error: 'Primary route must specify a valid upstream provider and upstream model ID' })
    }

    const primary = cleanRoutes[0]
    const freeModels = db.prepare(`SELECT id FROM model_catalog WHERE provider = 'Free'`).all() as Array<{ id: string }>
    if (freeModels.length === 0) {
      return reply.send({ success: true, count: 0 })
    }

    db.transaction(() => {
      db.prepare(`UPDATE model_catalog SET upstream_provider = ?, upstream_id = ? WHERE provider = 'Free'`).run(
        primary.provider,
        primary.modelId,
      )
      db.prepare(`DELETE FROM model_upstream_routes WHERE model_id IN (SELECT id FROM model_catalog WHERE provider = 'Free')`).run()
      const insertRoute = db.prepare(`INSERT INTO model_upstream_routes (model_id, position, upstream_provider, upstream_id) VALUES (?, ?, ?, ?)`)
      for (const model of freeModels) {
        cleanRoutes.forEach((route, index) => {
          insertRoute.run(model.id, index + 1, route.provider, route.modelId)
        })
      }
    })()

    db.prepare(
      'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id('audit'),
      actor.email,
      'models.bulk_free_routes_updated',
      'Free',
      JSON.stringify({ modelCount: freeModels.length, routes: cleanRoutes }),
      nowIso(),
    )

    return reply.send({ success: true, count: freeModels.length, routes: cleanRoutes })
  })

  app.post('/api/admin/models/import-apinex', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    try {
      const result = await importApinexCatalogModels()
      db.prepare(
        'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id('audit'),
        actor.email,
        'models.imported_apinex',
        'apinex',
        JSON.stringify(result),
        nowIso(),
      )
      return { ok: true, ...result }
    } catch (reason) {
      return reply
        .code(400)
        .send({ error: reason instanceof Error ? reason.message : 'Unable to import APInex models' })
    }
  })

  app.patch<{
    Params: { '*': string }
    Body: {
      id?: string
      status?: string
      upstreamId?: string
      upstreamProvider?: string
      upstreamRoutes?: Array<{ upstreamProvider?: string; upstreamId?: string }>
      name?: string
      provider?: string
      contextWindow?: string
      inputPrice?: number
      outputPrice?: number
      tokenWeight?: number
      tags?: string[]
    }
  }>('/api/admin/models/*', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const modelId = decodeURIComponent(request.params['*'] ?? '').trim()
    if (!modelId) return reply.code(400).send({ error: 'Model id required' })
    const current = db.prepare(`SELECT * FROM model_catalog WHERE id = ?`).get(modelId) as Record<string, unknown> | undefined
    if (!current) return reply.code(404).send({ error: 'Model not found' })
    const body = request.body ?? {}
    if (body.id !== undefined && (typeof body.id !== 'string' || !isValidModelId(body.id.trim()))) {
      return reply.code(400).send({ error: 'Invalid model id' })
    }
    const nextModelId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : modelId
    if (!isValidModelId(nextModelId)) return reply.code(400).send({ error: 'Invalid model id' })
    if (nextModelId !== modelId) {
      const duplicate = db.prepare(`SELECT 1 FROM model_catalog WHERE id = ?`).get(nextModelId)
      if (duplicate) return reply.code(409).send({ error: 'A model with this id already exists' })
    }
    const nextProvider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : String(current.provider)
    if (body.name !== undefined && (typeof body.name !== 'string' || !isValidModelName(body.name))) {
      return reply.code(400).send({ error: 'Invalid model name' })
    }
    const nextName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : String(current.name)
    if (!isValidModelName(nextName)) return reply.code(400).send({ error: 'Invalid model name' })
    const nextContext = typeof body.contextWindow === 'string' && body.contextWindow.trim() ? body.contextWindow.trim() : String(current.context_window)
    const nextUpstreamId = typeof body.upstreamId === 'string' && body.upstreamId.trim() ? body.upstreamId.trim() : String(current.upstream_id ?? current.id)
    const nextUpstreamProvider = typeof body.upstreamProvider === 'string' && body.upstreamProvider.trim() ? body.upstreamProvider.trim() : String(current.upstream_provider ?? 'apinex')
    const existingRoutes = db.prepare(`
      SELECT upstream_provider as provider, upstream_id as modelId
      FROM model_upstream_routes
      WHERE model_id = ?
      ORDER BY position ASC
    `).all(modelId) as Array<{ provider: string; modelId: string }>

    const nextRoutes = Array.isArray(body.upstreamRoutes)
      ? body.upstreamRoutes
          .slice(0, 5)
          .map((route) => ({
            provider: String(route?.upstreamProvider ?? '').trim(),
            modelId: String(route?.upstreamId ?? '').trim(),
          }))
          .filter((route) => isUpstreamProvider(route.provider) && isValidModelId(route.modelId))
      : existingRoutes.length > 0
        ? existingRoutes
        : [{ provider: nextUpstreamProvider, modelId: nextUpstreamId }]
    if (nextRoutes.length === 0) return reply.code(400).send({ error: 'Provider 1 is required' })
    const primaryRoute = nextRoutes[0]
    const nextWeight = body.tokenWeight == null ? Number(current.token_weight ?? 1) : Number(body.tokenWeight)
    if (!Number.isFinite(nextWeight) || nextWeight < 0) return reply.code(400).send({ error: 'tokenWeight must be 0 or a positive number' })
    const isFree = nextProvider.trim().toLowerCase() === 'free' || nextModelId.startsWith('free/')
    const isJev = !isFree && (normalizeProviderName(nextProvider) === 'Jev Group' || isDecisionCatalogModelId(nextModelId) || isDecisionCatalogModelId(primaryRoute.modelId))
    const inputMicros = isFree ? 0 : Math.round(Number(body.inputPrice ?? Number(current.input_price_micros ?? 0) / 1_000_000) * 1_000_000)
    const outputMicros = isFree ? 0 : Math.round(Number(body.outputPrice ?? Number(current.output_price_micros ?? 0) / 1_000_000) * 1_000_000)
    const weight = isFree
      ? (nextWeight > 0 ? nextWeight : (Number(current.token_weight) > 0 ? Number(current.token_weight) : 1))
      : (inputMicros > 0 ? 0 : (nextWeight > 0 ? nextWeight : 1))
    const storedProvider = isFree
      ? 'Free'
      : isJev
        ? 'Jev Group'
        : inputMicros > 0
          ? (familyFromUpstreamId(primaryRoute.modelId) ?? nextProvider)
          : providerForTokenWeight(weight, primaryRoute.modelId, nextProvider)
    const status = body.status === 'paused' ? 'paused' : body.status === 'active' ? 'active' : String(current.status)
    const tags = Array.isArray(body.tags) ? body.tags : safeParseTags(current.tags_json)
    const pricingRule = db.prepare(`SELECT id, active FROM pricing_rules WHERE model_id = ?`).get(modelId) as { id: string; active: number } | undefined
    const updateModel = db.prepare(`UPDATE model_catalog SET id = ?, upstream_id = ?, upstream_provider = ?, name = ?, provider = ?, context_window = ?, input_price_micros = ?, output_price_micros = ?, token_weight = ?, status = ?, tags_json = ? WHERE id = ?`)
    const insertPricing = db.prepare(`INSERT INTO pricing_rules (id, model_id, input_multiplier, output_multiplier, active, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    db.transaction(() => {
      // pricing_rules and model_upstream_routes have foreign keys to model_catalog(id)
      // without ON UPDATE CASCADE, so clean up dependent rows BEFORE updating model_catalog(id)
      // to avoid FOREIGN KEY constraint failures when a model id is renamed.
      if (pricingRule) {
        db.prepare(`DELETE FROM pricing_rules WHERE id = ?`).run(pricingRule.id)
      }
      db.prepare('DELETE FROM model_upstream_routes WHERE model_id = ?').run(modelId)

      updateModel.run(
        nextModelId, primaryRoute.modelId, primaryRoute.provider, nextName, storedProvider, nextContext,
        inputMicros,
        outputMicros,
        weight, status, JSON.stringify(tags), modelId,
      )
      if (pricingRule) {
        insertPricing.run(pricingRule.id, nextModelId, weight, weight, pricingRule.active, nowIso())
      } else {
        insertPricing.run(id('price'), nextModelId, weight, weight, 1, nowIso())
      }

      const insertRoute = db.prepare(`INSERT INTO model_upstream_routes (model_id, position, upstream_provider, upstream_id) VALUES (?, ?, ?, ?)`)
      nextRoutes.forEach((route, index) => insertRoute.run(nextModelId, index + 1, route.provider, route.modelId))
    })()
    db.prepare('INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id('audit'), actor.email, 'model.updated', nextModelId, JSON.stringify(request.body), nowIso(),
    )
    return { ok: true, id: nextModelId }
  })

  app.delete<{ Params: { '*': string } }>('/api/admin/models/*', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const modelId = decodeURIComponent(request.params['*'] ?? '').trim()
    if (!modelId) return reply.code(400).send({ error: 'Model id required' })
    const existing = db.prepare('SELECT id FROM model_catalog WHERE id = ?').get(modelId)
    if (!existing) return reply.code(404).send({ error: 'Model not found' })
    db.prepare('DELETE FROM pricing_rules WHERE model_id = ?').run(modelId)
    db.prepare('DELETE FROM model_catalog WHERE id = ?').run(modelId)
    db.prepare(
      'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id('audit'), actor.email, 'model.deleted', modelId, '{}', nowIso())
    return { ok: true }
  })

  app.post<{
    Body: {
      id?: string
      upstreamId?: string
      upstreamProvider?: string
      name?: string
      provider?: string
      contextWindow?: string
      inputPrice?: number
      outputPrice?: number
      tokenWeight?: number
      inputMultiplier?: number
      outputMultiplier?: number
      tags?: string[]
    }
  }>('/api/admin/models', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const modelId = request.body.id?.trim()
    const upstreamId = (request.body.upstreamId?.trim() || modelId) ?? ''
    const upstreamProvider = isUpstreamProvider(String(request.body.upstreamProvider ?? ''))
      ? String(request.body.upstreamProvider)
      : 'apinex'
    const name = request.body.name?.trim()
    const provider = request.body.provider?.trim()
    const requestedContextWindow = request.body.contextWindow?.trim()
    const contextWindow =
      requestedContextWindow && !['—', '-', '–'].includes(requestedContextWindow)
        ? requestedContextWindow
        : '—'
    const inputPrice = Number(request.body.inputPrice ?? 0)
    const outputPrice = Number(request.body.outputPrice ?? 0)
    const tokenWeight = Number(request.body.tokenWeight ?? request.body.inputMultiplier ?? 1)
    if (!modelId || !name || !provider) return reply.code(400).send({ error: 'Model id, name and provider are required' })
    if (!isValidModelId(modelId)) {
      return reply.code(400).send({ error: 'API model id may only use letters, numbers, ., _, :, /, -' })
    }
    if (!isValidModelName(name)) {
      return reply.code(400).send({ error: 'Invalid model name' })
    }
    if (!Number.isFinite(tokenWeight) || tokenWeight < 0) {
      return reply.code(400).send({ error: 'tokenWeight must be 0 or a positive number' })
    }
    const existing = db.prepare('SELECT id FROM model_catalog WHERE id = ?').get(modelId)
    if (existing) return reply.code(409).send({ error: 'Model already exists' })
    const createdAt = nowIso()
    const isFree = provider.trim().toLowerCase() === 'free' || modelId.startsWith('free/')
    const isJev = !isFree && (normalizeProviderName(provider) === 'Jev Group' || isDecisionCatalogModelId(modelId) || isDecisionCatalogModelId(upstreamId))
    const inputMicros = isFree ? 0 : Math.round(inputPrice * 1_000_000)
    const outputMicros = isFree ? 0 : Math.round((outputPrice > 0 ? outputPrice : isJev ? 0 : inputPrice) * 1_000_000)
    const weight = isFree ? (tokenWeight > 0 ? tokenWeight : 1) : (inputMicros > 0 ? 0 : (tokenWeight > 0 ? tokenWeight : 1))
    const storedProvider = isFree
      ? 'Free'
      : isJev
        ? 'Jev Group'
        : inputMicros > 0
          ? (familyFromUpstreamId(upstreamId) ?? provider)
          : providerForTokenWeight(weight, upstreamId, provider)
    const nextOrder =
      (
        db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM model_catalog`).get() as {
          n: number
        }
      ).n ?? 10
    db.prepare(`
      INSERT INTO model_catalog
        (id, provider, name, context_window, input_price_micros, output_price_micros, status, tags_json, created_at, upstream_id, upstream_provider, token_weight, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      modelId,
      storedProvider,
      name,
      contextWindow,
      inputMicros,
      outputMicros,
      JSON.stringify(request.body.tags ?? []),
      createdAt,
      upstreamId,
      upstreamProvider,
      weight,
      nextOrder,
    )
    db.prepare(`
      INSERT INTO pricing_rules (id, model_id, input_multiplier, output_multiplier, active, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(
      id('price'),
      modelId,
      weight,
      weight,
      createdAt,
    )
    db.prepare('INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id('audit'), actor.email, 'model.created', modelId, JSON.stringify(request.body), createdAt,
    )
    // Immediately pull an up-to-date health status for the new model instead of
    // waiting for the next 20-minute poll cycle.
    return { ok: true, id: modelId }
  })

  app.patch<{ Params: { '*': string }; Body: { tokenWeight?: number; dollarsPer1M?: number; inputDollarsPer1M?: number; outputDollarsPer1M?: number } }>('/api/admin/pricing/*', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const modelId = decodeURIComponent(request.params['*'] ?? '').trim()
    if (!modelId) return reply.code(400).send({ error: 'Model id required' })
    const current = db
      .prepare('SELECT upstream_id, provider FROM model_catalog WHERE id = ?')
      .get(modelId) as { upstream_id: string | null; provider: string } | undefined
    if (!current) return reply.code(404).send({ error: 'Model not found' })
    const free = current.provider.trim().toLowerCase() === 'free' || modelId.startsWith('free/')
    if (free) {
      const tokenWeight = Number(request.body.tokenWeight)
      if (!Number.isFinite(tokenWeight) || tokenWeight < 0) {
        return reply.code(400).send({ error: 'tokenWeight must be 0 or a positive number' })
      }
      const weight = tokenWeight > 0 ? tokenWeight : 1
      db.prepare('UPDATE model_catalog SET token_weight = ?, provider = ?, input_price_micros = 0, output_price_micros = 0 WHERE id = ?').run(
        weight,
        'Free',
        modelId,
      )
      db.prepare('UPDATE pricing_rules SET input_multiplier = ?, output_multiplier = ?, updated_at = ? WHERE model_id = ?').run(
        weight,
        weight,
        nowIso(),
        modelId,
      )
      db.prepare('INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id('audit'), actor.email, 'pricing.updated', modelId, JSON.stringify({ tokenWeight: weight }), nowIso(),
      )
      return { ok: true, tokenWeight: weight, provider: 'Free', dollarsPer1M: 0 }
    }
    const shared = request.body.dollarsPer1M
    const inputPrice = Number(request.body.inputDollarsPer1M ?? shared)
    const isJev = normalizeProviderName(current.provider) === 'Jev Group' || isDecisionCatalogModelId(modelId) || isDecisionCatalogModelId(current.upstream_id)
    const outputPrice = Number(request.body.outputDollarsPer1M ?? (isJev ? 0 : shared))
    if (!Number.isFinite(inputPrice) || inputPrice < 0.01 || !Number.isFinite(outputPrice) || outputPrice < (isJev ? 0 : 0.01)) {
      return reply.code(400).send({ error: 'Input price must be at least $0.01 per 1M tokens' })
    }
    const inputMicros = Math.round(inputPrice * 1_000_000)
    const outputMicros = Math.round(outputPrice * 1_000_000)
    db.prepare(
      `UPDATE model_catalog
       SET input_price_micros = ?, output_price_micros = ?, token_weight = 0,
           status = CASE WHEN status = 'paused' THEN 'active' ELSE status END
       WHERE id = ?`,
    ).run(inputMicros, outputMicros, modelId)
    db.prepare('INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id('audit'), actor.email, 'pricing.updated', modelId, JSON.stringify({ inputDollarsPer1M: inputPrice, outputDollarsPer1M: outputPrice }), nowIso(),
    )
    return {
      ok: true,
      tokenWeight: 0,
      provider: current.provider,
      dollarsPer1M: inputMicros / 1_000_000,
      inputDollarsPer1M: inputMicros / 1_000_000,
      outputDollarsPer1M: outputMicros / 1_000_000,
    }
  })

  app.get('/api/admin/balances', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    return {
      transactions: db.prepare(`
      SELECT t.*, u.name, u.email FROM balance_transactions t
      JOIN users u ON u.id = t.user_id
      ORDER BY datetime(t.created_at) DESC
    `).all(),
      settings: {
        minTopupCents: getMinTopupCents(),
        telegramBonusEnabled: false,
        telegramBonusUsd: 0,
        telegramBonusTokens: 0,
        telegramConfigured: false,
        telegramBotUsername: '',
      },
    }
  })



  app.patch<{
    Body: { telegram?: string; x?: string; telegramSupport?: string }
  }>('/api/admin/settings/links', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    try {
      const links = saveSiteLinks(request.body ?? {})
      return { ok: true, links }
    } catch (reason) {
      return reply.code(400).send({ error: reason instanceof Error ? reason.message : 'Invalid link' })
    }
  })

  app.patch<{ Body: { minTopupDollars?: number } }>('/api/admin/settings/billing', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const dollars = Number(request.body.minTopupDollars)
    if (!Number.isFinite(dollars) || dollars < 1) {
      return reply.code(400).send({ error: 'Minimum top-up must be at least $1' })
    }
    const cents = Math.round(dollars * 100)
    setSetting('min_topup_cents', String(cents))
    db.prepare(
      'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id('audit'),
      actor.email,
      'settings.billing_updated',
      'min_topup_cents',
      JSON.stringify({ minTopupCents: cents }),
      nowIso(),
    )
    return { ok: true, minTopupCents: cents }
  })

  app.get<{
    Querystring: { q?: string; period?: string; from?: string; to?: string }
  }>('/api/admin/statistics', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    try {
      return await buildAdminStatisticsOffThread({
        q: request.query?.q,
        period: request.query?.period,
        from: request.query?.from,
        to: request.query?.to,
      })
    } catch (reason) {
      return reply.code(500).send({
        error: reason instanceof Error ? reason.message : 'Could not load statistics',
      })
    }
  })

  app.get<{ Querystring: { window?: string } }>(
    '/api/admin/statistics/models',
    async (request, reply) => {
      if (!requireAuth(request, reply)) return
      try {
        return await buildModelUsageStatsOffThread({ window: request.query?.window })
      } catch (reason) {
        return reply.code(500).send({
          error: reason instanceof Error ? reason.message : 'Could not load model usage',
        })
      }
    },
  )


  app.get('/api/admin/settings', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    const referral = getReferralSettings()
    return {
      billing: {
        minTopupCents: getMinTopupCents(),
      },
      telegram: {
        enabled: false,
        bonusUsd: 0,
        bonusTokens: 0,
        configured: false,
        botUsername: '',
      },
      referral: {
        enabled: referral.enabled,
        minPurchaseCents: referral.minPurchaseCents,
        referrerRewardUsd: referral.referrerRewardCents / 100,
        refereeRewardUsd: referral.refereeRewardCents / 100,
      },
      fairness: getGatewayFairnessSettings(),
      links: getSiteLinks(),
      subscriptions: {
        ...getSubscriptionSettings(),
        payMethods: subscriptionPayMethods(),
        solanaConfigured: subscriptionSolanaPayConfigured(),
      },
    }
  })

  app.patch<{
    Body: {
      freeDailyTokens?: number
      plans?: Array<{
        key?: string
        days?: number
        label?: string
        enabled?: boolean
        priceCents?: number
        priceUsd?: number
        kind?: string
        tokenLimit?: number
        isFeatured?: boolean
      }>
    }
  }>('/api/admin/settings/subscriptions', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    try {
      const plans = request.body?.plans?.map((plan) => {
        const days =
          plan.days !== undefined && Number.isFinite(Number(plan.days))
            ? Math.round(Number(plan.days))
            : undefined
        return {
          key: String(plan.key ?? ''),
          enabled: plan.enabled,
          ...(days !== undefined && days >= 1 ? { days } : {}),
          ...(typeof plan.label === 'string' && plan.label.trim() ? { label: plan.label.trim() } : {}),
          // Accept dollars from the admin UI, store cents.
          priceCents:
            plan.priceCents !== undefined
              ? Math.round(Number(plan.priceCents))
              : plan.priceUsd !== undefined
                ? Math.round(Number(plan.priceUsd) * 100)
                : undefined,
          kind: plan.kind,
          tokenLimit: plan.tokenLimit,
          isFeatured: plan.isFeatured !== undefined ? Boolean(plan.isFeatured) : undefined,
        }
      })

      for (const plan of plans ?? []) {
        if (plan.priceCents !== undefined && (!Number.isFinite(plan.priceCents) || plan.priceCents < 1)) {
          return reply.code(400).send({ error: 'Plan price must be at least $0.01' })
        }
        if (
          plan.kind === 'custom' &&
          plan.tokenLimit !== undefined &&
          (!Number.isFinite(Number(plan.tokenLimit)) || Number(plan.tokenLimit) < 1)
        ) {
          return reply.code(400).send({ error: 'Custom plans need a token limit of at least 1' })
        }
      }

      const settings = updateSubscriptionSettings({
        freeDailyTokens: request.body?.freeDailyTokens,
        plans,
      })

      db.prepare(
        'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id('audit'),
        actor.email,
        'settings.subscriptions_updated',
        'subscription_settings',
        JSON.stringify(settings),
        nowIso(),
      )
      return { ok: true, settings }
    } catch (reason) {
      return reply
        .code(400)
        .send({ error: reason instanceof Error ? reason.message : 'Could not save subscriptions' })
    }
  })

  app.get('/api/admin/subscriptions', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    try {
      return {
        settings: getSubscriptionSettings(),
        stats: getAdminSubscriptionStats(),
        active: getAdminActiveSubscriptions(100),
        payMethods: subscriptionPayMethods(),
        solanaConfigured: subscriptionSolanaPayConfigured(),
      }
    } catch (reason) {
      request.log.error(reason)
      return reply.code(500).send({
        error: reason instanceof Error ? reason.message : 'Could not load subscriptions',
      })
    }
  })

  /** Grant a plan without payment — used for testing and support. */
  app.post<{ Body: { recipient?: string; plan?: string } }>(
    '/api/admin/subscriptions/grant',
    async (request, reply) => {
      const actor = requireAuth(request, reply)
      if (!actor) return
      const recipientRaw = String(request.body?.recipient ?? '').trim()
      const planKey = String(request.body?.plan ?? '').trim()
      if (!recipientRaw) return reply.code(400).send({ error: 'Recipient is required' })
      if (!isSubscriptionPlanKey(planKey)) return reply.code(400).send({ error: 'Invalid plan' })

      const target = resolveAdminRecipient(recipientRaw)
      if (!target.ok) return reply.code(target.status).send({ error: target.error })

      try {
        const activated = activateSubscription({
          userId: target.userId,
          planKey,
          source: 'admin',
          sourceRef: `admin:${actor.email}`,
          // Comped grants must not inflate revenue reporting.
          priceCents: 0,
        })
        db.prepare(
          'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(
          id('audit'),
          actor.email,
          'subscriptions.granted',
          target.userId,
          JSON.stringify({ planKey, recipient: recipientRaw, extended: activated.extended }),
          nowIso(),
        )
        return { ok: true, ...activated }
      } catch (reason) {
        return reply
          .code(400)
          .send({ error: reason instanceof Error ? reason.message : 'Could not grant subscription' })
      }
    },
  )

  app.post<{ Body: { recipient?: string } }>(
    '/api/admin/subscriptions/revoke',
    async (request, reply) => {
      const actor = requireAuth(request, reply)
      if (!actor) return
      const recipientRaw = String(request.body?.recipient ?? '').trim()
      if (!recipientRaw) return reply.code(400).send({ error: 'Recipient is required' })

      const target = resolveAdminRecipient(recipientRaw)
      if (!target.ok) return reply.code(target.status).send({ error: target.error })

      const result = revokeActiveSubscription(target.userId)
      if (!result.revoked) {
        return reply.code(404).send({ error: 'That user has no active subscription' })
      }
      db.prepare(
        'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id('audit'),
        actor.email,
        'subscriptions.revoked',
        target.userId,
        JSON.stringify({ recipient: recipientRaw, subscriptionId: result.subscriptionId }),
        nowIso(),
      )
      return { ok: true }
    },
  )

  app.get('/api/admin/fairness/queue', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    return dispatchQueueStats()
  })

  app.get('/api/admin/rpm', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    return { plans: getRpmCatalog(), cryptoEnabled: false }
  })

  app.patch<{
    Body: {
      plans?: Array<{ key?: string; rpm?: number; priceUsd?: number; priceCents?: number; enabled?: boolean }>
    }
  }>('/api/admin/rpm', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const raw = request.body?.plans
    if (!Array.isArray(raw) || raw.length === 0) return reply.code(400).send({ error: 'No RPM plans provided' })
    try {
      const plans = saveRpmCatalog(
        raw
          .filter((plan) => plan.key === 'free' || plan.key === 'standard' || plan.key === 'high' || plan.key === 'custom')
          .map((plan) => ({
            key: plan.key as 'free' | 'standard' | 'high' | 'custom',
            rpm: plan.rpm,
            enabled: plan.enabled,
            priceCents:
              plan.priceCents !== undefined
                ? Math.round(Number(plan.priceCents))
                : plan.priceUsd !== undefined
                  ? Math.round(Number(plan.priceUsd) * 100)
                  : undefined,
          })),
      )
      db.prepare(
        'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id('audit'), actor.email, 'settings.rpm_updated', 'rpm', JSON.stringify(plans), nowIso())
      return { ok: true, plans }
    } catch (reason) {
      return reply.code(400).send({ error: reason instanceof Error ? reason.message : 'Could not save RPM plans' })
    }
  })

  app.post<{ Body: { recipient?: string; rpm?: number | null; note?: string } }>(
    '/api/admin/rpm/grant',
    async (request, reply) => {
      const actor = requireAuth(request, reply)
      if (!actor) return
      const recipientRaw = String(request.body?.recipient ?? '').trim()
      if (!recipientRaw) return reply.code(400).send({ error: 'Recipient is required' })
      const target = resolveAdminRecipient(recipientRaw)
      if (!target.ok) return reply.code(target.status).send({ error: target.error })
      const rpm = request.body?.rpm == null || request.body.rpm === 0 ? null : Number(request.body.rpm)
      if (rpm != null && (!Number.isFinite(rpm) || rpm < 1 || rpm > 600)) {
        return reply.code(400).send({ error: 'RPM must be between 1 and 600' })
      }
      const granted = setUserRpmGrant(target.userId, rpm, request.body?.note ?? `admin:${actor.email}`)
      db.prepare(
        'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id('audit'),
        actor.email,
        granted == null ? 'rpm.grant_cleared' : 'rpm.granted',
        target.userId,
        JSON.stringify({ recipient: recipientRaw, rpm: granted }),
        nowIso(),
      )
      return { ok: true, rpm: adminRpmUser(target.userId) }
    },
  )

  app.patch<{
    Body: {
      rpmFree?: number
      rpmSubscription?: number
      subscriberPriority?: boolean
    }
  }>('/api/admin/settings/fairness', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const body = request.body ?? {}
    if (
      body.rpmFree === undefined &&
      body.rpmSubscription === undefined &&
      body.subscriberPriority === undefined
    ) {
      return reply.code(400).send({ error: 'No fairness settings provided' })
    }
    for (const field of ['rpmFree', 'rpmSubscription'] as const) {
      const raw = body[field]
      if (raw === undefined) continue
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 1 || n > 600) {
        return reply.code(400).send({ error: `${field} must be between 1 and 600` })
      }
    }
    const settings = setGatewayFairnessSettings({
      rpmFree: body.rpmFree,
      rpmSubscription: body.rpmSubscription,
      subscriberPriority: body.subscriberPriority,
    })
    db.prepare(
      'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id('audit'),
      actor.email,
      'settings.fairness_updated',
      'fairness',
      JSON.stringify(settings),
      nowIso(),
    )
    return { ok: true, settings, queue: dispatchQueueStats() }
  })

  app.patch<{
    Body: {
      enabled?: boolean
      minPurchaseDollars?: number
      referrerRewardUsd?: number
      refereeRewardUsd?: number
      referrerRewardXp?: number
      refereeRewardXp?: number
    }
  }>('/api/admin/settings/referral', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    try {
      const current = getReferralSettings()
      const minPurchaseCents =
        request.body.minPurchaseDollars !== undefined
          ? Math.round(Number(request.body.minPurchaseDollars) * 100)
          : current.minPurchaseCents
      const settings = setReferralSettings({
        enabled: request.body.enabled ?? current.enabled,
        minPurchaseCents,
        referrerRewardUsd: request.body.referrerRewardUsd,
        refereeRewardUsd: request.body.refereeRewardUsd,
      })
      db.prepare(
        'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id('audit'),
        actor.email,
        'settings.referral_updated',
        'referral',
        JSON.stringify(settings),
        nowIso(),
      )
      return { ok: true, settings }
    } catch (reason) {
      return reply.code(400).send({
        error: reason instanceof Error ? reason.message : 'Invalid referral settings',
      })
    }
  })

  app.get('/api/admin/promos', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    return {
      promos: listPromoCodes(),
      plans: getSubscriptionSettings().plans,
    }
  })

  app.post<{
    Body: {
      code?: string
      type?: 'balance' | 'subscription' | 'subscription_custom' | 'subscription_offer' | 'topup_bonus' | 'free_reset'
      planKey?: string | null
      customDays?: number | null
      customTokenLimit?: number | null
      discountMode?: string | null
      discountUsd?: number | null
      discountPercent?: number | null
      offerUnit?: string | null
      offerAmount?: number | null
      bonusTarget?: string | null
      bonusPercent?: number | null
      bonusDurationUnit?: string | null
      bonusDurationValue?: number | null
      rewardUsd?: number
      rewardTokens?: number
      maxUses?: number
      expiresAt?: string | null
      note?: string
      status?: string
    }
  }>('/api/admin/promos', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    try {
      const promo = createPromoCode({
        code: request.body.code ?? '',
        type: request.body.type,
        planKey: request.body.planKey,
        customDays: request.body.customDays,
        customTokenLimit: request.body.customTokenLimit,
        discountMode: request.body.discountMode,
        discountUsd: request.body.discountUsd,
        discountPercent: request.body.discountPercent,
        offerUnit: request.body.offerUnit,
        offerAmount: request.body.offerAmount,
        bonusTarget: request.body.bonusTarget,
        bonusPercent: request.body.bonusPercent,
        bonusDurationUnit: request.body.bonusDurationUnit,
        bonusDurationValue: request.body.bonusDurationValue,
        rewardUsd: Number(request.body.rewardUsd ?? (request.body.rewardTokens ?? 0) / TOKENS_PER_USD),
        maxUses: Number(request.body.maxUses),
        expiresAt: request.body.expiresAt ?? null,
        note: request.body.note ?? '',
        createdBy: actor.email,
        status: request.body.status === 'disabled' ? 'disabled' : 'active',
      })
      db.prepare(
        'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id('audit'),
        actor.email,
        'promo.created',
        promo.id,
        JSON.stringify({
          code: promo.code,
          type: promo.type,
          planKey: promo.plan_key,
          customDays: promo.custom_days,
          customTokenLimit: promo.custom_token_limit,
          rewardUsd: promo.reward_cents / 100,
          status: promo.status,
        }),
        nowIso(),
      )
      return { ok: true, promo }
    } catch (reason) {
      return reply.code(400).send({
        error: reason instanceof Error ? reason.message : 'Could not create promo',
      })
    }
  })

  app.patch<{
    Params: { id: string }
    Body: {
      code?: string
      type?: 'balance' | 'subscription' | 'subscription_custom' | 'subscription_offer' | 'topup_bonus' | 'free_reset'
      planKey?: string | null
      customDays?: number | null
      customTokenLimit?: number | null
      discountMode?: string | null
      discountUsd?: number | null
      discountPercent?: number | null
      offerUnit?: string | null
      offerAmount?: number | null
      bonusTarget?: string | null
      bonusPercent?: number | null
      bonusDurationUnit?: string | null
      bonusDurationValue?: number | null
      rewardUsd?: number
      rewardTokens?: number
      maxUses?: number
      expiresAt?: string | null
      note?: string
      status?: string
    }
  }>('/api/admin/promos/:id', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    try {
      const promo = updatePromoCode(request.params.id, {
        code: request.body.code ?? '',
        type: request.body.type,
        planKey: request.body.planKey,
        customDays: request.body.customDays,
        customTokenLimit: request.body.customTokenLimit,
        discountMode: request.body.discountMode,
        discountUsd: request.body.discountUsd,
        discountPercent: request.body.discountPercent,
        offerUnit: request.body.offerUnit,
        offerAmount: request.body.offerAmount,
        bonusTarget: request.body.bonusTarget,
        bonusPercent: request.body.bonusPercent,
        bonusDurationUnit: request.body.bonusDurationUnit,
        bonusDurationValue: request.body.bonusDurationValue,
        rewardUsd: Number(request.body.rewardUsd ?? (request.body.rewardTokens ?? 0) / TOKENS_PER_USD),
        maxUses: Number(request.body.maxUses),
        expiresAt: request.body.expiresAt ?? null,
        note: request.body.note ?? '',
        status: request.body.status === 'disabled' ? 'disabled' : 'active',
      })
      db.prepare(
        'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        id('audit'),
        actor.email,
        'promo.updated',
        promo.id,
        JSON.stringify({
          code: promo.code,
          type: promo.type,
          planKey: promo.plan_key,
          customDays: promo.custom_days,
          customTokenLimit: promo.custom_token_limit,
          rewardUsd: promo.reward_cents / 100,
          status: promo.status,
        }),
        nowIso(),
      )
      return { ok: true, promo }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not update promo'
      const code = message === 'Promo not found' ? 404 : 400
      return reply.code(code).send({ error: message })
    }
  })

  app.delete<{ Params: { id: string } }>('/api/admin/promos/:id', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const ok = deletePromoCode(request.params.id)
    if (!ok) return reply.code(404).send({ error: 'Promo not found' })
    db.prepare(
      'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id('audit'), actor.email, 'promo.deleted', request.params.id, '{}', nowIso())
    return { ok: true }
  })

  app.get('/api/admin/promos/generate', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    return { code: generatePromoCodeLocal(12) }
  })

  app.post<{ Body: { email?: string; userId?: string; amountUsd?: number; amountTokens?: number; note?: string } }>(
    '/api/admin/balances/adjust',
    async (request, reply) => {
      const actor = requireAuth(request, reply)
      if (!actor) return
      // Balance is adjusted in USD (min $0.01, no upper cap); legacy token clients convert at the fixed rate.
      const rawUsd = request.body.amountUsd != null ? Number(request.body.amountUsd) : Number(request.body.amountTokens ?? 0) / TOKENS_PER_USD
      const amountTokens = Math.round(rawUsd * TOKENS_PER_USD)
      const note = request.body.note?.trim()
      if (!Number.isFinite(rawUsd) || Math.abs(rawUsd) < 0.01) {
        return reply.code(400).send({ error: 'Amount must be at least $0.01 (positive or negative)' })
      }
      if (!note) {
        return reply.code(400).send({ error: 'Note is required' })
      }

      let userId = request.body.userId?.trim() || ''
      const email = request.body.email?.trim().toLowerCase()
      if (!userId && email) {
        const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined
        if (!row) return reply.code(404).send({ error: 'User not found for that email' })
        userId = row.id
      }
      if (!userId) return reply.code(400).send({ error: 'Email is required' })

      const amountCents = Math.round((amountTokens / TOKENS_PER_USD) * 100)
      try {
        const transaction = db.transaction(() => {
          const current = db.prepare('SELECT balance_tokens FROM users WHERE id = ?').get(userId) as { balance_tokens: number } | undefined
          if (!current) throw new Error('User not found')
          if (amountTokens < 0 && (current.balance_tokens + amountTokens) < 0) {
            throw new Error('Balance adjustment cannot drive balance below zero')
          }
          db.prepare('UPDATE users SET balance_tokens = balance_tokens + ? WHERE id = ?').run(amountTokens, userId)
          db.prepare(
            `INSERT INTO balance_transactions
              (id, user_id, type, amount_cents, amount_tokens, note, status, created_at)
             VALUES (?, ?, 'adjustment', ?, ?, ?, 'completed', ?)`,
          ).run(id('txn'), userId, amountCents, amountTokens, note, nowIso())
          db.prepare(
            'INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(
            id('audit'),
            actor.email,
            'balance.adjusted',
            userId,
            JSON.stringify({ amountUsd: amountCents / 100, note, email: email || null }),
            nowIso(),
          )
        })
        transaction()
      } catch (err: any) {
        return reply.code(400).send({ error: err.message || 'Balance adjustment failed' })
      }
      return { ok: true, amountUsd: amountCents / 100 }
    },
  )

  app.get('/api/admin/api-keys', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    return { keys: db.prepare(`
      SELECT k.id, k.user_id, k.name, k.prefix, k.spend_limit_tokens, k.spent_tokens, k.status, k.created_at, k.last_used_at, u.name, u.email
      FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.status != 'revoked'
      ORDER BY datetime(k.created_at) DESC
    `).all() }
  })

  app.patch<{ Params: { id: string }; Body: { status?: string } }>('/api/admin/api-keys/:id', async (request, reply) => {
    const actor = requireAuth(request, reply)
    if (!actor) return
    const status = request.body.status?.trim()
    if (!status || !['active', 'suspended', 'revoked'].includes(status)) {
      return reply.code(400).send({ error: 'Status must be active, suspended, or revoked' })
    }
    db.prepare('UPDATE api_keys SET status = ? WHERE id = ?').run(status, request.params.id)
    db.prepare('INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id('audit'), actor.email, 'key.updated', request.params.id, JSON.stringify({ status }), nowIso(),
    )
    return { ok: true }
  })

  app.get<{ Querystring: { user?: string } }>('/api/admin/usage', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    const userQuery = String(request.query?.user ?? '').trim()
    let userWhere = ''
    const params: unknown[] = []

    if (userQuery) {
      const user = db.prepare(`
        SELECT id FROM users
        WHERE lower(email) = lower(?)
           OR id = ?
           OR CAST(display_id AS TEXT) = ?
        LIMIT 1
      `).get(userQuery, userQuery, userQuery) as { id: string } | undefined

      if (!user) {
        return { events: [], userNotFound: true }
      }
      userWhere = 'WHERE e.user_id = ?'
      params.push(user.id)
    }

    const rows = db.prepare(`
      SELECT e.*, u.name AS user_name, u.email, k.prefix AS key_prefix,
             COALESCE(m.token_weight, 1.0) AS model_weight
      FROM usage_events e 
      LEFT JOIN users u ON u.id = e.user_id 
      LEFT JOIN api_keys k ON k.id = e.api_key_id
      LEFT JOIN model_catalog m ON m.id = e.model_id
      ${userWhere}
      ORDER BY e.created_at DESC
      LIMIT 500
    `).all(...params) as Array<Record<string, unknown>>
    // One pass for all events: getAdminUserAllowances is a full-table JOIN plus
    // a write transaction (expireDueSubscriptions), so calling it per event
    // (500×) would block the event loop for tens of seconds.
    const allowances = getAdminUserAllowances()
    const planPrices = new Map<string, number>(getSubscriptionSettings().plans.map((plan) => [plan.key as string, plan.priceCents]))
    return { events: rows.map((row) => {
      // Free-model allowance snapshot for the requester: live subscription plan
      // (with price) or the daily free tier, plus used/limit tokens.
      const allowance = allowances.get(String(row.user_id ?? '')) ?? null
      const isSubscriber = Boolean(allowance?.planKey)
      const planPriceCents = isSubscriber ? (planPrices.get(allowance?.planKey as string) ?? null) : null
      const planLabel = isSubscriber
        ? (planPriceCents != null ? `SUB ${planPriceCents / 100}$` : 'SUB')
        : 'FREE'
      const used = allowance?.used ?? 0
      const limit = allowance?.limit ?? null
      return {
        ...row,
        usage_plan_label: planLabel,
        usage_tokens_used: used,
        usage_tokens_limit: limit,
      }
    }) }
  })

  app.get('/api/admin/audit-logs', async (request, reply) => {
    if (!requireAuth(request, reply)) return
    return { logs: db.prepare('SELECT * FROM audit_logs ORDER BY datetime(created_at) DESC').all() }
  })

  await registerGatewayRoutes(app)
}
