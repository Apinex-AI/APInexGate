import { db, nowIso } from './db.js'

export function canonicalizeEmail(email: string | null | undefined): string {
  const raw = String(email ?? '').trim().toLowerCase()
  const at = raw.lastIndexOf('@')
  if (at <= 0) return raw
  const local = raw.slice(0, at)
  const domain = raw.slice(at + 1)
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const cleanLocal = local.split('+')[0]?.replace(/\./g, '') || ''
    return `${cleanLocal}@gmail.com`
  }
  return `${local}@${domain}`
}

export function normalizeBlockedIdentity(value: string | null | undefined) {
  return canonicalizeEmail(value)
}

export function isEmailBlocked(email: string | null | undefined) {
  const canonical = canonicalizeEmail(email)
  const raw = String(email ?? '').trim().toLowerCase()
  if (!canonical) return false
  const row = db
    .prepare(`SELECT 1 AS ok FROM blocked_emails WHERE email = ? OR email = ?`)
    .get(canonical, raw) as { ok: number } | undefined
  return Boolean(row)
}

export function blockEmail(email: string, reason = 'multiaccount') {
  const canonical = canonicalizeEmail(email)
  if (!canonical) return
  db.prepare(
    `INSERT OR IGNORE INTO blocked_emails (email, reason, created_at) VALUES (?, ?, ?)`,
  ).run(canonical, reason, nowIso())
}

export const BLOCKED_EMAIL_MESSAGE = 'This email cannot be used to register.'
