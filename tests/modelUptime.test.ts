import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyHour, uptimePercent } from '../server/modelUptime.ts'

test('classifyHour uses success rate and latency, never a probe', () => {
  assert.equal(classifyHour({ total: 0, ok: 0, avgLatencyMs: null }), 'up')
  assert.equal(classifyHour({ total: 2, ok: 2, avgLatencyMs: 400 }), 'up')
  assert.equal(classifyHour({ total: 2, ok: 1, avgLatencyMs: 400 }), 'none')
  assert.equal(classifyHour({ total: 10, ok: 10, avgLatencyMs: 800 }), 'up')
  assert.equal(classifyHour({ total: 10, ok: 10, avgLatencyMs: 30_000 }), 'load')
  assert.equal(classifyHour({ total: 10, ok: 7, avgLatencyMs: 800 }), 'partial')
  assert.equal(classifyHour({ total: 10, ok: 2, avgLatencyMs: 800 }), 'down')
})

test('uptimePercent ignores empty hours and halves partial ones', () => {
  assert.equal(uptimePercent(['none', 'none']), null)
  assert.equal(uptimePercent(['up', 'load', 'partial', 'down']), 62.5)
})
