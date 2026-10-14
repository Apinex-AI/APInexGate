import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clientSafeUpstreamError,
  isOutputLimitCompatibilityError,
  normalizeModelOutputLimits,
  isReasoningExhaustedResponse,
  raiseReasoningOutputLimit,
  removeOutputLimitsForFreeRetry,
  validateModelInputLimits,
  validateModelOutputLimits,
} from '../server/modelOutputLimits.ts'

test('free Luna uses its native 128K Chat Completions output budget', () => {
  const payload: Record<string, unknown> = {
    model: 'cx/gpt-5.6-luna',
    max_tokens: 512,
    max_output_tokens: 256,
    max_completion_tokens: 128,
    temperature: 0,
  }

  normalizeModelOutputLimits(
    payload,
    ['free/gpt-5.6-luna', 'cx/gpt-5.6-luna'],
    'chat/completions',
  )

  assert.deepEqual(payload, {
    model: 'cx/gpt-5.6-luna',
    max_tokens: 128_000,
    temperature: 0,
  })
})

test('free Luna uses the Responses max_output_tokens field', () => {
  const payload: Record<string, unknown> = {
    max_tokens: 4096,
    max_output_tokens: 1024,
    max_completion_tokens: 128,
    stream: true,
  }

  normalizeModelOutputLimits(payload, ['free/gpt-5.6-luna'], 'responses')

  assert.deepEqual(payload, { max_output_tokens: 128_000, stream: true })
})

test('paid Luna also uses its native output budget while other models retain caller limits', () => {
  const paidLuna = { max_tokens: 512, max_completion_tokens: 128 }
  const other = { max_output_tokens: 1 }

  normalizeModelOutputLimits(paidLuna, ['gpt/5.6-luna', 'cx/gpt-5.6-luna'], 'chat/completions')
  normalizeModelOutputLimits(other, ['free/gpt-5.6-terra'], 'responses')

  assert.deepEqual(paidLuna, { max_tokens: 128_000 })
  assert.deepEqual(other, { max_output_tokens: 1 })
})

test('GLM Flash reserves enough output for visible text after reasoning', () => {
  const payload = { max_tokens: 1, max_output_tokens: 2, max_completion_tokens: 128 }

  normalizeModelOutputLimits(payload, ['free/glm-5.3-flash', 'zai/glm-5.3-flash'], 'chat/completions')

  assert.deepEqual(payload, { max_tokens: 1024, max_output_tokens: 1024, max_completion_tokens: 1024 })
})

test('detects and raises a reasoning-exhausted empty completion', () => {
  const data = {
    warnings: [{ code: 'reasoning_exhausted' }],
    choices: [{ finish_reason: 'length', message: { content: null } }],
  }
  assert.equal(isReasoningExhaustedResponse(data), true)

  const payload: Record<string, unknown> = { max_tokens: 256 }
  assert.equal(raiseReasoningOutputLimit(payload), true)
  assert.equal(payload.max_tokens, 2048)
})

test('rejects output budgets above the selected model limit', () => {
  assert.equal(
    validateModelOutputLimits({ max_tokens: 2_000_000 }, ['free/glm-5.3-flash', 'zai/glm-5.3-flash']),
    'max_tokens=2000000 exceeds this model\'s maximum output limit of 1048576. Request fewer output tokens.',
  )
  assert.equal(
    validateModelOutputLimits({ max_output_tokens: 393_217 }, ['free/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro-0813']),
    'max_output_tokens=393217 exceeds this model\'s maximum output limit of 393216. Request fewer output tokens.',
  )
  assert.equal(validateModelOutputLimits({ max_completion_tokens: 393_216 }, ['free/deepseek-v4-pro-0813']), null)
  assert.equal(validateModelOutputLimits({ max_tokens: 1_048_576 }, ['free/glm-5.3-flash']), null)
})

test('rejects overly large Luna input locally', () => {
  const tooLarge = { messages: [{ role: 'user', content: 'x'.repeat(3_688_001) }] }
  assert.equal(
    validateModelInputLimits(tooLarge, ['free/gpt-5.6-luna', 'openai/gpt-5.6-luna']),
    'The request is too large for this model. Shorten the conversation to stay within its 900,000-token input limit.',
  )
  assert.equal(
    validateModelInputLimits({ messages: [{ role: 'user', content: 'x'.repeat(4_000_001) }] }, ['free/glm-5.3-flash']),
    'The request is too large for this model. Shorten the conversation to stay within its 1,000,000-token input limit.',
  )
  assert.equal(validateModelInputLimits({ messages: [{ role: 'user', content: 'short' }] }, ['free/glm-5.3-flash']), null)
})

test('sanitizes upstream validation errors for clients', () => {
  assert.equal(
    clientSafeUpstreamError(400, 'ContextWindowExceededError: Input tokens exceed the configured limit'),
    'The request is too large for this model. Shorten the conversation or reduce max_tokens, then retry.',
  )
  assert.equal(
    clientSafeUpstreamError(400, 'OpenAIException: max_tokens=2000000 cannot be greater'),
    'The requested output token limit is not supported by this model. Reduce max_tokens and retry.',
  )
  assert.equal(
    clientSafeUpstreamError(429, '您已达到总请求数限制：1分钟内最多请求10次'),
    'The model is temporarily unavailable. Please try again later.',
  )
  assert.equal(
    clientSafeUpstreamError(503, 'No available channel for model oc/muse-spark-1.3-contributor under group Free (distributor)'),
    'The model is temporarily unavailable. Please try again later.',
  )
  assert.equal(
    clientSafeUpstreamError(500, 'Internal upstream details'),
    'The model is temporarily unavailable. Please try again later.',
  )
  assert.equal(
    clientSafeUpstreamError(502, 'Google API error: {"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}'),
    'The model is temporarily unavailable. Please try again later.',
  )
})

test('recognizes only the specific upstream output-limit HTTP 400', () => {
  const message =
    'Could not finish the message because max_tokens or model output limit was reached. Please try again with higher max_tokens.'

  assert.equal(isOutputLimitCompatibilityError(400, message), true)
  assert.equal(isOutputLimitCompatibilityError(429, message), false)
  assert.equal(isOutputLimitCompatibilityError(400, 'Invalid max_tokens value'), false)
})

test('fallback removes every output cap for other free models and only once', () => {
  const payload: Record<string, unknown> = {
    max_tokens: 128,
    max_output_tokens: 512,
    max_completion_tokens: 4096,
    temperature: 0,
  }

  assert.equal(removeOutputLimitsForFreeRetry(payload, true), true)
  assert.deepEqual(payload, { temperature: 0 })
  assert.equal(removeOutputLimitsForFreeRetry(payload, true), false)
})

test('fallback never removes a paid model pre-authorization cap', () => {
  const payload = { max_tokens: 128 }

  assert.equal(removeOutputLimitsForFreeRetry(payload, false), false)
  assert.deepEqual(payload, { max_tokens: 128 })
})
