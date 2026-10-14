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
  return db
    .prepare(
      `SELECT
         COALESCE(balance_tokens, 0) AS balance_tokens,
         COALESCE(restricted_tokens, 0) AS restricted_tokens,
         COALESCE(reserved_tokens, 0) AS reserved_tokens
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
  const cents = Math.max(0, Math.round(Number(input.amountCents) || 0))
  const tokens = tokensFromUsdCents(cents)
  const sourceRef = String(input.sourceRef || '').trim()
  if (!sourceRef) throw new Error('sourceRef required')
  if (cents < 1 || tokens < 1) throw new Error('Amount is too small')

  const charged = db.transaction(() => {
    const dup = db
      .prepare(`SELECT id FROM wallet_purchases WHERE source_ref = ?`)
      .get(sourceRef) as { id: string } | undefined
    if (dup) return { ok: true as const, already: true, tokens, cents }

    const user = userWalletRow(input.userId)
    if (!user) throw new Error('Account not found')
    const available = Math.max(0, Math.floor(user.balance_tokens - user.reserved_tokens))
    if (available < tokens) {
      throw new InsufficientBalanceError(
        `Insufficient balance. This purchase costs ${usdFromTokens(tokens).toFixed(2)} USD.`,
      )
    }

    const restrictedUsed = Math.min(tokens, Math.max(0, user.restricted_tokens))
    const updated = db
      .prepare(
        `UPDATE users
         SET balance_tokens = balance_tokens - ?,
             restricted_tokens = MAX(0, COALESCE(restricted_tokens, 0) - ?)
         WHERE id = ?
           AND balance_tokens - COALESCE(reserved_tokens, 0) >= ?`,
      )
      .run(tokens, restrictedUsed, input.userId, tokens)
    if (updated.changes !== 1) {
      throw new InsufficientBalanceError('Insufficient balance')
    }

    const when = nowIso()
    db.prepare(
      `INSERT INTO wallet_purchases
        (id, user_id, kind, source_ref, amount_cents, amount_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id('wpurch'), input.userId, input.kind, sourceRef, cents, tokens, when)

    db.prepare(
      `INSERT INTO balance_transactions
        (id, user_id, type, amount_cents, amount_tokens, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`,
    ).run(id('txn'), input.userId, input.kind, -cents, -tokens, input.note, when)

    const res = { ok: true as const, already: false, tokens, cents }
    try {
      tryGrantReferralReward({
        userId: input.userId,
        paymentId: sourceRef,
        amountCents: cents,
      })
    } catch (error) {
      console.error('[referral] grant on wallet purchase failed', error)
    }
    return res
  })()

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
