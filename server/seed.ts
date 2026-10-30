import { db, id, nowIso } from './db.js'
import { hashPassword, verifyPassword } from './auth.js'

const adminEmail = 'admin@localhost'

export function ensureAdminUser() {
  const adminPassword = (process.env.ADMIN_PASSWORD ?? '').trim()
  if (!adminPassword) {
    console.warn('ADMIN_PASSWORD is not set; admin login is disabled until it is configured.')
    return
  }
  const timestamp = nowIso()
  const passwordHash = hashPassword(adminPassword)

  const existing = db
    .prepare('SELECT id, password_hash FROM admin_users WHERE email = ?')
    .get(adminEmail) as { id: string; password_hash?: string } | undefined
  if (existing) {
    const passwordChanged = !existing.password_hash || !verifyPassword(adminPassword, existing.password_hash)
    if (passwordChanged) {
      db.prepare('UPDATE admin_users SET password_hash = ?, role = ? WHERE id = ?').run(
        passwordHash,
        'owner',
        existing.id,
      )
      // D39: Immediately revoke all existing sessions if admin password was rotated
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id)
    } else {
      db.prepare('UPDATE admin_users SET role = ? WHERE id = ?').run('owner', existing.id)
    }
    return
  }

  // Migrate away from any previous local admin account.
  db.prepare('DELETE FROM sessions').run()
  db.prepare('DELETE FROM admin_users').run()
  db.prepare(
    'INSERT INTO admin_users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id('admin'), adminEmail, passwordHash, 'owner', timestamp)
}

ensureAdminUser()

if (process.argv[1]?.includes('seed')) {
  console.log(`Admin ready: ${adminEmail}`)
  console.log(`Database: ${process.env.DB_PATH ?? './data/gateway.sqlite'}`)
}
