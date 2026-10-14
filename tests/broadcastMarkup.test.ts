import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeBroadcastNodes, type BroadcastNode } from '../src/admin/broadcastMarkup.ts'

const text = (value: string): BroadcastNode => ({ type: 'text', text: value })
const el = (tag: string, children: BroadcastNode[]): BroadcastNode => ({ type: 'el', tag, children })

test('editor markup keeps spaces, breaks, and visible formatting tags', () => {
  assert.equal(serializeBroadcastNodes([text('  hello\nthere  ')]), '  hello\nthere  ')
  assert.equal(
    serializeBroadcastNodes([text('hello'), el('div', [text('world')])]),
    'hello\nworld',
  )
  assert.equal(
    serializeBroadcastNodes([text('hello'), el('div', [el('br', [])]), el('div', [text('world')])]),
    'hello\n\nworld',
  )
  assert.equal(
    serializeBroadcastNodes([el('b', [text('bold')]), text(' '), el('code', [text('PROMO')])]),
    '<b>bold</b> <code>PROMO</code>',
  )
  assert.equal(serializeBroadcastNodes([el('div', [el('br', [])])]), '\n')
})
