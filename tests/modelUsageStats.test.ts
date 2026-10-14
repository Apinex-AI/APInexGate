import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveModelUsageWindow } from '../server/modelUsageStats.ts'

test('accepts the supported windows', () => {
  assert.equal(resolveModelUsageWindow('24h'), '24h')
  assert.equal(resolveModelUsageWindow('7d'), '7d')
  assert.equal(resolveModelUsageWindow('30d'), '30d')
  assert.equal(resolveModelUsageWindow('all'), 'all')
})

test('falls back to 7d for unknown or missing values', () => {
  assert.equal(resolveModelUsageWindow(undefined), '7d')
  assert.equal(resolveModelUsageWindow(null), '7d')
  assert.equal(resolveModelUsageWindow(''), '7d')
  assert.equal(resolveModelUsageWindow('90d'), '7d')
  assert.equal(resolveModelUsageWindow('; DROP TABLE usage_events'), '7d')
})
