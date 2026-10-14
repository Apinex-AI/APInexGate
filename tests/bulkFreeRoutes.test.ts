import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbPath = join(tmpdir(), `gateway-bulk-free-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`)
mkdirSync(tmpdir(), { recursive: true })
process.env.DB_PATH = dbPath

const { db } = await import('../server/db.ts')

test('bulk-free-routes updates all free models and leaves paid models untouched', () => {
  // Setup sample models
  db.prepare(`DELETE FROM model_upstream_routes`).run()
  db.prepare(`DELETE FROM pricing_rules`).run()
  db.prepare(`DELETE FROM model_catalog`).run()

  db.prepare(`
    INSERT INTO model_catalog (id, upstream_id, upstream_provider, name, provider, context_window, input_price_micros, output_price_micros, token_weight, status, tags_json, created_at)
    VALUES
      ('free/gpt-6-luna', 'old-luna', 'apinex', 'Luna', 'Free', '128K', 0, 0, 1, 'active', '[]', datetime('now')),
      ('free/claude-sonnet-4.6', 'old-claude', 'apinex', 'Claude', 'Free', '128K', 0, 0, 1, 'active', '[]', datetime('now')),
      ('openai/gpt-5.6', 'official-gpt', 'apinex', 'GPT 5.6', 'GPT', '128K', 1000000, 2000000, 1, 'active', '[]', datetime('now'))
  `).run()

  db.prepare(`
    INSERT INTO model_upstream_routes (model_id, position, upstream_provider, upstream_id)
    VALUES
      ('free/gpt-6-luna', 1, 'apinex', 'old-luna'),
      ('free/claude-sonnet-4.6', 1, 'apinex', 'old-claude'),
      ('openai/gpt-5.6', 1, 'apinex', 'official-gpt')
  `).run()

  const cleanRoutes = [
    { provider: 'apinex', modelId: 'glm-5.3-flash' },
  ]
  const primary = cleanRoutes[0]

  const freeModels = db.prepare(`SELECT id FROM model_catalog WHERE provider = 'Free'`).all() as Array<{ id: string }>
  assert.equal(freeModels.length, 2)

  db.transaction(() => {
    db.prepare(`UPDATE model_catalog SET upstream_provider = ?, upstream_id = ? WHERE provider = 'Free'`).run(
      primary.provider,
      primary.modelId,
    )
    db.prepare(`DELETE FROM model_upstream_routes WHERE model_id IN (SELECT id FROM model_catalog WHERE provider = 'Free')`).run()
    const insertRoute = db.prepare(`INSERT INTO model_upstream_routes (model_id, position, upstream_provider, upstream_id) VALUES (?, ?, ?, ?)`)
    for (const model of freeModels) {
      cleanRoutes.forEach((route, index) => {
        insertRoute.run(model.id, index + 1, route.provider, route.modelId)
      })
    }
  })()

  // Verify free models
  const updatedFree1 = db.prepare(`SELECT upstream_provider, upstream_id FROM model_catalog WHERE id = 'free/gpt-6-luna'`).get() as { upstream_provider: string; upstream_id: string }
  assert.equal(updatedFree1.upstream_provider, 'apinex')
  assert.equal(updatedFree1.upstream_id, 'glm-5.3-flash')

  const free1Routes = db.prepare(`SELECT position, upstream_provider, upstream_id FROM model_upstream_routes WHERE model_id = 'free/gpt-6-luna' ORDER BY position ASC`).all() as Array<{ position: number; upstream_provider: string; upstream_id: string }>
  assert.equal(free1Routes.length, 1)
  assert.deepEqual(free1Routes, [
    { position: 1, upstream_provider: 'apinex', upstream_id: 'glm-5.3-flash' },
  ])

  // Verify paid model was untouched
  const paid = db.prepare(`SELECT upstream_provider, upstream_id FROM model_catalog WHERE id = 'openai/gpt-5.6'`).get() as { upstream_provider: string; upstream_id: string }
  assert.equal(paid.upstream_provider, 'apinex')
  assert.equal(paid.upstream_id, 'official-gpt')

  const paidRoutes = db.prepare(`SELECT position, upstream_provider, upstream_id FROM model_upstream_routes WHERE model_id = 'openai/gpt-5.6' ORDER BY position ASC`).all() as Array<{ position: number; upstream_provider: string; upstream_id: string }>
  assert.equal(paidRoutes.length, 1)
  assert.equal(paidRoutes[0].upstream_provider, 'apinex')
})
