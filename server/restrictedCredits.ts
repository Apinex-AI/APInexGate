import { db, id, nowIso } from './db.js'

function ensureRestrictedCreditsSchema() {
  const userCols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
  if (!userCols.some((column) => column.name === 'restricted_tokens')) {
    db.exec('ALTER TABLE users ADD COLUMN restricted_tokens INTEGER NOT NULL DEFAULT 0')
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS restricted_credit_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_tokens INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(source, source_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_restricted_credit_user
      ON restricted_credit_ledger(user_id, created_at);
  `)

  const reservationCols = db.prepare('PRAGMA table_info(token_reservations)').all() as Array<{ name: string }>
  if (!reservationCols.some((column) => column.name === 'reserved_restricted_tokens')) {
    db.exec('ALTER TABLE token_reservations ADD COLUMN reserved_restricted_tokens INTEGER NOT NULL DEFAULT 0')
  }
  if (!reservationCols.some((column) => column.name === 'restricted_credits_allowed')) {
    db.exec('ALTER TABLE token_reservations ADD COLUMN restricted_credits_allowed INTEGER NOT NULL DEFAULT 1')
  }
}

ensureRestrictedCreditsSchema()

export function getRestrictedTokens(userId: string) {
  const row = db.prepare(`SELECT COALESCE(restricted_tokens, 0) AS tokens FROM users WHERE id = ?`).get(userId) as
    | { tokens: number }
    | undefined
  return Math.max(0, Math.floor(Number(row?.tokens) || 0))
}

export function creditRestrictedTokens(input: {
  userId: string
  tokens: number
  source: string
  sourceRef: string
  note: string
}) {
  const tokens = Math.max(0, Math.floor(Number(input.tokens) || 0))
  if (tokens <= 0) return { credited: false, tokens: 0 }

  return db.transaction(() => {
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO restricted_credit_ledger
        (id, user_id, amount_tokens, source, source_ref, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id('rcredit'), input.userId, tokens, input.source, input.sourceRef, input.note, nowIso())
    if (inserted.changes !== 1) return { credited: false, tokens: 0 }

    db.prepare(
      `UPDATE users
       SET balance_tokens = balance_tokens + ?,
           restricted_tokens = COALESCE(restricted_tokens, 0) + ?
       WHERE id = ?`,
    ).run(tokens, tokens, input.userId)
    return { credited: true, tokens }
  })()
}

/** API/tools-only debit. Restricted tokens are consumed before regular balance. */
export function debitApiTokens(userId: string, amount: number) {
  const tokens = Math.max(0, Math.floor(Number(amount) || 0))
  if (tokens <= 0) return { ok: true as const, restrictedUsed: 0, regularUsed: 0 }

  return db.transaction(() => {
    const user = db.prepare(
      `SELECT balance_tokens, COALESCE(restricted_tokens, 0) AS restricted_tokens
       FROM users WHERE id = ?`,
    ).get(userId) as { balance_tokens: number; restricted_tokens: number } | undefined
    if (!user || user.balance_tokens < tokens) {
      return { ok: false as const, restrictedUsed: 0, regularUsed: 0 }
    }
    const restrictedUsed = Math.min(tokens, Math.max(0, user.restricted_tokens))
    const result = db.prepare(
      `UPDATE users
       SET balance_tokens = balance_tokens - ?,
           restricted_tokens = MAX(0, COALESCE(restricted_tokens, 0) - ?)
       WHERE id = ? AND balance_tokens >= ?`,
    ).run(tokens, restrictedUsed, userId, tokens)
    if (result.changes !== 1) {
      return { ok: false as const, restrictedUsed: 0, regularUsed: 0 }
    }
    return { ok: true as const, restrictedUsed, regularUsed: tokens - restrictedUsed }
  }).immediate()
}

export function debitRegularTokens(userId: string, amount: number) {
  const tokens = Math.max(0, Math.floor(Number(amount) || 0))
  if (tokens <= 0) return { ok: true as const }
  const result = db.prepare(
    `UPDATE users
     SET balance_tokens = balance_tokens - ?
     WHERE id = ? AND balance_tokens - COALESCE(restricted_tokens, 0) >= ?`,
  ).run(tokens, userId, tokens)
  return result.changes === 1 ? { ok: true as const } : { ok: false as const }
}

export function regularSpendableTokens(userId: string) {
  const row = db.prepare(
    `SELECT balance_tokens, COALESCE(restricted_tokens, 0) AS restricted_tokens
     FROM users WHERE id = ?`,
  ).get(userId) as { balance_tokens: number; restricted_tokens: number } | undefined
  if (!row) return 0
  return Math.max(0, Math.floor(row.balance_tokens - row.restricted_tokens))
}

export function hasUserTopup(userId: string): boolean {
  const tableExists = (name: string) =>
    Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name))

  const parts: string[] = []
  const params: unknown[] = []

  if (tableExists('crypto_payments')) {
    parts.push(
      `SELECT 1 AS ok FROM crypto_payments WHERE user_id = ? AND (credited_at IS NOT NULL OR lower(status) IN ('finished', 'confirmed'))`,
    )
    params.push(userId)
  }
  if (tableExists('balance_transactions')) {
    parts.push(
      `SELECT 1 AS ok FROM balance_transactions WHERE user_id = ? AND type IN ('top_up', 'adjustment') AND (amount_cents > 0 OR amount_tokens > 0) AND status = 'completed'`,
    )
    params.push(userId)
  }
  if (tableExists('subscription_payments')) {
    parts.push(
      `SELECT 1 AS ok FROM subscription_payments WHERE user_id = ? AND (credited_at IS NOT NULL OR lower(status) IN ('finished', 'confirmed'))`,
    )
    params.push(userId)
  }
  if (tableExists('nft_payments')) {
    parts.push(
      `SELECT 1 AS ok FROM nft_payments WHERE user_id = ? AND (credited_at IS NOT NULL OR lower(status) IN ('finished', 'confirmed'))`,
    )
    params.push(userId)
  }

  if (parts.length === 0) return false

  const query = `SELECT 1 AS ok FROM (${parts.join(' UNION ALL ')}) LIMIT 1`
  const row = db.prepare(query).get(...params) as { ok: number } | undefined
  return Boolean(row?.ok)
}
