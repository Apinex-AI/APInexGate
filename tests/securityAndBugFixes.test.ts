import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { parseSafeInt } from '../server/db.js'
import { requestHostname } from '../shared/adminHosts.js'
import { tryReserveTokens, settleReservation } from '../server/tokenReservations.js'
import { db, id, nowIso } from '../server/db.js'

test('parseSafeInt safely sanitizes floats and invalid inputs for SQLite queries', () => {
  // Bug 6 reproduction inputs:
  assert.equal(parseSafeInt('1.5', 50, 1, 100), 1)
  assert.equal(parseSafeInt(1.5, 50, 1, 100), 1)
  assert.equal(parseSafeInt('2.5', 50, 1, 100), 2)
  assert.equal(parseSafeInt('99.99', 50, 1, 100), 99)

  // Out-of-range floats and infinities that triggered SqliteError datatype mismatch:
  assert.equal(parseSafeInt('1e999', 0, 0, 1_000_000), 0)
  assert.equal(parseSafeInt(Infinity, 0, 0, 1_000_000), 0)
  assert.equal(parseSafeInt(-Infinity, 0, 0, 1_000_000), 0)
  assert.equal(parseSafeInt('Infinity', 0, 0, 1_000_000), 0)
  assert.equal(parseSafeInt('9223372036854775807', 0, 0, 1_000_000), 0) // exceeds Number.MAX_SAFE_INTEGER
  assert.equal(parseSafeInt('abc', 50, 1, 100), 50)
  assert.equal(parseSafeInt(NaN, 50, 1, 100), 50)
  assert.equal(parseSafeInt(undefined, 50, 1, 100), 50)
  assert.equal(parseSafeInt(null, 50, 1, 100), 50)

  // Standard safe inputs:
  assert.equal(parseSafeInt('25', 50, 1, 100), 25)
  assert.equal(parseSafeInt(25, 50, 1, 100), 25)
  assert.equal(parseSafeInt('200', 50, 1, 100), 100) // clamped to max
  assert.equal(parseSafeInt('-5', 50, 1, 100), 1) // clamped to min

  // SQLite execution verification:
  const db = new Database(':memory:')
  db.exec('CREATE TABLE test_items (id INTEGER PRIMARY KEY, name TEXT)')
  for (let i = 1; i <= 10; i++) {
    db.prepare('INSERT INTO test_items (name) VALUES (?)').run(`item-${i}`)
  }

  // Passing sanitized values to SQLite prepared statement must not throw:
  const offset = parseSafeInt('1.5', 0, 0, 1_000_000)
  const limit = parseSafeInt('1e999', 50, 1, 100)
  const rows = db.prepare('SELECT * FROM test_items LIMIT ? OFFSET ?').all(limit, offset)
  assert.equal(rows.length, 9)
  db.close()
})

test('requestHostname prioritizes authoritative Host over spoofed X-Forwarded-Host', () => {
  // Bug 7: client injects X-Forwarded-Host
  const headers = {
    host: 'example.com',
    'x-forwarded-host': 'evil.example',
  }
  const host = requestHostname(headers)
  assert.equal(host, 'example.com')

  // Multiple comma-separated hosts in header
  const headersWithPort = {
    host: 'api.example.com:443',
    'x-forwarded-host': 'attacker.tld:8443',
  }
  assert.equal(requestHostname(headersWithPort), 'api.example.com')

  // When Host is absent, fall back to forwarded host
  const fallback = requestHostname({ 'x-forwarded-host': 'internal.local' })
  assert.equal(fallback, 'internal.local')
})

test('tryReserveTokens blocks parallel requests exceeding spendLimitTokens', () => {
  const userId = id('test_user')
  const keyId = id('test_key')
  const now = nowIso()

  const userEmail = `test-spend-${Date.now()}-${Math.random()}@example.com`
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_tokens, requests, created_at, last_seen_at)
    VALUES (?, 'Test', ?, 'default', 'active', 1000, 0, ?, ?)
  `).run(userId, userEmail, now, now)

  db.prepare(`
    INSERT INTO api_keys (id, user_id, name, prefix, secret_hash, spend_limit_tokens, spent_tokens, reserved_tokens, status, created_at)
    VALUES (?, ?, 'Test Key', 'sk-test', 'hash123', 20, 0, 0, 'active', ?)
  `).run(keyId, userId, now)

  // Request 1: wants 20 tokens (limit is 20) -> should succeed
  const r1 = tryReserveTokens({ userId, apiKeyId: keyId, amount: 20 })
  assert.equal(r1.ok, true)

  // Request 2 (parallel while Request 1 is still open): wants 20 tokens -> must fail!
  const r2 = tryReserveTokens({ userId, apiKeyId: keyId, amount: 20 })
  assert.equal(r2.ok, false)
  if (!r2.ok) {
    assert.match(r2.error, /spend limit/i)
  }

  // Once Request 1 settles:
  if (r1.ok) {
    settleReservation(r1.reservationId, 20)
  }

  // Request 3 (after settle): wants 20 tokens -> must fail because key is at limit
  const r3 = tryReserveTokens({ userId, apiKeyId: keyId, amount: 20 })
  assert.equal(r3.ok, false)
})

test('tryReserveTokens blocks parallel requests exceeding available user balance', () => {
  const userId = id('test_user2')
  const keyId = id('test_key2')
  const now = nowIso()

  const userEmail2 = `test-spend2-${Date.now()}-${Math.random()}@example.com`
  // User has only 200 tokens
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_tokens, requests, created_at, last_seen_at)
    VALUES (?, 'Test2', ?, 'default', 'active', 200, 0, ?, ?)
  `).run(userId, userEmail2, now, now)

  db.prepare(`
    INSERT INTO api_keys (id, user_id, name, prefix, secret_hash, spend_limit_tokens, spent_tokens, reserved_tokens, status, created_at)
    VALUES (?, ?, 'Test Key 2', 'sk-test2', 'hash456', NULL, 0, 0, 'active', ?)
  `).run(keyId, userId, now)

  // Request 1: wants 200 tokens -> should succeed
  const r1 = tryReserveTokens({ userId, apiKeyId: keyId, amount: 200 })
  assert.equal(r1.ok, true)

  // Request 2 (parallel): wants 200 tokens -> must fail!
  const r2 = tryReserveTokens({ userId, apiKeyId: keyId, amount: 200 })
  assert.equal(r2.ok, false)
  if (!r2.ok) {
    assert.match(r2.error, /balance/i)
  }

  // Request 1 settles
  if (r1.ok) {
    settleReservation(r1.reservationId, 200)
  }

  const user = db.prepare('SELECT balance_tokens FROM users WHERE id = ?').get(userId) as { balance_tokens: number }
  assert.equal(user.balance_tokens, 0)
})
