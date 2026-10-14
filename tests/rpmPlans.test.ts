import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../server/db.js'
import {
  creditRpmCryptoOrder,
  getAccountRpm,
  getRpmCatalog,
  saveRpmCatalog,
  setUserRpmGrant,
  upgradeUserRpm,
} from '../server/rpmPlans.js'

function seedUser(id: string, rpmPlan = 'free') {
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id)
  db.prepare(`DELETE FROM rpm_grants WHERE user_id = ?`).run(id)
  db.prepare(`DELETE FROM rpm_payments WHERE user_id = ?`).run(id)
  db.prepare(
    `INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, rpm_plan, created_at)
     VALUES (?, ?, ?, 'free', 'active', 0, 0, 0, ?, datetime('now'))`,
  ).run(id, id, `${id}@example.invalid`, rpmPlan)
}

test('rpm catalog has 4 plans by default and saves edits', () => {
  const catalog = getRpmCatalog()
  assert.equal(catalog.length, 4)
  const free = catalog.find((p) => p.key === 'free')
  const standard = catalog.find((p) => p.key === 'standard')
  const high = catalog.find((p) => p.key === 'high')
  const custom = catalog.find((p) => p.key === 'custom')
  assert.ok(free && standard && high && custom)
  assert.equal(free.rpm, 5)
  assert.equal(free.priceCents, 0)
  assert.equal(custom.custom, true)

  const updated = saveRpmCatalog([
    { key: 'standard', rpm: 35, priceCents: 1200 },
    { key: 'high', rpm: 75, priceCents: 2400 },
  ])
  const newStandard = updated.find((p) => p.key === 'standard')
  const newHigh = updated.find((p) => p.key === 'high')
  assert.equal(newStandard?.rpm, 35)
  assert.equal(newStandard?.priceCents, 1200)
  assert.equal(newHigh?.rpm, 75)
  assert.equal(newHigh?.priceCents, 2400)

  // Restore standard test defaults
  saveRpmCatalog([
    { key: 'standard', rpm: 30, priceCents: 1000 },
    { key: 'high', rpm: 60, priceCents: 2000 },
  ])
})

test('user starts on free RPM, upgrades via IPN credit, and can receive custom grant', () => {
  const userId = 'user_rpm_test'
  seedUser(userId)

  const initial = getAccountRpm(userId)
  assert.equal(initial.rpm, 5)
  assert.equal(initial.planKey, 'free')
  assert.equal(initial.source, 'free')

  // Simulate payment created
  const orderId = 'rpm_order_123'
  db.prepare(
    `INSERT INTO rpm_payments
      (id, user_id, plan_key, rpm, amount_cents, status, order_id, created_at, updated_at)
     VALUES ('rpmpay_1', ?, 'standard', 30, 1000, 'waiting', ?, datetime('now'), datetime('now'))`,
  ).run(userId, orderId)

  // Credit payment
  const res = creditRpmCryptoOrder(orderId, 'np_tx_999')
  assert.ok(res && res.ok && !res.already)
  assert.equal(res.rpm, 30)

  const upgraded = getAccountRpm(userId)
  assert.equal(upgraded.rpm, 30)
  assert.equal(upgraded.planKey, 'standard')
  assert.equal(upgraded.source, 'plan')
  assert.equal(upgraded.termLabel, '30 Days')
  assert.ok(upgraded.expiresAt)
  const expiresMs = Date.parse(upgraded.expiresAt!)
  assert.ok(expiresMs > Date.now() + 29 * 24 * 60 * 60 * 1000)
  assert.ok(expiresMs < Date.now() + 31 * 24 * 60 * 60 * 1000)

  // Support grant overrides plan
  setUserRpmGrant(userId, 150, 'VIP support deal')
  const custom = getAccountRpm(userId)
  assert.equal(custom.rpm, 150)
  assert.equal(custom.source, 'grant')
  assert.equal(custom.termLabel, 'Custom')

  // Clearing custom grant falls back to purchased plan
  setUserRpmGrant(userId, null)
  const restored = getAccountRpm(userId)
  assert.equal(restored.rpm, 30)
  assert.equal(restored.source, 'plan')
})

test('upgradeUserRpm upgrades user to 30 RPM and 60 RPM with 30-day expiration', () => {
  const userId = 'user_rpm_upgrade_test'
  seedUser(userId)

  const upgraded30 = upgradeUserRpm(userId, { rpm: 30, days: 30, paymentId: 'card_test_30' })
  assert.equal(upgraded30.rpm, 30)
  assert.equal(upgraded30.planKey, 'standard')

  const state30 = getAccountRpm(userId)
  assert.equal(state30.rpm, 30)
  assert.equal(state30.planKey, 'standard')
  assert.equal(state30.source, 'plan')

  const upgraded60 = upgradeUserRpm(userId, { rpm: 60, days: 30, paymentId: 'card_test_60' })
  assert.equal(upgraded60.rpm, 60)
  assert.equal(upgraded60.planKey, 'high')

  const state60 = getAccountRpm(userId)
  assert.equal(state60.rpm, 60)
  assert.equal(state60.planKey, 'high')
  assert.equal(state60.source, 'plan')
})


