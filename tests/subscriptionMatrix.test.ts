import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbPath = join(tmpdir(), `gateway-sub-matrix-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`)
mkdirSync(tmpdir(), { recursive: true })
process.env.DB_PATH = dbPath

const { db } = await import('../server/db.ts')
db.exec(`ALTER TABLE users ADD COLUMN restricted_tokens INTEGER NOT NULL DEFAULT 0`)
const {
  activateSubscription,
  consumeFreeTierTokens,
  expireDueSubscriptions,
  freeTierExhaustedMessage,
  getActiveSubscription,
  getFreeTierAccess,
  purchaseSubscriptionWithBalance,
  revokeActiveSubscription,
  updateSubscriptionSettings,
} = await import('../server/subscriptions.ts')
const { InsufficientBalanceError } = await import('../server/wallet.ts')

function seed(id: string, balance = 0) {
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO users (id,name,email,plan,status,balance_cents,balance_tokens,requests,created_at)
     VALUES (?,?,?,'free','active',0,?,0,?)`,
  ).run(id, id, `${id}@example.invalid`, balance, at)
}

function sub(id: string) {
  return db.prepare(`SELECT status, expires_at, token_limit, tokens_used, plan_key FROM user_subscriptions WHERE user_id = ? ORDER BY created_at DESC`).all(id)
}

test('wallet purchase grants the plan, charges dollars, and leaves the daily bucket untouched', () => {
  seed('buy_ok', 5_000_000)
  const result = purchaseSubscriptionWithBalance({ userId: 'buy_ok', planKey: 'day1' })
  assert.equal(result.credited, true)
  assert.equal(result.extended, false)
  assert.equal(result.amountUsd, 5)
  assert.equal(result.access.mode, 'subscription')
  assert.equal(result.access.remaining, 500_000_000)
  assert.ok(Date.parse(result.subscription.expiresAt) > Date.now() + 2 * 86400000)
  const wallet = db.prepare(`SELECT balance_tokens FROM users WHERE id = 'buy_ok'`).get() as { balance_tokens: number }
  assert.equal(wallet.balance_tokens, 0)
  const daily = db.prepare(`SELECT COUNT(*) AS n FROM free_tier_usage WHERE user_id = 'buy_ok'`).get() as { n: number }
  assert.equal(daily.n, 0)
})

test('a second wallet purchase extends time and adds a fresh allowance without resetting usage', () => {
  db.prepare(`UPDATE users SET balance_tokens = balance_tokens + 10000000 WHERE id = 'buy_ok'`).run()
  consumeFreeTierTokens('buy_ok', 40_000_000)
  const again = purchaseSubscriptionWithBalance({ userId: 'buy_ok', planKey: 'day7' })
  assert.equal(again.extended, true)
  assert.equal(again.subscription.planLabel, '10 days')
  assert.equal(again.subscription.tokenLimit, 1_600_000_000)
  const access = getFreeTierAccess('buy_ok')
  assert.equal(access.used, 40_000_000)
  assert.equal(access.remaining, 1_560_000_000)
  assert.equal(access.allowed, true)
  const rows = sub('buy_ok')
  assert.equal(rows.length, 1)
})

test('buying with an empty wallet refuses and does not open a subscription', () => {
  seed('buy_poor', 0)
  assert.throws(
    () => purchaseSubscriptionWithBalance({ userId: 'buy_poor', planKey: 'day1' }),
    (error: unknown) => error instanceof InsufficientBalanceError,
  )
  assert.equal(getActiveSubscription('buy_poor'), null)
  assert.equal(getFreeTierAccess('buy_poor').mode, 'free')
})

test('a wallet just short of the price is refused', () => {
  seed('buy_short', 999_999)
  assert.throws(() => purchaseSubscriptionWithBalance({ userId: 'buy_short', planKey: 'day1' }))
  assert.equal(getActiveSubscription('buy_short'), null)
})

test('disabled, unknown, and custom pack purchases are rejected', () => {
  seed('buy_bad', 50_000_000)
  updateSubscriptionSettings({ plans: [{ key: 'day14', enabled: false }] })
  assert.throws(() => purchaseSubscriptionWithBalance({ userId: 'buy_bad', planKey: 'day14' }), /unavailable|Unknown/)
  assert.throws(() => purchaseSubscriptionWithBalance({ userId: 'buy_bad', planKey: 'custom' }), /Choose a subscription plan/)
  assert.throws(() => purchaseSubscriptionWithBalance({ userId: 'buy_bad', planKey: 'nope' as 'day1' }), /Unknown|Choose/)
  updateSubscriptionSettings({ plans: [{ key: 'day14', enabled: true }] })
  assert.equal(getActiveSubscription('buy_bad'), null)
})

test('exact pool exhaustion blocks while the clock is still running', () => {
  seed('exact')
  activateSubscription({ userId: 'exact', planKey: 'day1', source: 'admin', grantedTokenLimit: 5_000, priceCents: 0 })
  consumeFreeTierTokens('exact', 5_000)
  const access = getFreeTierAccess('exact')
  assert.equal(access.allowed, false)
  assert.equal(access.remaining, 0)
  assert.equal(access.mode, 'subscription')
  assert.ok(Date.parse(getActiveSubscription('exact')!.expiresAt) > Date.now())
  assert.match(freeTierExhaustedMessage(access), /Subscription limit reached/)
  assert.match(freeTierExhaustedMessage(access), /\/subscriptions/)
})

test('overshoot never reports a negative remainder and still bills the subscription, not the daily bucket', () => {
  consumeFreeTierTokens('exact', 9_000)
  const access = getFreeTierAccess('exact')
  assert.equal(access.remaining, 0)
  assert.equal(access.used, 14_000)
  const daily = db.prepare(`SELECT COUNT(*) AS n FROM free_tier_usage WHERE user_id = 'exact'`).get() as { n: number }
  assert.equal(daily.n, 0)
})

test('zero and negative consumption do not change the pool', () => {
  const before = getFreeTierAccess('exact').used
  consumeFreeTierTokens('exact', 0)
  consumeFreeTierTokens('exact', -20)
  assert.equal(getFreeTierAccess('exact').used, before)
})

test('an expired subscription falls back to a clean daily allowance even if the pool was spent', () => {
  db.prepare(`UPDATE user_subscriptions SET expires_at = ? WHERE user_id = 'exact'`).run(new Date(Date.now() - 1000).toISOString())
  assert.equal(expireDueSubscriptions(), 1)
  const access = getFreeTierAccess('exact')
  assert.equal(access.mode, 'free')
  assert.equal(access.used, 0)
  assert.equal(access.remaining, 10_000_000)
  assert.equal(access.allowed, true)
  assert.equal(getActiveSubscription('exact'), null)
})

test('a subscription that expires one second ago is not active, one hour ahead is', () => {
  seed('clock')
  activateSubscription({ userId: 'clock', planKey: 'day1', source: 'admin', priceCents: 0 })
  db.prepare(`UPDATE user_subscriptions SET expires_at = ? WHERE user_id = 'clock'`).run(new Date(Date.now() + 3600_000).toISOString())
  assert.equal(getFreeTierAccess('clock').mode, 'subscription')
  db.prepare(`UPDATE user_subscriptions SET expires_at = ? WHERE user_id = 'clock'`).run(new Date(Date.now() - 1000).toISOString())
  expireDueSubscriptions()
  assert.equal(getFreeTierAccess('clock').mode, 'free')
})

test('buying after expiry starts a fresh pool and does not inherit old usage', () => {
  seed('rebuy', 5_000_000)
  activateSubscription({ userId: 'rebuy', planKey: 'day1', source: 'admin', priceCents: 0 })
  consumeFreeTierTokens('rebuy', 12_000)
  db.prepare(`UPDATE user_subscriptions SET expires_at = ? WHERE user_id = 'rebuy'`).run(new Date(Date.now() - 1000).toISOString())
  expireDueSubscriptions()
  const bought = purchaseSubscriptionWithBalance({ userId: 'rebuy', planKey: 'day1' })
  assert.equal(bought.extended, false)
  assert.equal(bought.access.used, 0)
  assert.equal(bought.access.remaining, 500_000_000)
})

test('revoke returns the user to the daily bucket and a second revoke is a no-op', () => {
  seed('revoke_me')
  activateSubscription({ userId: 'revoke_me', planKey: 'day30', source: 'admin', priceCents: 0 })
  assert.equal(revokeActiveSubscription('revoke_me').revoked, true)
  assert.equal(getFreeTierAccess('revoke_me').mode, 'free')
  assert.equal(revokeActiveSubscription('revoke_me').revoked, false)
})

test('unlimited stays allowed after a huge spend and ignores the token cap', () => {
  seed('unlim')
  updateSubscriptionSettings({ plans: [{ key: 'day30', kind: 'unlimited', tokenLimit: 1 }] })
  activateSubscription({ userId: 'unlim', planKey: 'day30', source: 'purchase', priceCents: 3000 })
  consumeFreeTierTokens('unlim', 9_000_000_000)
  const access = getFreeTierAccess('unlim')
  assert.equal(access.unlimited, true)
  assert.equal(access.allowed, true)
  assert.equal(access.remaining, null)
  assert.equal(access.limit, null)
  updateSubscriptionSettings({ plans: [{ key: 'day30', kind: 'custom', tokenLimit: 5_000_000_000 }] })
})

test('one user subscription never leaks into another account', () => {
  seed('a')
  seed('b')
  activateSubscription({ userId: 'a', planKey: 'day7', source: 'admin', priceCents: 0 })
  consumeFreeTierTokens('a', 3_000_000)
  assert.equal(getFreeTierAccess('b').mode, 'free')
  assert.equal(getFreeTierAccess('b').used, 0)
  assert.equal(getFreeTierAccess('a').used, 3_000_000)
})

test('daily usage from yesterday does not block today after a subscription ends', () => {
  seed('rollover')
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  db.prepare(
    `INSERT INTO free_tier_usage (user_id, period_key, tokens_used, updated_at) VALUES ('rollover', ?, 10000000, ?)`,
  ).run(yesterday, new Date().toISOString())
  activateSubscription({ userId: 'rollover', planKey: 'day1', source: 'admin', priceCents: 0 })
  db.prepare(`UPDATE user_subscriptions SET expires_at = ? WHERE user_id = 'rollover'`).run(new Date(Date.now() - 1000).toISOString())
  expireDueSubscriptions()
  const access = getFreeTierAccess('rollover')
  assert.equal(access.mode, 'free')
  assert.equal(access.used, 0)
  assert.equal(access.allowed, true)
})
