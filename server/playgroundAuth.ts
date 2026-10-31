import { createHash, randomBytes } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { getCustomerSessionUser } from './auth.js'
import { db, id, nowIso } from './db.js'

/** Hidden key so playground billing has a real api_keys row without showing up in the customer key list. */
export const PLAYGROUND_KEY_NAME = '__playground'

export function stripPlaygroundTools(body: Record<string, unknown>) {
  delete body.tools
  delete body.tool_choice
  delete body.functions
  delete body.function_call
  delete body.parallel_tool_calls
  if (!Array.isArray(body.messages)) return
  body.messages = body.messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return []
    const row = { ...(message as Record<string, unknown>) }
    if (row.role === 'tool' || row.role === 'function') return []
    delete row.tool_calls
    delete row.function_call
    return [row]
  })
}

export function ensurePlaygroundKey(userId: string) {
  const existing = db
    .prepare(`SELECT id FROM api_keys WHERE user_id = ? AND name = ?`)
    .get(userId, PLAYGROUND_KEY_NAME) as { id: string } | undefined
  if (existing) {
    db.prepare(`UPDATE api_keys SET status = 'active', spend_limit_tokens = NULL WHERE id = ?`).run(existing.id)
    return existing.id
  }
  const keyId = id('key')
  const secret = `sk-${randomBytes(32).toString('hex')}`
  const secretHash = createHash('sha256').update(secret).digest('hex')
  const prefix = `${secret.slice(0, 12)}…${secret.slice(-4)}`
  db.prepare(
    `INSERT INTO api_keys
      (id, user_id, name, prefix, secret_hash, secret, spend_limit_tokens, spent_tokens, status, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, 'active', ?, NULL)`,
  ).run(keyId, userId, PLAYGROUND_KEY_NAME, prefix, secretHash, nowIso())
  return keyId
}

export function playgroundSessionUser(request: FastifyRequest) {
  const session = getCustomerSessionUser(request)
  if (!session) return null
  const user = db
    .prepare(
      `SELECT id, balance_tokens, COALESCE(reserved_tokens, 0) AS reserved_tokens, status, requests
       FROM users WHERE id = ?`,
    )
    .get(session.id) as
    | { id: string; balance_tokens: number; reserved_tokens: number; status: string; requests: number }
    | undefined
  if (!user || user.status !== 'active') return null
  const keyId = ensurePlaygroundKey(user.id)
  return {
    key: {
      id: keyId,
      user_id: user.id,
      spend_limit_tokens: null as number | null,
      spent_tokens: 0,
      reserved_tokens: 0,
      status: 'active',
    },
    user,
  }
}
