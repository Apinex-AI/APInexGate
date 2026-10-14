import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbPath = join(
  tmpdir(),
  `gateway-free-reset-promo-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
)
mkdirSync(tmpdir(), { recursive: true })
process.env.DB_PATH = dbPath

const { db } = await import('../server/db.ts')
const {
  createPromoCode,
  redeemPromoCode,
} = await import('../server/promo.ts')
const {
  activateSubscription,
  consumeFreeTierTokens,
  getActiveSubscription,
  getFreeTierAccess,
} = await import('../server/subscriptions.ts')

function seedUser(userId: string) {
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at, telegram_verified_at)
     VALUES (?, ?, ?, 'free', 'active', 0, 0, 0, ?, ?)`,
  ).run(userId, userId, `${userId}@example.invalid`, at, at)
}

test('creates and redeems free_reset promo code, resetting daily usage to 0 while keeping free-tier limits', () => {
  const userId = 'user_free_tester'
  seedUser(userId)

  // 1. User spends tokens (e.g. 500_000 out of daily limit)
  consumeFreeTierTokens(userId, 500_000)
  const usedBefore = getFreeTierAccess(userId)
  assert.equal(usedBefore.mode, 'free')
  assert.equal(usedBefore.used, 500_000)
  assert.equal(getActiveSubscription(userId), null)

  // 2. Admin creates a free_reset promo code
  const promo = createPromoCode({
    code: 'RESETFREE100',
    type: 'free_reset',
    maxUses: 5,
    expiresAt: null,
    note: 'Daily limit reset promo',
    createdBy: 'admin@example.com',
  })
  assert.equal(promo.code, 'RESETFREE100')
  assert.equal(promo.type, 'free_reset')
  assert.equal(promo.plan_label, 'Daily Free Limit Reset')
  assert.equal(promo.reward_cents, 0)

  // 3. User redeems the promo code
  const result = redeemPromoCode({
    userId,
    code: 'RESETFREE100',
  })
  assert.equal(result.ok, true)
  assert.equal(result.type, 'free_reset')
  assert.equal(result.code, 'RESETFREE100')

  // 4. Verify user free allowance is reset to 0 used
  const accessAfter = getFreeTierAccess(userId)
  assert.equal(accessAfter.mode, 'free')
  assert.equal(accessAfter.used, 0)
  assert.equal(accessAfter.remaining, accessAfter.limit)
  assert.equal(accessAfter.allowed, true)

  // 5. Verify NO subscription was created (RPM and models remain free-tier)
  assert.equal(getActiveSubscription(userId), null)
})

test('free_reset works even when user spent only 1 token', () => {
  const userId = 'user_single_token'
  seedUser(userId)

  consumeFreeTierTokens(userId, 1)
  assert.equal(getFreeTierAccess(userId).used, 1)

  createPromoCode({
    code: 'RESET1TOKEN',
    type: 'free_reset',
    maxUses: 1,
    expiresAt: null,
    createdBy: 'admin@example.com',
  })

  redeemPromoCode({
    userId,
    code: 'RESET1TOKEN',
  })

  const access = getFreeTierAccess(userId)
  assert.equal(access.used, 0)
  assert.equal(getActiveSubscription(userId), null)
})

test('cannot redeem free_reset promo while subscription is active, but can redeem once it expires', () => {
  const userId = 'user_with_sub'
  seedUser(userId)

  // User has an active subscription
  activateSubscription({
    userId,
    planKey: 'day1',
    source: 'admin',
  })
  assert.ok(getActiveSubscription(userId))

  createPromoCode({
    code: 'RESETWITHACTIVE',
    type: 'free_reset',
    maxUses: 1,
    expiresAt: null,
    createdBy: 'admin@example.com',
  })

  // 1. Attempting to redeem fails because subscription is active
  assert.throws(
    () => {
      redeemPromoCode({
        userId,
        code: 'RESETWITHACTIVE',
      })
    },
    /active subscription/,
  )

  // 2. Code usage count was NOT consumed
  const promoRow = db.prepare('SELECT used_count FROM promo_codes WHERE code = ?').get('RESETWITHACTIVE') as { used_count: number }
  assert.equal(promoRow.used_count, 0)

  // 3. User expires their subscription
  db.prepare(`UPDATE user_subscriptions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?`).run(userId)
  assert.equal(getActiveSubscription(userId), null)

  // User spends some free tokens
  consumeFreeTierTokens(userId, 300_000)
  assert.equal(getFreeTierAccess(userId).used, 300_000)

  // 4. Now that subscription has ended, the promo can be redeemed!
  const result = redeemPromoCode({
    userId,
    code: 'RESETWITHACTIVE',
  })
  assert.equal(result.ok, true)
  assert.equal(result.type, 'free_reset')

  // Daily free credits reset to 0
  assert.equal(getFreeTierAccess(userId).used, 0)
})
