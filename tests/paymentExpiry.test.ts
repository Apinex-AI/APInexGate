import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.DB_PATH = join(tmpdir(), `gateway-payment-expiry-${Date.now()}.sqlite`)

const { db } = await import('../server/db.ts')
const { expireStalePaymentInvoices, PAYMENT_TTL_MS, MAX_INVOICES_PER_WINDOW } = await import('../server/paymentExpiry.ts')

const tables = ['crypto_payments', 'subscription_payments']

function insertPayment(table: string, id: string, status: string, createdAt: string, creditedAt: string | null) {
  let columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }>
  if (columns.length === 0) {
    db.exec(`CREATE TABLE ${table} (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      raw_status TEXT,
      credited_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    columns = db.prepare(`PRAGMA table_info(${table})`).all() as typeof columns
  }
  const values: Record<string, unknown> = {
    id,
    status,
    raw_status: status,
    credited_at: creditedAt,
    created_at: createdAt,
    updated_at: createdAt,
  }
  for (const column of columns) {
    if (column.name in values || column.pk || !column.notnull || column.dflt_value != null) continue
    values[column.name] = column.type.toUpperCase().includes('INT') ? 1 : `${column.name}-${id}`
  }
  const names = Object.keys(values).filter((name) => columns.some((column) => column.name === name))
  const placeholders = names.map(() => '?').join(', ')
  db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`).run(...names.map((name) => values[name]))
}

test('invoice policy is 7 creates per 15 minutes', () => {
  assert.equal(PAYMENT_TTL_MS, 15 * 60 * 1000)
  assert.equal(MAX_INVOICES_PER_WINDOW, 7)
})

test('stale open invoices expire across every payment table', () => {
  db.pragma('foreign_keys = OFF')
  const now = new Date('2026-09-02T12:00:00.000Z')
  const stale = '2026-09-02T11:44:59.000Z'
  const fresh = '2026-09-02T11:45:01.000Z'

  for (const table of tables) {
    insertPayment(table, `${table}-stale`, 'waiting', stale, null)
    insertPayment(table, `${table}-fresh`, 'waiting', fresh, null)
    insertPayment(table, `${table}-paid`, 'finished', stale, stale)
  }

  assert.equal(expireStalePaymentInvoices(now), tables.length)

  for (const table of tables) {
    const rows = db.prepare(`SELECT id, status FROM ${table} ORDER BY id`).all() as Array<{ id: string; status: string }>
    assert.equal(rows.find((row) => row.id.endsWith('-stale'))?.status, 'expired')
    assert.equal(rows.find((row) => row.id.endsWith('-fresh'))?.status, 'waiting')
    assert.equal(rows.find((row) => row.id.endsWith('-paid'))?.status, 'finished')
  }
  db.pragma('foreign_keys = ON')
})
