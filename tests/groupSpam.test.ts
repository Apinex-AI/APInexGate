import assert from 'node:assert/strict'
import test from 'node:test'
import { containsBlockedPromo, groupMessageIsSpam } from '../server/groupSpam.ts'

test('blocks leftover promo words without hardcoding third-party domains', () => {
  assert.equal(containsBlockedPromo('try apmix today'), true)
  assert.equal(containsBlockedPromo('https://example.invalid/v1'), false)
  assert.equal(containsBlockedPromo('hello from the chat'), false)
})

test('blocks t.me links including spaced dots', () => {
  assert.equal(containsBlockedPromo('https://t.me/spam'), true)
  assert.equal(containsBlockedPromo('http://t.me/spam'), true)
  assert.equal(containsBlockedPromo('t.me/spam'), true)
  assert.equal(containsBlockedPromo('t . me/spam'), true)
  assert.equal(containsBlockedPromo('t. me/spam'), true)
  assert.equal(containsBlockedPromo('t .me/spam'), true)
  assert.equal(containsBlockedPromo('see chat.me later'), false)
  assert.equal(containsBlockedPromo('t.media'), false)
})

test('blocks markdown and hidden text_link urls', () => {
  assert.equal(containsBlockedPromo('click [here](https://t.me/spam)'), true)
  assert.equal(
    groupMessageIsSpam({
      text: 'click here',
      entities: [{ url: 'https://t.me/spam' }],
    }),
    true,
  )
  assert.equal(
    groupMessageIsSpam({
      caption: 'photo',
      caption_entities: [{ url: 'http://t.me/spam' }],
    }),
    true,
  )
  assert.equal(groupMessageIsSpam({ text: 'normal message' }), false)
})
