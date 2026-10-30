import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyHour, uptimePercent, buildModelUptime } from '../server/modelUptime.ts'

test('classifyHour uses success rate and latency, never a probe', () => {
  assert.equal(classifyHour({ total: 0, ok: 0, avgLatencyMs: null }), 'no_data')
  assert.equal(classifyHour({ total: 2, ok: 2, avgLatencyMs: 400 }), 'up')
  assert.equal(classifyHour({ total: 2, ok: 1, avgLatencyMs: 400 }), 'none')
  assert.equal(classifyHour({ total: 10, ok: 10, avgLatencyMs: 800 }), 'up')
  assert.equal(classifyHour({ total: 10, ok: 10, avgLatencyMs: 30_000 }), 'load')
  assert.equal(classifyHour({ total: 10, ok: 7, avgLatencyMs: 800 }), 'partial')
  assert.equal(classifyHour({ total: 10, ok: 2, avgLatencyMs: 800 }), 'down')
})

test('uptimePercent ignores empty hours and halves partial ones', () => {
  assert.equal(uptimePercent(['none', 'none']), null)
  assert.equal(uptimePercent(['no_data', 'no_data']), null)
  assert.equal(uptimePercent(['none', 'no_data']), null)
  assert.equal(uptimePercent(['up', 'load', 'partial', 'down']), 62.5)
})

test('buildModelUptime reflects no_data when a model has zero samples', () => {
  const result = buildModelUptime()
  assert.ok(Array.isArray(result.models))
  if (result.models.length > 0) {
    const untrafficked = result.models.find((m) => m.hours.every((h) => h.state === 'no_data'))
    if (untrafficked) {
      assert.equal(untrafficked.state, 'no_data')
      assert.equal(untrafficked.uptimePct, null)
    }
  }
})
