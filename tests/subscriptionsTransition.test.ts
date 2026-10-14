import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../server/db.js'
import {
  activateSubscription,
  consumeFreeTierTokens,
  expireDueSubscriptions,
  getFreeTierAccess,
  updateSubscriptionSettings,
} from '../server/subscriptions.js'

function seedUser(id: string) {
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id)
  db.prepare(`DELETE FROM user_subscriptions WHERE user_id = ?`).run(id)
  db.prepare(`DELETE FROM free_tier_usage WHERE user_id = ?`).run(id)
  db.prepare(
    `INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
     VALUES (?, ?, ?, 'free', 'active', 0, 0, 0, datetime('now'))`,
  ).run(id, id, `${id}@example.invalid`)
}

test('a subscription replaces the daily bucket until it expires, then the daily allowance returns', () => {
  const userId = 'user_sub_transition'
  seedUser(userId)
  updateSubscriptionSettings({ freeDailyTokens: 10_000_000 })

  const initial = getFreeTierAccess(userId)
  assert.equal(initial.mode, 'free')
  assert.equal(initial.remaining, 10_000_000)

  activateSubscription({
    userId,
    planKey: 'day7',
    source: 'purchase',
    priceCents: 700,
  })

  const active = getFreeTierAccess(userId)
  assert.equal(active.mode, 'subscription')
  assert.equal(active.allowed, true)
  assert.ok((active.remaining ?? 0) > 0)
  assert.ok(active.expiresAt)

  consumeFreeTierTokens(userId, active.limit ?? 0)
  const spent = getFreeTierAccess(userId)
  assert.equal(spent.mode, 'subscription')
  assert.equal(spent.allowed, false)
  assert.equal(spent.remaining, 0)

  db.prepare(`UPDATE user_subscriptions SET expires_at = ? WHERE user_id = ?`).run(
    new Date(Date.now() - 1000).toISOString(),
    userId,
  )
  expireDueSubscriptions()

  const afterExpiry = getFreeTierAccess(userId)
  assert.equal(afterExpiry.mode, 'free')
  assert.equal(afterExpiry.allowed, true)
  assert.equal(afterExpiry.limit, 10_000_000)
  assert.equal(afterExpiry.used, 0)
})
