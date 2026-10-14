import { db, nowIso } from './db.js'

export const PAYMENT_TTL_MS = 15 * 60 * 1000
export const PAYMENT_TTL_MINUTES = 15
export const MAX_INVOICES_PER_WINDOW = 7

const PAYMENT_TABLES = [
  'crypto_payments',
  'subscription_payments',
] as const

const OPEN_PAYMENT_STATUSES = ['waiting', 'confirming', 'partially_paid', 'sending'] as const

function tableExists(table: string) {
  return Boolean(
    db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table),
  )
}

/** Mark every locally open invoice older than 15 minutes as expired. */
export function expireStalePaymentInvoices(now = new Date()) {
  const cutoff = new Date(now.getTime() - PAYMENT_TTL_MS).toISOString()
  const updatedAt = now.toISOString()
  let expired = 0

  for (const table of PAYMENT_TABLES) {
    if (!tableExists(table)) continue
    const placeholders = OPEN_PAYMENT_STATUSES.map(() => '?').join(', ')
    const result = db
      .prepare(
        `UPDATE ${table}
         SET status = 'expired', raw_status = 'expired', updated_at = ?
         WHERE credited_at IS NULL
           AND status IN (${placeholders})
           AND created_at <= ?`,
      )
      .run(updatedAt, ...OPEN_PAYMENT_STATUSES, cutoff)
    expired += result.changes
  }

  return expired
}

let timer: ReturnType<typeof setInterval> | null = null

/** Sweep once at startup and every minute, independent of UI polling. */
export function startPaymentInvoiceExpiryJob() {
  if (timer) return
  const run = () => {
    try {
      const expired = expireStalePaymentInvoices()
      if (expired > 0) console.log(`[payment-expiry] expired ${expired} stale invoice(s) at ${nowIso()}`)
    } catch (error) {
      console.error('[payment-expiry] failed', error)
    }
  }
  run()
  timer = setInterval(run, 60_000)
  timer.unref?.()
}
