import { db, id, nowIso } from './db.js'
import { hashPassword, verifyPassword } from './auth.js'
import { APINEX_CATALOG_DEFAULTS } from './providerKeys.js'

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

export function ensureDefaultModels() {
  const count = (db.prepare('SELECT COUNT(*) as n FROM model_catalog').get() as { n: number })?.n ?? 0
  if (count > 0) return

  const insert = db.prepare(`
    INSERT INTO model_catalog
      (id, provider, name, context_window, input_price_micros, output_price_micros, status, tags_json, created_at, upstream_id, upstream_provider, token_weight, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, 'active', '[]', ?, ?, 'apinex', ?, ?)
  `)

  let order = 10
  const now = nowIso()
  db.transaction(() => {
    for (const [modelId, spec] of Object.entries(APINEX_CATALOG_DEFAULTS)) {
      const inMicros = Math.round(spec.dollarsPer1M * 1_000_000)
      const outMicros = Math.round((spec.outputDollarsPer1M ?? spec.dollarsPer1M) * 1_000_000)
      insert.run(modelId, spec.provider, spec.name, spec.contextWindow, inMicros, outMicros, now, modelId, spec.tokenWeight, order)
      order += 10
    }
  })()
  console.log(`[seed] Populated ${Object.keys(APINEX_CATALOG_DEFAULTS).length} default models into catalog`)
}

ensureAdminUser()
ensureDefaultModels()

if (process.argv[1]?.includes('seed')) {
  console.log(`Admin ready: ${adminEmail}`)
  console.log(`Database: ${process.env.DB_PATH ?? './data/gateway.sqlite'}`)
}
