import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbPath = join(
  tmpdir(),
  `gateway-sub-promo-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
)
mkdirSync(tmpdir(), { recursive: true })
process.env.DB_PATH = dbPath

const { db } = await import('../server/db.ts')
const {
  createPromoCode,
  listPromoCodes,
  redeemPromoCode,
} = await import('../server/promo.ts')
const {
  getActiveSubscription,
  getFreeTierAccess,
} = await import('../server/subscriptions.ts')

function seedUser(userId: string) {
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
     VALUES (?, ?, ?, 'free', 'active', 100, 4000000, 0, ?)`,
  ).run(userId, userId, `${userId}@example.invalid`, at)
}

test('creates and lists balance and subscription promo codes', () => {
  const balancePromo = createPromoCode({
    code: 'BALANCETEST1',
    type: 'balance',
    rewardUsd: 2.5,
    maxUses: 10,
    expiresAt: null,
    note: 'Test USD balance promo',
    createdBy: 'admin@example.com',
  })
  assert.equal(balancePromo.code, 'BALANCETEST1')
  assert.equal(balancePromo.type, 'balance')
  assert.equal(balancePromo.reward_cents, 250)

  const subPromo = createPromoCode({
    code: 'SUBPROMO3DAY',
    type: 'subscription',
    planKey: 'day1',
    maxUses: 5,
    expiresAt: null,
    note: 'Test 3 days sub promo',
    createdBy: 'admin@example.com',
  })
  assert.equal(subPromo.code, 'SUBPROMO3DAY')
  assert.equal(subPromo.type, 'subscription')
  assert.equal(subPromo.plan_key, 'day1')
  assert.equal(subPromo.plan_label, '3 days')
  assert.equal(subPromo.reward_cents, 0)

  const list = listPromoCodes()
  const foundSub = list.find((p) => p.code === 'SUBPROMO3DAY')
  assert.ok(foundSub)
  assert.equal(foundSub.type, 'subscription')
  assert.equal(foundSub.plan_key, 'day1')
  assert.equal(foundSub.plan_label, '3 days')
})

test('redeems subscription promo and activates subscription for user', () => {
  seedUser('user_sub_1')
  const beforeAccess = getFreeTierAccess('user_sub_1')
  assert.equal(beforeAccess.mode, 'free')

  const redeem = redeemPromoCode({
    userId: 'user_sub_1',
    code: 'SUBPROMO3DAY',
  })

  assert.equal(redeem.ok, true)
  assert.equal(redeem.type, 'subscription')
  assert.equal(redeem.code, 'SUBPROMO3DAY')
  assert.equal(redeem.planLabel, '3 days')
  assert.equal(redeem.extended, false)
  assert.ok(redeem.expiresAt)

  const sub = getActiveSubscription('user_sub_1')
  assert.ok(sub)
  assert.equal(sub.planKey, 'day1')
  assert.equal(sub.planLabel, '3 days')
  assert.equal(sub.tokenLimit, 500_000_000)

  const access = getFreeTierAccess('user_sub_1')
  assert.equal(access.allowed, true)
  assert.equal(access.mode, 'subscription')
  assert.equal(access.planLabel, '3 days')
})

test('redeeming second subscription promo extends existing active subscription', () => {
  // Create another promo code for 10 days
  createPromoCode({
    code: 'SUBPROMO10D',
    type: 'subscription',
    planKey: 'day7',
    maxUses: 10,
    expiresAt: null,
    note: '10 day sub',
    createdBy: 'admin@example.com',
  })

  const subBefore = getActiveSubscription('user_sub_1')
  assert.ok(subBefore)
  const prevExpiresMs = Date.parse(subBefore.expiresAt)
  const prevLimit = subBefore.tokenLimit

  const redeem2 = redeemPromoCode({
    userId: 'user_sub_1',
    code: 'SUBPROMO10D',
  })

  assert.equal(redeem2.ok, true)
  assert.equal(redeem2.type, 'subscription')
  assert.equal(redeem2.extended, true)

  const subAfter = getActiveSubscription('user_sub_1')
  assert.ok(subAfter)
  const nextExpiresMs = Date.parse(subAfter.expiresAt)

  // 10 days = 10 * 86400 * 1000 ms = 864_000_000 ms
  const diffMs = nextExpiresMs - prevExpiresMs
  const tenDaysMs = 10 * 24 * 60 * 60 * 1000
  assert.ok(Math.abs(diffMs - tenDaysMs) < 5000, `Expected ~10 days extension, got ${diffMs}`)

  // Token limit increased by the day7 pool (1.1B)
  assert.equal(subAfter.tokenLimit, prevLimit + 1_100_000_000)
})

test('cannot redeem the same promo code twice', () => {
  assert.throws(
    () => {
      redeemPromoCode({
        userId: 'user_sub_1',
        code: 'SUBPROMO3DAY',
      })
    },
    /already redeemed this promo code/,
  )
})

test('creates, validates and redeems custom subscription promo codes', () => {
  seedUser('user_custom_sub')

  // Validation: days < 1
  assert.throws(
    () => {
      createPromoCode({
        code: 'BADCUSTOMDAYS',
        type: 'subscription_custom',
        customDays: 0,
        customTokenLimit: 10_000_000,
        maxUses: 1,
        expiresAt: null,
        note: 'Bad days',
        createdBy: 'admin@example.com',
      })
    },
    /Subscription duration must be at least 1 day/,
  )

  // Validation: tokens < 1
  assert.throws(
    () => {
      createPromoCode({
        code: 'BADCUSTOMTOKENS',
        type: 'subscription_custom',
        customDays: 5,
        customTokenLimit: 0,
        maxUses: 1,
        expiresAt: null,
        note: 'Bad tokens',
        createdBy: 'admin@example.com',
      })
    },
    /Token limit must be at least 1 token/,
  )

  // Create valid custom subscription promo: 15 days, 45,000,000 tokens
  const customPromo = createPromoCode({
    code: 'APX-CUST-15D-45M',
    type: 'subscription_custom',
    customDays: 15,
    customTokenLimit: 45_000_000,
    maxUses: 5,
    expiresAt: null,
    note: 'Custom 15 days and 45M tokens',
    createdBy: 'admin@example.com',
  })

  assert.equal(customPromo.code, 'APX-CUST-15D-45M')
  assert.equal(customPromo.type, 'subscription_custom')
  assert.equal(customPromo.custom_days, 15)
  assert.equal(customPromo.custom_token_limit, 45_000_000)
  assert.equal(customPromo.plan_label, '15 days (45M)')

  // Listed properly
  const list = listPromoCodes()
  const found = list.find((p) => p.code === 'APX-CUST-15D-45M')
  assert.ok(found)
  assert.equal(found.type, 'subscription_custom')
  assert.equal(found.custom_days, 15)
  assert.equal(found.custom_token_limit, 45_000_000)

  // Redeem for user
  const beforeAccess = getFreeTierAccess('user_custom_sub')
  assert.equal(beforeAccess.mode, 'free')

  const redeem = redeemPromoCode({
    userId: 'user_custom_sub',
    code: 'APX-CUST-15D-45M',
  })

  assert.equal(redeem.ok, true)
  assert.equal(redeem.type, 'subscription_custom')
  assert.equal(redeem.tokens, 45_000_000)
  assert.equal(redeem.extended, false)

  const sub = getActiveSubscription('user_custom_sub')
  assert.ok(sub)
  assert.equal(sub.tokenLimit, 45_000_000)
  assert.equal(sub.planLabel, '15 days (45M)')

  const access = getFreeTierAccess('user_custom_sub')
  assert.equal(access.mode, 'subscription')
  assert.equal(access.limit, 45_000_000)
  assert.equal(access.remaining, 45_000_000)
})

test('limited subscription offer redeems a timed discount (% and $) and discounts /api/user/subscriptions plans', async () => {
  seedUser('user_offer')
  createPromoCode({
    code: 'APX-OFFR-20PC-24H',
    type: 'subscription_offer',
    discountMode: 'percent',
    discountPercent: 20,
    offerUnit: 'hours',
    offerAmount: 24,
    maxUses: 5,
    expiresAt: null,
    note: '20% for a day',
    createdBy: 'admin@example.invalid',
  })
  const redeem = redeemPromoCode({ userId: 'user_offer', code: 'APX-OFFR-20PC-24H' })
  assert.equal(redeem.type, 'subscription_offer')
  assert.match(redeem.planLabel ?? '', /20% off/)
  const { getActiveSubscriptionOffer, applyOfferCents } = await import('../server/subscriptionOffers.ts')
  const offer = getActiveSubscriptionOffer('user_offer')
  assert.ok(offer)
  assert.equal(offer.mode, 'percent')
  assert.equal(applyOfferCents(500, offer), 400) // $5 -> $4
  assert.equal(applyOfferCents(1000, offer), 800) // $10 -> $8
  assert.ok(Date.parse(offer.expiresAt) > Date.now())

  // Also test fixed USD ($ off) subscription_offer promo code
  seedUser('user_offer_usd')
  createPromoCode({
    code: 'APX-OFFR-3USD-2D',
    type: 'subscription_offer',
    discountMode: 'usd',
    discountUsd: 3.5,
    offerUnit: 'days',
    offerAmount: 2,
    maxUses: 5,
    expiresAt: null,
    note: '$3.50 off for 2 days',
    createdBy: 'admin@example.invalid',
  })
  const redeemUsd = redeemPromoCode({ userId: 'user_offer_usd', code: 'APX-OFFR-3USD-2D' })
  assert.equal(redeemUsd.type, 'subscription_offer')
  assert.match(redeemUsd.planLabel ?? '', /\$3\.50 off/)
  const offerUsd = getActiveSubscriptionOffer('user_offer_usd')
  assert.ok(offerUsd)
  assert.equal(offerUsd.mode, 'usd')
  assert.equal(offerUsd.value, 350)
  assert.equal(applyOfferCents(500, offerUsd), 150) // $5.00 - $3.50 = $1.50
  assert.equal(applyOfferCents(1000, offerUsd), 650) // $10.00 - $3.50 = $6.50
})

test('balance promo code credits positive amount_cents in balance_transactions and updates user wallet', () => {
  seedUser('user_bal_check')
  const before = db.prepare('SELECT balance_tokens FROM users WHERE id = ?').get('user_bal_check') as { balance_tokens: number }

  createPromoCode({
    code: 'BALPOSITIVE15',
    type: 'balance',
    rewardUsd: 15,
    maxUses: 2,
    expiresAt: null,
    note: '$15 balance',
    createdBy: 'admin@example.com',
  })

  const res = redeemPromoCode({ userId: 'user_bal_check', code: 'BALPOSITIVE15' })
  assert.equal(res.ok, true)
  assert.equal(res.type, 'balance')
  assert.equal(res.usd, 15)
  assert.equal(res.tokens, 15_000_000)

  const after = db.prepare('SELECT balance_tokens FROM users WHERE id = ?').get('user_bal_check') as { balance_tokens: number }
  assert.equal(after.balance_tokens, before.balance_tokens + 15_000_000)

  const tx = db
    .prepare("SELECT amount_cents, amount_tokens, type, status FROM balance_transactions WHERE user_id = ? AND type = 'promo_credit'")
    .get('user_bal_check') as { amount_cents: number; amount_tokens: number; type: string; status: string }
  assert.ok(tx)
  assert.equal(tx.amount_cents, 1500)
  assert.equal(tx.amount_tokens, 15_000_000)
  assert.equal(tx.status, 'completed')
})
