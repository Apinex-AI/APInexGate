import { db, id, nowIso } from './db.js'
import { tokensFromUsdCents, usdFromTokens } from '../shared/billing.js'
import { tryGrantReferralReward } from './referrals.js'

export class InsufficientBalanceError extends Error {
  status = 402 as const
  constructor(message = 'Insufficient balance') {
    super(message)
    this.name = 'InsufficientBalanceError'
  }
}

function userWalletRow(userId: string) {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name),
  )
  const restrictedCol = cols.has('restricted_tokens') ? 'COALESCE(restricted_tokens, 0)' : '0'
  const reservedCol = cols.has('reserved_tokens') ? 'COALESCE(reserved_tokens, 0)' : '0'
  return db
    .prepare(
      `SELECT
         COALESCE(balance_tokens, 0) AS balance_tokens,
         ${restrictedCol} AS restricted_tokens,
         ${reservedCol} AS reserved_tokens
       FROM users WHERE id = ?`,
    )
    .get(userId) as
    | { balance_tokens: number; restricted_tokens: number; reserved_tokens: number }
    | undefined
}

/** Tokens the user can spend right now (held reservations excluded). */
export function walletAvailableTokens(userId: string) {
  const row = userWalletRow(userId)
  if (!row) return 0
  return Math.max(0, Math.floor(row.balance_tokens - row.reserved_tokens))
}

export function walletAvailableUsd(userId: string) {
  return usdFromTokens(walletAvailableTokens(userId))
}

function ensureWalletPurchasesSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      source_ref TEXT NOT NULL UNIQUE,
      amount_cents INTEGER NOT NULL,
      amount_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_purchases_user
      ON wallet_purchases(user_id, created_at);
  `)
}

ensureWalletPurchasesSchema()

/**
 * Atomically debit the unified USD wallet for an in-app purchase.
 * Restricted API credits are spent first (same as PAYG). Reservations stay locked.
 */
export function debitWalletForPurchase(input: {
  userId: string
  amountCents: number
  kind: string
  sourceRef: string
  note: string
}): { ok: true; already: boolean; tokens: number; cents: number } {
  const rawCents = Number(input.amountCents)
  if (!Number.isFinite(rawCents) || rawCents <= 0) {
    throw new Error('Amount must be a positive finite number')
  }
  const cents = Math.round(rawCents)
  if (cents < 1) throw new Error('Amount is too small')
  const tokens = tokensFromUsdCents(cents)
  if (!Number.isFinite(tokens) || tokens < 1) throw new Error('Amount is too small')
  const sourceRef = String(input.sourceRef || '').trim()
  if (!sourceRef) throw new Error('sourceRef required')
  const userId = String(input.userId || '').trim()
  if (!userId) throw new Error('userId required')

  const charged = db.transaction(() => {
    const dup = db
      .prepare(`SELECT id FROM wallet_purchases WHERE source_ref = ?`)
      .get(sourceRef) as { id: string } | undefined
    if (dup) return { ok: true as const, already: true, tokens, cents }

    const user = userWalletRow(userId)
    if (!user) throw new Error('Account not found')
    const available = Math.max(0, Math.floor(user.balance_tokens - user.reserved_tokens))
    if (available < tokens) {
      throw new InsufficientBalanceError(
        `Insufficient balance. This purchase costs ${usdFromTokens(tokens).toFixed(2)} USD.`,
      )
    }

    const cols = new Set(
      (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    const hasRestricted = cols.has('restricted_tokens')
    const hasReserved = cols.has('reserved_tokens')

    const restrictedUsed = Math.min(tokens, Math.max(0, user.restricted_tokens))
    const setRestricted = hasRestricted ? ', restricted_tokens = MAX(0, COALESCE(restricted_tokens, 0) - ?)' : ''
    const whereReserved = hasReserved ? 'AND balance_tokens - COALESCE(reserved_tokens, 0) >= ?' : 'AND balance_tokens >= ?'

    const stmt = `UPDATE users SET balance_tokens = balance_tokens - ?${setRestricted} WHERE id = ? ${whereReserved}`
    const params = hasRestricted ? [tokens, restrictedUsed, userId, tokens] : [tokens, userId, tokens]
    const updated = db.prepare(stmt).run(...params)
    if (updated.changes !== 1) {
      throw new InsufficientBalanceError('Insufficient balance')
    }

    const when = nowIso()
    db.prepare(
      `INSERT INTO wallet_purchases
        (id, user_id, kind, source_ref, amount_cents, amount_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id('wpurch'), userId, input.kind, sourceRef, cents, tokens, when)

    db.prepare(
      `INSERT INTO balance_transactions
        (id, user_id, type, amount_cents, amount_tokens, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`,
    ).run(id('txn'), userId, input.kind, -cents, -tokens, input.note, when)

    const res = { ok: true as const, already: false, tokens, cents }
    try {
      tryGrantReferralReward({
        userId,
        paymentId: sourceRef,
        amountCents: cents,
      })
    } catch (error) {
      console.error('[referral] grant on wallet purchase failed', error)
    }
    return res
  }).immediate()

  if (!charged.already) {
    void import('./accountLevels.js')
      .then(({ recordLevelSpend }) => {
        recordLevelSpend({ userId: input.userId, amountCents: charged.cents, sourceRef: `wallet:${sourceRef}` })
      })
      .catch((error) => {
        console.error('[levels] wallet purchase credit failed', error)
      })
  }
  return charged
}

/**
 * Atomically credit the unified USD wallet.
 * Runs inside an immediate transaction with strict numeric validation.
 */
export function creditWalletBalance(input: {
  userId: string
  amountCents: number
  note?: string
  sourceRef?: string
}): { ok: true; tokens: number; cents: number } {
  const rawCents = Number(input.amountCents)
  if (!Number.isFinite(rawCents) || rawCents <= 0) {
    throw new Error('Amount must be a positive finite number')
  }
  const cents = Math.round(rawCents)
  if (cents < 1) throw new Error('Amount is too small')
  const tokens = tokensFromUsdCents(cents)
  if (!Number.isFinite(tokens) || tokens < 1) throw new Error('Amount is too small')
  const userId = String(input.userId || '').trim()
  if (!userId) throw new Error('userId required')

  return db.transaction(() => {
    const user = userWalletRow(userId)
    if (!user) throw new Error('Account not found')

    const updated = db
      .prepare('UPDATE users SET balance_tokens = balance_tokens + ? WHERE id = ?')
      .run(tokens, userId)
    if (updated.changes !== 1) throw new Error('Failed to update balance')

    const when = nowIso()
    db.prepare(
      `INSERT INTO balance_transactions
        (id, user_id, type, amount_cents, amount_tokens, note, status, created_at)
       VALUES (?, ?, 'credit', ?, ?, ?, 'completed', ?)`,
    ).run(id('txn'), userId, cents, tokens, input.note ?? 'Wallet credit', when)

    return { ok: true as const, tokens, cents }
  }).immediate()
}

export const addWalletBalance = creditWalletBalance

/**
 * Atomically debit the unified USD wallet.
 * Runs inside an immediate transaction with strict numeric validation.
 */
export function debitWalletBalance(input: {
  userId: string
  amountCents: number
  note?: string
  kind?: string
}): { ok: true; tokens: number; cents: number } {
  const rawCents = Number(input.amountCents)
  if (!Number.isFinite(rawCents) || rawCents <= 0) {
    throw new Error('Amount must be a positive finite number')
  }
  const cents = Math.round(rawCents)
  if (cents < 1) throw new Error('Amount is too small')
  const tokens = tokensFromUsdCents(cents)
  if (!Number.isFinite(tokens) || tokens < 1) throw new Error('Amount is too small')
  const userId = String(input.userId || '').trim()
  if (!userId) throw new Error('userId required')

  return db.transaction(() => {
    const user = userWalletRow(userId)
    if (!user) throw new Error('Account not found')
    const available = Math.max(0, Math.floor(user.balance_tokens - user.reserved_tokens))
    if (available < tokens) {
      throw new InsufficientBalanceError(
        `Insufficient balance. This purchase costs ${usdFromTokens(tokens).toFixed(2)} USD.`,
      )
    }

    const cols = new Set(
      (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    const hasRestricted = cols.has('restricted_tokens')
    const hasReserved = cols.has('reserved_tokens')

    const restrictedUsed = Math.min(tokens, Math.max(0, user.restricted_tokens))
    const setRestricted = hasRestricted ? ', restricted_tokens = MAX(0, COALESCE(restricted_tokens, 0) - ?)' : ''
    const whereReserved = hasReserved ? 'AND balance_tokens - COALESCE(reserved_tokens, 0) >= ?' : 'AND balance_tokens >= ?'

    const stmt = `UPDATE users SET balance_tokens = balance_tokens - ?${setRestricted} WHERE id = ? ${whereReserved}`
    const params = hasRestricted ? [tokens, restrictedUsed, userId, tokens] : [tokens, userId, tokens]
    const updated = db.prepare(stmt).run(...params)
    if (updated.changes !== 1) {
      throw new InsufficientBalanceError('Insufficient balance')
    }

    const when = nowIso()
    db.prepare(
      `INSERT INTO balance_transactions
        (id, user_id, type, amount_cents, amount_tokens, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`,
    ).run(id('txn'), userId, input.kind || 'debit', -cents, -tokens, input.note || 'Wallet debit', when)

    return { ok: true as const, tokens, cents }
  }).immediate()
}
