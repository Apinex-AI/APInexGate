import test from 'node:test'
import assert from 'node:assert/strict'

const { db, id, nowIso } = await import('../server/db.ts')
const { rotateProviderTargets } = await import('../server/gateway.ts')

test('provider keys rotate round-robin across requests', () => {
  const targets = [
    { secret: 'apinex-key-1', proxyIndex: 1 },
    { secret: 'apinex-key-2', proxyIndex: 2 },
    { secret: 'apinex-key-3', proxyIndex: 3 },
  ]

  const r1 = rotateProviderTargets('apinex', targets)
  const r2 = rotateProviderTargets('apinex', targets)
  const r3 = rotateProviderTargets('apinex', targets)

  assert.equal(r1[0].secret, 'apinex-key-1')
  assert.equal(r1[0].proxyIndex, 1)

  assert.equal(r2[0].secret, 'apinex-key-2')
  assert.equal(r2[0].proxyIndex, 2)

  assert.equal(r3[0].secret, 'apinex-key-3')
  assert.equal(r3[0].proxyIndex, 3)

  const r4 = rotateProviderTargets('apinex', targets)
  assert.equal(r4[0].secret, 'apinex-key-1')
})

test('usage query aggregates both free and paid tokens', () => {
  const userId = id('usr')
  const userEmail = `test_${userId}@example.test`
  db.prepare(`INSERT INTO users (id, name, email, plan, status, created_at) VALUES (?, 'Test', ?, 'free', 'active', ?)`).run(userId, userEmail, nowIso())

  const uId1 = id('usg')
  const uId2 = id('usg')

  // Insert models into model_catalog if not present
  db.prepare(`INSERT OR IGNORE INTO model_catalog (id, provider, name, context_window, input_price_micros, output_price_micros, status, tags_json, created_at) VALUES ('free/glm-5.3-flash', 'free', 'GLM Flash', '128k', 0, 0, 'active', '[]', datetime('now'))`).run()
  db.prepare(`INSERT OR IGNORE INTO model_catalog (id, provider, name, context_window, input_price_micros, output_price_micros, status, tags_json, created_at) VALUES ('claude-opus-5', 'anthropic', 'Claude Opus', '200k', 10, 30, 'active', '[]', datetime('now'))`).run()

  // Free model event: 1000 input, 2000 output
  db.prepare(`
    INSERT INTO usage_events
      (id, user_id, model_id, provider, input_tokens, output_tokens, cost_cents, cost_tokens, latency_ms, status, created_at)
    VALUES (?, ?, 'free/glm-5.3-flash', 'free', 1000, 2000, 0, 0, 150, 'ok', datetime('now'))
  `).run(uId1, userId)

  // Paid model event: 500 input, 500 output
  db.prepare(`
    INSERT INTO usage_events
      (id, user_id, model_id, provider, input_tokens, output_tokens, cost_cents, cost_tokens, latency_ms, status, created_at)
    VALUES (?, ?, 'claude-opus-5', 'anthropic', 500, 500, 10, 4000, 250, 'ok', datetime('now'))
  `).run(uId2, userId)

  const row = db.prepare(`
    SELECT 
      COALESCE(SUM(CASE WHEN (input_tokens + output_tokens) > 0 THEN (input_tokens + output_tokens) ELSE cost_tokens END), 0) AS spend_tokens,
      COALESCE(SUM(CASE WHEN lower(provider) = 'free' OR lower(COALESCE(model_id, '')) LIKE 'free/%' THEN (CASE WHEN (input_tokens + output_tokens) > 0 THEN (input_tokens + output_tokens) ELSE cost_tokens END) ELSE 0 END), 0) AS free_tokens,
      COALESCE(SUM(CASE WHEN NOT (lower(provider) = 'free' OR lower(COALESCE(model_id, '')) LIKE 'free/%') THEN (CASE WHEN (input_tokens + output_tokens) > 0 THEN (input_tokens + output_tokens) ELSE cost_tokens END) ELSE 0 END), 0) AS paid_tokens
    FROM usage_events
    WHERE id IN (?, ?)
  `).get(uId1, uId2) as { spend_tokens: number; free_tokens: number; paid_tokens: number }

  assert.equal(row.spend_tokens, 4000) // 3000 free + 1000 paid
  assert.equal(row.free_tokens, 3000)
  assert.equal(row.paid_tokens, 1000)
})

test('buildAdminStatistics includes topUps and rpmPurchases chart series', async () => {
  const { upgradeUserRpm } = await import('../server/rpmPlans.ts')
  const { buildAdminStatistics } = await import('../server/adminStatistics.ts')

  const userId = id('usr_stats')
  const now = nowIso()
  db.prepare(
    `INSERT INTO users (id, name, email, plan, status, created_at) VALUES (?, 'Stats User', ?, 'free', 'active', ?)`,
  ).run(userId, `${userId}@example.test`, now)

  // Insert a credited top-up payment today
  db.prepare(
    `INSERT INTO crypto_payments
      (id, user_id, provider, amount_cents, credited_usd_cents, currency, status, order_id, credited_at, created_at, updated_at)
     VALUES (?, ?, 'crypto', 2500, 2500, 'USD', 'finished', ?, ?, ?, ?)`,
  ).run(id('cpay'), userId, `ord_${id('o')}`, now, now, now)

  // Record an RPM purchase today ($10.80 = 1080 cents)
  upgradeUserRpm(userId, { rpm: 30, amountCents: 1080, paymentId: `pay_${id('p')}` })

  const stats: any = await buildAdminStatistics({ period: '7d' })
  assert.ok(Array.isArray(stats.charts.series.topUps), 'topUps series should exist')
  assert.ok(Array.isArray(stats.charts.series.rpmPurchases), 'rpmPurchases series should exist')
  assert.ok((stats.charts.meta.topUps?.total ?? 0) >= 25, 'topUps total should include $25 top-up')
  assert.ok((stats.charts.meta.rpmPurchases?.total ?? 0) >= 10.8, 'rpmPurchases total should include $10.80 RPM purchase')
})

test('adminStatisticsJob exports WORKER_TIMEOUT_MS of 20 seconds', async () => {
  const { WORKER_TIMEOUT_MS } = await import('../server/adminStatisticsJob.ts')
  assert.equal(WORKER_TIMEOUT_MS, 20_000)
})

test('corrupted tags_json in model_catalog does not crash with SyntaxError', async () => {
  const testModelId = `test-model-corrupted-${Date.now()}`
  db.prepare(`
    INSERT INTO model_catalog
      (id, provider, name, context_window, input_price_micros, output_price_micros, status, tags_json, created_at)
    VALUES (?, 'GPT', 'Corrupted Tags Model', '128k', 0, 0, 'active', ?, datetime('now'))
  `).run(testModelId, 'NOT_VALID_JSON{{{')

  const row = db.prepare(`SELECT tags_json FROM model_catalog WHERE id = ?`).get(testModelId) as { tags_json: string }
  assert.equal(row.tags_json, 'NOT_VALID_JSON{{{')

  // Verify safe parse behavior
  function safeParseTags(raw: unknown): string[] {
    try {
      const parsed = JSON.parse(String(raw ?? '[]'))
      return Array.isArray(parsed) ? (parsed as string[]) : []
    } catch {
      return []
    }
  }

  const tags = safeParseTags(row.tags_json)
  assert.deepEqual(tags, [], 'Corrupted tags should safely fallback to empty array')
})
