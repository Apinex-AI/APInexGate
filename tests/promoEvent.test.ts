import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { formatEventTokenLabel } from '../shared/billing.ts'

const dir = mkdtempSync(join(tmpdir(), 'gateway-promo-'))
process.env.DB_PATH = join(dir, 'test.sqlite')
process.env.PROMO_EVENT_COOLDOWN_MS = '120000'

const { db, id, nowIso } = await import('../server/db.ts')
const {
  applySettledPromoCost,
  getPublicPromoEvent,
  noteQualifyingTopup,
  promoBillingPlan,
  saveAdminPromoEvent,
} = await import('../server/promoEvents.ts')

function seedUser() {
  const userId = id('user')
  const when = nowIso()
  db.prepare(
    `INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
     VALUES (?, 'Promo', ?, 'default', 'active', 0, 0, 0, ?)`,
  ).run(userId, `${userId}@example.invalid`, when)
  return userId
}

function seedModel(modelId: string) {
  db.prepare(
    `INSERT INTO model_catalog
      (id, provider, name, context_window, input_price_micros, output_price_micros, status, tags_json, created_at, upstream_provider, token_weight)
     VALUES (?, 'Test', ?, '1M', 0, 0, 'active', '[]', ?, 'apinex', 1.2)`,
  ).run(modelId, modelId, nowIso())
}

function topup(userId: string, cents: number, createdAt: string, type = 'top_up') {
  db.prepare(
    `INSERT INTO balance_transactions (id, user_id, type, amount_cents, amount_tokens, note, status, created_at)
     VALUES (?, ?, ?, ?, 0, 'test', 'completed', ?)`,
  ).run(id('txn'), userId, type, cents, createdAt)
}

const start = new Date(Date.now() - 60_000).toISOString()
const end = new Date(Date.now() + 3_600_000).toISOString()

seedModel('kimi-k3')
seedModel('gemini-3.8-flash')

test('token labels keep round units and full uneven numbers', () => {
  assert.equal(formatEventTokenLabel(5_000_000_000), '5B')
  assert.equal(formatEventTokenLabel(1_000_000), '1M')
  assert.equal(formatEventTokenLabel(1_562_632), '1,562,632')
})

test('only an in-window balance top-up unlocks the discount', () => {
  saveAdminPromoEvent({
    startsAt: start,
    endsAt: end,
    tokenLimit: 5_000_000_000,
    tokensUsed: 0,
    minTopupUsd: 5,
    models: [
      { modelId: 'kimi-k3', discountPct: 90 },
      { modelId: 'gemini-3.8-flash', discountPct: 100 },
    ],
  })
  const userId = seedUser()
  topup(userId, 500, new Date(Date.now() - 86_400_000).toISOString())
  topup(userId, 500, new Date().toISOString(), 'adjustment')
  noteQualifyingTopup(userId)
  assert.equal(promoBillingPlan(userId, 'kimi-k3', 0.3).discountPct, 0)

  topup(userId, 200, new Date().toISOString())
  noteQualifyingTopup(userId)
  assert.equal(promoBillingPlan(userId, 'kimi-k3', 0.3).discountPct, 0)

  topup(userId, 300, new Date().toISOString())
  noteQualifyingTopup(userId)
  assert.equal(promoBillingPlan(userId, 'kimi-k3', 0.3).discountPct, 90)
  assert.equal(applySettledPromoCost(userId, 'kimi-k3', 1000, 335), 100)
  assert.equal(applySettledPromoCost(userId, 'gemini-3.8-flash', 1000, 335), 0)
  assert.equal(getPublicPromoEvent().tokensUsed, 670)

  const other = seedUser()
  assert.equal(applySettledPromoCost(other, 'kimi-k3', 1000), 1000)
})

test('pool exhaustion and the end time open a two-minute pause', () => {
  const userId = seedUser()
  topup(userId, 500, new Date().toISOString())
  noteQualifyingTopup(userId)

  saveAdminPromoEvent({
    startsAt: start,
    endsAt: end,
    tokenLimit: 1000,
    tokensUsed: 900,
    minTopupUsd: 5,
    models: [{ modelId: 'kimi-k3', discountPct: 90 }],
  })
  assert.equal(applySettledPromoCost(userId, 'kimi-k3', 1000), 100)
  const blocked = promoBillingPlan(userId, 'kimi-k3', 0.3)
  assert.match(blocked.block || '', /limited-time discount has ended/i)
  assert.match(blocked.block || '', /\$0\.30/)
  const paused = getPublicPromoEvent()
  assert.equal(paused.phase, 'cooldown')
  const left = Date.parse(paused.cooldownUntil || '') - Date.now()
  assert.ok(left > 110_000 && left <= 120_000)

  db.prepare(`UPDATE promo_events SET cooldown_until = ? WHERE id = 'current'`).run(new Date(Date.now() - 1000).toISOString())
  assert.equal(promoBillingPlan(userId, 'kimi-k3', 0.3).discountPct, 0)
  assert.equal(applySettledPromoCost(userId, 'kimi-k3', 1000), 1000)
  assert.equal(getPublicPromoEvent().phase, 'ended')
})

test('raising the minimum keeps people who already qualified', () => {
  saveAdminPromoEvent({
    startsAt: start,
    endsAt: end,
    tokenLimit: 5_000_000_000,
    tokensUsed: 0,
    minTopupUsd: 5,
    models: [{ modelId: 'kimi-k3', discountPct: 90 }],
  })
  const userId = seedUser()
  topup(userId, 500, new Date().toISOString())
  noteQualifyingTopup(userId)
  assert.equal(promoBillingPlan(userId, 'kimi-k3', 0.3).discountPct, 90)
  saveAdminPromoEvent({
    startsAt: start,
    endsAt: end,
    tokenLimit: 5_000_000_000,
    tokensUsed: 0,
    minTopupUsd: 10,
    models: [{ modelId: 'kimi-k3', discountPct: 90 }],
  })
  assert.equal(promoBillingPlan(userId, 'kimi-k3', 0.3).discountPct, 90)
  const late = seedUser()
  topup(late, 500, new Date().toISOString())
  noteQualifyingTopup(late)
  assert.equal(promoBillingPlan(late, 'kimi-k3', 0.3).discountPct, 0)
})

test('a future start shows upcoming and does not discount', () => {
  saveAdminPromoEvent({
    startsAt: new Date(Date.now() + 60_000).toISOString(),
    endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    tokenLimit: 2_000_000,
    tokensUsed: 0,
    minTopupUsd: 5,
    models: [{ modelId: 'kimi-k3', discountPct: 50 }],
  })
  const userId = seedUser()
  topup(userId, 500, new Date().toISOString())
  noteQualifyingTopup(userId)
  assert.equal(getPublicPromoEvent().phase, 'upcoming')
  assert.equal(applySettledPromoCost(userId, 'kimi-k3', 400), 400)
})
