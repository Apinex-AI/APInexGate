import { db, nowIso } from './db.js'
import { claimPaymentSignatureOrThrow, type PaymentFlow } from './paymentSignatures.js'
import { timingSafeCompare } from './crypto.js'

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/

/**
 * Validates a Solana transaction signature format (base58, 87-88 chars).
 */
export function isValidSolanaSignature(signature: string): boolean {
  if (typeof signature !== 'string') return false
  return BASE58_REGEX.test(signature.trim())
}

/**
 * Validates SOL amount, ensuring positive finite value within bounds.
 */
export function validateSolanaAmount(sol: unknown, minSol = 0.000001, maxSol?: number): number {
  const num = Number(sol)
  if (!Number.isFinite(num) || isNaN(num)) {
    throw new Error('SOL amount must be a valid finite number')
  }
  if (num <= 0) {
    throw new Error('SOL amount must be greater than zero')
  }
  if (num < minSol) {
    throw new Error(`SOL amount must be at least ${minSol}`)
  }
  if (maxSol != null && num > maxSol) {
    throw new Error(`SOL amount cannot exceed ${maxSol}`)
  }
  return num
}

/**
 * Validates lamports amount, ensuring positive integer BigInt within bounds.
 */
export function validateSolanaLamports(
  lamports: unknown,
  minLamports: bigint | number = 1n,
  maxLamports?: bigint | number,
): bigint {
  let val: bigint
  try {
    if (typeof lamports === 'bigint') {
      val = lamports
    } else {
      const num = Number(lamports)
      if (!Number.isFinite(num) || isNaN(num) || num <= 0) {
        throw new Error('Invalid lamports')
      }
      val = BigInt(Math.round(num))
    }
  } catch {
    throw new Error('Lamports amount must be a valid positive integer')
  }

  if (val <= 0n) {
    throw new Error('Lamports amount must be greater than zero')
  }
  const min = BigInt(minLamports)
  if (val < min) {
    throw new Error(`Lamports amount must be at least ${min.toString()}`)
  }
  if (maxLamports != null && val > BigInt(maxLamports)) {
    throw new Error(`Lamports amount cannot exceed ${BigInt(maxLamports).toString()}`)
  }
  return val
}

/**
 * Verifies a Solana transaction signature and protects against replay/reuse.
 */
export function verifySolanaTransactionSignature(input: {
  signature: string
  flow: PaymentFlow
  paymentId: string
  userId?: string | null
}) {
  const sig = String(input.signature || '').trim()
  if (!sig) throw new Error('Transaction signature required')
  if (!isValidSolanaSignature(sig)) {
    throw new Error('Invalid Solana transaction signature format')
  }
  claimPaymentSignatureOrThrow({
    signature: sig,
    flow: input.flow,
    paymentId: input.paymentId,
    userId: input.userId,
  })
}

/**
 * Compare Solana public keys or addresses using constant-time comparison to prevent timing attacks.
 */
export function compareSolanaAddresses(a: string, b: string): boolean {
  return timingSafeCompare(String(a || '').trim(), String(b || '').trim())
}

/**
 * Process a Solana payment with replay protection and amount bounds inside an immediate transaction.
 */
export function processSolanaPayment(input: {
  paymentId: string
  signature: string
  amountLamports: bigint | number
  expectedLamports?: bigint | number
  userId: string
  flow?: PaymentFlow
}): { ok: true; paymentId: string; amountLamports: bigint } {
  const lamports = validateSolanaLamports(input.amountLamports)
  if (input.expectedLamports != null) {
    const expected = validateSolanaLamports(input.expectedLamports)
    if (lamports < expected) {
      throw new Error(`Underpaid: received ${lamports.toString()} lamports, expected ${expected.toString()}`)
    }
  }

  const sig = String(input.signature || '').trim()
  if (!isValidSolanaSignature(sig)) {
    throw new Error('Invalid Solana transaction signature format')
  }
  const flow = input.flow ?? 'topup'

  return db.transaction(() => {
    // Replay protection: atomically claim the signature across all payment flows
    claimPaymentSignatureOrThrow({
      signature: sig,
      flow,
      paymentId: input.paymentId,
      userId: input.userId,
    })

    const when = nowIso()
    try {
      db.prepare(
        `UPDATE crypto_payments
         SET status = 'finished', credited_at = ?, payment_id = ?, updated_at = ?
         WHERE id = ? AND credited_at IS NULL`,
      ).run(when, sig, when, input.paymentId)
    } catch {}

    return { ok: true as const, paymentId: input.paymentId, amountLamports: lamports }
  }).immediate()
}
