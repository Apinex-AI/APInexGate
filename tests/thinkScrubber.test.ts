import assert from 'node:assert/strict'
import test from 'node:test'
import { createThinkTagScrubber } from '../server/gateway.ts'

test('think scrubber keeps text when the closing tag is split across chunks', () => {
  const scrub = createThinkTagScrubber()
  assert.equal(scrub('Hello <think>secret</thi'), 'Hello ')
  assert.equal(scrub('nk> world'), ' world')
})
