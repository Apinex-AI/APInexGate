import assert from 'node:assert/strict'
import test from 'node:test'
import { classify, resolveModelUsageWindow } from '../server/modelUsageStats.ts'

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

test('D30: classifies paid models with token_weight = 0 as paid, and free models as free', () => {
  // Paid model with tokenWeight = 0 and positive prices
  const paidCatalogInfo = {
    provider: 'Claude',
    tokenWeight: 0,
    name: 'Claude Sonnet 5.5',
    status: 'active',
    upstreamProvider: 'apinex',
    inputPriceMicros: 400_000,
    outputPriceMicros: 400_000,
  }
  assert.equal(classify('claude-sonnet-5.5', 'Claude', paidCatalogInfo), 'paid')

  // Paid GPT model with tokenWeight = 0
  const gptInfo = {
    provider: 'GPT',
    tokenWeight: 0,
    name: 'GPT 6.1 Sol',
    status: 'active',
    upstreamProvider: 'apinex',
    inputPriceMicros: 300_000,
    outputPriceMicros: 300_000,
  }
  assert.equal(classify('gpt-6.1-sol', 'GPT', gptInfo), 'paid')

  // Free model with provider = 'Free'
  const freeInfo = {
    provider: 'Free',
    tokenWeight: 3,
    name: 'GPT 6 Luna',
    status: 'active',
    upstreamProvider: 'apinex',
    inputPriceMicros: 0,
    outputPriceMicros: 0,
  }
  assert.equal(classify('free/gpt-6-luna', 'Free', freeInfo), 'free')

  // Free model with zero prices
  const zeroPriceInfo = {
    provider: 'Custom',
    tokenWeight: 1,
    name: 'Zero Price Model',
    status: 'active',
    upstreamProvider: 'apinex',
    inputPriceMicros: 0,
    outputPriceMicros: 0,
  }
  assert.equal(classify('zero-price', 'Custom', zeroPriceInfo), 'free')

  // Tool provider
  assert.equal(classify('web.search', 'web', undefined), 'tool')
})
