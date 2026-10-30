import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbPath = join(tmpdir(), `gateway-audit-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`)
mkdirSync(tmpdir(), { recursive: true })
process.env.DB_PATH = dbPath

const { db } = await import('../server/db.ts')
const {
  tryReserveTokens,
  settleReservation,
  releaseReservation,
  settleTokens,
  releaseTokens,
} = await import('../server/tokenReservations.ts')
const {
  isSafeUpstreamUrl,
  assertSafeUpstreamUrl,
  sanitizeErrorMessage,
} = await import('../server/upstreamFallback.ts')
const {
  buildDecisionPayload,
  applyUpstreamPayloadQuirks,
  upstreamFailureMessage,
} = await import('../server/gateway.ts')

function seedAuditUser() {
  const at = new Date().toISOString()
  db.prepare(
    `INSERT OR REPLACE INTO users (id,name,email,plan,status,balance_cents,balance_tokens,requests,created_at)
     VALUES ('u_audit','Audit','audit@test.invalid','free','active',0,5000,0,?)`,
  ).run(at)
  db.prepare(
    `INSERT OR REPLACE INTO api_keys (id,user_id,name,prefix,status,created_at,secret_hash,spent_tokens,spend_limit_tokens,reserved_tokens)
     VALUES ('k_audit','u_audit','K','apx_test','active',?,'hash_audit',0,5000,0)`,
  ).run(at)
}

test('settleTokens and settleReservation are idempotent and do not double charge or refund', () => {
  seedAuditUser()
  const r = tryReserveTokens({ userId: 'u_audit', apiKeyId: 'k_audit', amount: 300 })
  assert.equal(r.ok, true)
  if (!r.ok) return

  const userBefore = db.prepare(`SELECT balance_tokens FROM users WHERE id='u_audit'`).get() as { balance_tokens: number }

  // First settle
  const s1 = settleTokens(r.reservationId, 100)
  assert.equal(s1.ok, true)
  assert.equal(s1.charged, 100)
  assert.equal(s1.refunded, 200)

  const userAfterFirst = db.prepare(`SELECT balance_tokens FROM users WHERE id='u_audit'`).get() as { balance_tokens: number }
  assert.equal(userAfterFirst.balance_tokens, userBefore.balance_tokens + 200)

  // Second settle call (idempotent)
  const s2 = settleTokens(r.reservationId, 100)
  assert.equal(s2.ok, true)
  assert.equal(s2.charged, 100)
  assert.equal(s2.refunded, 200)

  const userAfterSecond = db.prepare(`SELECT balance_tokens FROM users WHERE id='u_audit'`).get() as { balance_tokens: number }
  // Balance must remain unchanged on repeated settle!
  assert.equal(userAfterSecond.balance_tokens, userAfterFirst.balance_tokens)
})

test('releaseTokens and releaseReservation are idempotent and do not double refund', () => {
  seedAuditUser()
  const r = tryReserveTokens({ userId: 'u_audit', apiKeyId: 'k_audit', amount: 250 })
  assert.equal(r.ok, true)
  if (!r.ok) return

  const userBefore = db.prepare(`SELECT balance_tokens FROM users WHERE id='u_audit'`).get() as { balance_tokens: number }

  // First release
  const rel1 = releaseTokens(r.reservationId)
  assert.equal(rel1.ok, true)
  assert.equal(rel1.refunded, 250)

  const userAfterFirst = db.prepare(`SELECT balance_tokens FROM users WHERE id='u_audit'`).get() as { balance_tokens: number }
  assert.equal(userAfterFirst.balance_tokens, userBefore.balance_tokens + 250)

  // Second release (idempotent)
  const rel2 = releaseTokens(r.reservationId)
  assert.equal(rel2.ok, true)
  assert.equal(rel2.refunded, 250)

  const userAfterSecond = db.prepare(`SELECT balance_tokens FROM users WHERE id='u_audit'`).get() as { balance_tokens: number }
  assert.equal(userAfterSecond.balance_tokens, userAfterFirst.balance_tokens)
})

test('tryReserveTokens releases hold immediately when client aborts via AbortSignal', () => {
  seedAuditUser()
  const controller = new AbortController()
  const r = tryReserveTokens({
    userId: 'u_audit',
    apiKeyId: 'k_audit',
    amount: 400,
    signal: controller.signal,
  })
  assert.equal(r.ok, true)
  if (!r.ok) return

  const userDuringHold = db.prepare(`SELECT reserved_tokens FROM users WHERE id='u_audit'`).get() as { reserved_tokens: number }
  assert.equal(userDuringHold.reserved_tokens, 400)

  // Simulate client disconnect / abort
  controller.abort()

  const userAfterAbort = db.prepare(`SELECT reserved_tokens FROM users WHERE id='u_audit'`).get() as { reserved_tokens: number }
  assert.equal(userAfterAbort.reserved_tokens, 0)

  const resRow = db.prepare(`SELECT status FROM token_reservations WHERE id=?`).get(r.reservationId) as { status: string }
  assert.equal(resRow.status, 'released')
})

test('SSRF URL validation strictly blocks internal, loopback, and metadata services', () => {
  // Blocked cloud metadata
  assert.equal(isSafeUpstreamUrl('http://169.254.169.254/latest/meta-data'), false)
  assert.equal(isSafeUpstreamUrl('http://169.254.1.1/'), false)
  assert.equal(isSafeUpstreamUrl('http://metadata.google.internal/'), false)
  assert.equal(isSafeUpstreamUrl('http://instance-data/'), false)

  // Blocked localhost / loopback
  assert.equal(isSafeUpstreamUrl('http://localhost:8080/'), false)
  assert.equal(isSafeUpstreamUrl('http://sub.localhost/'), false)
  assert.equal(isSafeUpstreamUrl('http://127.0.0.1:3000/'), false)
  assert.equal(isSafeUpstreamUrl('http://127.0.0.2/'), false)
  assert.equal(isSafeUpstreamUrl('http://0.0.0.0/'), false)
  assert.equal(isSafeUpstreamUrl('http://[::1]/'), false)
  assert.equal(isSafeUpstreamUrl('http://[::ffff:127.0.0.1]/'), false)
  assert.equal(isSafeUpstreamUrl('http://[::ffff:169.254.169.254]/'), false)

  // Blocked RFC 1918 private IPs
  assert.equal(isSafeUpstreamUrl('http://10.0.0.1/'), false)
  assert.equal(isSafeUpstreamUrl('http://172.16.0.1/'), false)
  assert.equal(isSafeUpstreamUrl('http://172.31.255.255/'), false)
  assert.equal(isSafeUpstreamUrl('http://192.168.1.1/'), false)
  assert.equal(isSafeUpstreamUrl('http://100.64.0.1/'), false)

  // Blocked userinfo credentials
  assert.equal(isSafeUpstreamUrl('http://admin:secret@api.apinex.bond/'), false)

  // Blocked non-http/https protocols
  assert.equal(isSafeUpstreamUrl('file:///etc/passwd'), false)
  assert.equal(isSafeUpstreamUrl('gopher://127.0.0.1/'), false)

  // Allowed public upstreams
  assert.equal(isSafeUpstreamUrl('https://api.apinex.bond/v1/chat/completions'), true)
  assert.equal(isSafeUpstreamUrl('https://api.openai.com/v1/chat/completions'), true)
  assert.equal(isSafeUpstreamUrl('https://api.anthropic.com/v1/messages'), true)

  assert.throws(() => assertSafeUpstreamUrl('http://169.254.169.254/'), /SSRF blocked/)
})

test('sanitizeErrorMessage strips API keys, proxy credentials, and server paths', () => {
  const leakedError =
    'Failed to connect to http://proxyUser:superSecretPass@proxy.internal:8080: Error in /Users/Th3ryks/Projects/APInexGate/server/gateway.ts with secret sk-live-1234567890abcdef and Bearer apx_testkey12345'
  const clean = sanitizeErrorMessage(leakedError)

  assert.equal(clean.includes('superSecretPass'), false)
  assert.equal(clean.includes('/Users/Th3ryks'), false)
  assert.equal(clean.includes('sk-live-1234567890abcdef'), false)
  assert.equal(clean.includes('apx_testkey12345'), false)

  // Upstream failure message also uses sanitizer
  const failure = upstreamFailureMessage(new Error(leakedError), {})
  assert.equal(failure.includes('superSecretPass'), false)
  assert.equal(failure.includes('/Users/Th3ryks'), false)
})

test('gateway null/undefined safety on malformed messages, tools, and decision questions', () => {
  // Messages with null/undefined/non-object elements
  const payloadWithNulls: Record<string, unknown> = {
    messages: [
      null,
      undefined,
      'just a string',
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: null, tool_calls: null },
    ],
    tools: [
      null,
      undefined,
      { type: 'function', function: { name: 'test_fn', parameters: null } },
    ],
  }

  // Must not throw and must clean invalid items
  applyUpstreamPayloadQuirks(payloadWithNulls, 'apinex')
  const msgs = payloadWithNulls.messages as Array<Record<string, unknown>>
  assert.ok(msgs.every((m) => m && typeof m === 'object'))

  const tools = payloadWithNulls.tools as Array<Record<string, unknown>>
  assert.ok(tools.every((t) => t && typeof t === 'object'))

  // Decision questions with null/undefined levels and options
  const decisionPayload = buildDecisionPayload(
    {
      input: 'analyze this',
      questions: [
        null,
        undefined,
        { id: 'q1', type: 'score', levels: [null, { value: 1, label: 'Low' }] },
      ],
    },
    'jev-1.13',
  )
  assert.equal(decisionPayload.model, 'jev-1.13')
  assert.ok(Array.isArray(decisionPayload.questions))
})
