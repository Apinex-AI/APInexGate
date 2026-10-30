import assert from 'node:assert/strict'
import test from 'node:test'
import { isClientDisconnect } from '../server/gateway.ts'
import { db } from '../server/db.js'
import { tryReserveTokens, settleReservation } from '../server/tokenReservations.js'

test('a destroyed or ended client socket means the client went away', () => {
  assert.equal(isClientDisconnect(new Error('aborted'), { destroyed: true }), true)
  assert.equal(isClientDisconnect(new Error('aborted'), { writableEnded: true }), true)
})

test('write-side stream codes are treated as client cancellation', () => {
  for (const code of ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_ALREADY_FINISHED']) {
    const error = Object.assign(new Error(code), { code })
    assert.equal(isClientDisconnect(error, { destroyed: false, writableEnded: false }), true, code)
  }
})

test('an upstream read failure on a live client socket stays a real incident', () => {
  const socket = { destroyed: false, writableEnded: false }
  assert.equal(isClientDisconnect(new TypeError('terminated'), socket), false)
  assert.equal(
    isClientDisconnect(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), socket),
    false,
  )
  assert.equal(isClientDisconnect(new Error('upstream closed'), socket), false)
})

test('a missing socket reference does not mask an upstream failure', () => {
  assert.equal(isClientDisconnect(new Error('terminated'), null), false)
  assert.equal(isClientDisconnect(new Error('terminated'), undefined), false)
})

test('D18: mid-stream client disconnect settles actual usage against hold instead of 100% refund leak', () => {
  const at = new Date().toISOString()
  db.prepare(`DELETE FROM token_reservations WHERE user_id = 'u_stream_test'`).run()
  db.prepare(`DELETE FROM api_keys WHERE user_id = 'u_stream_test'`).run()
  db.prepare(`DELETE FROM users WHERE id = 'u_stream_test'`).run()

  db.prepare(
    `INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
     VALUES ('u_stream_test', 'Streamer', 'stream@example.invalid', 'free', 'active', 0, 5000, 0, ?)`,
  ).run(at)
  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, prefix, status, created_at, secret_hash, spent_tokens, spend_limit_tokens, reserved_tokens)
     VALUES ('k_stream_test', 'u_stream_test', 'Key', 'apx_stream', 'active', ?, 'hash', 0, 5000, 0)`,
  ).run(at)

  // Hold 1000 tokens for streaming completion
  const reserve = tryReserveTokens({ userId: 'u_stream_test', apiKeyId: 'k_stream_test', amount: 1000 })
  assert.equal(reserve.ok, true)
  if (!reserve.ok) return

  const userDuringHold = db.prepare(`SELECT balance_tokens, reserved_tokens FROM users WHERE id = 'u_stream_test'`).get() as { balance_tokens: number; reserved_tokens: number }
  assert.equal(userDuringHold.balance_tokens, 4000)
  assert.equal(userDuringHold.reserved_tokens, 1000)

  // Client disconnects mid-stream after 350 tokens streamed: settle hold with 350 actual usage
  const actualCostTokens = 350
  const settleResult = settleReservation(reserve.reservationId, actualCostTokens)
  assert.equal(settleResult.ok, true)
  assert.equal(settleResult.charged, 350)
  assert.equal(settleResult.refunded, 650)

  const userAfterDisconnect = db.prepare(`SELECT balance_tokens, reserved_tokens FROM users WHERE id = 'u_stream_test'`).get() as { balance_tokens: number; reserved_tokens: number }
  assert.equal(userAfterDisconnect.balance_tokens, 4650) // 5000 - 350 = 4650
  assert.equal(userAfterDisconnect.reserved_tokens, 0)
})
