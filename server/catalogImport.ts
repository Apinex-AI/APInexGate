import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { db, id, nowIso } from './db.js'
import { isUpstreamProvider } from '../shared/providers.js'
import { secretHint } from './providerKeys.js'

type JsonProvider = {
  provider?: string
  email?: string
  secret?: string
  status?: string
  priority?: number
  proxyIndex?: number | null
  cookies?: unknown
  meta?: Record<string, unknown>
}

function readJson<T>(filename: string): T | null {
  const path = resolve(process.cwd(), filename)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Imports provider keys from providers.json. Models are added only from the admin. */
export function importCatalogFiles() {
  importProviders()
}

function importProviders() {
  const payload = readJson<{ providers?: JsonProvider[] }>('providers.json')
  if (!payload?.providers?.length) return
  const insert = db.prepare(
    `INSERT INTO provider_keys
      (id, provider, email, secret, secret_hint, balance_tokens, balance_usd_cents, status,
       last_synced_at, last_error, low_balance_notified_at, low_balance_notified_json, priority, proxy_index, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, NULL, NULL, NULL, '{}', ?, ?, ?, ?)`,
  )
  const update = db.prepare(
    `UPDATE provider_keys
     SET provider = ?, email = ?, secret_hint = ?, status = ?, priority = ?, proxy_index = ?, meta_json = ?
     WHERE secret = ?`,
  )
  let added = 0
  db.transaction(() => {
    for (const row of payload.providers ?? []) {
      const provider = String(row.provider ?? '').trim().toLowerCase()
      const secret = String(row.secret ?? '').trim()
      const email = String(row.email ?? '').trim().toLowerCase()
      if (!provider || !secret || !isUpstreamProvider(provider)) continue
      const status = ['healthy', 'active', 'pending', 'exhausted'].includes(String(row.status))
        ? String(row.status)
        : 'pending'
      const priority = Number.isFinite(Number(row.priority)) ? Math.round(Number(row.priority)) : 100
      const proxyIndex = row.proxyIndex == null || !Number.isFinite(Number(row.proxyIndex)) ? null : Math.round(Number(row.proxyIndex))
      const meta = {
        ...(row.meta && typeof row.meta === 'object' ? row.meta : {}),
        cookies: Array.isArray(row.cookies) && row.cookies.length ? row.cookies : undefined,
      }
      const existing = db.prepare(`SELECT id FROM provider_keys WHERE secret = ?`).get(secret) as { id: string } | undefined
      if (existing) {
        update.run(provider, email || provider, secretHint(secret), status, priority, proxyIndex, JSON.stringify(meta), secret)
        continue
      }
      insert.run(id('pkey'), provider, email || provider, secret, secretHint(secret), status, priority, proxyIndex, JSON.stringify(meta), nowIso())
      added += 1
    }
  })()
  if (added) console.log(`Imported ${added} provider keys from providers.json`)
}
