import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const dbPath = join(tmpdir(), `gateway-provider-proxy-test-${stamp}.sqlite`)
const proxyPath = join(tmpdir(), `gateway-provider-proxy-test-${stamp}.txt`)

mkdirSync(tmpdir(), { recursive: true })
writeFileSync(
  proxyPath,
  [
    '# comment lines and blanks are ignored',
    '',
    'http://user:pass@10.0.0.1:8000',
    '   http://user:pass@10.0.0.2:8000   ',
    'http://user:pass@10.0.0.3:8000',
    '',
    '# trailing comment',
  ].join('\n'),
  'utf8',
)

process.env.DB_PATH = dbPath
process.env.PROXY_FILE = proxyPath

await import('../server/db.ts')
const { configuredProxyCount, dispatcherForProxyIndex } = await import('../server/providerProxy.ts')
const { createProviderKey } = await import('../server/providerKeys.ts')
const { rotateProviderTargets } = await import('../server/gateway.ts')

test('proxy pool ignores comments and blank lines', () => {
  assert.equal(configuredProxyCount(), 3)
})

test('a proxy index resolves to one cached dispatcher', () => {
  const first = dispatcherForProxyIndex(2)
  assert.ok(first)
  assert.equal(dispatcherForProxyIndex(2), first)
  assert.notEqual(dispatcherForProxyIndex(1), first)
})

test('keys without a proxy assignment use the default transport', () => {
  assert.equal(dispatcherForProxyIndex(null), undefined)
})

test('an unusable proxy index is rejected instead of silently going direct', () => {
  assert.throws(() => dispatcherForProxyIndex(0), /Invalid provider proxy index/)
  assert.throws(() => dispatcherForProxyIndex(1.5), /Invalid provider proxy index/)
  assert.throws(() => dispatcherForProxyIndex(99), /Provider proxy #99 is not configured/)
})

test('only APInex keys can be created, and only one at a time', () => {
  assert.throws(
    () => createProviderKey({ provider: 'other', email: 'other@example.test', secret: 'other-secret' }),
    /only APInex is supported/,
  )
  const keyId = createProviderKey({ provider: 'apinex', email: 'one@example.test', secret: 'apinex-secret-one' })
  assert.ok(keyId)
  assert.throws(
    () => createProviderKey({ provider: 'apinex', email: 'two@example.test', secret: 'apinex-secret-two' }),
    /Only 1 APInex provider key is allowed/,
  )
})

test('round-robin keeps each key attached to its proxy', () => {
  const two = [
    { secret: 'a', proxyIndex: 1 },
    { secret: 'b', proxyIndex: 2 },
  ]
  const first = rotateProviderTargets('apinex', two)
  const second = rotateProviderTargets('apinex', two)
  assert.notEqual(first[0].secret, second[0].secret)
  assert.equal(first[0].proxyIndex, first[0].secret === 'a' ? 1 : 2)
  assert.equal(second[0].proxyIndex, second[0].secret === 'a' ? 1 : 2)
})
