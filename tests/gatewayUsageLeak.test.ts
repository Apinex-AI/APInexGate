import assert from 'node:assert/strict'
import test from 'node:test'
import { publicUsage } from '../server/gateway.ts'

test('upstream accounting fields never reach the customer', () => {
  // Upstream payloads can include vendor accounting next to OpenAI token counts.
  const usage = publicUsage(
    {
      prompt_tokens: 7567,
      completion_tokens: 4,
      total_tokens: 7571,
      kiro_credits: 0.10666495796019901,
      kiro_credit_unit: 'credit',
      cost: 0.0042,
    },
    0,
  ) as Record<string, unknown>

  assert.deepEqual(usage, {
    prompt_tokens: 7567,
    completion_tokens: 4,
    total_tokens: 7571,
  })
  for (const key of Object.keys(usage)) {
    assert.equal(/kiro|credit|cost/.test(key), false, `leaked field: ${key}`)
  }
})

test('standard token detail objects are preserved', () => {
  const usage = publicUsage(
    {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 64 },
      completion_tokens_details: { reasoning_tokens: 8 },
    },
    42,
  ) as Record<string, unknown>

  assert.deepEqual(usage.prompt_tokens_details, {})
  assert.deepEqual(usage.completion_tokens_details, { reasoning_tokens: 8 })
  assert.equal('cost_tokens' in usage, false)
})

test('cache accounting fields are stripped from usage details', () => {
  const usage = publicUsage(
    {
      prompt_tokens: 500,
      completion_tokens: 50,
      total_tokens: 550,
      prompt_tokens_details: { cached_tokens: 128, cache_write_tokens: 0, audio_tokens: 10 },
      input_tokens_details: { cached_tokens: 128 },
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 128,
    },
    100,
  ) as Record<string, unknown>

  // Cache keys are removed wherever they appear; non-cache detail keys survive.
  assert.deepEqual(usage.prompt_tokens_details, { audio_tokens: 10 })
  assert.deepEqual(usage.input_tokens_details, {})
  assert.equal('cache_creation_input_tokens' in usage, false)
  assert.equal('cache_read_input_tokens' in usage, false)
})

test('anthropic-style token names survive the whitelist', () => {
  const usage = publicUsage({ input_tokens: 10, output_tokens: 5, billing_tier: 'x' }, 7) as Record<
    string,
    unknown
  >

  assert.equal(usage.input_tokens, 10)
  assert.equal(usage.output_tokens, 5)
  assert.equal('billing_tier' in usage, false)
  assert.equal('cost_tokens' in usage, false)
})

test('non-object usage passes through untouched', () => {
  assert.equal(publicUsage(null, 5), null)
  assert.equal(publicUsage(undefined, 5), undefined)
})
