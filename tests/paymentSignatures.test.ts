import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbPath = join(
  tmpdir(),
  `gateway-sig-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
)
mkdirSync(tmpdir(), { recursive: true })
process.env.DB_PATH = dbPath

const { db } = await import('../server/db.ts')

// Seed a credited on-chain top-up BEFORE the ledger module loads, so the
// import-time backfill has something historical to register.
{
  const cols = db.prepare('PRAGMA table_info(crypto_payments)').all() as Array<{ name: string }>
  if (!cols.some((column) => column.name === 'asset')) {
    db.exec('ALTER TABLE crypto_payments ADD COLUMN asset TEXT')
  }
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO users (id,name,email,plan,status,balance_cents,balance_tokens,requests,created_at)
     VALUES ('u_sig','Sig','sig@example.invalid','free','active',0,0,0,?)`,
  ).run(at)
  db.prepare(
    `INSERT INTO crypto_payments
      (id,user_id,provider,amount_cents,currency,status,order_id,payment_id,asset,credited_at,created_at,updated_at)
     VALUES ('pay_historic','u_sig','solana',500,'usd','finished','order_historic','SIG_HISTORIC','SOL',?,?,?)`,
  ).run(at, at, at)
}

const {
  claimPaymentSignature,
  claimPaymentSignatureOrThrow,
  findSignatureClaim,
  PaymentSignatureConflictError,
  signatureConflict,
} = await import('../server/paymentSignatures.ts')

test('import-time backfill registers already-credited on-chain payments', () => {
  const claim = findSignatureClaim('SIG_HISTORIC')
  assert.ok(claim, 'historic credited signature should be registered')
  assert.equal(claim.flow, 'topup')
  assert.equal(claim.paymentId, 'pay_historic')
})

test('a historic signature cannot be replayed into a different flow', () => {
  const result = claimPaymentSignature({
    signature: 'SIG_HISTORIC',
    flow: 'subscription',
    paymentId: 'subpay_attacker',
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.conflict.flow, 'topup')
    assert.equal(result.conflict.paymentId, 'pay_historic')
  }
})

test('THE BUG: one transfer cannot be credited by two different flows', () => {
  // Subscription claims it first.
  const first = claimPaymentSignature({
    signature: 'SIG_SHARED',
    flow: 'subscription',
    paymentId: 'subpay_1',
    userId: 'u_sig',
  })
  assert.equal(first.ok, true)

  // The same transfer, same price, now offered to topup. Previously each
  // table only checked itself, so this used to succeed.
  const second = claimPaymentSignature({
    signature: 'SIG_SHARED',
    flow: 'topup',
    paymentId: 'topup_1',
    userId: 'u_sig',
  })
  assert.equal(second.ok, false)
  if (!second.ok) assert.equal(second.conflict.flow, 'subscription')

  // And repeated attempts are locked out too.
  for (const flow of ['topup'] as const) {
    const attempt = claimPaymentSignature({
      signature: 'SIG_SHARED',
      flow,
      paymentId: `other_${flow}`,
    })
    assert.equal(attempt.ok, false, `${flow} must not be able to reuse the signature`)
  }

  // Exactly one owner is recorded.
  const rows = db
    .prepare(`SELECT COUNT(*) AS n FROM used_payment_signatures WHERE signature = 'SIG_SHARED'`)
    .get() as { n: number }
  assert.equal(rows.n, 1)
})

test('re-verifying the same payment is idempotent', () => {
  const again = claimPaymentSignature({
    signature: 'SIG_SHARED',
    flow: 'subscription',
    paymentId: 'subpay_1',
  })
  assert.equal(again.ok, true, 'the owning payment may re-verify freely')
  assert.equal(signatureConflict('SIG_SHARED', 'subpay_1'), null)
  assert.ok(signatureConflict('SIG_SHARED', 'rpay_1'))
})

test('an empty signature is never deduplicated', () => {
  assert.equal(claimPaymentSignature({ signature: '', flow: 'topup', paymentId: 'p1' }).ok, true)
  assert.equal(claimPaymentSignature({ signature: '   ', flow: 'topup', paymentId: 'p2' }).ok, true)
  assert.equal(findSignatureClaim(''), null)
})

test('claimOrThrow rolls the whole credit back, releasing the claim', () => {
  claimPaymentSignature({ signature: 'SIG_TX', flow: 'topup', paymentId: 'topup_owner' })

  // A different payment attempting to credit inside a transaction must abort.
  assert.throws(() => {
    db.transaction(() => {
      claimPaymentSignatureOrThrow({
        signature: 'SIG_TX',
        flow: 'topup',
        paymentId: 'topup_thief',
      })
      db.prepare(`UPDATE users SET balance_tokens = balance_tokens + 999999 WHERE id = 'u_sig'`).run()
    })()
  }, PaymentSignatureConflictError)

  // The balance change was rolled back with the failed claim.
  const user = db.prepare(`SELECT balance_tokens FROM users WHERE id = 'u_sig'`).get() as {
    balance_tokens: number
  }
  assert.equal(user.balance_tokens, 0)

  // Ownership is unchanged.
  const claim = findSignatureClaim('SIG_TX')
  assert.ok(claim)
  assert.equal(claim.paymentId, 'topup_owner')
})

test('a rolled-back claim does not leave a stale lock', () => {
  // A credit that fails for an unrelated reason must release its signature so a
  // legitimate retry can still succeed.
  assert.throws(() => {
    db.transaction(() => {
      claimPaymentSignatureOrThrow({
        signature: 'SIG_ROLLBACK',
        flow: 'subscription',
        paymentId: 'subpay_retry',
      })
      throw new Error('unrelated failure after the claim')
    })()
  }, /unrelated failure/)

  assert.equal(findSignatureClaim('SIG_ROLLBACK'), null, 'claim must not survive a rollback')

  // The retry now works.
  const retry = claimPaymentSignature({
    signature: 'SIG_ROLLBACK',
    flow: 'subscription',
    paymentId: 'subpay_retry',
  })
  assert.equal(retry.ok, true)
})

test('distinct signatures are unaffected', () => {
  assert.equal(
    claimPaymentSignature({ signature: 'SIG_A', flow: 'topup', paymentId: 'a' }).ok,
    true,
  )
  assert.equal(
    claimPaymentSignature({ signature: 'SIG_B', flow: 'topup', paymentId: 'b' }).ok,
    true,
  )
  assert.equal(
    claimPaymentSignature({ signature: 'SIG_C', flow: 'subscription', paymentId: 'c' }).ok,
    true,
  )
})

test('backfill is idempotent across restarts', async () => {
  const before = db.prepare(`SELECT COUNT(*) AS n FROM used_payment_signatures`).get() as {
    n: number
  }
  // Re-importing is a no-op because the module is cached; assert the historic
  // row was not duplicated by the initial run either.
  await import('../server/paymentSignatures.ts')
  const after = db.prepare(`SELECT COUNT(*) AS n FROM used_payment_signatures`).get() as {
    n: number
  }
  assert.equal(after.n, before.n)
  const historic = db
    .prepare(`SELECT COUNT(*) AS n FROM used_payment_signatures WHERE signature = 'SIG_HISTORIC'`)
    .get() as { n: number }
  assert.equal(historic.n, 1)
})
