import { db, nowIso } from './db.js'

/**
 * Centralized on-chain signature ledger.
 *
 * Every Solana payment flow (top-ups, subscriptions) used to guard against replay with a query scoped to its
 * OWN table. A single transfer whose amount satisfied two different flows could
 * therefore be credited once in each, because neither table knew about the
 * other.
 *
 * This table is the single source of truth: the signature is the PRIMARY KEY, so
 * the first flow to claim it wins and every other flow is locked out at the
 * storage layer. Claims are made inside the crediting transaction, so a rollback
 * releases the claim and two concurrent verifications cannot both succeed.
 *
 * Scope is deliberately on-chain signatures only. External gateway invoices cannot
 * cross flows: each invoice is bound to one `order_id`, and `order_id` is UNIQUE
 * in every payment table.
 */

export type PaymentFlow = 'topup' | 'subscription' | 'rpm'

function ensurePaymentSignatureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS used_payment_signatures (
      signature TEXT PRIMARY KEY,
      flow TEXT NOT NULL,
      payment_id TEXT NOT NULL,
      user_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_used_payment_signatures_payment
      ON used_payment_signatures(payment_id);
  `)
}

ensurePaymentSignatureSchema()

/**
 * Register every already-credited on-chain signature so historical transfers
 * cannot be replayed into a flow that did not previously know about them.
 * Idempotent: existing claims are left untouched.
 */
function backfillExistingSignatures() {
  const sources: Array<{ flow: PaymentFlow; table: string }> = [
    { flow: 'topup', table: 'crypto_payments' },
    { flow: 'subscription', table: 'subscription_payments' },
    { flow: 'rpm', table: 'rpm_payments' },
  ]

  const claim = db.prepare(
    `INSERT OR IGNORE INTO used_payment_signatures
      (signature, flow, payment_id, user_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )

  for (const source of sources) {
    try {
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(source.table) as { name: string } | undefined
      if (!tableExists) continue

      const columns = db.prepare(`PRAGMA table_info(${source.table})`).all() as Array<{
        name: string
      }>
      const names = new Set(columns.map((column) => column.name))
      if (!names.has('payment_id') || !names.has('credited_at')) continue
      // Only on-chain rows are in scope when provider/asset columns exist.
      // `crypto_payments` predates provider column on some deployments.
      // Tables like `rpm_payments` have neither column, so all credited rows with payment_id are processed.
      let onChainFilter = '1 = 1'
      if (names.has('provider') && names.has('asset')) {
        onChainFilter = `(provider = 'solana' OR asset = 'SOL')`
      } else if (names.has('provider')) {
        onChainFilter = `provider = 'solana'`
      } else if (names.has('asset')) {
        onChainFilter = `asset = 'SOL'`
      }

      const rows = db
        .prepare(
          `SELECT id, payment_id, ${names.has('user_id') ? 'user_id' : 'NULL AS user_id'}, credited_at
           FROM ${source.table}
           WHERE credited_at IS NOT NULL
             AND payment_id IS NOT NULL
             AND TRIM(payment_id) != ''
             AND ${onChainFilter}`,
        )
        .all() as Array<{
        id: string
        payment_id: string
        user_id: string | null
        credited_at: string
      }>

      if (rows.length === 0) continue
      db.transaction(() => {
        for (const row of rows) {
          claim.run(row.payment_id, source.flow, row.id, row.user_id, row.credited_at)
        }
      }).immediate()
    } catch {
      // A missing table or column on an older deployment must never block boot.
    }
  }
}

backfillExistingSignatures()

/** Thrown from inside a crediting transaction so the whole credit rolls back. */
export class PaymentSignatureConflictError extends Error {
  readonly conflict: { flow: PaymentFlow; paymentId: string }

  constructor(conflict: { flow: PaymentFlow; paymentId: string }) {
    super('This transaction was already used for another payment')
    this.name = 'PaymentSignatureConflictError'
    this.conflict = conflict
  }
}

export type SignatureClaim = {
  signature: string
  flow: PaymentFlow
  paymentId: string
  userId: string | null
  createdAt: string
}

export function findSignatureClaim(signature: string): SignatureClaim | null {
  const sig = signature.trim()
  if (!sig) return null
  const row = db
    .prepare(
      `SELECT signature, flow, payment_id, user_id, created_at
       FROM used_payment_signatures WHERE signature = ?`,
    )
    .get(sig) as
    | {
        signature: string
        flow: string
        payment_id: string
        user_id: string | null
        created_at: string
      }
    | undefined
  if (!row) return null
  return {
    signature: row.signature,
    flow: row.flow as PaymentFlow,
    paymentId: row.payment_id,
    userId: row.user_id,
    createdAt: row.created_at,
  }
}

/**
 * Cross-flow replay pre-check. Returns a conflict only when the signature is
 * already held by a DIFFERENT payment — re-verifying the same payment is a
 * normal idempotent retry and must stay allowed.
 */
export function signatureConflict(
  signature: string,
  paymentId: string,
): SignatureClaim | null {
  const existing = findSignatureClaim(signature)
  if (!existing) return null
  if (existing.paymentId === paymentId) return null
  return existing
}

/**
 * Atomically take ownership of a signature. Call this INSIDE the crediting
 * transaction, before any balance is moved, so the claim and the credit commit
 * or roll back together.
 */
export function claimPaymentSignature(input: {
  signature: string
  flow: PaymentFlow
  paymentId: string
  userId?: string | null
}): { ok: true } | { ok: false; conflict: SignatureClaim } {
  const signature = input.signature.trim()
  // An unsigned/unknown reference cannot be deduplicated; the caller's own
  // `credited_at` guard remains the protection there.
  if (!signature) return { ok: true }

  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO used_payment_signatures
        (signature, flow, payment_id, user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(signature, input.flow, input.paymentId, input.userId ?? null, nowIso())
  if (inserted.changes === 1) return { ok: true }

  const existing = findSignatureClaim(signature)
  // Same payment re-verifying: idempotent, allow it.
  if (!existing || existing.paymentId === input.paymentId) return { ok: true }
  return { ok: false, conflict: existing }
}

/** Convenience for crediting transactions: claim or roll back. */
export function claimPaymentSignatureOrThrow(input: {
  signature: string
  flow: PaymentFlow
  paymentId: string
  userId?: string | null
}) {
  const signature = String(input.signature || '').trim()
  if (!signature) {
    throw new Error('Transaction signature required')
  }
  const claim = claimPaymentSignature({
    ...input,
    signature,
  })
  if (!claim.ok) {
    throw new PaymentSignatureConflictError({
      flow: claim.conflict.flow,
      paymentId: claim.conflict.paymentId,
    })
  }
}
