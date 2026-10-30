import { db, id, nowIso } from './db.js'
import { formatUsdExact } from '../shared/billing.js'
import { chargeTokens, isFreeWeight } from '../shared/billing.js'
import { debitApiTokens, debitRegularTokens, hasUserTopup } from './restrictedCredits.js'

/** Default max output when client omits max_tokens / max_output_tokens. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096
/** Floor for estimated input tokens (provider overhead / system tools). */
const MIN_INPUT_RESERVE_TOKENS = 2_048
/** Safety buffer on top of estimated cost (ceil). */
const RESERVE_BUFFER_RATIO = 0.08
/** Open reservations auto-release after this TTL (covers crashes / stuck streams). */
export const RESERVATION_TTL_MS = 15 * 60 * 1000

const reservationAbortCleanups = new Map<string, () => void>()

export type TokenReservationRow = {
  id: string
  user_id: string
  api_key_id: string
  model_id: string | null
  path: string | null
  reserved_tokens: number
  reserved_restricted_tokens: number
  restricted_credits_allowed: number
  charged_tokens: number
  status: 'open' | 'settled' | 'released' | 'expired'
  created_at: string
  updated_at: string
  expires_at: string
  settled_at: string | null
}

function textCharCount(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + textCharCount(item), 0)
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    if (typeof row.text === 'string') return row.text.length
    if (
      typeof row.content === 'string' ||
      Array.isArray(row.content) ||
      (row.content && typeof row.content === 'object')
    ) {
      return textCharCount(row.content)
    }
    if ('input' in row) return textCharCount(row.input)
    if ('messages' in row) return textCharCount(row.messages)
    if ('system' in row) return textCharCount(row.system)
    if ('prompt' in row) return textCharCount(row.prompt)
  }
  return 0
}

function charsToTokens(chars: number) {
  return Math.max(1, Math.ceil(Math.max(0, chars) / 4))
}

/**
 * Upper-bound token cost for a model call (input estimate + max output × weight).
 * Used only for pre-authorization — final charge uses real usage.
 */
export function estimateModelReservationTokens(
  body: Record<string, unknown>,
  weight: number,
): { inputTokens: number; outputTokens: number; costTokens: number } {
  const inputChars =
    textCharCount(body.messages) +
    textCharCount(body.input) +
    textCharCount(body.state) +
    (body.questions ? JSON.stringify(body.questions).length : 0) +
    textCharCount(body.prompt) +
    textCharCount(body.system)
  const inputTokens = Math.max(charsToTokens(Math.max(inputChars, 16)), MIN_INPUT_RESERVE_TOKENS)

  const rawMax = Number(body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens ?? 0)
  let outputTokens = DEFAULT_MAX_OUTPUT_TOKENS
  if (Number.isFinite(rawMax) && rawMax > 0) {
    // Honor the caller's declared cap in full; silently capping it would allow
    // a completion to cost more than its pre-authorization.
    outputTokens = Math.max(1, Math.floor(rawMax))
  }

  if (isFreeWeight(weight)) {
    return { inputTokens, outputTokens, costTokens: 0 }
  }
  const base = chargeTokens(inputTokens, outputTokens, weight)
  const buffered = Math.max(1, Math.ceil(base * (1 + RESERVE_BUFFER_RATIO)))
  return { inputTokens, outputTokens, costTokens: buffered }
}

export function getOpenReservedTokensForUser(userId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(reserved_tokens - charged_tokens), 0) AS n
       FROM token_reservations
       WHERE user_id = ? AND status = 'open'`,
    )
    .get(userId) as { n: number }
  return Math.max(0, Number(row?.n ?? 0))
}

export function getOpenReservedTokensForKey(apiKeyId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(reserved_tokens - charged_tokens), 0) AS n
       FROM token_reservations
       WHERE api_key_id = ? AND status = 'open'`,
    )
    .get(apiKeyId) as { n: number }
  return Math.max(0, Number(row?.n ?? 0))
}

export function anthropicTopupRequiredErrorMessage() {
  return 'Anthropic models (Claude) are only available to accounts with at least one balance top-up. Please top up your balance to use Claude models.'
}

/**
 * Single source of truth for the Anthropic restriction notice, so edits to the
 * bonus setting are reflected immediately.
 */
export function anthropicBonusErrorMessage() {
  return anthropicTopupRequiredErrorMessage()
}

/**
 * Atomically holds `amount` tokens: debits user balance immediately and tracks hold.
 * Also checks API key spend limit against spent + currently reserved + new amount.
 */
export function tryReserveTokens(input: {
  userId: string
  apiKeyId: string
  amount: number
  modelId?: string | null
  path?: string | null
  allowRestrictedCredits?: boolean
  signal?: AbortSignal
}): { ok: true; reservationId: string; reservedTokens: number } | { ok: false; error: string; status: 402 } {
  if (input.signal?.aborted) {
    return { ok: false, error: 'Request aborted', status: 402 }
  }
  const amount = Math.max(0, Math.floor(Number(input.amount) || 0))
  if (amount <= 0) {
    // Zero-cost paths still get a reservation row for uniform settle/release.
    const reservationId = id('tres')
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS).toISOString()
    db.prepare(
      `INSERT INTO token_reservations
        (id, user_id, api_key_id, model_id, path, reserved_tokens, charged_tokens, status, created_at, updated_at, expires_at, settled_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'open', ?, ?, ?, NULL)`,
    ).run(
      reservationId,
      input.userId,
      input.apiKeyId,
      input.modelId ?? null,
      input.path ?? null,
      createdAt,
      createdAt,
      expiresAt,
    )

    if (input.signal) {
      const onAbort = () => {
        try {
          releaseReservation(reservationId)
        } catch {
          /* ignore */
        }
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
      reservationAbortCleanups.set(reservationId, () => {
        input.signal?.removeEventListener('abort', onAbort)
      })
    }

    return { ok: true, reservationId, reservedTokens: 0 }
  }

  const tx = db.transaction(() => {
    const user = db
      .prepare(
        `SELECT id, balance_tokens, COALESCE(restricted_tokens, 0) AS restricted_tokens,
                COALESCE(reserved_tokens, 0) AS reserved_tokens, status FROM users WHERE id = ?`,
      )
      .get(input.userId) as
      | { id: string; balance_tokens: number; restricted_tokens: number; reserved_tokens: number; status: string }
      | undefined
    if (!user || user.status === 'suspended' || user.status === 'pending' || user.status !== 'active') {
      return {
        ok: false as const,
        error: user?.status === 'pending' ? 'Account pending activation' : 'Account suspended or missing',
        status: 402 as const,
      }
    }
    const allowRestrictedCredits = input.allowRestrictedCredits !== false
    if (!allowRestrictedCredits && !hasUserTopup(input.userId)) {
      return {
        ok: false as const,
        error: anthropicTopupRequiredErrorMessage(),
        status: 402 as const,
      }
    }
    const regularBalance = Math.max(0, user.balance_tokens - Math.max(0, user.restricted_tokens))
    if (user.balance_tokens < amount || (!allowRestrictedCredits && regularBalance < amount)) {
      return {
        ok: false as const,
        error: !allowRestrictedCredits
          ? anthropicTopupRequiredErrorMessage()
          : `Insufficient balance. This request requires up to ${amount.toLocaleString('en-US')} tokens reserved.`,
        status: 402 as const,
      }
    }

    const key = db
      .prepare(
        `SELECT id, spend_limit_tokens, spent_tokens, COALESCE(reserved_tokens, 0) AS reserved_tokens, status
         FROM api_keys WHERE id = ?`,
      )
      .get(input.apiKeyId) as
      | {
          id: string
          spend_limit_tokens: number | null
          spent_tokens: number
          reserved_tokens: number
          status: string
        }
      | undefined
    if (!key || key.status !== 'active') {
      return { ok: false as const, error: 'Invalid API key', status: 402 as const }
    }
    if (key.spend_limit_tokens !== null) {
      const projected = key.spent_tokens + key.reserved_tokens + amount
      if (projected > key.spend_limit_tokens) {
        return { ok: false as const, error: 'API key spend limit would be exceeded', status: 402 as const }
      }
    }

    const restrictedReserved = allowRestrictedCredits ? Math.min(amount, Math.max(0, user.restricted_tokens)) : 0
    const debit = db
      .prepare(
        `UPDATE users
         SET balance_tokens = balance_tokens - ?,
             restricted_tokens = MAX(0, COALESCE(restricted_tokens, 0) - ?),
             reserved_tokens = COALESCE(reserved_tokens, 0) + ?
         WHERE id = ? AND balance_tokens >= ?`,
      )
      .run(amount, restrictedReserved, amount, input.userId, amount)
    if (debit.changes !== 1) {
      return {
        ok: false as const,
        error: `Insufficient balance. This request requires up to ${amount.toLocaleString('en-US')} tokens reserved.`,
        status: 402 as const,
      }
    }

    db.prepare(
      `UPDATE api_keys SET reserved_tokens = COALESCE(reserved_tokens, 0) + ? WHERE id = ?`,
    ).run(amount, input.apiKeyId)

    const reservationId = id('tres')
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS).toISOString()
    db.prepare(
      `INSERT INTO token_reservations
        (id, user_id, api_key_id, model_id, path, reserved_tokens, reserved_restricted_tokens, restricted_credits_allowed, charged_tokens, status, created_at, updated_at, expires_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', ?, ?, ?, NULL)`,
    ).run(
      reservationId,
      input.userId,
      input.apiKeyId,
      input.modelId ?? null,
      input.path ?? null,
      amount,
      restrictedReserved,
      allowRestrictedCredits ? 1 : 0,
      createdAt,
      createdAt,
      expiresAt,
    )

    const result = { ok: true as const, reservationId, reservedTokens: amount }
    if (input.signal) {
      const onAbort = () => {
        try {
          releaseReservation(reservationId)
        } catch {
          /* ignore */
        }
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
      reservationAbortCleanups.set(reservationId, () => {
        input.signal?.removeEventListener('abort', onAbort)
      })
    }
    return result
  })

  return tx()
}

function loadReservation(reservationId: string): TokenReservationRow | null {
  const row = db
    .prepare(`SELECT * FROM token_reservations WHERE id = ?`)
    .get(reservationId) as TokenReservationRow | undefined
  return row ?? null
}

function loadOpenReservation(reservationId: string): TokenReservationRow | null {
  const row = loadReservation(reservationId)
  if (!row || row.status !== 'open') return null
  return row
}

/**
 * Finalize a hold: charge `chargedTokens` against the reservation.
 * Refunds unused hold to the user balance. If actual cost somehow exceeds hold,
 * attempts to debit the extra from remaining balance (clamp at 0).
 * Fully atomic and idempotent.
 */
export function settleReservation(
  reservationId: string,
  chargedTokens: number,
): { ok: boolean; charged: number; refunded: number } {
  const charge = Math.max(0, Math.floor(Number(chargedTokens) || 0))
  const tx = db.transaction(() => {
    const row = loadReservation(reservationId)
    if (!row) return { ok: false, charged: 0, refunded: 0 }

    // Idempotent settlement: if already settled, return existing result without re-billing.
    if (row.status === 'settled') {
      const reserved = Math.max(0, row.reserved_tokens)
      const charged = Math.max(0, row.charged_tokens)
      const refunded = Math.max(0, reserved - Math.min(charged, reserved))
      return { ok: true, charged, refunded }
    }

    if (row.status !== 'open') return { ok: false, charged: 0, refunded: 0 }

    const reserved = Math.max(0, row.reserved_tokens)
    const applied = Math.min(charge, reserved)
    const refund = Math.max(0, reserved - applied)
    const overage = Math.max(0, charge - reserved)
    const restrictedReserved = Math.max(0, row.reserved_restricted_tokens || 0)
    const restrictedApplied = Math.min(applied, restrictedReserved)
    const restrictedRefund = Math.max(0, restrictedReserved - restrictedApplied)
    const updatedAt = nowIso()

    if (refund > 0) {
      db.prepare(
        `UPDATE users
         SET balance_tokens = balance_tokens + ?,
             restricted_tokens = COALESCE(restricted_tokens, 0) + ?,
             reserved_tokens = MAX(0, COALESCE(reserved_tokens, 0) - ?)
         WHERE id = ?`,
      ).run(refund, restrictedRefund, reserved, row.user_id)
    } else {
      db.prepare(
        `UPDATE users
         SET reserved_tokens = MAX(0, COALESCE(reserved_tokens, 0) - ?)
         WHERE id = ?`,
      ).run(reserved, row.user_id)
    }

    if (overage > 0) {
      // Should be rare (bad estimate). Anthropic reservations must never consume
      // restricted Telegram credits, including an unexpected usage overage.
      if (row.restricted_credits_allowed === 0) debitRegularTokens(row.user_id, overage)
      else debitApiTokens(row.user_id, overage)
    }

    db.prepare(
      `UPDATE api_keys
       SET reserved_tokens = MAX(0, COALESCE(reserved_tokens, 0) - ?),
           spent_tokens = spent_tokens + ?
       WHERE id = ?`,
    ).run(reserved, charge, row.api_key_id)

    db.prepare(
      `UPDATE token_reservations
       SET status = 'settled',
           charged_tokens = ?,
           updated_at = ?,
           settled_at = ?
       WHERE id = ? AND status = 'open'`,
    ).run(charge, updatedAt, updatedAt, reservationId)

    const cleanup = reservationAbortCleanups.get(reservationId)
    if (cleanup) {
      reservationAbortCleanups.delete(reservationId)
      try { cleanup() } catch { /* ignore */ }
    }

    return { ok: true, charged: charge, refunded: refund }
  })
  return tx()
}

/** Release a full open hold (errors / aborted upstream) — refund everything. Fully atomic and idempotent. */
export function releaseReservation(reservationId: string): { ok: boolean; refunded: number } {
  const tx = db.transaction(() => {
    const row = loadReservation(reservationId)
    if (!row) return { ok: false, refunded: 0 }

    // Idempotent release: if already released or expired, return success without duplicate refund.
    if (row.status === 'released' || row.status === 'expired') {
      return { ok: true, refunded: Math.max(0, row.reserved_tokens) }
    }

    if (row.status !== 'open') return { ok: false, refunded: 0 }

    const reserved = Math.max(0, row.reserved_tokens)
    const restrictedReserved = Math.max(0, row.reserved_restricted_tokens || 0)
    const updatedAt = nowIso()

    if (reserved > 0) {
      db.prepare(
        `UPDATE users
         SET balance_tokens = balance_tokens + ?,
             restricted_tokens = COALESCE(restricted_tokens, 0) + ?,
             reserved_tokens = MAX(0, COALESCE(reserved_tokens, 0) - ?)
         WHERE id = ?`,
      ).run(reserved, restrictedReserved, reserved, row.user_id)
      db.prepare(
        `UPDATE api_keys
         SET reserved_tokens = MAX(0, COALESCE(reserved_tokens, 0) - ?)
         WHERE id = ?`,
      ).run(reserved, row.api_key_id)
    }

    db.prepare(
      `UPDATE token_reservations
       SET status = 'released',
           charged_tokens = 0,
           updated_at = ?,
           settled_at = ?
       WHERE id = ? AND status = 'open'`,
    ).run(updatedAt, updatedAt, reservationId)

    const cleanup = reservationAbortCleanups.get(reservationId)
    if (cleanup) {
      reservationAbortCleanups.delete(reservationId)
      try { cleanup() } catch { /* ignore */ }
    }

    return { ok: true, refunded: reserved }
  })
  return tx()
}

/** Aliases ensuring settleTokens and releaseTokens naming conventions work atomically and idempotently. */
export const settleTokens = settleReservation
export const releaseTokens = releaseReservation

/** Sweep expired open holds (process crash / abandoned streams). */
export function expireOpenReservations(now = new Date()): number {
  const nowIsoStr = now.toISOString()
  let totalExpired = 0

  while (true) {
    const open = db
      .prepare(
        `SELECT id FROM token_reservations WHERE status = 'open' AND expires_at <= ? LIMIT 200`,
      )
      .all(nowIsoStr) as Array<{ id: string }>

    if (open.length === 0) break

    let batchCount = 0
    for (const row of open) {
      const tx = db.transaction(() => {
        const full = loadOpenReservation(row.id)
        if (!full) return false
        const reserved = Math.max(0, full.reserved_tokens)
        const restrictedReserved = Math.max(0, full.reserved_restricted_tokens || 0)
        const updatedAt = nowIso()
        if (reserved > 0) {
          db.prepare(
            `UPDATE users
             SET balance_tokens = balance_tokens + ?,
                 restricted_tokens = COALESCE(restricted_tokens, 0) + ?,
                 reserved_tokens = MAX(0, COALESCE(reserved_tokens, 0) - ?)
             WHERE id = ?`,
          ).run(reserved, restrictedReserved, reserved, full.user_id)
          db.prepare(
            `UPDATE api_keys
             SET reserved_tokens = MAX(0, COALESCE(reserved_tokens, 0) - ?)
             WHERE id = ?`,
          ).run(reserved, full.api_key_id)
        }
        db.prepare(
          `UPDATE token_reservations
           SET status = 'expired',
               charged_tokens = 0,
               updated_at = ?,
               settled_at = ?
           WHERE id = ? AND status = 'open'`,
        ).run(updatedAt, updatedAt, row.id)
        return true
      })
      if (tx()) batchCount += 1
    }
    totalExpired += batchCount
    if (open.length < 200 || batchCount === 0) break
  }
  return totalExpired
}

let expiryTimer: ReturnType<typeof setInterval> | null = null

export function startReservationExpiryJob() {
  if (expiryTimer) return
  // Run once shortly after boot, then periodically.
  setTimeout(() => {
    try {
      expireOpenReservations()
    } catch (reason) {
      console.error('token reservation expiry failed', reason)
    }
  }, 5_000).unref?.()
  expiryTimer = setInterval(() => {
    try {
      expireOpenReservations()
    } catch (reason) {
      console.error('token reservation expiry failed', reason)
    }
  }, 60_000)
  expiryTimer.unref?.()
}
