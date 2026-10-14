import { db, nowIso } from './db.js'
import { createAdminSession } from './auth.js'

export function ensureAdminLoginApprovalTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_login_approvals (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      admin_email TEXT NOT NULL,
      device TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      telegram_message_id INTEGER,
      decided_by TEXT,
      session_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_admin_login_approvals_status
      ON admin_login_approvals (status, expires_at);
  `)
}

ensureAdminLoginApprovalTable()
{
  const cols = db.prepare('PRAGMA table_info(admin_login_approvals)').all() as Array<{ name: string }>
  if (!cols.some((column) => column.name === 'callback_token')) {
    db.exec('ALTER TABLE admin_login_approvals ADD COLUMN callback_token TEXT')
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_login_approvals_callback ON admin_login_approvals (callback_token)',
    )
  }
}


function expireStalePending() {
  db.prepare(
    `UPDATE admin_login_approvals
     SET status = 'expired', decided_at = ?
     WHERE status = 'pending' AND expires_at <= ?`,
  ).run(nowIso(), nowIso())
}

export async function createAdminLoginApproval(input: {
  adminId: string
  adminEmail: string
}) {
  expireStalePending()
  const session = createAdminSession(input.adminId)
  return {
    pending: false as const,
    session,
  }
}

export function getAdminLoginApprovalStatus(requestId: string) {
  expireStalePending()
  const row = db
    .prepare(
      `SELECT id, admin_id, admin_email, status, session_id, expires_at, decided_at
       FROM admin_login_approvals WHERE id = ?`,
    )
    .get(requestId) as
    | {
        id: string
        admin_id: string
        admin_email: string
        status: string
        session_id: string | null
        expires_at: string
        decided_at: string | null
      }
    | undefined

  if (!row) return { ok: false as const, reason: 'not_found' as const }

  if (row.status === 'pending' && Date.parse(row.expires_at) <= Date.now()) {
    db.prepare(
      `UPDATE admin_login_approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(nowIso(), row.id)
    return { ok: true as const, status: 'expired' as const, requestId: row.id }
  }

  if (row.status === 'approved' && row.session_id) {
    const session = db
      .prepare(`SELECT id, expires_at FROM sessions WHERE id = ?`)
      .get(row.session_id) as { id: string; expires_at: string } | undefined
    if (session) {
      return {
        ok: true as const,
        status: 'approved' as const,
        requestId: row.id,
        adminId: row.admin_id,
        adminEmail: row.admin_email,
        sessionId: session.id,
        expiresAt: session.expires_at,
      }
    }
  }

  return {
    ok: true as const,
    status: row.status as 'pending' | 'approved' | 'denied' | 'expired',
    requestId: row.id,
  }
}

/** Claim a one-time session token after approval (prevents double cookie set races). */
export function claimApprovedLoginSession(requestId: string) {
  const status = getAdminLoginApprovalStatus(requestId)
  if (!status.ok) return status
  if (status.status !== 'approved' || !('sessionId' in status) || !status.sessionId) {
    return { ok: true as const, status: status.status }
  }

  // Mark consumed so polling cannot re-issue infinitely; session itself remains valid.
  db.prepare(
    `UPDATE admin_login_approvals
     SET status = 'consumed', decided_at = COALESCE(decided_at, ?)
     WHERE id = ? AND status = 'approved'`,
  ).run(nowIso(), requestId)

  const changed = db.prepare(`SELECT changes() AS n`).get() as { n: number }
  if (!changed.n) {
    // Already consumed by another poll.
    return { ok: true as const, status: 'consumed' as const }
  }

  return {
    ok: true as const,
    status: 'approved' as const,
    sessionId: status.sessionId,
    expiresAt: status.expiresAt,
    adminId: status.adminId,
    adminEmail: status.adminEmail,
  }
}
