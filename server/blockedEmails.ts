import { db, nowIso } from './db.js'

export function normalizeBlockedIdentity(value: string | null | undefined) {
  return String(value ?? '').trim().toLowerCase()
}

export function isEmailBlocked(email: string | null | undefined) {
  const key = normalizeBlockedIdentity(email)
  if (!key) return false
  const row = db.prepare(`SELECT 1 AS ok FROM blocked_emails WHERE email = ?`).get(key) as { ok: number } | undefined
  return Boolean(row)
}

export function blockEmail(email: string, reason = 'multiaccount') {
  const key = normalizeBlockedIdentity(email)
  if (!key) return
  db.prepare(
    `INSERT OR IGNORE INTO blocked_emails (email, reason, created_at) VALUES (?, ?, ?)`,
  ).run(key, reason, nowIso())
}

export const BLOCKED_EMAIL_MESSAGE = 'This email cannot be used to register.'
