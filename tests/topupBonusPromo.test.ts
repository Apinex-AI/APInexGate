import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbPath = join(
  tmpdir(),
  `gateway-topup-bonus-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
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
  getActivePromoBonus,
  getPromoBonusPct,
  applyCombinedTopupBonus,
  applyCombinedSubscriptionBonus,
} = await import('../server/promoBonus.ts')
const {
  activateSubscription,
  getActiveSubscription,
} = await import('../server/subscriptions.ts')

function seedUser(userId: string) {
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
     VALUES (?, ?, ?, 'free', 'active', 100, 20000000, 0, ?)`,
  ).run(userId, userId, `${userId}@example.invalid`, at)
}

test('creates and validates top up bonus promo codes for both, subscription, and topup', () => {
  const bothPromo = createPromoCode({
    code: 'BONUSBOTH20',
    type: 'topup_bonus',
    bonusTarget: 'both',
    bonusPercent: 20,
    bonusDurationUnit: 'hours',
    bonusDurationValue: 2,
    maxUses: 10,
    expiresAt: null,
    note: '+20% on both topup and subs for 2 hours',
    createdBy: 'admin@example.com',
  })
  assert.equal(bothPromo.code, 'BONUSBOTH20')
  assert.equal(bothPromo.type, 'topup_bonus')
  assert.equal(bothPromo.bonus_target, 'both')
  assert.equal(bothPromo.bonus_percent, 20)
  assert.equal(bothPromo.bonus_duration_unit, 'hours')
  assert.equal(bothPromo.bonus_duration_value, 2)
  assert.match(bothPromo.plan_label ?? '', /\+20%.*Top up & Subs.*2 hours/)

  const topupPromo = createPromoCode({
    code: 'BONUSTOPUP15',
    type: 'topup_bonus',
    bonusTarget: 'topup',
    bonusPercent: 15,
    bonusDurationUnit: 'minutes',
    bonusDurationValue: 30,
    maxUses: 5,
    expiresAt: null,
    note: '+15% topup only for 30 minutes',
    createdBy: 'admin@example.com',
  })
  assert.equal(topupPromo.type, 'topup_bonus')
  assert.equal(topupPromo.bonus_target, 'topup')
  assert.equal(topupPromo.bonus_percent, 15)
  assert.equal(topupPromo.bonus_duration_unit, 'minutes')
  assert.equal(topupPromo.bonus_duration_value, 30)

  const subsPromo = createPromoCode({
    code: 'BONUSSUBS25',
    type: 'topup_bonus',
    bonusTarget: 'subscription',
    bonusPercent: 25,
    bonusDurationUnit: 'hours',
    bonusDurationValue: 24,
    maxUses: 5,
    expiresAt: null,
    note: '+25% subs only for 24h',
    createdBy: 'admin@example.com',
  })
  assert.equal(subsPromo.type, 'topup_bonus')
  assert.equal(subsPromo.bonus_target, 'subscription')
  assert.equal(subsPromo.bonus_percent, 25)

  const list = listPromoCodes()
  assert.ok(list.find((p) => p.code === 'BONUSBOTH20'))
  assert.ok(list.find((p) => p.code === 'BONUSTOPUP15'))
  assert.ok(list.find((p) => p.code === 'BONUSSUBS25'))
})

test('redeems top up bonus promo and activates timed bonus for user', () => {
  seedUser('user_bonus_1')

  const redeem = redeemPromoCode({
    userId: 'user_bonus_1',
    code: 'BONUSBOTH20',
  })

  assert.equal(redeem.ok, true)
  assert.equal(redeem.type, 'topup_bonus')
  assert.equal(redeem.bonusPercent, 20)
  assert.equal(redeem.bonusTarget, 'both')
  assert.ok(redeem.expiresAt)

  const active = getActivePromoBonus('user_bonus_1')
  assert.ok(active)
  assert.equal(active.bonusPercent, 20)
  assert.equal(active.target, 'both')

  assert.equal(getPromoBonusPct('user_bonus_1', 'topup'), 20)
  assert.equal(getPromoBonusPct('user_bonus_1', 'subscription'), 20)
})

test('topup bonus calculation on $5 gives $6 worth of wallet units (+20%)', () => {
  // $5 = 5,000,000 wallet units. +20% = 1,000,000 bonus units. Total = $6.
  const baseTokens = 5_000_000
  const topupResult = applyCombinedTopupBonus('user_bonus_1', baseTokens)

  assert.equal(topupResult.baseTokens, 5_000_000)
  assert.equal(topupResult.bonusTokens, 1_000_000)
  assert.equal(topupResult.tokens, 6_000_000)
  assert.equal(topupResult.promoBonusPct, 20)
  assert.equal(topupResult.totalBonusPct, 20)
})

test('subscription calculation with +20% promo gives 600M tokens on 500M base', () => {
  seedUser('user_stacked')

  // Redeem +20% bonus promo
  createPromoCode({
    code: 'BONUSSTACK20',
    type: 'topup_bonus',
    bonusTarget: 'both',
    bonusPercent: 20,
    bonusDurationUnit: 'hours',
    bonusDurationValue: 2,
    maxUses: 10,
    expiresAt: null,
    note: '+20% promo',
    createdBy: 'admin@example.com',
  })
  redeemPromoCode({
    userId: 'user_stacked',
    code: 'BONUSSTACK20',
  })

  // Subscription plan with 500,000,000 tokens base
  const baseTokens = 500_000_000
  const subResult = applyCombinedSubscriptionBonus('user_stacked', baseTokens)

  assert.equal(subResult.baseTokens, 500_000_000)
  assert.equal(subResult.promoBonusPct, 20)
  assert.equal(subResult.totalBonusPct, 20)
  assert.equal(subResult.bonusTokens, 100_000_000)
  assert.equal(subResult.tokens, 600_000_000)

  const activated = activateSubscription({
    userId: 'user_stacked',
    planKey: 'day10',
    planLabel: '10 days',
    grantedDays: 10,
    grantedTokenLimit: 500_000_000,
    source: 'purchase',
    priceCents: 500,
  })
  assert.equal(activated.subscription.tokenLimit, 600_000_000)

  // Active subscription holds the 600M tokens
  const sub = getActiveSubscription('user_stacked')
  assert.ok(sub)
  assert.equal(sub.tokenLimit, 600_000_000)
})

test('a subscription token promo credits the exact amount and ignores a checkout bonus', () => {
  seedUser('user_exact_grant')
  redeemPromoCode({
    userId: 'user_exact_grant',
    code: 'BONUSSTACK20',
  })
  assert.equal(getPromoBonusPct('user_exact_grant', 'subscription'), 20)

  const promo = createPromoCode({
    code: 'EXACT1000001',
    type: 'subscription_custom',
    customDays: 30,
    customTokenLimit: 1_000_001,
    maxUses: 1,
    expiresAt: null,
    note: 'exact grant',
    createdBy: 'admin@example.com',
  })
  assert.equal(promo.custom_token_limit, 1_000_001)

  const redeemed = redeemPromoCode({
    userId: 'user_exact_grant',
    code: 'EXACT1000001',
  })
  assert.equal(redeemed.ok, true)
  assert.equal(redeemed.tokens, 1_000_001)

  const granted = getActiveSubscription('user_exact_grant')
  assert.ok(granted)
  assert.equal(granted.tokenLimit, 1_000_001)
})

test('target-specific bonus: only applies to selected context', () => {
  seedUser('user_topup_only')
  seedUser('user_subs_only')

  createPromoCode({
    code: 'TARGETTOPUP30',
    type: 'topup_bonus',
    bonusTarget: 'topup',
    bonusPercent: 30,
    bonusDurationUnit: 'hours',
    bonusDurationValue: 1,
    maxUses: 5,
    expiresAt: null,
    note: '',
    createdBy: 'admin@example.com',
  })
  redeemPromoCode({ userId: 'user_topup_only', code: 'TARGETTOPUP30' })

  assert.equal(getPromoBonusPct('user_topup_only', 'topup'), 30)
  assert.equal(getPromoBonusPct('user_topup_only', 'subscription'), 0)

  createPromoCode({
    code: 'TARGETSUBS30',
    type: 'topup_bonus',
    bonusTarget: 'subscription',
    bonusPercent: 30,
    bonusDurationUnit: 'hours',
    bonusDurationValue: 1,
    maxUses: 5,
    expiresAt: null,
    note: '',
    createdBy: 'admin@example.com',
  })
  redeemPromoCode({ userId: 'user_subs_only', code: 'TARGETSUBS30' })

  assert.equal(getPromoBonusPct('user_subs_only', 'topup'), 0)
  assert.equal(getPromoBonusPct('user_subs_only', 'subscription'), 30)
})

test('cannot redeem the same promo code twice', () => {
  assert.throws(
    () => {
      redeemPromoCode({
        userId: 'user_bonus_1',
        code: 'BONUSBOTH20',
      })
    },
    /already redeemed/,
  )
})
