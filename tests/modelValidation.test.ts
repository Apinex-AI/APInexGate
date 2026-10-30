import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import {
  isValidModelId,
  isValidModelName,
  displayNameFromId,
  sanitizeModelName,
  MODEL_ID_REGEX,
  FORBIDDEN_NAME_CHARS_REGEX,
} from '../shared/modelValidation.js'
import { db, nowIso } from '../server/db.js'
import { importApinexCatalogModels } from '../server/providerKeys.js'
import { registerRoutes } from '../server/routes.js'
import { createAdminSession, ADMIN_SESSION_COOKIE } from '../server/auth.js'

test('isValidModelId accepts valid model IDs', () => {
  const validIds = [
    'a',
    'model123',
    'free/gpt-6-luna',
    'openai/gpt-4o:mini',
    'deepseek-v4.1-flash',
    'claude-opus-4.6',
    'provider.name/model_v1.0-alpha:test',
    'a'.repeat(128),
  ]

  for (const id of validIds) {
    assert.equal(isValidModelId(id), true, `Expected "${id}" to be a valid model ID`)
  }
})

test('isValidModelId rejects invalid model IDs, shell injection attempts and length violations', () => {
  const invalidIds = [
    '', // empty
    ' ', // whitespace
    'a'.repeat(129), // exceeds 128 chars
    '/leading-slash',
    '.leading-dot',
    '-leading-dash',
    '_leading-underscore',
    ':leading-colon',
    'has space',
    'free/evil-$(touch /tmp/marker)',
    'evil;rm -rf /',
    'evil`whoami`',
    'evil|sh',
    'evil&calc',
    'evil>out',
    'evil<in',
    'evil\\escape',
    'evil"quote',
    'evil\'quote',
    'evil\0nullbyte',
    'evil\nnewline',
    null,
    undefined,
    123 as any,
    {} as any,
  ]

  for (const id of invalidIds) {
    assert.equal(isValidModelId(id), false, `Expected "${String(id)}" to be an invalid model ID`)
  }
})

test('isValidModelName accepts valid model names', () => {
  const validNames = [
    'GPT 6 Luna',
    'Claude 4.6 Sonnet',
    'GLM-5.3 Flash',
    'SubQ Snap (Preview)',
    'GPT-6 Luna (Decisions)',
    'Model + Vision',
    "Llama's Best",
    'Model (v1:0, 32k)',
    '智谱清言 GLM-5',
    'Модель Русская',
    'Modèle Français',
    'a'.repeat(128),
  ]

  for (const name of validNames) {
    assert.equal(isValidModelName(name), true, `Expected "${name}" to be a valid model name`)
  }
})

test('isValidModelName strictly rejects shell injection metacharacters, control chars, newlines and length violations', () => {
  const invalidNames = [
    '', // empty
    '   ', // whitespace only
    'a'.repeat(129), // exceeds 128 chars
    '$(id > /tmp/marker)', // command substitution
    '!000-evil-$(touch /tmp/marker)',
    'foo; rm -rf /;', // command chaining semicolon
    '`whoami`', // backtick command substitution
    'model | sh', // pipe
    'model & ping 1.1.1.1', // ampersand
    'model < /etc/shadow', // input redirect
    'model > /tmp/out', // output redirect
    'model \\ escape', // backslash
    'model " doublequote', // double quote
    'model\0nullbyte', // null byte
    'model\nwith\nnewlines', // newline
    'model\rwith\rcarriage', // carriage return
    'model\x07bell', // ASCII control char
    'model\x1Funit_separator', // ASCII control char
    null,
    undefined,
    123 as any,
    {} as any,
  ]

  for (const name of invalidNames) {
    assert.equal(isValidModelName(name), false, `Expected "${String(name)}" to be rejected as model name`)
  }
})

test('displayNameFromId produces clean, safe names', () => {
  assert.equal(displayNameFromId('free/claude-opus-4.6'), 'Claude Opus 4.6')
  assert.equal(displayNameFromId('deepseek-v4.1-flash'), 'Deepseek V4.1 Flash')
  assert.equal(displayNameFromId('gpt-6-luna'), 'Gpt 6 Luna')
  assert.equal(displayNameFromId('free/evil-model'), 'Evil Model')
  assert.equal(isValidModelName(displayNameFromId('free/evil-$(touch /tmp/marker)')), true)
})

test('sanitizeModelName neutralizes shell metacharacters and control characters', () => {
  // Preserves safe names
  assert.equal(sanitizeModelName('Claude 4.6 Opus', 'free/claude-opus-4.6'), 'Claude 4.6 Opus')

  // Strips $ command substitution
  const strippedDollar = sanitizeModelName('!000-evil-$(touch /tmp/marker)', 'test-model')
  assert.equal(strippedDollar, '!000-evil-(touch /tmp/marker)')
  assert.equal(isValidModelName(strippedDollar), true)

  // Strips semicolon and ampersand
  const strippedSemicolon = sanitizeModelName('; rm -rf /; &', 'free/test-model')
  assert.equal(strippedSemicolon, 'rm -rf /')
  assert.equal(isValidModelName(strippedSemicolon), true)

  // Strips backticks
  const strippedBacktick = sanitizeModelName('model `whoami` test', 'test-model')
  assert.equal(strippedBacktick, 'model whoami test')
  assert.equal(isValidModelName(strippedBacktick), true)

  // Strips pipes, redirects, backslashes, double quotes
  const strippedPunct = sanitizeModelName('foo | bar < in > out \\ "quote"', 'test-model')
  assert.equal(strippedPunct, 'foo bar in out quote')
  assert.equal(isValidModelName(strippedPunct), true)

  // Normalizes newlines, carriage returns, tabs to spaces
  const strippedNewlines = sanitizeModelName('Foo\r\n\tBar\nBaz', 'test-model')
  assert.equal(strippedNewlines, 'Foo Bar Baz')
  assert.equal(isValidModelName(strippedNewlines), true)

  // Completely malicious string falls back to clean display name from ID
  const fallbackResult = sanitizeModelName('$`;&|<>\\"', 'free/my-cool-model')
  assert.equal(fallbackResult, 'MY Cool Model')
  assert.equal(isValidModelName(fallbackResult), true)

  // Null/undefined/empty falls back
  assert.equal(sanitizeModelName(null, 'free/gemini-3.1-pro'), 'Gemini 3.1 Pro')
  assert.equal(sanitizeModelName('', 'free/gemini-3.1-pro'), 'Gemini 3.1 Pro')
  assert.equal(sanitizeModelName('   ', 'free/gemini-3.1-pro'), 'Gemini 3.1 Pro')

  // Clamps excessively long names
  const longName = 'A'.repeat(200)
  const clamped = sanitizeModelName(longName, 'test-model')
  assert.equal(clamped.length, 128)
  assert.equal(isValidModelName(clamped), true)
})

test('defense-in-depth: importApinexCatalogModels skips invalid IDs and sanitizes malicious names', () => {
  // Verify that an item with malicious model ID or malicious name is handled safely
  const maliciousId = 'free/evil-$(touch /tmp/import-marker)'
  assert.equal(isValidModelId(maliciousId), false)

  // Even if an item somehow had a malicious name, sanitizeModelName strips it
  const evilName = 'Evil Model $(id > /tmp/marker)'
  const safeName = sanitizeModelName(evilName, 'free/safe-fallback')
  assert.equal(safeName, 'Evil Model (id /tmp/marker)')
  assert.doesNotMatch(safeName, /[\$`;&|<>\\"]/)
  assert.equal(isValidModelName(safeName), true)
})

test('admin model routes enforce validation on model creation and updates', async () => {
  const app = Fastify()
  await app.register(cookie)
  await registerRoutes(app)

  // Ensure an admin user exists for testing
  const adminId = 'test-admin-model-val'
  db.prepare(`
    INSERT OR IGNORE INTO admin_users (id, email, password_hash, role, created_at)
    VALUES (?, 'admin-model-val@local', 'hash', 'owner', ?)
  `).run(adminId, nowIso())

  const { sessionId } = createAdminSession(adminId)
  const cookieHeader = `${ADMIN_SESSION_COOKIE}=${sessionId}`

  try {
    // 1. POST /api/admin/models with shell injection in name -> 400
    const resEvilName = await app.inject({
      method: 'POST',
      url: '/api/admin/models',
      headers: {
        host: 'localhost',
        cookie: cookieHeader,
      },
      payload: {
        id: 'free/test-valid-id',
        name: '$(id > /tmp/marker)',
        provider: 'Free',
      },
    })
    assert.equal(resEvilName.statusCode, 400)
    assert.equal(resEvilName.json().error, 'Invalid model name')

    // 2. POST /api/admin/models with shell injection in ID -> 400
    const resEvilId = await app.inject({
      method: 'POST',
      url: '/api/admin/models',
      headers: {
        host: 'localhost',
        cookie: cookieHeader,
      },
      payload: {
        id: 'free/evil-$(touch /tmp/marker)',
        name: 'Valid Name',
        provider: 'Free',
      },
    })
    assert.equal(resEvilId.statusCode, 400)
    assert.equal(resEvilId.json().error, 'API model id may only use letters, numbers, ., _, :, /, -')

    // 3. POST /api/admin/models with valid ID and name -> 200
    const testModelId = 'free/test-validated-model'
    db.prepare('DELETE FROM model_catalog WHERE id = ?').run(testModelId)

    const resValid = await app.inject({
      method: 'POST',
      url: '/api/admin/models',
      headers: {
        host: 'localhost',
        cookie: cookieHeader,
      },
      payload: {
        id: testModelId,
        name: 'Validated Model 1.0 (Test)',
        provider: 'Free',
      },
    })
    assert.equal(resValid.statusCode, 200)
    assert.equal(resValid.json().ok, true)

    // 4. PATCH /api/admin/models/* with malicious name -> 400
    const resPatchEvilName = await app.inject({
      method: 'PATCH',
      url: `/api/admin/models/${encodeURIComponent(testModelId)}`,
      headers: {
        host: 'localhost',
        cookie: cookieHeader,
      },
      payload: {
        name: 'foo; rm -rf /;',
      },
    })
    assert.equal(resPatchEvilName.statusCode, 400)
    assert.equal(resPatchEvilName.json().error, 'Invalid model name')

    // 5. PATCH /api/admin/models/* with malicious next ID -> 400
    const resPatchEvilId = await app.inject({
      method: 'PATCH',
      url: `/api/admin/models/${encodeURIComponent(testModelId)}`,
      headers: {
        host: 'localhost',
        cookie: cookieHeader,
      },
      payload: {
        id: 'evil/id;rm',
      },
    })
    assert.equal(resPatchEvilId.statusCode, 400)
    assert.equal(resPatchEvilId.json().error, 'Invalid model id')

    // 6. PATCH /api/admin/models/* with valid next name -> 200
    const resPatchValid = await app.inject({
      method: 'PATCH',
      url: `/api/admin/models/${encodeURIComponent(testModelId)}`,
      headers: {
        host: 'localhost',
        cookie: cookieHeader,
      },
      payload: {
        name: 'Validated Model 2.0 (Updated)',
      },
    })
    assert.equal(resPatchValid.statusCode, 200)
    assert.equal(resPatchValid.json().ok, true)

    // Clean up
    db.prepare('DELETE FROM model_catalog WHERE id = ?').run(testModelId)
  } finally {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    db.prepare('DELETE FROM admin_users WHERE id = ?').run(adminId)
    await app.close()
  }
})
