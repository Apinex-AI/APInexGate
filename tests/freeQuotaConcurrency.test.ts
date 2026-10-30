import assert from 'node:assert/strict'
import test from 'node:test'
import { db, id, nowIso, setSetting } from '../server/db.js'
import {
  getFreeTierAccess,
  resetFreeTierDailyUsage,
  tryReserveFreeTierTokens,
  settleFreeTierReservation,
  releaseFreeTierReservation,
} from '../server/subscriptions.js'

test('atomic free quota reservation blocks concurrent race condition overrun (H-04)', async () => {
  const userId = `u_race_${id('test')}`
  const now = nowIso()

  // 1. Create a test user with a 10,000 free-tier daily limit
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
    VALUES (?, 'Race Tester', ?, 'free', 'active', 0, 0, 0, ?)
  `).run(userId, `${userId}@example.invalid`, now)

  // Explicitly configure 10,000 daily free tokens
  setSetting('subscription_settings', JSON.stringify({
    freeDailyTokens: 10_000,
    plans: [],
  }))

  resetFreeTierDailyUsage(userId)

  const initialAccess = getFreeTierAccess(userId)
  assert.equal(initialAccess.limit, 10_000)
  assert.equal(initialAccess.remaining, 10_000)

  // 2. Simulate 200 concurrent requests (the exact scenario reported in H-04)
  // Each asking to reserve 2,400 tokens: total attempted 200 * 2,400 = 480,000 tokens!
  // In the researcher's unpatched run, 200 requests consumed 453,600 tokens against a 10,000 allowance.
  // With atomic quota reservation, exactly 4 requests fit (4 * 2400 = 9600 <= 10000).
  // The remaining 196 requests MUST be rejected immediately!
  const concurrentCount = 200
  const requestTokens = 2_400

  const results = await Promise.all(
    Array.from({ length: concurrentCount }, async () => {
      return tryReserveFreeTierTokens(userId, requestTokens)
    }),
  )

  const passed = results.filter((r) => r.ok)
  const rejected = results.filter((r) => !r.ok)

  assert.equal(passed.length, 4, `Expected exactly 4 requests to pass, but got ${passed.length}`)
  assert.equal(rejected.length, 196, `Expected 196 requests to be rejected, but got ${rejected.length}`)

  for (const r of rejected) {
    if (!r.ok) {
      assert.ok(r.error.includes('Daily free allowance would be exceeded'))
    }
  }

  // Check state: 9,600 reserved, 0 used, remaining 400
  const midAccess = getFreeTierAccess(userId)
  assert.equal(midAccess.used, 0)
  assert.equal(midAccess.remaining, 400)
  assert.equal(midAccess.allowed, true) // 400 remaining > 0

  // 3. Settle the 4 successful requests with actual usage of 1,000 tokens each
  for (const p of passed) {
    if (p.ok) {
      settleFreeTierReservation({
        userId,
        holdType: p.holdType,
        targetId: p.targetId,
        periodKey: p.periodKey,
        reservedTokens: p.reservedTokens,
        actualTokens: 1_000,
      })
    }
  }

  // Now: 4,000 used, 0 reserved, remaining 6,000
  const finalAccess = getFreeTierAccess(userId)
  assert.equal(finalAccess.used, 4_000)
  assert.equal(finalAccess.remaining, 6_000)
  assert.equal(finalAccess.allowed, true)

  // 4. Try reserving 7,000 tokens: must fail because only 6,000 remaining
  const failResult = tryReserveFreeTierTokens(userId, 7_000)
  assert.equal(failResult.ok, false)

  // 5. Try reserving 5,000 tokens: succeeds
  const okResult = tryReserveFreeTierTokens(userId, 5_000)
  assert.equal(okResult.ok, true)

  // Release the 5,000 hold: returns remaining back to 6,000
  if (okResult.ok) {
    releaseFreeTierReservation({
      userId,
      holdType: okResult.holdType,
      targetId: okResult.targetId,
      periodKey: okResult.periodKey,
      reservedTokens: okResult.reservedTokens,
    })
  }

  const restoredAccess = getFreeTierAccess(userId)
  assert.equal(restoredAccess.remaining, 6_000)
})
