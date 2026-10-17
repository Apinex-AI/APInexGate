import assert from 'node:assert/strict'
import test from 'node:test'

process.env.DB_PATH = ':memory:'

const {
  isUpstreamProvider,
  normalizeProviderName,
  UPSTREAM_PROVIDERS,
  UPSTREAM_PROVIDER_LABELS,
} = await import('../shared/providers.ts')
const {
  APINEX_BASE_URL,
  APINEX_CATALOG_DEFAULTS,
  createProviderKey,
  deleteProviderKey,
  familyFromUpstreamId,
} = await import('../server/providerKeys.ts')
const {
  buildDecisionPayload,
  buildUpstreamRequestHeaders,
  isDecisionModelId,
  registerGatewayRoutes,
} = await import('../server/gateway.ts')
const { db, id, nowIso } = await import('../server/db.ts')
const Fastify = (await import('fastify')).default
const { createHash } = await import('node:crypto')

test('buildUpstreamRequestHeaders enforces src: gate and prevents client override', () => {
  const headers = buildUpstreamRequestHeaders('sk-apx-secret', {
    src: 'spoofed',
    SRC: 'spoofed-upper',
    'X-Custom': 'allowed',
  })
  assert.equal(headers.src, 'gate')
  assert.equal('SRC' in headers, false)
  assert.equal(headers.Authorization, 'Bearer sk-apx-secret')
  assert.equal(headers['X-Custom'], 'allowed')
})

test('APInex provider is the primary upstream provider', () => {
  assert.equal(isUpstreamProvider('apinex'), true)
  assert.equal(UPSTREAM_PROVIDERS[0], 'apinex')
  assert.equal(UPSTREAM_PROVIDER_LABELS.apinex, 'APInex')
  assert.equal(APINEX_BASE_URL, 'https://api.apinex.bond/v1')
})

test('enforces strict lock of at most 1 APInex provider key', () => {
  // Clear any existing keys for clean test
  db.exec('DELETE FROM provider_keys')

  const key1 = createProviderKey({
    provider: 'apinex',
    email: 'admin@apinex.bond',
    secret: 'sk-apinex-test-key-1',
  })
  assert.ok(key1)

  // Adding second key should throw error due to 1-key limit lock
  assert.throws(
    () => {
      createProviderKey({
        provider: 'apinex',
        email: 'admin2@apinex.bond',
        secret: 'sk-apinex-test-key-2',
      })
    },
    /Only 1 APInex provider key is allowed/,
  )

  // Cleaning up
  deleteProviderKey(key1)
})

test('Jev Group models (jev, subq, drex, gpt-6-luna-decisions) map to Jev Group, while free decision models stay in Free', () => {
  assert.equal(familyFromUpstreamId('jev-1.13'), 'Jev Group')
  assert.equal(familyFromUpstreamId('drex-v2.0'), 'Jev Group')
  assert.equal(familyFromUpstreamId('subq-snap-preview'), 'Jev Group')
  assert.equal(familyFromUpstreamId('gpt-6-luna-decisions'), 'Jev Group')
  assert.equal(familyFromUpstreamId('gpt-6-luna'), 'GPT')

  assert.equal(normalizeProviderName('jev'), 'Jev Group')
  assert.equal(normalizeProviderName('jev group'), 'Jev Group')
  assert.equal(normalizeProviderName('decisions'), 'Jev Group')

  assert.equal(APINEX_CATALOG_DEFAULTS['jev-1.13']?.provider, 'Jev Group')
  assert.equal(APINEX_CATALOG_DEFAULTS['drex-v2.0']?.provider, 'Jev Group')
  assert.equal(APINEX_CATALOG_DEFAULTS['subq-snap-preview']?.provider, 'Jev Group')
  assert.equal(APINEX_CATALOG_DEFAULTS['gpt-6-luna-decisions']?.provider, 'Jev Group')
  assert.equal(APINEX_CATALOG_DEFAULTS['free/jev-1.13']?.provider, 'Free')

  assert.equal(isDecisionModelId('jev-1.13'), true)
  assert.equal(isDecisionModelId('drex-v2.0'), true)
  assert.equal(isDecisionModelId('subq-snap-preview'), true)
  assert.equal(isDecisionModelId('gpt-6-luna-decisions'), true)
  assert.equal(isDecisionModelId('free/jev-1.13'), true)
  assert.equal(isDecisionModelId('gpt-6-luna'), false)
  assert.equal(isDecisionModelId('claude-opus-5.5'), false)
})

test('buildDecisionPayload supports both TypeSafe/SubQ and OpenAI Decisions shapes', () => {
  const tsPayload = buildDecisionPayload(
    {
      model: 'jev-1.13',
      state: 'Test input',
      questions: {
        is_safe: { type: 'predicate', instructions: 'Is it safe?' },
      },
    },
    'jev-1.13',
  )
  assert.equal(tsPayload.model, 'jev-1.13')
  assert.equal(tsPayload.state, 'Test input')
  assert.deepEqual(tsPayload.questions, {
    is_safe: { type: 'noul', instructions: 'Is it safe?' },
  })

  const oaiPayload = buildDecisionPayload(
    {
      model: 'subq-snap-preview',
      input: 'Test input',
      questions: [
        {
          type: 'score',
          name: 'urgency',
          instructions: 'Rate urgency',
          levels: [{ value: 'low' }, { label: 'high' }],
        },
      ],
    },
    'subq-snap-preview',
  )
  assert.equal(oaiPayload.model, 'subq-snap-preview')
  assert.equal(oaiPayload.input, 'Test input')
  assert.deepEqual(oaiPayload.questions, [
    {
      type: 'score',
      name: 'urgency',
      instructions: 'Rate urgency',
      levels: [{ label: 'low' }, { label: 'high' }],
    },
  ])
})

test('calling a Decision model (paid Jev Group or free/jev-1.13) on /v1/chat/completions, /v1/responses, or /v1/messages returns 400 pointing to /v1/decisions', async () => {
  const app = Fastify()
  await registerGatewayRoutes(app)

  const userId = id('user_dec')
  const keyId = id('key_dec')
  const rawSecret = 'sk-test-decision-key-12345'
  const secretHash = createHash('sha256').update(rawSecret).digest('hex')
  const now = nowIso()

  db.prepare(
    `INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
     VALUES (?, 'Decision Tester', ?, 'default', 'active', 1000, 10000000, 0, ?)`,
  ).run(userId, `${userId}@example.test`, now)

  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, prefix, secret_hash, secret, status, created_at)
     VALUES (?, ?, 'Test', 'sk-test', ?, ?, 'active', ?)`,
  ).run(keyId, userId, secretHash, rawSecret, now)

  // Seed paid Jev Group model, free decision model, and normal chat model
  const insertModel = db.prepare(
    `INSERT OR REPLACE INTO model_catalog
      (id, provider, name, context_window, input_price_micros, output_price_micros, status, tags_json, created_at, upstream_id, upstream_provider, token_weight, sort_order)
     VALUES (?, ?, ?, '64K', ?, 0, 'active', '[]', ?, ?, 'apinex', ?, 10)`,
  )
  insertModel.run('jev-1.13', 'Jev Group', 'Jev 1.13', 42_000, now, 'jev-1.13', 0)
  insertModel.run('free/jev-1.13', 'Free', 'Jev 1.13', 0, now, 'free/jev-1.13', 1)
  insertModel.run('claude-opus-5.5', 'Claude', 'Claude Opus 5.5', 500_000, now, 'claude-opus-5.5', 0)

  for (const modelId of ['jev-1.13', 'free/jev-1.13']) {
    for (const endpoint of ['/v1/chat/completions', '/v1/responses', '/v1/messages']) {
      const res = await app.inject({
        method: 'POST',
        url: endpoint,
        headers: { authorization: `Bearer ${rawSecret}` },
        payload: {
          model: modelId,
          messages: [{ role: 'user', content: 'Hello' }],
          input: 'Hello',
          max_tokens: 64,
        },
      })
      assert.equal(res.statusCode, 400, `Expected 400 for ${modelId} on ${endpoint}`)
      const body = res.json()
      const msg = body.error?.message ?? ''
      assert.match(msg, /POST \/v1\/decisions/i)
    }
  }

  // Calling a regular non-decision chat model on /v1/decisions should also return 400
  const badDec = await app.inject({
    method: 'POST',
    url: '/v1/decisions',
    headers: { authorization: `Bearer ${rawSecret}` },
    payload: {
      model: 'claude-opus-5.5',
      state: 'Test',
      questions: { q1: { type: 'noul', instructions: 'Test?' } },
    },
  })
  assert.equal(badDec.statusCode, 400)
  assert.match(badDec.json().error?.message ?? '', /not a Jev Group Decision model/i)

  await app.close()
})

test('end-to-end /v1/decisions execution for paid Jev Group models and free/jev-1.13 with upstream mock', async () => {
  const { getFreeTierAccess } = await import('../server/subscriptions.ts')
  const { setGlobalDispatcher, getGlobalDispatcher, MockAgent } = await import('undici')

  const prevDispatcher = getGlobalDispatcher()
  const mockAgent = new MockAgent()
  mockAgent.disableNetConnect()
  setGlobalDispatcher(mockAgent)

  const pool = mockAgent.get('https://api.apinex.bond')
  pool
    .intercept({ path: '/v1/decisions', method: 'POST' })
    .reply(200, (opts) => {
      const reqBody = JSON.parse(String(opts.body ?? '{}'))
      return {
        object: 'decision',
        model: reqBody.model,
        answers: {
          is_safe: { type: 'noul', noul: 0.99 },
        },
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 200,
          total_tokens: 1_200,
        },
      }
    })
    .persist()

  try {
    db.exec('DELETE FROM provider_keys')
    const pkey = createProviderKey({
      provider: 'apinex',
      email: 'upstream@apinex.bond',
      secret: 'sk-apx-live-upstream-key',
    })

    const app = Fastify()
    await registerGatewayRoutes(app)

    const userId = id('user_e2e_dec')
    const keyId = id('key_e2e_dec')
    const rawSecret = 'sk-test-e2e-decision-key'
    const secretHash = createHash('sha256').update(rawSecret).digest('hex')
    const now = nowIso()

    // Start user with $1.00 = 1,000,000 balance_tokens
    db.prepare(
      `INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
       VALUES (?, 'E2E Decision User', ?, 'default', 'active', 100, 1000000, 0, ?)`,
    ).run(userId, `${userId}@example.test`, now)

    db.prepare(
      `INSERT INTO api_keys (id, user_id, name, prefix, secret_hash, secret, status, created_at)
       VALUES (?, ?, 'E2E Key', 'sk-e2e', ?, ?, 'active', ?)`,
    ).run(keyId, userId, secretHash, rawSecret, now)

    const insertModel = db.prepare(
      `INSERT OR REPLACE INTO model_catalog
        (id, provider, name, context_window, input_price_micros, output_price_micros, status, tags_json, created_at, upstream_id, upstream_provider, token_weight, sort_order)
       VALUES (?, ?, ?, '64K', ?, 0, 'active', '[]', ?, ?, 'apinex', ?, 10)`,
    )
    insertModel.run('jev-1.13', 'Jev Group', 'Jev 1.13', 42_000, now, 'jev-1.13', 0)
    insertModel.run('drex-v2.0', 'Jev Group', 'Drex 2.0', 40_000, now, 'drex-v2.0', 0)
    insertModel.run('subq-snap-preview', 'Jev Group', 'SubQ Snap (Preview)', 50_000, now, 'subq-snap-preview', 0)
    insertModel.run('gpt-6-luna-decisions', 'Jev Group', 'GPT-6 Luna (Decisions)', 100_000, now, 'gpt-6-luna-decisions', 0)
    insertModel.run('free/jev-1.13', 'Free', 'Jev 1.13', 0, now, 'free/jev-1.13', 1)

    // 1. Paid Jev Group model (jev-1.13 at $0.042/1M input, $0 output)
    const paidRes = await app.inject({
      method: 'POST',
      url: '/v1/decisions',
      headers: { authorization: `Bearer ${rawSecret}` },
      payload: {
        model: 'jev-1.13',
        state: 'Backup database script',
        questions: {
          is_safe: { type: 'noul', instructions: 'Is this safe?' },
        },
      },
    })
    assert.equal(paidRes.statusCode, 200)
    const paidBody = paidRes.json()
    assert.equal(paidBody.object, 'decision')
    assert.equal(paidBody.model, 'jev-1.13')
    assert.equal(paidBody.answers?.is_safe?.noul, 0.99)
    assert.equal(paidBody.usage?.prompt_tokens, 1_000)

    // 1,000 input tokens at $0.042/1M = $0.000042 = 42 wallet tokens (output is $0 -> 0 tokens)
    const balAfterPaid = (
      db.prepare('SELECT balance_tokens FROM users WHERE id = ?').get(userId) as { balance_tokens: number }
    ).balance_tokens
    assert.equal(balAfterPaid, 1_000_000 - 42)

    // 2. Free decision model (free/jev-1.13): should NOT deduct wallet balance, should deduct free tier tokens
    const freeBefore = getFreeTierAccess(userId).used
    const freeRes = await app.inject({
      method: 'POST',
      url: '/v1/decisions',
      headers: { authorization: `Bearer ${rawSecret}` },
      payload: {
        model: 'free/jev-1.13',
        input: 'Check this message',
        questions: [
          { type: 'predicate', name: 'is_safe', instructions: 'Is it safe?' },
        ],
      },
    })
    assert.equal(freeRes.statusCode, 200)
    const freeBody = freeRes.json()
    assert.equal(freeBody.model, 'free/jev-1.13')
    assert.equal(freeBody.answers?.is_safe?.noul, 0.99)

    const balAfterFree = (
      db.prepare('SELECT balance_tokens FROM users WHERE id = ?').get(userId) as { balance_tokens: number }
    ).balance_tokens
    assert.equal(balAfterFree, balAfterPaid, 'Free decision model must not charge USD wallet')

    const freeAfter = getFreeTierAccess(userId).used
    assert.equal(freeAfter - freeBefore, 1_200, 'Free decision model must meter against free allowance')

    // 3. Test drex-v2.0, subq-snap-preview, and gpt-6-luna-decisions on /v1/decisions
    for (const mId of ['drex-v2.0', 'subq-snap-preview', 'gpt-6-luna-decisions']) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/decisions',
        headers: { authorization: `Bearer ${rawSecret}` },
        payload: {
          model: mId,
          state: 'Test content',
          questions: { is_safe: { type: 'noul', instructions: 'Safe?' } },
        },
      })
      assert.equal(r.statusCode, 200, `Expected 200 on /v1/decisions for ${mId}`)
      assert.equal(r.json().model, mId)
    }

    deleteProviderKey(pkey)
    await app.close()
  } finally {
    setGlobalDispatcher(prevDispatcher)
    await mockAgent.close()
  }
})

test('separate /v1/balance, /v1/subscription, and /v1/rpm endpoints return clean dedicated payloads', async () => {
  const { activateSubscription } = await import('../server/subscriptions.ts')
  const { setUserRpmGrant } = await import('../server/rpmPlans.ts')

  const app = Fastify()
  await registerGatewayRoutes(app)

  const userId = id('user_status_eps')
  const keyId = id('key_status_eps')
  const rawSecret = 'sk-test-status-endpoints-key'
  const secretHash = createHash('sha256').update(rawSecret).digest('hex')
  const now = nowIso()

  // $12.50 = 12,500,000 balance_tokens
  db.prepare(
    `INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
     VALUES (?, 'Status User', ?, 'default', 'active', 1250, 12500000, 0, ?)`,
  ).run(userId, `${userId}@example.test`, now)

  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, prefix, secret_hash, secret, spend_limit_tokens, spent_tokens, status, created_at)
     VALUES (?, ?, 'Status Key', 'sk-stat', ?, ?, 5000000, 1000000, 'active', ?)`,
  ).run(keyId, userId, secretHash, rawSecret, now)

  // 1. GET /v1/balance
  const balRes = await app.inject({
    method: 'GET',
    url: '/v1/balance',
    headers: { authorization: `Bearer ${rawSecret}` },
  })
  assert.equal(balRes.statusCode, 200)
  const bal = balRes.json()
  assert.equal(bal.object, 'balance')
  assert.equal(bal.balance_usd, 12.5)
  assert.equal(bal.reserved_usd, 0)
  assert.equal(bal.api_key.spend_limit_usd, 5)
  assert.equal(bal.api_key.spent_usd, 1)
  assert.equal(bal.api_key.remaining_usd, 4)
  assert.equal('subscription' in bal, false, '/v1/balance must not include subscription')
  assert.equal('rpm' in bal, false, '/v1/balance must not include rpm')

  // 2. GET /v1/subscription (free tier initially, then active subscription)
  const subFreeRes = await app.inject({
    method: 'GET',
    url: '/v1/subscription',
    headers: { authorization: `Bearer ${rawSecret}` },
  })
  assert.equal(subFreeRes.statusCode, 200)
  const subFree = subFreeRes.json()
  assert.equal(subFree.object, 'subscription')
  assert.equal(subFree.mode, 'free')
  assert.equal(subFree.active, false)
  assert.equal(subFree.plan_label, 'FREE')
  assert.ok(subFree.token_limit > 0)
  assert.ok(subFree.resets_at_utc)

  activateSubscription({ userId, planKey: 'day1', source: 'admin' })
  const subPaidRes = await app.inject({
    method: 'GET',
    url: '/v1/subscription',
    headers: { authorization: `Bearer ${rawSecret}` },
  })
  assert.equal(subPaidRes.statusCode, 200)
  const subPaid = subPaidRes.json()
  assert.equal(subPaid.object, 'subscription')
  assert.equal(subPaid.mode, 'subscription')
  assert.equal(subPaid.active, true)
  assert.equal(subPaid.plan, '3_days')
  assert.equal(subPaid.plan_label, '3 days')
  assert.equal(subPaid.token_limit, 500_000_000)
  assert.ok(subPaid.expires_at_utc)

  // 3. GET /v1/rpm (default free RPM, then granted 120 RPM)
  const rpmFreeRes = await app.inject({
    method: 'GET',
    url: '/v1/rpm',
    headers: { authorization: `Bearer ${rawSecret}` },
  })
  assert.equal(rpmFreeRes.statusCode, 200)
  const rpmFree = rpmFreeRes.json()
  assert.equal(rpmFree.object, 'rpm')
  assert.equal(rpmFree.rpm, 5)
  assert.equal(rpmFree.plan, 'free')
  assert.equal(rpmFree.source, 'free')

  setUserRpmGrant(userId, 120, 'test grant')
  const rpmGrantRes = await app.inject({
    method: 'GET',
    url: '/v1/rpm',
    headers: { authorization: `Bearer ${rawSecret}` },
  })
  assert.equal(rpmGrantRes.statusCode, 200)
  const rpmGrant = rpmGrantRes.json()
  assert.equal(rpmGrant.object, 'rpm')
  assert.equal(rpmGrant.rpm, 120)
  assert.equal(rpmGrant.source, 'grant')
  assert.ok(rpmGrant.expires_at_utc)

  await app.close()
})
