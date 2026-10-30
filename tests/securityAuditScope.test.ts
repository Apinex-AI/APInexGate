import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbPath = join(
  tmpdir(),
  `gateway-audit-scope-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
)
mkdirSync(tmpdir(), { recursive: true })
process.env.DB_PATH = dbPath

const { db } = await import('../server/db.ts')
const { debitWalletForPurchase, creditWalletBalance, debitWalletBalance, InsufficientBalanceError } = await import('../server/wallet.ts')
const { createPromoCode, redeemPromoCode, generatePromoCodeLocal } = await import('../server/promo.ts')
const { timingSafeCompare, verifyCallbackSignature, validatePaymentAmount, validateCentsAmount, processCryptoPayment } = await import('../server/crypto.ts')
const { isValidSolanaSignature, validateSolanaAmount, validateSolanaLamports, verifySolanaTransactionSignature, compareSolanaAddresses, processSolanaPayment } = await import('../server/solana.ts')
const { PaymentSignatureConflictError } = await import('../server/paymentSignatures.ts')

function seedUser(userId: string, email: string, balanceTokens = 0) {
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
     VALUES (?, ?, ?, 'free', 'active', 0, ?, 0, ?)`,
  ).run(userId, userId, email, balanceTokens, at)
}

test('1. Numeric sanitization: rejects negative, zero, NaN, and Infinity in wallet', () => {
  seedUser('u_num_test', 'num@example.invalid', 100_000)

  // NaN, Infinity, -Infinity, negative, 0
  assert.throws(() => debitWalletForPurchase({ userId: 'u_num_test', amountCents: NaN, kind: 'test', sourceRef: 'ref_nan', note: 'test' }), /Amount/)
  assert.throws(() => debitWalletForPurchase({ userId: 'u_num_test', amountCents: Infinity, kind: 'test', sourceRef: 'ref_inf', note: 'test' }), /Amount/)
  assert.throws(() => debitWalletForPurchase({ userId: 'u_num_test', amountCents: -Infinity, kind: 'test', sourceRef: 'ref_neginf', note: 'test' }), /Amount/)
  assert.throws(() => debitWalletForPurchase({ userId: 'u_num_test', amountCents: -50, kind: 'test', sourceRef: 'ref_neg', note: 'test' }), /Amount/)
  assert.throws(() => debitWalletForPurchase({ userId: 'u_num_test', amountCents: 0, kind: 'test', sourceRef: 'ref_zero', note: 'test' }), /Amount/)

  assert.throws(() => creditWalletBalance({ userId: 'u_num_test', amountCents: NaN }), /Amount/)
  assert.throws(() => creditWalletBalance({ userId: 'u_num_test', amountCents: Infinity }), /Amount/)
  assert.throws(() => creditWalletBalance({ userId: 'u_num_test', amountCents: -100 }), /Amount/)
  assert.throws(() => creditWalletBalance({ userId: 'u_num_test', amountCents: 0 }), /Amount/)

  assert.throws(() => debitWalletBalance({ userId: 'u_num_test', amountCents: NaN }), /Amount/)
  assert.throws(() => debitWalletBalance({ userId: 'u_num_test', amountCents: Infinity }), /Amount/)
  assert.throws(() => debitWalletBalance({ userId: 'u_num_test', amountCents: -100 }), /Amount/)
  assert.throws(() => debitWalletBalance({ userId: 'u_num_test', amountCents: 0 }), /Amount/)
})

test('2. Numeric sanitization: rejects negative, zero, NaN, and Infinity in promo creation', () => {
  const code = generatePromoCodeLocal()
  assert.throws(() => createPromoCode({ code, maxUses: NaN, expiresAt: null, note: 'n', createdBy: 'admin', rewardUsd: 5 }), /Max uses/)
  assert.throws(() => createPromoCode({ code, maxUses: Infinity, expiresAt: null, note: 'n', createdBy: 'admin', rewardUsd: 5 }), /Max uses/)
  assert.throws(() => createPromoCode({ code, maxUses: -1, expiresAt: null, note: 'n', createdBy: 'admin', rewardUsd: 5 }), /Max uses/)
  assert.throws(() => createPromoCode({ code, maxUses: 0, expiresAt: null, note: 'n', createdBy: 'admin', rewardUsd: 5 }), /Max uses/)

  assert.throws(() => createPromoCode({ code, maxUses: 1, expiresAt: null, note: 'n', createdBy: 'admin', rewardUsd: NaN }), /Reward/)
  assert.throws(() => createPromoCode({ code, maxUses: 1, expiresAt: null, note: 'n', createdBy: 'admin', rewardUsd: Infinity }), /Reward/)
  assert.throws(() => createPromoCode({ code, maxUses: 1, expiresAt: null, note: 'n', createdBy: 'admin', rewardUsd: -5 }), /Reward/)
  assert.throws(() => createPromoCode({ code, maxUses: 1, expiresAt: null, note: 'n', createdBy: 'admin', rewardUsd: 0 }), /Reward/)
})

test('3. Concurrency / Immediate transactions: wallet debit & credit', () => {
  seedUser('u_wallet_tx', 'wtx@example.invalid', 100_000)

  // Credit 500 cents
  const cred = creditWalletBalance({ userId: 'u_wallet_tx', amountCents: 500, note: 'Bonus' })
  assert.equal(cred.ok, true)
  assert.equal(cred.cents, 500)

  // Debit 200 cents
  const deb = debitWalletBalance({ userId: 'u_wallet_tx', amountCents: 200, note: 'Fee' })
  assert.equal(deb.ok, true)
  assert.equal(deb.cents, 200)

  // Insufficient balance debit throws InsufficientBalanceError
  assert.throws(() => debitWalletBalance({ userId: 'u_wallet_tx', amountCents: 10_000_000 }), InsufficientBalanceError)
})

test('4. Atomic promo redemption and max_uses row locking', () => {
  seedUser('u_promo_user1', 'p1@example.invalid')
  seedUser('u_promo_user2', 'p2@example.invalid')

  const code = generatePromoCodeLocal()
  createPromoCode({
    code,
    type: 'balance',
    rewardUsd: 5,
    maxUses: 1,
    expiresAt: null,
    note: 'Single use voucher',
    createdBy: 'admin',
  })

  // First redemption succeeds
  const r1 = redeemPromoCode({ userId: 'u_promo_user1', code })
  assert.equal(r1.ok, true)

  // Second concurrent or subsequent redemption fails atomically
  assert.throws(() => redeemPromoCode({ userId: 'u_promo_user2', code }), /already been redeemed|usage limit/)
})

test('5. Constant-time cryptographic comparison against timing attacks', async () => {
  assert.equal(timingSafeCompare('secret-key-12345', 'secret-key-12345'), true)
  assert.equal(timingSafeCompare('secret-key-12345', 'secret-key-12346'), false)
  assert.equal(timingSafeCompare('short', 'much-longer-secret'), false)
  assert.equal(timingSafeCompare('', ''), true)
  assert.equal(timingSafeCompare(Buffer.from('test'), Buffer.from('test')), true)

  const payload = JSON.stringify({ event: 'payment.success', amount: 500 })
  const secret = 'webhook-signing-secret'
  const { createHmac } = await import('node:crypto')
  const validSig = createHmac('sha256', secret).update(payload).digest('hex')

  assert.equal(verifyCallbackSignature({ payload, signature: validSig, secret }), true)
  assert.equal(verifyCallbackSignature({ payload, signature: 'invalid-sig', secret }), false)
  assert.equal(verifyCallbackSignature({ payload, signature: validSig.slice(0, 10), secret }), false)
  // Missing or whitespace secrets and signatures must strictly reject
  assert.equal(verifyCallbackSignature({ payload, signature: validSig, secret: '' }), false)
  assert.equal(verifyCallbackSignature({ payload, signature: validSig, secret: '   ' }), false)
  assert.equal(verifyCallbackSignature({ payload, signature: '', secret }), false)
  assert.equal(verifyCallbackSignature({ payload, signature: '   ', secret }), false)
})

test('6. Solana and Crypto amount validation and bounds', () => {
  assert.throws(() => validatePaymentAmount(NaN), /finite number/)
  assert.throws(() => validatePaymentAmount(Infinity), /finite number/)
  assert.throws(() => validatePaymentAmount(-5), /greater than zero/)
  assert.throws(() => validatePaymentAmount(0.005, { min: 0.01 }), /at least 0.01/)
  assert.throws(() => validatePaymentAmount(150, { max: 100 }), /maximum allowed limit/)

  assert.throws(() => validateCentsAmount(NaN), /finite number/)
  assert.throws(() => validateCentsAmount(Infinity), /finite number/)
  assert.throws(() => validateCentsAmount(-10), /greater than zero/)
  assert.throws(() => validateCentsAmount(0), /greater than zero/)

  assert.throws(() => validateSolanaAmount(NaN), /finite number/)
  assert.throws(() => validateSolanaAmount(-1), /greater than zero/)
  assert.throws(() => validateSolanaAmount(0), /greater than zero/)

  assert.throws(() => validateSolanaLamports(NaN), /valid positive integer/)
  assert.throws(() => validateSolanaLamports(-100n), /greater than zero/)
  assert.throws(() => validateSolanaLamports(0n), /greater than zero/)
  assert.equal(validateSolanaLamports(100_000_000n), 100_000_000n)
})

test('7. Solana and Crypto transaction replay protection', () => {
  seedUser('u_crypto_pay', 'cpay@example.invalid')

  const validSig = '5'.repeat(88)
  assert.equal(isValidSolanaSignature(validSig), true)
  assert.equal(isValidSolanaSignature('short-sig'), false)

  // 1. First process succeeds
  const res = processSolanaPayment({
    paymentId: 'pay_sol_1',
    signature: validSig,
    amountLamports: 1_000_000_000n,
    expectedLamports: 1_000_000_000n,
    userId: 'u_crypto_pay',
    flow: 'topup',
  })
  assert.equal(res.ok, true)

  // 2. Replay attack: trying to reuse same signature on another payment must throw PaymentSignatureConflictError
  assert.throws(
    () => {
      processSolanaPayment({
        paymentId: 'pay_sol_2_attacker',
        signature: validSig,
        amountLamports: 1_000_000_000n,
        userId: 'u_crypto_pay',
        flow: 'topup',
      })
    },
    PaymentSignatureConflictError,
  )

  // 3. Replay across flows: trying to reuse same signature for subscription flow must also throw
  assert.throws(
    () => {
      processCryptoPayment({
        paymentId: 'sub_pay_attacker',
        signature: validSig,
        amountCents: 500,
        userId: 'u_crypto_pay',
        flow: 'subscription',
      })
    },
    PaymentSignatureConflictError,
  )

  // 4. Underpayment validation on Solana
  const sig2 = '6'.repeat(88)
  assert.throws(
    () => {
      processSolanaPayment({
        paymentId: 'pay_sol_underpaid',
        signature: sig2,
        amountLamports: 500_000n,
        expectedLamports: 1_000_000n,
        userId: 'u_crypto_pay',
      })
    },
    /Underpaid/,
  )
})
