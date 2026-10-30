import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { registerSecurityHeaders } from '../server/securityHeaders.js'
import { registerRoutes } from '../server/routes.js'
import { db, nowIso, id } from '../server/db.js'
import { buildUpstreamRequestHeaders } from '../server/gateway.js'
import { tryReserveTokens } from '../server/tokenReservations.ts'
import { createHash } from 'node:crypto'

function hashKey(secret: string) {
  return createHash('sha256').update(secret).digest('hex')
}

test('1. Static and sensitive file protection: blocks .env, database files, package.json, and git', async () => {
  const app = Fastify()
  registerSecurityHeaders(app)
  await registerRoutes(app)

  const sensitivePaths = [
    '/.env',
    '/.env.local',
    '/.env.production',
    '/data/database.sqlite',
    '/data/database.sqlite-wal',
    '/package.json',
    '/package-lock.json',
    '/.git',
    '/.git/config',
    '/.git/HEAD',
    '/api/../.env',
    '/api/public/../../package.json',
  ]

  for (const path of sensitivePaths) {
    const res = await app.inject({
      method: 'GET',
      url: path,
    })
    assert.equal(res.statusCode, 404, `Expected 404 for ${path}, got ${res.statusCode}`)
    // Body should not contain any file contents
    assert.equal(res.body.includes('DB_PATH'), false)
    assert.equal(res.body.includes('SQLite format'), false)
    assert.equal(res.body.includes('"name": "apinex-gate"'), false)
  }
})

test('2. API Key authentication & account status: blocks suspended and pending users immediately', async () => {
  const app = Fastify()
  registerSecurityHeaders(app)
  await registerRoutes(app)

  const now = nowIso()
  // Active user
  const activeUserId = id('usr')
  const activeKeySecret = `apx_audit_active_${id('sec')}`
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
    VALUES (?, 'Active User', ?, 'default', 'active', 100, 1000000, 0, ?)
  `).run(activeUserId, `${activeUserId}@example.invalid`, now)
  db.prepare(`
    INSERT INTO api_keys (id, user_id, name, prefix, status, created_at, secret_hash, spent_tokens, reserved_tokens)
    VALUES (?, ?, 'Active Key', 'apx_active', 'active', ?, ?, 0, 0)
  `).run(id('key'), activeUserId, now, hashKey(activeKeySecret))

  // Suspended user
  const suspendedUserId = id('usr')
  const suspendedKeySecret = `apx_audit_susp_${id('sec')}`
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
    VALUES (?, 'Suspended User', ?, 'default', 'suspended', 100, 1000000, 0, ?)
  `).run(suspendedUserId, `${suspendedUserId}@example.invalid`, now)
  const suspendedKeyId = id('key')
  db.prepare(`
    INSERT INTO api_keys (id, user_id, name, prefix, status, created_at, secret_hash, spent_tokens, reserved_tokens)
    VALUES (?, ?, 'Suspended Key', 'apx_susp', 'active', ?, ?, 0, 0)
  `).run(suspendedKeyId, suspendedUserId, now, hashKey(suspendedKeySecret))

  // Pending user
  const pendingUserId = id('usr')
  const pendingKeySecret = `apx_audit_pend_${id('sec')}`
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
    VALUES (?, 'Pending User', ?, 'default', 'pending', 100, 1000000, 0, ?)
  `).run(pendingUserId, `${pendingUserId}@example.invalid`, now)
  const pendingKeyId = id('key')
  db.prepare(`
    INSERT INTO api_keys (id, user_id, name, prefix, status, created_at, secret_hash, spent_tokens, reserved_tokens)
    VALUES (?, ?, 'Pending Key', 'apx_pend', 'active', ?, ?, 0, 0)
  `).run(pendingKeyId, pendingUserId, now, hashKey(pendingKeySecret))

  // Test /v1/balance with suspended user
  const suspRes = await app.inject({
    method: 'GET',
    url: '/v1/balance',
    headers: { Authorization: `Bearer ${suspendedKeySecret}` },
  })
  assert.equal(suspRes.statusCode, 403)
  assert.ok(suspRes.body.includes('Account suspended or missing'))

  // Test /v1/balance with pending user
  const pendRes = await app.inject({
    method: 'GET',
    url: '/v1/balance',
    headers: { Authorization: `Bearer ${pendingKeySecret}` },
  })
  assert.equal(pendRes.statusCode, 403)
  assert.ok(pendRes.body.includes('Account pending activation'))

  // Test /v1/balance with active user
  const activeRes = await app.inject({
    method: 'GET',
    url: '/v1/balance',
    headers: { Authorization: `Bearer ${activeKeySecret}` },
  })
  assert.equal(activeRes.statusCode, 200)

  // Test tryReserveTokens blocks suspended and pending users
  const resSusp = tryReserveTokens({ userId: suspendedUserId, apiKeyId: suspendedKeyId, amount: 100 })
  assert.equal(resSusp.ok, false)
  assert.equal(resSusp.status, 402)
  assert.ok(resSusp.error.includes('Account suspended'))

  const resPend = tryReserveTokens({ userId: pendingUserId, apiKeyId: pendingKeyId, amount: 100 })
  assert.equal(resPend.ok, false)
  assert.equal(resPend.status, 402)
  assert.ok(resPend.error.includes('Account pending activation'))
})

test('3. Upstream header leaks: buildUpstreamRequestHeaders strips client cookies, client auth, and internal headers', () => {
  const headers = buildUpstreamRequestHeaders('sk-provider-secret-xyz', {
    // Client cookies
    cookie: 'user_session=secret_session_token; apinex_session=abc',
    Cookie: 'admin_session=secret_admin',
    'Set-Cookie': 'session=leaked',

    // Client Authorization / credentials
    authorization: 'Bearer client_jwt_token',
    Authorization: 'Bearer client_jwt_token_2',
    'x-api-key': 'apx_live_client_key',
    'X-Api-Key': 'apx_live_client_key_upper',
    'api-key': 'client_api_key_custom',

    // Internal headers
    'x-session-id': 'sess_internal_123',
    'X-User-Id': 'usr_internal_456',
    'x-admin-key': 'adm_internal_key',
    'x-internal-flag': 'true',
    host: 'api.apinex.bond',
    connection: 'keep-alive',

    // Gateway spoof attempt
    src: 'malicious-spoof',
    SRC: 'malicious-spoof-2',

    // Legitimate custom headers
    'anthropic-version': '2023-06-01',
    'X-Custom-Client-Trace': 'trace-123',
  })

  // Verify provider credentials set correctly
  assert.equal(headers.Authorization, 'Bearer sk-provider-secret-xyz')
  assert.equal(headers.src, 'gate')
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers.Accept, 'application/json')

  // Verify client cookies are NEVER leaked
  assert.equal('cookie' in headers, false)
  assert.equal('Cookie' in headers, false)
  assert.equal('set-cookie' in headers, false)
  assert.equal('Set-Cookie' in headers, false)

  // Verify client authorization / keys are NEVER leaked
  assert.equal('authorization' in headers, false)
  assert.equal('x-api-key' in headers, false)
  assert.equal('X-Api-Key' in headers, false)
  assert.equal('api-key' in headers, false)

  // Verify internal headers are NEVER leaked
  assert.equal('x-session-id' in headers, false)
  assert.equal('x-user-id' in headers, false)
  assert.equal('X-User-Id' in headers, false)
  assert.equal('x-admin-key' in headers, false)
  assert.equal('x-internal-flag' in headers, false)
  assert.equal('host' in headers, false)
  assert.equal('connection' in headers, false)

  // Verify safe custom headers pass through
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers['X-Custom-Client-Trace'], 'trace-123')
})

test('4. Public endpoints: verify no sensitive provider keys, database paths, or admin info leaked', async () => {
  const app = Fastify()
  await app.register(cookie)
  registerSecurityHeaders(app)
  await registerRoutes(app)

  const publicRoutes = [
    '/api/public/status',
    '/api/public/brand',
    '/api/public/links',
    '/api/public/rate-limits',
    '/api/public/levels',
    '/api/public/models',
    '/api/public/promo-event',
    '/api/public/subscriptions',
  ]

  for (const url of publicRoutes) {
    const res = await app.inject({ method: 'GET', url })
    assert.equal(res.statusCode, 200, `Failed for ${url}: ${res.body}`)

    const body = res.body

    // Ensure no provider secret keys leaked (sk-, apx_, ghp_, etc.)
    assert.equal(/sk-[a-zA-Z0-9_-]{16,}/.test(body), false, `Secret key pattern leaked in ${url}`)
    assert.equal(/apx_[a-zA-Z0-9_-]{16,}/.test(body), false, `API key leaked in ${url}`)

    // Ensure no SQLite / filesystem paths leaked
    assert.equal(body.includes('.sqlite'), false, `Database path leaked in ${url}`)
    assert.equal(body.includes('/Users/'), false, `User directory path leaked in ${url}`)
    assert.equal(body.includes('/home/'), false, `Home directory path leaked in ${url}`)

    // Ensure no admin passwords or password hashes leaked
    assert.equal(body.includes('password_hash'), false, `Password hash leaked in ${url}`)
    assert.equal(body.includes('admin_users'), false, `Admin user info leaked in ${url}`)

    // Ensure no internal upstream details leaked in model list
    if (url === '/api/public/models') {
      const parsed = JSON.parse(body)
      assert.ok(Array.isArray(parsed.models))
      for (const model of parsed.models) {
        assert.equal('upstream_id' in model, false, 'upstream_id must not be exposed')
        assert.equal('upstream_provider' in model, false, 'upstream_provider must not be exposed')
        assert.equal('secret' in model, false, 'secret must not be exposed')
      }
    }
  }
})
