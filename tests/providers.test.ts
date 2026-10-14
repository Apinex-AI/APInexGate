import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeProviderName, PROVIDER_ORDER } from '../shared/providers.ts'
import { providerBrandIcon, providerSlug } from '../src/lib/providerStyle.ts'

const dbPath = join(tmpdir(), `gateway-providers-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`)
mkdirSync(tmpdir(), { recursive: true })
process.env.DB_PATH = dbPath

const { db } = await import('../server/db.ts')

const {
  familyFromUpstreamId,
  isSupportedGeminiModel,
  isSupportedGptModel,
  providerForTokenWeight,
  pickProviderSecrets,
  markProviderSecretFailed,
} = await import('../server/providerKeys.ts')

test('catalogs hide GPT versions below 5.6', () => {
  assert.equal(isSupportedGptModel('openai/gpt-5.5'), false)
  assert.equal(isSupportedGptModel('openai/gpt-5.6-luna'), true)
  assert.equal(isSupportedGptModel('openai/gpt-6.0'), true)
  assert.equal(isSupportedGptModel('anthropic/claude-sonnet-5'), true)
})

test('only Gemini 3.1 Pro and 3.7 Flash are catalog-supported', () => {
  assert.equal(isSupportedGeminiModel('gemini-3.1-pro'), true)
  assert.equal(isSupportedGeminiModel('google/gemini-3.7-flash'), true)
  assert.equal(isSupportedGeminiModel('gemini-3.1-flash-lite'), false)
  assert.equal(isSupportedGeminiModel('google/gemma-4-27b'), true)
})

test('provider pools use one key to exhaustion before advancing to the next key', () => {
  const provider = 'apinex'
  const base = Date.now()
  const add = (id: string, secret: string, priority: number, createdAt: string) => {
    db.prepare(
      `INSERT INTO provider_keys
        (id, provider, email, secret, secret_hint, balance_tokens, balance_usd_cents, status, priority, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'healthy', ?, ?)`,
    ).run(id, provider, `${id}@example.test`, secret, `${secret.slice(0, 8)}…`, priority, createdAt)
  }

  add('pool-first', 'pool-first-secret', 100, new Date(base).toISOString())
  add('pool-second', 'pool-second-secret', 100, new Date(base + 1).toISOString())
  add('pool-priority', 'pool-priority-secret', 50, new Date(base + 2).toISOString())

  assert.deepEqual(pickProviderSecrets(provider), [
    'pool-priority-secret',
    'pool-first-secret',
    'pool-second-secret',
  ])
})

test('an auth failure permanently excludes a key from its pool', () => {
  const keyId = 'apinex-auth-failed'
  const secret = 'apinex-auth-failed-secret'
  db.prepare(
    `INSERT INTO provider_keys
      (id, provider, email, secret, secret_hint, balance_tokens, balance_usd_cents, status, priority, created_at)
     VALUES (?, 'apinex', ?, ?, ?, 0, 0, 'pending', 1, ?)`,
  ).run(keyId, 'failed@example.test', secret, 'apx-au…', new Date().toISOString())

  markProviderSecretFailed(secret, 'HTTP 401', 401)

  assert.equal(
    (db.prepare(`SELECT status FROM provider_keys WHERE id = ?`).get(keyId) as { status: string }).status,
    'exhausted',
  )
  assert.equal(pickProviderSecrets('apinex').includes(secret), false)
})

test('an unexplained 403 does not exhaust a healthy pool key', () => {
  const keyId = 'apinex-temporary-403'
  const secret = 'apinex-temporary-403-secret'
  db.prepare(
    `INSERT INTO provider_keys
      (id, provider, email, secret, secret_hint, balance_tokens, balance_usd_cents, status, priority, created_at)
     VALUES (?, 'apinex', ?, ?, ?, 0, 500, 'healthy', 1, ?)`,
  ).run(keyId, 'temporary@example.test', secret, 'apx-te…', new Date().toISOString())

  markProviderSecretFailed(secret, 'HTTP 403', 403)

  assert.equal(
    (db.prepare(`SELECT status FROM provider_keys WHERE id = ?`).get(keyId) as { status: string }).status,
    'healthy',
  )
  assert.equal(pickProviderSecrets('apinex').includes(secret), true)
})

test('a temporary infrastructure 403 does not exhaust a valid key', () => {
  const keyId = 'apinex-timeout-403'
  const secret = 'apinex-timeout-403-secret'
  db.prepare(
    `INSERT INTO provider_keys
      (id, provider, email, secret, secret_hint, balance_tokens, balance_usd_cents, status, priority, created_at)
     VALUES (?, 'apinex', ?, ?, ?, 0, 0, 'active', 1, ?)`,
  ).run(keyId, 'temporary@example.test', secret, 'apx-to…', new Date().toISOString())

  markProviderSecretFailed(secret, 'upstream request timeout', 403)

  assert.equal(
    (db.prepare(`SELECT status FROM provider_keys WHERE id = ?`).get(keyId) as { status: string }).status,
    'active',
  )
  assert.equal(pickProviderSecrets('apinex').includes(secret), true)
})

test('an explicit credential 403 exhausts the key', () => {
  const keyId = 'apinex-invalid-403'
  const secret = 'apinex-invalid-403-secret'
  db.prepare(
    `INSERT INTO provider_keys
      (id, provider, email, secret, secret_hint, balance_tokens, balance_usd_cents, status, priority, created_at)
     VALUES (?, 'apinex', ?, ?, ?, 0, 500, 'healthy', 1, ?)`,
  ).run(keyId, 'invalid@example.test', secret, 'apx-in…', new Date().toISOString())

  markProviderSecretFailed(secret, 'Invalid API key', 403)

  assert.equal(
    (db.prepare(`SELECT status FROM provider_keys WHERE id = ?`).get(keyId) as { status: string }).status,
    'exhausted',
  )
})

test('Free is a first-class provider and keeps its own slug/logo', () => {
  assert.equal(PROVIDER_ORDER[0], 'Free')
  assert.equal(normalizeProviderName('Free'), 'Free')
  assert.equal(normalizeProviderName('free'), 'Free')
  assert.equal(providerSlug('Free'), 'free')
  assert.equal(providerBrandIcon('Free'), '/brand/mark.png')
})

test('Tencent and Muse are supported paid display families with icons', () => {
  assert.equal(PROVIDER_ORDER.includes('Tencent'), true)
  assert.equal(PROVIDER_ORDER.includes('Muse'), true)
  assert.equal(normalizeProviderName('Tencent'), 'Tencent')
  assert.equal(providerSlug('Tencent'), 'tencent')
  assert.equal(providerBrandIcon('Tencent'), '/brand/tencent.svg')
  assert.equal(normalizeProviderName('Muse'), 'Muse')
  assert.equal(providerSlug('Muse'), 'muse')
  assert.equal(providerBrandIcon('Muse'), '/brand/muse.svg')
})

test('weight 0 maps to Free and raising the price restores family', () => {
  assert.equal(familyFromUpstreamId('deepseek-v4-flash'), 'DeepSeek')
  assert.equal(familyFromUpstreamId('kimi-k3'), 'Kimi')
  assert.equal(providerForTokenWeight(0, 'deepseek-v4-flash', 'DeepSeek'), 'Free')
  assert.equal(providerForTokenWeight(0.3, 'deepseek-v4-flash', 'Free'), 'DeepSeek')
  assert.equal(providerForTokenWeight(1, 'gpt-5.6', 'Free'), 'GPT')
})
