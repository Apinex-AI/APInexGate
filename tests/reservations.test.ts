import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbPath = join(tmpdir(), `gateway-res-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`)
mkdirSync(tmpdir(), { recursive: true })
process.env.DB_PATH = dbPath

const { db } = await import('../server/db.ts')
const {
  tryReserveTokens,
  settleReservation,
  releaseReservation,
  expireOpenReservations,
  estimateModelReservationTokens,
} = await import('../server/tokenReservations.ts')

function seed() {
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO users (id,name,email,plan,status,balance_cents,balance_tokens,requests,created_at)
     VALUES ('u1','T','t@example.invalid','free','active',0,1000,0,?)`,
  ).run(at)
  db.prepare(
    `INSERT INTO api_keys (id,user_id,name,prefix,status,created_at,secret_hash,spent_tokens,spend_limit_tokens,reserved_tokens)
     VALUES ('k1','u1','K','apx_test','active',?,'hash',0,1000,0)`,
  ).run(at)
}

test('free weight reserves zero tokens', () => {
  const estimate = estimateModelReservationTokens(
    { messages: [{ role: 'user', content: 'hello world' }] },
    0,
  )
  assert.equal(estimate.costTokens, 0)
})

test('parallel reserves cannot overdraw balance', () => {
  seed()
  const a = tryReserveTokens({ userId: 'u1', apiKeyId: 'k1', amount: 700 })
  const b = tryReserveTokens({ userId: 'u1', apiKeyId: 'k1', amount: 400 })
  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  if (a.ok) releaseReservation(a.reservationId)
})

test('settle charges actual and refunds unused hold', () => {
  const userBefore = db.prepare(`SELECT balance_tokens FROM users WHERE id='u1'`).get() as {
    balance_tokens: number
  }
  const reserve = tryReserveTokens({ userId: 'u1', apiKeyId: 'k1', amount: 500 })
  assert.equal(reserve.ok, true)
  if (!reserve.ok) return
  const settled = settleReservation(reserve.reservationId, 200)
  assert.equal(settled.ok, true)
  assert.equal(settled.charged, 200)
  assert.equal(settled.refunded, 300)
  const user = db.prepare(`SELECT balance_tokens, reserved_tokens FROM users WHERE id='u1'`).get() as {
    balance_tokens: number
    reserved_tokens: number
  }
  const key = db.prepare(`SELECT spent_tokens, reserved_tokens FROM api_keys WHERE id='k1'`).get() as {
    spent_tokens: number
    reserved_tokens: number
  }
  assert.equal(user.balance_tokens, userBefore.balance_tokens - 200)
  assert.equal(user.reserved_tokens, 0)
  assert.equal(key.spent_tokens, 200)
  assert.equal(key.reserved_tokens, 0)
})

test('release returns full reservation', () => {
  const before = db.prepare(`SELECT balance_tokens FROM users WHERE id='u1'`).get() as { balance_tokens: number }
  const reserve = tryReserveTokens({ userId: 'u1', apiKeyId: 'k1', amount: 150 })
  assert.equal(reserve.ok, true)
  if (!reserve.ok) return
  const released = releaseReservation(reserve.reservationId)
  assert.equal(released.ok, true)
  assert.equal(released.refunded, 150)
  const after = db.prepare(`SELECT balance_tokens, reserved_tokens FROM users WHERE id='u1'`).get() as {
    balance_tokens: number
    reserved_tokens: number
  }
  assert.equal(after.balance_tokens, before.balance_tokens)
  assert.equal(after.reserved_tokens, 0)
})

test('expiry job frees abandoned holds', () => {
  const before = db.prepare(`SELECT balance_tokens FROM users WHERE id='u1'`).get() as { balance_tokens: number }
  const reserve = tryReserveTokens({ userId: 'u1', apiKeyId: 'k1', amount: 80 })
  assert.equal(reserve.ok, true)
  if (!reserve.ok) return
  db.prepare(`UPDATE token_reservations SET expires_at = ? WHERE id = ?`).run(
    '2000-01-01T00:00:00.000Z',
    reserve.reservationId,
  )
  const n = expireOpenReservations(new Date('2001-01-01T00:00:00.000Z'))
  assert.ok(n >= 1)
  const after = db.prepare(`SELECT balance_tokens, reserved_tokens FROM users WHERE id='u1'`).get() as {
    balance_tokens: number
    reserved_tokens: number
  }
  assert.equal(after.balance_tokens, before.balance_tokens)
  assert.equal(after.reserved_tokens, 0)
})

test('Anthropic models reject users without a top-up even if they have bonus balance', () => {
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO users (id,name,email,plan,status,balance_cents,balance_tokens,restricted_tokens,requests,created_at)
     VALUES ('u_bonus_only','Bonus','bonus@test.com','free','active',0,400000,400000,0,?)`,
  ).run(at)
  db.prepare(
    `INSERT INTO api_keys (id,user_id,name,prefix,status,created_at,secret_hash,spent_tokens,spend_limit_tokens,reserved_tokens)
     VALUES ('k_bonus','u_bonus_only','K','apx_test','active',?,'hash2',0,null,0)`,
  ).run(at)

  // Disallow restricted credits (Anthropic model) without top-up
  const res = tryReserveTokens({
    userId: 'u_bonus_only',
    apiKeyId: 'k_bonus',
    amount: 1000,
    allowRestrictedCredits: false,
  })
  assert.equal(res.ok, false)
  assert.match((res as { error: string }).error, /Anthropic models/i)

  // Now simulate a top-up
  db.prepare(
    `INSERT INTO crypto_payments (id, user_id, provider, order_id, amount_cents, currency, status, credited_at, created_at, updated_at)
     VALUES ('pay_1', 'u_bonus_only', 'solana', 'ord_1', 500, 'USD', 'finished', ?, ?, ?)`,
  ).run(at, at, at)
  // Give regular balance
  db.prepare(`UPDATE users SET balance_tokens = 500000, restricted_tokens = 0 WHERE id = 'u_bonus_only'`).run()

  const resAfterTopup = tryReserveTokens({
    userId: 'u_bonus_only',
    apiKeyId: 'k_bonus',
    amount: 1000,
    allowRestrictedCredits: false,
  })
  assert.equal(resAfterTopup.ok, true)
  if (resAfterTopup.ok) releaseReservation(resAfterTopup.reservationId)
})
