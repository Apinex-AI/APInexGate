import assert from 'node:assert/strict'
import test from 'node:test'
import { isTemporarilyRestrictedModelForKey } from '../server/gateway.ts'

const restrictedKeyHash = 'c52924eaed69f62683da752e0f150a89797a66a10afbb0ffd053266a8f4b13cb'
const otherKeyHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

test('temporary model restriction applies only to the two target key hashes and models', () => {
  assert.equal(isTemporarilyRestrictedModelForKey(restrictedKeyHash, 'gpt/5.6-terra'), true)
  assert.equal(isTemporarilyRestrictedModelForKey(restrictedKeyHash, 'claude/opus-5'), true)
  assert.equal(isTemporarilyRestrictedModelForKey(restrictedKeyHash, 'gpt/5.6-luna'), false)
  assert.equal(isTemporarilyRestrictedModelForKey(otherKeyHash, 'gpt/5.6-terra'), false)
})
