import assert from 'node:assert/strict'
import test from 'node:test'
import { consumeRateLimit, rateLimitKey } from '../server/rateLimit.ts'

test('rateLimitKey joins stable parts', () => {
  assert.equal(rateLimitKey(['a', 'b', null, '']), 'a:b:unknown:unknown')
})

test('consumeRateLimit enforces fixed window', () => {
  const key = `test-${Date.now()}-${Math.random()}`
  const first = consumeRateLimit(key, 2, 60_000)
  const second = consumeRateLimit(key, 2, 60_000)
  const third = consumeRateLimit(key, 2, 60_000)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(third.ok, false)
  if (!third.ok) {
    assert.ok(third.retryAfterSec >= 1)
  }
})
