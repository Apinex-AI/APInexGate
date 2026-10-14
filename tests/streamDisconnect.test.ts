import assert from 'node:assert/strict'
import test from 'node:test'
import { isClientDisconnect } from '../server/gateway.ts'

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
