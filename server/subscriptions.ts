import { db, getSetting, id, nowIso, setSetting } from './db.js'
import { formatTokenCount } from '../shared/billing.js'
import { siteName, siteUrl } from '../shared/brand.js'
import { debitWalletForPurchase } from './wallet.js'
import { applyOfferCents, getActiveSubscriptionOffer } from './subscriptionOffers.js'
import { applyCombinedSubscriptionBonus } from './promoBonus.js'
import {
  DEFAULT_FREE_DAILY_TOKENS,
  DEFAULT_SUBSCRIPTION_PLANS,
  SUBSCRIPTION_PLAN_KEYS,
  SUBSCRIPTIONS_PATH,
  defaultSubscriptionSettings,
  isSubscriptionPlanKey,
  nextUtcResetIso,
  utcPeriodKey,
  type FreeTierAccess,
  type SubscriptionGrantKind,
  type SubscriptionPlanConfig,
  type SubscriptionPlanKey,
  type SubscriptionSettings,
} from '../shared/subscriptions.js'

const SETTINGS_KEY = 'subscription_settings'

export function ensureSubscriptionSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_extra_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pack_label TEXT NOT NULL,
      token_limit INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      price_cents INTEGER NOT NULL DEFAULT 0,
      depleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_extra_tokens_user
      ON user_extra_tokens(user_id, status);

    CREATE TABLE IF NOT EXISTS extra_token_payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pack_tokens INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      order_id TEXT NOT NULL UNIQUE,
      payment_id TEXT,
      invoice_url TEXT,
      pay_amount TEXT,
      raw_status TEXT,
      credited_at TEXT,
      provider TEXT NOT NULL DEFAULT 'crypto',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_extra_token_payments_user
      ON extra_token_payments(user_id, created_at);

    CREATE TABLE IF NOT EXISTS free_tier_usage (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      period_key TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      tokens_reserved INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, period_key)
    );
    CREATE INDEX IF NOT EXISTS idx_free_tier_usage_period
      ON free_tier_usage(period_key);

    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_key TEXT NOT NULL,
      plan_label TEXT NOT NULL,
      kind TEXT NOT NULL,
      token_limit INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      tokens_reserved INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT,
      price_cents INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      expiry_warned_at TEXT,
      expired_notified_at TEXT,
      expiry_warn_24_at TEXT,
      expiry_warn_12_at TEXT,
      expiry_warn_3_at TEXT,
      usage_alert_step INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user
      ON user_subscriptions(user_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status
      ON user_subscriptions(status, expires_at);
  `)
}

ensureSubscriptionSchema()
{
  const freeCols = db.prepare('PRAGMA table_info(free_tier_usage)').all() as Array<{ name: string }>
  if (!freeCols.some((c) => c.name === 'tokens_reserved')) {
    db.exec('ALTER TABLE free_tier_usage ADD COLUMN tokens_reserved INTEGER NOT NULL DEFAULT 0')
  }
  const subCols = db.prepare('PRAGMA table_info(user_subscriptions)').all() as Array<{ name: string }>
  if (!subCols.some((c) => c.name === 'tokens_reserved')) {
    db.exec('ALTER TABLE user_subscriptions ADD COLUMN tokens_reserved INTEGER NOT NULL DEFAULT 0')
  }
}

function clampInt(value: unknown, fallback: number, min = 0): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, n)
}

function normalizeKind(value: unknown): SubscriptionGrantKind {
  return String(value ?? '').toLowerCase() === 'unlimited' ? 'unlimited' : 'custom'
}

export function getSubscriptionSettings(): SubscriptionSettings {
  const defaults = defaultSubscriptionSettings()
  const raw = getSetting(SETTINGS_KEY, '')
  if (!raw) return defaults

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return defaults
    const storedPlans = Array.isArray(parsed.plans) ? (parsed.plans as Array<Record<string, unknown>>) : []
    const plans = SUBSCRIPTION_PLAN_KEYS.map((key) => {
      const fallback = DEFAULT_SUBSCRIPTION_PLANS.find((plan) => plan.key === key) ?? DEFAULT_SUBSCRIPTION_PLANS[0]
      const stored = storedPlans.find((plan) => plan?.key === key)
      if (!stored) return { ...fallback }
      return {
        key,
        label: typeof stored.label === 'string' && stored.label.trim() ? stored.label.trim() : fallback.label,
        days: clampInt(stored.days, fallback.days, 1),
        enabled: stored.enabled === undefined ? fallback.enabled : Boolean(stored.enabled),
        priceCents: clampInt(stored.priceCents, fallback.priceCents, 0),
        kind: normalizeKind(stored.kind ?? fallback.kind),
        tokenLimit: clampInt(stored.tokenLimit, fallback.tokenLimit, 0),
        isFeatured: stored.isFeatured !== undefined ? Boolean(stored.isFeatured) : fallback.isFeatured,
      } satisfies SubscriptionPlanConfig
    })

    return {
      freeDailyTokens: clampInt(parsed.freeDailyTokens, defaults.freeDailyTokens, 0),
      plans,
    }
  } catch {
    return defaults
  }
}

export function updateSubscriptionSettings(input: {
  freeDailyTokens?: number
  plans?: Array<{
    key: string
    days?: number
    label?: string
    enabled?: boolean
    priceCents?: number
    kind?: string
    tokenLimit?: number
    isFeatured?: boolean
  }>
}): SubscriptionSettings {
  const current = getSubscriptionSettings()
  const next: SubscriptionSettings = {
    freeDailyTokens:
      input.freeDailyTokens === undefined
        ? current.freeDailyTokens
        : clampInt(input.freeDailyTokens, current.freeDailyTokens, 0),
    plans: current.plans.map((plan) => {
      const patch = input.plans?.find((row) => row.key === plan.key)
      if (!patch) return { ...plan }
      const nextDays = patch.days !== undefined ? clampInt(patch.days, plan.days, 1) : plan.days
      const nextLabel = typeof patch.label === 'string' && patch.label.trim() ? patch.label.trim() : `${nextDays} days`
      return {
        ...plan,
        days: nextDays,
        label: nextLabel,
        enabled: patch.enabled === undefined ? plan.enabled : Boolean(patch.enabled),
        priceCents: clampInt(patch.priceCents, plan.priceCents, 0),
        kind: patch.kind === undefined ? plan.kind : normalizeKind(patch.kind),
        tokenLimit: clampInt(patch.tokenLimit, plan.tokenLimit, 0),
        isFeatured: patch.isFeatured !== undefined ? Boolean(patch.isFeatured) : plan.isFeatured,
      }
    }),
  }
  setSetting(SETTINGS_KEY, JSON.stringify(next))
  return next
}

export function getSubscriptionPlan(key: SubscriptionPlanKey): SubscriptionPlanConfig | null {
  return getSubscriptionSettings().plans.find((plan) => plan.key === key) ?? null
}

export function getFreeDailyTokens() {
  return getSubscriptionSettings().freeDailyTokens
}

export type ExtraTokensPackRow = {
  id: string
  user_id: string
  pack_label: string
  token_limit: number
  tokens_used: number
  status: string
  source: string
  source_ref: string | null
  price_cents: number
  depleted_at: string | null
  created_at: string
  updated_at: string
}

export type ActiveExtraTokensPack = {
  id: string
  planKey: SubscriptionPlanKey | null
  planLabel: string
  kind: SubscriptionGrantKind
  unlimited: boolean
  tokenLimit: number
  tokensUsed: number
  remaining: number | null
  startedAt: string
  expiresAt: string | null
  source: string
}

export type SubscriptionRow = {
  id: string
  user_id: string
  plan_key: string
  plan_label: string
  kind: string
  token_limit: number
  tokens_used: number
  status: string
  source: string
  source_ref: string | null
  price_cents: number
  started_at: string
  expires_at: string
  created_at: string
  updated_at: string
}

export function expireDueSubscriptions(): number {
  const result = db
    .prepare(
      `UPDATE user_subscriptions
       SET status = 'expired', updated_at = ?
       WHERE status = 'active' AND datetime(expires_at) <= datetime(?)`,
    )
    .run(nowIso(), nowIso())
  return result.changes
}

export function loadActiveSubscriptionRow(userId: string): SubscriptionRow | null {
  expireDueSubscriptions()
  const row = db
    .prepare(
      `SELECT * FROM user_subscriptions
       WHERE user_id = ? AND status = 'active' AND datetime(expires_at) > datetime(?)
       ORDER BY datetime(expires_at) DESC
       LIMIT 1`,
    )
    .get(userId, nowIso()) as SubscriptionRow | undefined
  return row ?? null
}

function toActiveExtraTokensPack(row: SubscriptionRow): ActiveExtraTokensPack {
  const unlimited = normalizeKind(row.kind) === 'unlimited'
  const tokensUsed = Math.max(0, row.tokens_used)
  const tokenLimit = Math.max(0, row.token_limit)
  return {
    id: row.id,
    planKey: isSubscriptionPlanKey(row.plan_key) ? row.plan_key : null,
    planLabel: row.plan_label,
    kind: unlimited ? 'unlimited' : 'custom',
    unlimited,
    tokenLimit,
    tokensUsed,
    remaining: unlimited ? null : Math.max(0, tokenLimit - tokensUsed),
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    source: row.source,
  }
}

/**
 * Returns user's active pack.
 * If remaining tokens have dropped below 1,000,000 (and not unlimited),
 * the pack is marked depleted and null is returned.
 */
export function getActiveExtraTokenPack(userId: string): ActiveExtraTokensPack | null {
  expireDueSubscriptions()
  const row = loadActiveSubscriptionRow(userId)
  if (!row) return null
  return toActiveExtraTokensPack(row)
}

/** Backward-compatible alias */
export const getActiveSubscription = getActiveExtraTokenPack

function freeUsedToday(userId: string, periodKey = utcPeriodKey()) {
  const row = db
    .prepare(
      `SELECT tokens_used, COALESCE(tokens_reserved, 0) AS tokens_reserved
       FROM free_tier_usage WHERE user_id = ? AND period_key = ?`,
    )
    .get(userId, periodKey) as { tokens_used: number; tokens_reserved: number } | undefined
  return {
    used: Math.max(0, Number(row?.tokens_used ?? 0)),
    reserved: Math.max(0, Number(row?.tokens_reserved ?? 0)),
  }
}

/**
 * Access resolution:
 * 1. Unexpired subscription: free models draw that pool until it is empty.
 * 2. Otherwise: the daily free allowance, which resets at 00:00 UTC.
 * A spent subscription stays blocked until it expires or the user buys another plan.
 */
export function getFreeTierAccess(userId: string): FreeTierAccess {
  expireDueSubscriptions()
  const rawRow = loadActiveSubscriptionRow(userId)

  if (rawRow) {
    const unlimited = normalizeKind(rawRow.kind) === 'unlimited'
    const reserved = Math.max(0, Number((rawRow as any).tokens_reserved ?? 0))
    const totalCommitted = rawRow.tokens_used + reserved
    const remaining = unlimited ? null : Math.max(0, rawRow.token_limit - totalCommitted)
    const planKey = isSubscriptionPlanKey(rawRow.plan_key) && rawRow.plan_key !== 'custom' ? rawRow.plan_key : null
    return {
      allowed: unlimited || (remaining ?? 0) > 0,
      mode: 'subscription',
      unlimited,
      limit: unlimited ? null : rawRow.token_limit,
      used: rawRow.tokens_used,
      remaining,
      planKey,
      planLabel: rawRow.plan_label,
      expiresAt: rawRow.expires_at,
      resetsAt: null,
      telegramVerified: true,
    }
  }

  const todayKey = utcPeriodKey()
  const dailyLimit = getFreeDailyTokens()
  const usage = freeUsedToday(userId, todayKey)
  const totalCommitted = usage.used + usage.reserved
  return {
    allowed: totalCommitted < dailyLimit,
    mode: 'free',
    unlimited: false,
    limit: dailyLimit,
    used: usage.used,
    remaining: Math.max(0, dailyLimit - totalCommitted),
    planKey: null,
    planLabel: 'FREE',
    expiresAt: null,
    resetsAt: nextUtcResetIso(),
    telegramVerified: true,
  }
}

export type ReserveFreeTierResult =
  | { ok: true; holdType: 'subscription' | 'free_tier'; targetId: string; periodKey?: string; reservedTokens: number }
  | { ok: false; remaining: number; limit: number; error: string }

/**
 * Atomically reserves free-tier or subscription tokens before sending requests upstream.
 * Uses an immediate SQLite transaction to eliminate concurrency / race condition bypasses (H-04).
 */
export function tryReserveFreeTierTokens(userId: string, requestedTokens: number): ReserveFreeTierResult {
  const amount = Math.max(0, Math.floor(Number(requestedTokens) || 0))
  const now = nowIso()
  const todayKey = utcPeriodKey()

  return db.transaction(() => {
    // 1. Subscription check
    const rawRow = loadActiveSubscriptionRow(userId)
    if (rawRow) {
      const unlimited = normalizeKind(rawRow.kind) === 'unlimited'
      if (unlimited) {
        return { ok: true as const, holdType: 'subscription' as const, targetId: rawRow.id, reservedTokens: 0 }
      }
      const reserved = Math.max(0, Number((rawRow as any).tokens_reserved ?? 0))
      const projected = rawRow.tokens_used + reserved + amount
      if (projected > rawRow.token_limit) {
        const remaining = Math.max(0, rawRow.token_limit - (rawRow.tokens_used + reserved))
        return {
          ok: false as const,
          remaining,
          limit: rawRow.token_limit,
          error: `Subscription token limit would be exceeded. Remaining: ${remaining.toLocaleString('en-US')}, required: ${amount.toLocaleString('en-US')}`,
        }
      }
      db.prepare(
        `UPDATE user_subscriptions
         SET tokens_reserved = COALESCE(tokens_reserved, 0) + ?, updated_at = ?
         WHERE id = ?`,
      ).run(amount, now, rawRow.id)
      return { ok: true as const, holdType: 'subscription' as const, targetId: rawRow.id, reservedTokens: amount }
    }

    // 2. Daily free allowance check
    const dailyLimit = getFreeDailyTokens()
    const usage = freeUsedToday(userId, todayKey)
    const projected = usage.used + usage.reserved + amount

    if (projected > dailyLimit) {
      const remaining = Math.max(0, dailyLimit - (usage.used + usage.reserved))
      return {
        ok: false as const,
        remaining,
        limit: dailyLimit,
        error: `Daily free allowance would be exceeded. Remaining: ${remaining.toLocaleString('en-US')}, required: ${amount.toLocaleString('en-US')}`,
      }
    }

    db.prepare(
      `INSERT INTO free_tier_usage (user_id, period_key, tokens_used, tokens_reserved, updated_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(user_id, period_key)
       DO UPDATE SET tokens_reserved = COALESCE(tokens_reserved, 0) + excluded.tokens_reserved, updated_at = excluded.updated_at`,
    ).run(userId, todayKey, amount, now)

    return { ok: true as const, holdType: 'free_tier' as const, targetId: userId, periodKey: todayKey, reservedTokens: amount }
  })()
}

export function settleFreeTierReservation(input: {
  userId: string
  holdType: 'subscription' | 'free_tier'
  targetId: string
  periodKey?: string
  reservedTokens: number
  actualTokens: number
}) {
  const now = nowIso()
  const reserved = Math.max(0, Math.floor(Number(input.reservedTokens) || 0))
  const actual = Math.max(0, Math.floor(Number(input.actualTokens) || 0))

  db.transaction(() => {
    if (input.holdType === 'subscription') {
      db.prepare(
        `UPDATE user_subscriptions
         SET tokens_reserved = MAX(0, COALESCE(tokens_reserved, 0) - ?),
             tokens_used = tokens_used + ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(reserved, actual, now, input.targetId)
    } else {
      const periodKey = input.periodKey || utcPeriodKey()
      db.prepare(
        `INSERT INTO free_tier_usage (user_id, period_key, tokens_used, tokens_reserved, updated_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(user_id, period_key)
         DO UPDATE SET
           tokens_reserved = MAX(0, COALESCE(tokens_reserved, 0) - ?),
           tokens_used = tokens_used + ?,
           updated_at = excluded.updated_at`,
      ).run(input.userId, periodKey, actual, now, reserved, actual)
    }
  })()
}

export function releaseFreeTierReservation(input: {
  userId: string
  holdType: 'subscription' | 'free_tier'
  targetId: string
  periodKey?: string
  reservedTokens: number
}) {
  const reserved = Math.max(0, Math.floor(Number(input.reservedTokens) || 0))
  if (reserved <= 0) return

  const now = nowIso()
  db.transaction(() => {
    if (input.holdType === 'subscription') {
      db.prepare(
        `UPDATE user_subscriptions
         SET tokens_reserved = MAX(0, COALESCE(tokens_reserved, 0) - ?),
             updated_at = ?
         WHERE id = ?`,
      ).run(reserved, now, input.targetId)
    } else {
      const periodKey = input.periodKey || utcPeriodKey()
      db.prepare(
        `UPDATE free_tier_usage
         SET tokens_reserved = MAX(0, COALESCE(tokens_reserved, 0) - ?),
             updated_at = ?
         WHERE user_id = ? AND period_key = ?`,
      ).run(reserved, now, input.userId, periodKey)
    }
  })()
}

/**
 * Charges zero-cost model usage against user's account.
 */
export function consumeFreeTierTokens(userId: string, tokens: number) {
  const amount = Math.max(0, Math.floor(Number(tokens) || 0))
  if (amount <= 0) return

  const now = nowIso()
  db.transaction(() => {
    const rawRow = loadActiveSubscriptionRow(userId)
    if (rawRow) {
      db.prepare(
        `UPDATE user_subscriptions
         SET tokens_used = tokens_used + ?, updated_at = ?
         WHERE id = ?`,
      ).run(amount, now, rawRow.id)
      return
    }

    const periodKey = utcPeriodKey()
    db.prepare(
      `INSERT INTO free_tier_usage (user_id, period_key, tokens_used, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, period_key)
       DO UPDATE SET tokens_used = tokens_used + excluded.tokens_used, updated_at = excluded.updated_at`,
    ).run(userId, periodKey, amount, now)
  })()
}

export function resetFreeTierDailyUsage(userId: string, periodKey = utcPeriodKey()) {
  const now = nowIso()
  db.prepare(
    `INSERT INTO free_tier_usage (user_id, period_key, tokens_used, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(user_id, period_key)
     DO UPDATE SET tokens_used = 0, updated_at = excluded.updated_at`,
  ).run(userId, periodKey, now)
}

let notificationTimer: ReturnType<typeof setInterval> | null = null

export function startSubscriptionNotificationJob() {
  if (notificationTimer || process.env.SUBSCRIPTION_REMINDERS_ENABLED === '0') return

  const tick = async () => {
    try {
      expireDueSubscriptions()
    } catch (reason) {
      console.error('[subscriptions] expiry notification run failed', reason)
    }
  }

  setTimeout(() => void tick(), 20_000).unref?.()
  notificationTimer = setInterval(() => void tick(), 10 * 60_000)
  notificationTimer.unref?.()
}

/** 402 body copy shown when a free-model allowance is spent. */
export function freeTierExhaustedMessage(access: FreeTierAccess) {
  const page = `${siteUrl()}${SUBSCRIPTIONS_PATH}`
  if (access.mode === 'subscription') {
    const limit = access.limit ?? 0
    return (
      `Subscription limit reached (${formatTokenCount(access.used)} of ` +
      `${formatTokenCount(limit)} tokens). Buy a subscription at ${page} to continue.`
    )
  }
  const limit = access.limit ?? DEFAULT_FREE_DAILY_TOKENS
  return (
    `Free daily limit reached (${formatTokenCount(limit)} tokens). ` +
    `Buy a subscription at ${page} to continue.`
  )
}

export type ActivateSubscriptionInput = {
  userId: string
  planKey?: SubscriptionPlanKey | string | null
  planLabel?: string | null
  source: 'purchase' | 'admin' | 'promo'
  sourceRef?: string | null
  priceCents?: number
  grantedDays?: number | null
  grantedKind?: string | null
  grantedTokenLimit?: number | null
}

export function activateSubscription(input: ActivateSubscriptionInput) {
  const plan = input.planKey && isSubscriptionPlanKey(input.planKey) ? getSubscriptionPlan(input.planKey) : null
  const now = nowIso()
  const days = Math.max(1, Math.floor(Number(input.grantedDays ?? plan?.days ?? 1)))
  const kind = normalizeKind(input.grantedKind ?? plan?.kind ?? 'custom')
  const baseTokens = Math.max(0, Math.floor(Number(input.grantedTokenLimit ?? plan?.tokenLimit ?? 0)))
  const applyCheckoutBonus = input.source === 'purchase'
  const tokenLimitForGrant = kind === 'unlimited' || baseTokens <= 0 || !applyCheckoutBonus
    ? baseTokens
    : applyCombinedSubscriptionBonus(input.userId, baseTokens).tokens

  const durationMs = days * 24 * 60 * 60 * 1000
  const planKey = plan?.key ?? (typeof input.planKey === 'string' && input.planKey.trim() ? input.planKey.trim() : 'custom')
  const planLabel = input.planLabel ?? plan?.label ?? `${days} days`

  return db.transaction(() => {
    const existing = loadActiveSubscriptionRow(input.userId)

    if (existing) {
      const base = Math.max(Date.parse(existing.expires_at) || Date.now(), Date.now())
      const expiresAt = new Date(base + durationMs).toISOString()
      const unlimited = normalizeKind(existing.kind) === 'unlimited'
      const tokenLimit = unlimited ? 0 : Math.max(0, existing.token_limit) + tokenLimitForGrant

      db.prepare(
        `UPDATE user_subscriptions
         SET plan_key = ?, plan_label = ?, kind = ?, token_limit = ?, expires_at = ?,
             price_cents = price_cents + ?, source_ref = COALESCE(?, source_ref), updated_at = ?,
             status = 'active', expiry_warned_at = NULL, expired_notified_at = NULL,
             expiry_warn_24_at = NULL, expiry_warn_12_at = NULL, expiry_warn_3_at = NULL,
             usage_alert_step = 0
         WHERE id = ?`,
      ).run(
        planKey,
        planLabel,
        unlimited ? 'unlimited' : 'custom',
        tokenLimit,
        expiresAt,
        Math.max(0, Math.floor(input.priceCents ?? plan?.priceCents ?? 0)),
        input.sourceRef ?? null,
        now,
        existing.id,
      )

      db.prepare(
        `UPDATE user_extra_tokens
         SET pack_label = ?, token_limit = ?, price_cents = price_cents + ?,
             source_ref = COALESCE(?, source_ref), status = 'active', depleted_at = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(
        planLabel,
        tokenLimit,
        Math.max(0, Math.floor(input.priceCents ?? plan?.priceCents ?? 0)),
        input.sourceRef ?? null,
        now,
        existing.id,
      )

      const row = db.prepare(`SELECT * FROM user_subscriptions WHERE id = ?`).get(existing.id) as SubscriptionRow
      return { extended: true as const, subscription: toActiveExtraTokensPack(row) }
    }

    const subscriptionId = id('sub')
    const expiresAt = new Date(Date.now() + durationMs).toISOString()
    const finalTokens = kind === 'unlimited' ? 0 : tokenLimitForGrant

    db.prepare(
      `INSERT INTO user_subscriptions
        (id, user_id, plan_key, plan_label, kind, token_limit, tokens_used, status, source,
         source_ref, price_cents, started_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      subscriptionId,
      input.userId,
      planKey,
      planLabel,
      kind,
      finalTokens,
      input.source,
      input.sourceRef ?? null,
      Math.max(0, Math.floor(input.priceCents ?? plan?.priceCents ?? 0)),
      now,
      expiresAt,
      now,
      now,
    )

    db.prepare(
      `INSERT INTO user_extra_tokens
        (id, user_id, pack_label, token_limit, tokens_used, status, source, source_ref, price_cents, depleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'active', ?, ?, ?, NULL, ?, ?)`,
    ).run(
      subscriptionId,
      input.userId,
      planLabel,
      finalTokens,
      input.source,
      input.sourceRef ?? null,
      Math.max(0, Math.floor(input.priceCents ?? plan?.priceCents ?? 0)),
      now,
      now,
    )

    const row = db.prepare(`SELECT * FROM user_subscriptions WHERE id = ?`).get(subscriptionId) as SubscriptionRow
    return { extended: false as const, subscription: toActiveExtraTokensPack(row) }
  })()
}



export function revokeActiveSubscription(userId: string) {
  const row = loadActiveSubscriptionRow(userId)
  if (!row) return { revoked: false as const }
  const now = nowIso()

  db.prepare(
    `UPDATE user_subscriptions SET status = 'revoked', updated_at = ? WHERE id = ? AND status = 'active'`,
  ).run(now, row.id)

  db.prepare(
    `UPDATE user_extra_tokens SET status = 'revoked', updated_at = ? WHERE id = ?`,
  ).run(now, row.id)

  return { revoked: true as const, subscriptionId: row.id }
}

export function purchaseSubscriptionWithBalance(input: {
  userId: string
  planKey: SubscriptionPlanKey
  tokens?: number
}) {
  if (input.planKey === 'custom' || (input.tokens != null && input.tokens > 0 && !isSubscriptionPlanKey(input.planKey))) {
    throw new Error('Choose a subscription plan')
  }
  const plan = getSubscriptionPlan(input.planKey)
  if (!plan || !plan.enabled) throw new Error('Unknown subscription plan')
  const listCents = Math.max(0, Math.round(plan.priceCents))
  const offer = getActiveSubscriptionOffer(input.userId)
  const amountCents = applyOfferCents(listCents, offer)

  if (amountCents < 1) throw new Error('Plan price is not configured')
  const paymentId = id('spay')
  const sourceRef = `wallet:sub:${paymentId}`

  const activated = db.transaction(() => {
    debitWalletForPurchase({
      userId: input.userId,
      amountCents,
      kind: 'subscription',
      sourceRef,
      note: `Subscription ${plan.label} · paid from balance`,
    })
    return activateSubscription({
      userId: input.userId,
      planKey: plan.key,
      planLabel: plan.label,
      source: 'purchase',
      sourceRef,
      priceCents: amountCents,
      grantedDays: plan.days,
      grantedKind: plan.kind,
      grantedTokenLimit: plan.tokenLimit,
    })
  })()

  return {
    credited: true as const,
    already: false as const,
    paymentId,
    provider: 'balance' as const,
    asset: 'BALANCE' as const,
    amountUsd: amountCents / 100,
    amountCents,
    planKey: plan.key,
    planLabel: plan.label,
    extended: activated.extended,
    subscription: activated.subscription,
    access: getFreeTierAccess(input.userId),
  }
}

const EXPIRY_WINDOWS = [
  { ms: 24 * 60 * 60 * 1000, column: 'expiry_warn_24_at', label: '24 hours' },
  { ms: 12 * 60 * 60 * 1000, column: 'expiry_warn_12_at', label: '12 hours' },
  { ms: 3 * 60 * 60 * 1000, column: 'expiry_warn_3_at', label: '3 hours' },
] as const

function formatExpiryForMessage(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function subscriptionStillHasTokens(row: { kind: string; token_limit: number; tokens_used: number }) {
  if (row.kind === 'unlimited' || row.token_limit <= 0) return true
  return row.tokens_used < row.token_limit
}

export async function runSubscriptionExpiryNotifications(
  notify: (userId: string, text: string) => Promise<boolean>,
) {
  const now = Date.now()
  const nowIsoStr = new Date(now).toISOString()
  let warned = 0
  let expired = 0

  for (const window of EXPIRY_WINDOWS) {
    const warnBeforeIso = new Date(now + window.ms).toISOString()
    const dueWarning = db
      .prepare(
        `SELECT s.id, s.user_id, s.plan_label, s.kind, s.token_limit, s.tokens_used, s.expires_at
         FROM user_subscriptions s
         JOIN users u ON u.id = s.user_id
         WHERE s.status = 'active'
           AND s.${window.column} IS NULL
           AND datetime(s.expires_at) > datetime(?)
           AND datetime(s.expires_at) <= datetime(?)
           AND u.telegram_id IS NOT NULL
         LIMIT 200`,
      )
      .all(nowIsoStr, warnBeforeIso) as Array<{
      id: string
      user_id: string
      plan_label: string
      kind: string
      token_limit: number
      tokens_used: number
      expires_at: string
    }>

    for (const row of dueWarning) {
      if (!subscriptionStillHasTokens(row)) {
        db.prepare(
          `UPDATE user_subscriptions SET ${window.column} = ?, updated_at = ? WHERE id = ? AND ${window.column} IS NULL`,
        ).run(nowIsoStr, nowIsoStr, row.id)
        continue
      }
      const claimed = db
        .prepare(
          `UPDATE user_subscriptions SET ${window.column} = ?, updated_at = ?
           WHERE id = ? AND ${window.column} IS NULL`,
        )
        .run(nowIsoStr, nowIsoStr, row.id)
      if (claimed.changes !== 1) continue

      const left =
        row.kind === 'unlimited' || row.token_limit <= 0
          ? 'Unlimited free-model tokens'
          : `${formatTokenCount(Math.max(0, row.token_limit - row.tokens_used))} tokens left`
      const text =
        `⏳ Your ${siteName()} subscription expires in ${window.label}\n\n` +
        `Plan: ${row.plan_label}\n` +
        `${left}\n` +
        `Expires: ${formatExpiryForMessage(row.expires_at)}\n\n` +
        `Renew at ${siteUrl()}${SUBSCRIPTIONS_PATH}`
      if (await notify(row.user_id, text)) warned += 1
    }
  }

  const dueExpired = db
    .prepare(
      `SELECT s.id, s.user_id, s.plan_label, s.expires_at
       FROM user_subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.status IN ('active', 'expired')
         AND s.expired_notified_at IS NULL
         AND datetime(s.expires_at) <= datetime(?)
         AND u.telegram_id IS NOT NULL
       LIMIT 200`,
    )
    .all(nowIsoStr) as Array<{
    id: string
    user_id: string
    plan_label: string
    expires_at: string
  }>

  for (const row of dueExpired) {
    const stillCovered = loadActiveSubscriptionRow(row.user_id)
    const claimed = db
      .prepare(
        `UPDATE user_subscriptions SET expired_notified_at = ?, updated_at = ?
         WHERE id = ? AND expired_notified_at IS NULL`,
      )
      .run(nowIsoStr, nowIsoStr, row.id)
    if (claimed.changes !== 1) continue
    if (stillCovered && stillCovered.id !== row.id) continue

    const text =
      `🔴 Your ${siteName()} subscription has ended\n\n` +
      `Plan: ${row.plan_label}\n` +
      `Expired: ${formatExpiryForMessage(row.expires_at)}\n\n` +
      `You are back on the free daily allowance of ` +
      `${formatTokenCount(getFreeDailyTokens())} tokens, which resets at 00:00 UTC.\n\n` +
      `Renew at ${siteUrl()}${SUBSCRIPTIONS_PATH}`
    if (await notify(row.user_id, text)) expired += 1
  }

  return { warned, expired }
}

export function getAdminActiveSubscriptions(limit = 100) {
  const rows = db
    .prepare(
      `SELECT s.id, s.user_id, u.email, s.plan_key, s.plan_label, s.kind, s.token_limit, s.tokens_used,
              s.price_cents, s.source, s.started_at, s.expires_at, s.created_at
       FROM user_subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.status = 'active'
       ORDER BY datetime(s.created_at) DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string
    user_id: string
    email: string
    plan_key: string
    plan_label: string
    kind: string
    source: string
    token_limit: number
    tokens_used: number
    price_cents: number
    started_at: string
    expires_at: string
    created_at: string
  }>

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    email: r.email,
    planKey: r.plan_key,
    planLabel: r.plan_label,
    kind: r.kind === 'unlimited' ? 'unlimited' as const : 'custom' as const,
    source: r.source,
    tokenLimit: r.token_limit,
    tokensUsed: r.tokens_used,
    remaining: Math.max(0, r.token_limit - r.tokens_used),
    priceCents: r.price_cents,
    expiresAt: r.expires_at,
    startedAt: r.started_at || r.created_at,
  }))
}

export function getAdminSubscriptionStats() {
  const active = (
    db.prepare(`SELECT COUNT(*) AS c FROM user_subscriptions WHERE status = 'active'`).get() as { c: number }
  ).c
  const revenueRow = db
    .prepare(
      `SELECT COALESCE(SUM(price_cents), 0) AS s FROM user_subscriptions WHERE source = 'purchase'`,
    )
    .get() as { s: number }
  return {
    activeSubscriptions: active,
    revenueCents: Math.max(0, Math.round(Number(revenueRow?.s) || 0)),
    byPlan: [],
    freeTierToday: {
      periodKey: utcPeriodKey(),
      users: 0,
      tokensUsed: 0,
      resetsAt: nextUtcResetIso(),
    },
  }
}

export function getAdminUserAllowances() {
  const rows = db
    .prepare(
      `SELECT u.id, s.plan_label, s.token_limit, s.tokens_used, s.expires_at
       FROM users u
       LEFT JOIN user_subscriptions s ON s.user_id = u.id AND s.status = 'active'`,
    )
    .all() as Array<{ id: string; plan_label: string | null; token_limit: number | null; tokens_used: number | null; expires_at: string | null }>

  const map = new Map<string, {
    planKey: string | null
    planLabel: string
    kind: 'custom'
    unlimited: false
    limit: number | null
    used: number
    remaining: number | null
    percentUsed: number | null
    expiresAt: string | null
  }>()

  const dailyLimit = getFreeDailyTokens()
  for (const r of rows) {
    if (r.plan_label && r.token_limit != null && r.token_limit > 0) {
      const used = r.tokens_used ?? 0
      const limit = r.token_limit
      map.set(r.id, {
        planKey: 'custom',
        planLabel: r.plan_label,
        kind: 'custom',
        unlimited: false,
        limit,
        used,
        remaining: Math.max(0, limit - used),
        percentUsed: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
        expiresAt: r.expires_at,
      })
    } else {
      const usage = freeUsedToday(r.id)
      const used = usage.used
      map.set(r.id, {
        planKey: null,
        planLabel: 'FREE',
        kind: 'custom',
        unlimited: false,
        limit: dailyLimit,
        used,
        remaining: Math.max(0, dailyLimit - used),
        percentUsed: dailyLimit > 0 ? Math.min(100, Math.round((used / dailyLimit) * 100)) : 0,
        expiresAt: null,
      })
    }
  }
  return map
}

export function getSubscriptionHistory(userId: string) {
  return db
    .prepare(
      `SELECT id, plan_label, token_limit, tokens_used, status, price_cents, created_at
       FROM user_subscriptions
       WHERE user_id = ?
       ORDER BY datetime(created_at) DESC`,
    )
    .all(userId)
}
