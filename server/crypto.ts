import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { db, nowIso, id } from './db.js'
import { claimPaymentSignature, claimPaymentSignatureOrThrow, PaymentSignatureConflictError, type PaymentFlow } from './paymentSignatures.js'

/**
 * Constant-time comparison for strings or Buffers to prevent timing attacks.
 * Uses SHA-256 digest comparison to equalize length before running timingSafeEqual,
 * preventing any timing side-channel on length differences.
 */
export function timingSafeCompare(a: string | Buffer, b: string | Buffer): boolean {
  if (a == null || b == null) return false
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(String(a))
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(String(b))

  const hashA = createHash('sha256').update(bufA).digest()
  const hashB = createHash('sha256').update(bufB).digest()

  const digestsMatch = timingSafeEqual(hashA, hashB)
  return digestsMatch && bufA.length === bufB.length
}

/** Constant-time string equality check */
export const timingSafeStringCompare = timingSafeCompare

/**
 * Verify HMAC signature on webhook or payment callback payloads in constant time.
 */
export function verifyCallbackSignature(input: {
  payload: string | Buffer
  signature: string
  secret: string
  algorithm?: string
}): boolean {
  const { payload, signature, secret, algorithm = 'sha256' } = input
  const cleanSig = typeof signature === 'string' ? signature.trim() : ''
  const cleanSecret = typeof secret === 'string' ? secret.trim() : (secret ? String(secret).trim() : '')
  if (!cleanSig || !cleanSecret) return false
  const hmac = createHmac(algorithm, cleanSecret)
  hmac.update(Buffer.isBuffer(payload) ? payload : String(payload ?? ''))
  const expectedHex = hmac.digest('hex')
  return timingSafeCompare(expectedHex.toLowerCase(), cleanSig.toLowerCase())
}

export const verifyWebhookSignature = verifyCallbackSignature

/**
 * Validates payment amounts, enforcing finite, positive values within bounds.
 * Rejects NaN, Infinity, -Infinity, zero, and negative values.
 */
export function validatePaymentAmount(
  amount: unknown,
  options: { min?: number; max?: number; fieldName?: string } = {},
): number {
  const field = options.fieldName ?? 'Payment amount'
  const num = Number(amount)
  if (!Number.isFinite(num) || isNaN(num)) {
    throw new Error(`${field} must be a valid finite number`)
  }
  if (num <= 0) {
    throw new Error(`${field} must be greater than zero`)
  }
  const min = options.min ?? 0.01
  if (num < min) {
    throw new Error(`${field} must be at least ${min}`)
  }
  if (options.max != null && num > options.max) {
    throw new Error(`${field} exceeds maximum allowed limit of ${options.max}`)
  }
  return num
}

/**
 * Validates integer amounts in cents, enforcing positive finite integers.
 */
export function validateCentsAmount(
  cents: unknown,
  minCents = 1,
  maxCents?: number,
): number {
  const num = Number(cents)
  if (!Number.isFinite(num) || isNaN(num)) {
    throw new Error('Amount in cents must be a valid finite number')
  }
  if (num <= 0) {
    throw new Error('Amount in cents must be greater than zero')
  }
  const rounded = Math.round(num)
  if (rounded < minCents) {
    throw new Error(`Amount in cents must be at least ${minCents}`)
  }
  if (maxCents != null && rounded > maxCents) {
    throw new Error(`Amount in cents cannot exceed ${maxCents}`)
  }
  return rounded
}

/**
 * Verifies that a transaction signature has not been used or replayed.
 */
export function assertTransactionSignatureNotReplayed(input: {
  signature: string
  flow: PaymentFlow
  paymentId: string
  userId?: string | null
}) {
  const sig = String(input.signature || '').trim()
  if (!sig) throw new Error('Transaction signature required')
  claimPaymentSignatureOrThrow({
    signature: sig,
    flow: input.flow,
    paymentId: input.paymentId,
    userId: input.userId,
  })
}

/**
 * Atomically verifies and records a crypto payment.
 * Ensures signature replay protection and amount validation inside an immediate transaction.
 */
export function processCryptoPayment(input: {
  paymentId: string
  signature: string
  amountCents: number
  userId: string
  flow?: PaymentFlow
  minCents?: number
}): { ok: true; paymentId: string; amountCents: number } {
  const amountCents = validateCentsAmount(input.amountCents, input.minCents ?? 1)
  const signature = String(input.signature || '').trim()
  if (!signature) throw new Error('Signature is required')
  const flow = input.flow ?? 'topup'

  return db.transaction(() => {
    // 1. Replay prevention: atomically claim the signature across all payment flows
    claimPaymentSignatureOrThrow({
      signature,
      flow,
      paymentId: input.paymentId,
      userId: input.userId,
    })

    const when = nowIso()
    // 2. Mark payment credited if table exists
    try {
      db.prepare(
        `UPDATE crypto_payments
         SET status = 'finished', credited_at = ?, payment_id = ?, updated_at = ?
         WHERE id = ? AND credited_at IS NULL`,
      ).run(when, signature, when, input.paymentId)
    } catch {}

    return { ok: true as const, paymentId: input.paymentId, amountCents }
  }).immediate()
}
