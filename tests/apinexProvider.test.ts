import assert from 'node:assert/strict'
import test from 'node:test'

process.env.DB_PATH = ':memory:'

const {
  isUpstreamProvider,
  UPSTREAM_PROVIDERS,
  UPSTREAM_PROVIDER_LABELS,
} = await import('../shared/providers.ts')
const {
  APINEX_BASE_URL,
  createProviderKey,
  deleteProviderKey,
} = await import('../server/providerKeys.ts')
const { buildUpstreamRequestHeaders } = await import('../server/gateway.ts')
const { db } = await import('../server/db.ts')

test('buildUpstreamRequestHeaders enforces src: gate and prevents client override', () => {
  const headers = buildUpstreamRequestHeaders('sk-apx-secret', {
    src: 'spoofed',
    SRC: 'spoofed-upper',
    'X-Custom': 'allowed',
  })
  assert.equal(headers.src, 'gate')
  assert.equal('SRC' in headers, false)
  assert.equal(headers.Authorization, 'Bearer sk-apx-secret')
  assert.equal(headers['X-Custom'], 'allowed')
})

test('APInex provider is the primary upstream provider', () => {
  assert.equal(isUpstreamProvider('apinex'), true)
  assert.equal(UPSTREAM_PROVIDERS[0], 'apinex')
  assert.equal(UPSTREAM_PROVIDER_LABELS.apinex, 'APInex')
  assert.equal(APINEX_BASE_URL, 'https://api.apinex.bond/v1')
})

test('enforces strict lock of at most 1 APInex provider key', () => {
  // Clear any existing keys for clean test
  db.exec('DELETE FROM provider_keys')

  const key1 = createProviderKey({
    provider: 'apinex',
    email: 'admin@apinex.bond',
    secret: 'sk-apinex-test-key-1',
  })
  assert.ok(key1)

  // Adding second key should throw error due to 1-key limit lock
  assert.throws(
    () => {
      createProviderKey({
        provider: 'apinex',
        email: 'admin2@apinex.bond',
        secret: 'sk-apinex-test-key-2',
      })
    },
    /Only 1 APInex provider key is allowed/,
  )

  // Cleaning up
  deleteProviderKey(key1)
})
