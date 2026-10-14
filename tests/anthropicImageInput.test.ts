import assert from 'node:assert/strict'
import test from 'node:test'
import { buildUpstreamPayload } from '../server/gateway.ts'

test('Anthropic base64 images are forwarded as OpenAI image_url blocks', () => {
  const payload = buildUpstreamPayload(
    {
      model: 'claude/opus-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What color is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQI=' } },
          ],
        },
      ],
    },
    'cc/claude-opus-5',
    'messages',
  )

  const userMessage = (payload.messages as Array<Record<string, unknown>>).find((message) => message.role === 'user')
  assert.deepEqual(userMessage?.content, [
    { type: 'text', text: 'What color is this?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQI=' } },
  ])
})

test('Anthropic URL images are forwarded and mixed content is preserved', () => {
  const payload = buildUpstreamPayload(
    {
      model: 'claude/opus-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
            { type: 'text', text: 'Describe it.' },
          ],
        },
      ],
    },
    'cc/claude-opus-5',
    'messages',
  )

  const userMessage = (payload.messages as Array<Record<string, unknown>>).find((message) => message.role === 'user')
  assert.deepEqual(userMessage?.content, [
    { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
    { type: 'text', text: 'Describe it.' },
  ])
})

test('plain Anthropic text remains a plain OpenAI message string', () => {
  const payload = buildUpstreamPayload(
    { model: 'claude/opus-5', messages: [{ role: 'user', content: 'Hello' }] },
    'cc/claude-opus-5',
    'messages',
  )

  const userMessage = (payload.messages as Array<Record<string, unknown>>).find((message) => message.role === 'user')
  assert.deepEqual(userMessage, {
    role: 'user',
    content: 'Hello',
  })
})
