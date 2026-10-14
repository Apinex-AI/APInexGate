import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbPath = join(tmpdir(), `gateway-blocked-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`)
mkdirSync(tmpdir(), { recursive: true })
process.env.DB_PATH = dbPath

const { isEmailBlocked, blockEmail, BLOCKED_EMAIL_MESSAGE } = await import('../server/blockedEmails.ts')
const { db } = await import('../server/db.ts')

test('blocked emails reject case-insensitively', () => {
  assert.equal(isEmailBlocked('dup@gmail.com'), false)
  blockEmail('Dup@Gmail.com', 'test')
  assert.equal(isEmailBlocked('dup@gmail.com'), true)
  assert.equal(isEmailBlocked('DUP@GMAIL.COM'), true)
  assert.equal(BLOCKED_EMAIL_MESSAGE.length > 0, true)
  const row = db.prepare(`SELECT email, reason FROM blocked_emails WHERE email = ?`).get('dup@gmail.com') as
    | { email: string; reason: string }
    | undefined
  assert.equal(row?.email, 'dup@gmail.com')
  assert.equal(row?.reason, 'test')
})
