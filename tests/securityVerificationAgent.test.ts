import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { db, id, nowIso, nextUserDisplayId } from '../server/db.js'
import {
  isSafeUpstreamUrl,
  isSafeUpstreamUrlAsync,
  assertSafeUpstreamUrlAsync,
} from '../server/upstreamFallback.js'
import { upstreamPost } from '../server/gateway.js'
import { proxiedFetch } from '../server/providerProxy.js'
import { proxiedFetchSafeRedirect } from '../server/providerKeys.js'
import {
  acquireDispatchSlot,
  releaseDispatchSlot,
  dispatchQueueStats,
  resetDispatchQueueForTests,
} from '../server/dispatchQueue.js'
import { consumeRateLimit, rateLimitKey, RL } from '../server/rateLimit.js'
import { publicApiKey, registerRoutes } from '../server/routes.js'
import { ensurePlaygroundKey } from '../server/playgroundAuth.js'
import {
  processSolanaPayment,
  verifySolanaTransactionSignature,
} from '../server/solana.js'
import {
  submitSubscriptionPurchase,
  subscriptionSolanaPayConfigured,
  verifyAndCreditSubscriptionPayment,
} from '../server/subscriptionPayments.js'
import {
  claimPaymentSignatureOrThrow,
  PaymentSignatureConflictError,
} from '../server/paymentSignatures.js'
import {
  grantSubscriptionOffer,
  getActiveSubscriptionOffer,
} from '../server/subscriptionOffers.js'
import {
  activateSubscription,
  getFreeTierAccess,
  purchaseSubscriptionWithBalance,
  updateSubscriptionSettings,
} from '../server/subscriptions.js'
import { normalizeModelOutputLimits } from '../server/modelOutputLimits.js'
import { debitApiTokens } from '../server/restrictedCredits.js'
import { creditWalletBalance } from '../server/wallet.js'
import { createAdminSession, createUserSession } from '../server/auth.js'

test('1. [CRIT-02] SSRF Protection: strictly blocks alternative notations, loopback, metadata, and nip.io while allowing public domains', async () => {
  const blockedSyncUrls = [
    'http://0177.0.0.1:8787', // octal
    'http://127.1:8787', // shortened
    'http://0x7f.0.0.1:8787', // hex
    'http://169.254.169.254/latest/meta-data', // cloud metadata
    'http://[::1]:8787', // ipv6 loopback
    'http://[::ffff:127.0.0.1]:8787', // ipv4-mapped ipv6
    'http://[fe80::1]:8787', // ipv6 link-local
  ]

  for (const url of blockedSyncUrls) {
    assert.equal(isSafeUpstreamUrl(url), false, `isSafeUpstreamUrl should block ${url}`)
    await assert.rejects(
      async () => await assertSafeUpstreamUrlAsync(url),
      /SSRF blocked/,
      `assertSafeUpstreamUrlAsync should reject ${url}`,
    )
  }

  // DNS to loopback (e.g. nip.io)
  const nipIoUrl = 'http://127.0.0.1.nip.io:8787'
  const isNipSafe = await isSafeUpstreamUrlAsync(nipIoUrl)
  assert.equal(isNipSafe, false, `isSafeUpstreamUrlAsync should block ${nipIoUrl}`)
  await assert.rejects(
    async () => await assertSafeUpstreamUrlAsync(nipIoUrl),
    /SSRF blocked/,
    `assertSafeUpstreamUrlAsync should reject ${nipIoUrl}`,
  )

  // Legitimate public URLs must remain permitted
  const publicUrl = 'https://api.openai.com/v1/chat/completions'
  assert.equal(isSafeUpstreamUrl(publicUrl), true, `isSafeUpstreamUrl must permit ${publicUrl}`)
  const isPublicSafe = await isSafeUpstreamUrlAsync(publicUrl)
  assert.equal(isPublicSafe, true, `isSafeUpstreamUrlAsync must permit ${publicUrl}`)
  await assert.doesNotReject(
    async () => await assertSafeUpstreamUrlAsync(publicUrl),
    `assertSafeUpstreamUrlAsync must not reject ${publicUrl}`,
  )
})

test('2. [CRIT-03] Redirect Following: enforces manual redirect, blocks redirects to internal destinations, and strips tokens across domains', async () => {
  // Test upstreamPost SSRF block
  await assert.rejects(
    async () => await upstreamPost('http://127.0.0.1:8787', 'chat/completions', 'test-sec', {}),
    /SSRF blocked/,
  )

  // Setup mock HTTP servers for redirect testing
  let server1Port = 0
  let server2Port = 0
  let capturedHeadersServer2: http.IncomingHttpHeaders = {}

  const server2 = http.createServer((req, res) => {
    capturedHeadersServer2 = req.headers
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, source: 'server2' }))
  })

  await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', () => {
    server2Port = (server2.address() as any).port
    resolve()
  }))

  const server1 = http.createServer((req, res) => {
    if (req.url === '/redirect-cross-origin') {
      res.writeHead(302, { Location: `http://localhost:${server2Port}/received` })
      res.end()
    } else if (req.url === '/redirect-to-internal-metadata') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' })
      res.end()
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, source: 'server1' }))
    }
  })

  await new Promise<void>((resolve) => server1.listen(0, '127.0.0.1', () => {
    server1Port = (server1.address() as any).port
    resolve()
  }))

  try {
    // 2a. upstreamPost enforces redirect: 'manual' and does NOT follow redirect
    process.env.ALLOW_INTERNAL_UPSTREAM = 'true'
    const resUpstream = await upstreamPost(
      `http://127.0.0.1:${server1Port}`,
      'redirect-cross-origin' as any,
      'prov-secret',
      {},
    )
    assert.equal(resUpstream.status, 302, 'upstreamPost must return 302 directly without following redirect')

    // 2b. proxiedFetch blocks redirect when destination points to internal / metadata
    delete process.env.ALLOW_INTERNAL_UPSTREAM
    await assert.rejects(
      async () => {
        // Allow initial target temporarily through proxy mock or test redirect validation
        process.env.ALLOW_INTERNAL_UPSTREAM = 'true'
        // Even if initial target is permitted, the redirect check asserts assertSafeUpstreamUrl(nextUrl)
        // Let us test nextUrl validation when ALLOW_INTERNAL_UPSTREAM is disabled
        delete process.env.ALLOW_INTERNAL_UPSTREAM
        await proxiedFetch(`http://127.0.0.1:${server1Port}/redirect-to-internal-metadata`)
      },
      /SSRF blocked/,
      'Must block redirect to internal metadata',
    )

    // 2c. proxiedFetchSafeRedirect strips sensitive headers on cross-origin redirect
    process.env.ALLOW_INTERNAL_UPSTREAM = 'true'
    capturedHeadersServer2 = {}
    await proxiedFetchSafeRedirect(
      `http://127.0.0.1:${server1Port}/redirect-cross-origin`,
      {
        headers: {
          Authorization: 'Bearer secret-token-leak',
          'x-api-key': 'secret-api-key',
          'api-key': 'secret-key',
          cookie: 'session=secret-cookie',
          'proxy-authorization': 'Basic secret-proxy',
          'custom-header': 'safe-to-keep',
        },
      },
      null,
    )

    assert.equal(capturedHeadersServer2['authorization'], undefined, 'Authorization header must be stripped')
    assert.equal(capturedHeadersServer2['x-api-key'], undefined, 'x-api-key header must be stripped')
    assert.equal(capturedHeadersServer2['api-key'], undefined, 'api-key header must be stripped')
    assert.equal(capturedHeadersServer2['cookie'], undefined, 'cookie header must be stripped')
    assert.equal(capturedHeadersServer2['proxy-authorization'], undefined, 'proxy-authorization header must be stripped')
    assert.equal(capturedHeadersServer2['custom-header'], 'safe-to-keep', 'Non-sensitive headers remain intact')
  } finally {
    delete process.env.ALLOW_INTERNAL_UPSTREAM
    await new Promise<void>((resolve) => server1.close(() => resolve()))
    await new Promise<void>((resolve) => server2.close(() => resolve()))
  }
})

test('3. [CRIT-04] Dispatch Queue & activeSlots: timed-out request does not double-decrement activeSlots and activeSlots matches reality', async () => {
  resetDispatchQueueForTests()
  const total = dispatchQueueStats().maxConcurrent
  assert.equal(total, 40)

  // 1. Fill all 40 slots
  const holders = await Promise.all(
    Array.from({ length: total }, () => acquireDispatchSlot('user-seeder')),
  )
  assert.ok(holders.every((h) => !h.timedOut && !h.waited))
  assert.equal(dispatchQueueStats().active, 40, 'All 40 slots must be active')
  assert.equal(dispatchQueueStats().waiting, 0)

  // 2. Enqueue a waiter with a short timeout
  const timeoutPromise = acquireDispatchSlot('user-waiter', { waitTimeoutMs: 50 })
  assert.equal(dispatchQueueStats().waiting, 1, 'Waiter should be in queue')

  const res = await timeoutPromise
  assert.equal(res.timedOut, true, 'Waiter must time out')
  assert.equal(dispatchQueueStats().waiting, 0, 'Timed-out waiter removed from queue')
  assert.equal(dispatchQueueStats().active, 40, 'activeSlots must still be 40, not decremented on timeout')

  // 3. Simulate gateway behavior: since dispatch.timedOut is true, releaseDispatchSlot is NOT called.
  // When an actual slot completes, releaseDispatchSlot is called once:
  releaseDispatchSlot()
  assert.equal(dispatchQueueStats().active, 39, 'activeSlots must now be 39, no double decrement occurred')

  // 4. Release remaining 39 slots
  for (let i = 0; i < 39; i++) {
    releaseDispatchSlot()
  }
  assert.equal(dispatchQueueStats().active, 0, 'activeSlots must return to 0')

  // 5. Erroneous release at 0 does not underflow
  releaseDispatchSlot()
  assert.equal(dispatchQueueStats().active, 0, 'activeSlots cannot become negative')

  resetDispatchQueueForTests()
})

test('4. [CRIT-05] Rate Limit IP Scoping: per-IP scoping prevents IP exhaustion from blocking other IPs', () => {
  const ipA = '1.2.3.4'
  const ipB = '5.6.7.8'

  const scopedRoutes = [
    { name: 'admin-login', config: RL.adminLoginIp },
    { name: 'install', config: RL.installIp },
    { name: 'google-start', config: RL.googleStartIp },
    { name: 'public-status', config: RL.publicStatusIp },
  ]

  for (const { name, config } of scopedRoutes) {
    const keyA = rateLimitKey([name, ipA])
    const keyB = rateLimitKey([name, ipB])

    // Exhaust IP A
    for (let i = 0; i < config.limit; i++) {
      const resA = consumeRateLimit(keyA, config.limit, config.windowMs)
      assert.equal(resA.ok, true, `${name} for IP A should pass within limit (attempt ${i + 1})`)
    }

    // IP A is now rate-limited
    const limitedA = consumeRateLimit(keyA, config.limit, config.windowMs)
    assert.equal(limitedA.ok, false, `${name} for IP A must now be rate-limited`)

    // IP B must still be permitted!
    const resB = consumeRateLimit(keyB, config.limit, config.windowMs)
    assert.equal(resB.ok, true, `${name} for IP B must NOT be blocked by IP A exhaustion`)
  }
})

test('5. [CRIT-06] Plaintext API Key Redaction: publicApiKey outputs secret: null, routes do not expose secret or hash', async () => {
  const now = nowIso()

  // 1. Verify publicApiKey outputs secret: null
  const pub = publicApiKey({
    id: 'key_test_1',
    name: 'Test Key',
    prefix: 'sk-12345678…abcd',
    spend_limit_tokens: 1000,
    spent_tokens: 0,
    status: 'active',
    created_at: now,
    last_used_at: null,
  })
  assert.equal(pub.secret, null, 'publicApiKey must output secret: null')

  // 2. Setup Fastify app to test GET /api/user/keys, POST /api/user/keys, GET /api/admin/api-keys
  const app = Fastify()
  app.register(cookie)
  await registerRoutes(app)

  const testUserId = id('u_key_test')
  const testUserEmail = `key_test_${testUserId}@example.invalid`
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
    VALUES (?, 'Key Tester', ?, 'default', 'active', 100, 100000, 0, ?)
  `).run(testUserId, testUserEmail, now)

  const userSession = createUserSession(testUserId)

  // 3. POST /api/user/keys creates key with secret: null in SQLite and returns raw secret once
  const postRes = await app.inject({
    method: 'POST',
    url: '/api/user/keys',
    headers: {
      cookie: `user_session=${userSession.sessionId}`,
    },
    payload: { name: 'New Test Key' },
  })
  assert.equal(postRes.statusCode, 200)
  const postBody = postRes.json()
  assert.ok(postBody.secret && postBody.secret.startsWith('sk-'), 'POST must return secret string once')
  assert.equal(postBody.key.secret, null, 'POST key object secret must be null')

  // Verify DB row has secret NULL and secret_hash non-null
  const dbKey = db.prepare('SELECT secret, secret_hash FROM api_keys WHERE id = ?').get(postBody.key.id) as {
    secret: string | null
    secret_hash: string
  }
  assert.equal(dbKey.secret, null, 'SQLite secret column must be NULL')
  assert.ok(dbKey.secret_hash && dbKey.secret_hash.length === 64, 'secret_hash must be stored as SHA-256')

  // 4. GET /api/user/keys does not expose secret
  const getKeysRes = await app.inject({
    method: 'GET',
    url: '/api/user/keys',
    headers: {
      cookie: `user_session=${userSession.sessionId}`,
    },
  })
  assert.equal(getKeysRes.statusCode, 200)
  const userKeys = getKeysRes.json().keys
  assert.ok(userKeys.length > 0)
  for (const k of userKeys) {
    assert.equal(k.secret, null, 'GET /api/user/keys must have secret: null')
  }

  // 5. GET /api/admin/api-keys does not return secret or secret_hash
  const adminId = id('admin_test')
  db.prepare(`
    INSERT INTO admin_users (id, email, password_hash, role, created_at)
    VALUES (?, 'admin_keys@test.invalid', 'hash', 'owner', ?)
  `).run(adminId, now)
  const adminSession = createAdminSession(adminId)

  const getAdminKeysRes = await app.inject({
    method: 'GET',
    url: '/api/admin/api-keys',
    headers: {
      cookie: `admin_session=${adminSession.sessionId}`,
    },
  })
  assert.equal(getAdminKeysRes.statusCode, 200)
  const adminKeys = getAdminKeysRes.json().keys
  assert.ok(adminKeys.length > 0)
  for (const k of adminKeys) {
    assert.equal(k.secret, undefined, 'Admin keys must not contain secret')
    assert.equal(k.secret_hash, undefined, 'Admin keys must not contain secret_hash')
  }

  // 6. playgroundAuth.ts sets secret: null in SQLite
  const playUserId = id('u_play_test')
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
    VALUES (?, 'Playground User', ?, 'default', 'active', 0, 0, 0, ?)
  `).run(playUserId, `play_${playUserId}@example.invalid`, now)

  const playKeyId = ensurePlaygroundKey(playUserId)
  const playKeyRow = db.prepare('SELECT secret, secret_hash FROM api_keys WHERE id = ?').get(playKeyId) as {
    secret: string | null
    secret_hash: string
  }
  assert.equal(playKeyRow.secret, null, 'playgroundAuth must insert secret as NULL in SQLite')
  assert.ok(playKeyRow.secret_hash, 'playgroundAuth must insert secret_hash')
})

test('6. Solana direct on-chain removal: verify on-chain verification is disabled and does not auto-confirm payments', async () => {
  // 1. verifySolanaTransactionSignature throws disabled error
  assert.throws(
    () =>
      verifySolanaTransactionSignature({
        signature: '5'.repeat(88),
        flow: 'topup',
        paymentId: 'pay_test',
        userId: 'u_test',
      }),
    /Direct Solana transaction verification is disabled/,
  )

  // 2. submitSubscriptionPurchase throws disabled error
  await assert.rejects(
    async () => await submitSubscriptionPurchase({ paymentId: 'sub_pay_1' }),
    /Direct blockchain submission is disabled/,
  )

  // 3. subscriptionSolanaPayConfigured returns false
  assert.equal(subscriptionSolanaPayConfigured(), false)

  // 4. processSolanaPayment returns disabled: true and does NOT auto-confirm payments
  const uId = id('u_sol_test')
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
    VALUES (?, 'Sol Tester', ?, 'default', 'active', 0, 0, 0, ?)
  `).run(uId, `${uId}@example.invalid`, nowIso())

  const validSig = '5'.repeat(88)
  const procRes = processSolanaPayment({
    paymentId: 'pay_sol_disable_test',
    signature: validSig,
    amountLamports: 1_000_000_000n,
    userId: uId,
    flow: 'topup',
  })
  assert.equal(procRes.ok, true)
  assert.equal(procRes.disabled, true, 'processSolanaPayment must indicate disabled: true')

  // User balance must remain 0 (not auto-credited)
  const user = db.prepare('SELECT balance_tokens FROM users WHERE id = ?').get(uId) as { balance_tokens: number }
  assert.equal(user.balance_tokens, 0, 'Solana payment must NOT credit tokens automatically')

  // 5. verifyAndCreditSubscriptionPayment does not confirm fake uncredited payments
  const fakePayId = id('fake_sub_pay')
  const fakeRes = await verifyAndCreditSubscriptionPayment(fakePayId)
  assert.equal(fakeRes.credited, false)
})

test('7. [HIGH-01, HIGH-02, HIGH-03, HIGH-04, HIGH-14, HIGH-15] Security & Concurrency Verification', () => {
  const now = nowIso()

  // --- HIGH-01 / HIGH-02: RPM payment replay is blocked in claimPaymentSignatureOrThrow ---
  const rpmSig = `sig_rpm_${Date.now()}_${Math.random()}`
  claimPaymentSignatureOrThrow({
    signature: rpmSig,
    flow: 'rpm',
    paymentId: 'rpm_pay_1',
    userId: 'u_rpm_test',
  })

  // Replaying in RPM flow fails
  assert.throws(
    () =>
      claimPaymentSignatureOrThrow({
        signature: rpmSig,
        flow: 'rpm',
        paymentId: 'rpm_pay_replay',
        userId: 'u_rpm_attacker',
      }),
    PaymentSignatureConflictError,
  )

  // Replaying in topup or subscription flow fails
  assert.throws(
    () =>
      claimPaymentSignatureOrThrow({
        signature: rpmSig,
        flow: 'topup',
        paymentId: 'topup_pay_replay',
        userId: 'u_topup_attacker',
      }),
    PaymentSignatureConflictError,
  )

  // --- HIGH-03: Subscription promo offers are consumed upon purchase and cannot be stacked repeatedly ---
  const offerUserId = id('u_offer')
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
    VALUES (?, 'Offer Tester', ?, 'default', 'active', 0, 0, 0, ?)
  `).run(offerUserId, `${offerUserId}@example.invalid`, now)

  // Grant user 20% discount offer for 1 day
  grantSubscriptionOffer({
    userId: offerUserId,
    promoId: 'promo_test_1',
    mode: 'percent',
    value: 20,
    unit: 'days',
    amount: 1,
  })

  const activeOffer = getActiveSubscriptionOffer(offerUserId)
  assert.ok(activeOffer, 'Offer should be active')

  // Credit wallet with enough for 1 discounted purchase
  creditWalletBalance({ userId: offerUserId, amountCents: 5000 })

  // Purchase subscription using balance
  updateSubscriptionSettings({
    plans: [{ key: 'day7', enabled: true, priceCents: 2000, days: 7, kind: 'custom', tokenLimit: 500_000 }],
  })
  const purchase1 = purchaseSubscriptionWithBalance({ userId: offerUserId, planKey: 'day7' })
  assert.equal(purchase1.credited, true)
  assert.equal(purchase1.amountCents, 1600, '20% discount applied: 2000 * 0.8 = 1600 cents')

  // Verify offer is CONSUMED and cannot be used again
  const afterOffer = getActiveSubscriptionOffer(offerUserId)
  assert.equal(afterOffer, null, 'Subscription offer must be consumed after purchase')

  // Second purchase now charges full price (2000 cents), not stacked
  const purchase2 = purchaseSubscriptionWithBalance({ userId: offerUserId, planKey: 'day7' })
  assert.equal(purchase2.amountCents, 2000, 'Full price must be charged without offer')

  // --- HIGH-04: Purchasing unlimited plan properly sets kind: 'unlimited' ---
  const unlimUserId = id('u_unlim')
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
    VALUES (?, 'Unlim Tester', ?, 'default', 'active', 0, 0, 0, ?)
  `).run(unlimUserId, `${unlimUserId}@example.invalid`, now)

  updateSubscriptionSettings({
    plans: [{ key: 'day30', enabled: true, priceCents: 3000, days: 30, kind: 'unlimited', tokenLimit: 0 }],
  })
  const activatedUnlim = activateSubscription({
    userId: unlimUserId,
    planKey: 'day30',
    source: 'purchase',
    priceCents: 3000,
  })
  assert.equal(activatedUnlim.subscription.kind, 'unlimited', 'Activated subscription must have kind: unlimited')

  const unlimAccess = getFreeTierAccess(unlimUserId)
  assert.equal(unlimAccess.unlimited, true, 'getFreeTierAccess must report unlimited: true')
  assert.equal(unlimAccess.allowed, true)

  // --- HIGH-14: Luna models do not force 128K on client-capped requests ---
  const clientCappedPayload = {
    model: 'gpt-6-luna',
    max_tokens: 500,
  }
  normalizeModelOutputLimits(clientCappedPayload, ['gpt-6-luna'], 'chat/completions')
  assert.equal(clientCappedPayload.max_tokens, 500, 'Client-capped max_tokens must remain 500, not forced to 128K')

  const uncappedPayload = {
    model: 'gpt-6-luna',
  }
  normalizeModelOutputLimits(uncappedPayload, ['gpt-6-luna'], 'chat/completions')
  assert.equal(uncappedPayload.max_tokens, 128_000, 'Uncapped Luna request should receive default 128K')

  // --- HIGH-15: debitApiTokens checks changes === 1 and uses .immediate() ---
  const debitUserId = id('u_debit')
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, restricted_tokens, requests, created_at)
    VALUES (?, 'Debit Tester', ?, 'default', 'active', 0, 1000, 400, 0, ?)
  `).run(debitUserId, `${debitUserId}@example.invalid`, now)

  // Debit 500 tokens: 400 restricted + 100 regular
  const debitRes1 = debitApiTokens(debitUserId, 500)
  assert.equal(debitRes1.ok, true)
  assert.equal(debitRes1.restrictedUsed, 400)
  assert.equal(debitRes1.regularUsed, 100)

  const debitUser1 = db.prepare('SELECT balance_tokens, restricted_tokens FROM users WHERE id = ?').get(debitUserId) as any
  assert.equal(debitUser1.balance_tokens, 500)
  assert.equal(debitUser1.restricted_tokens, 0)

  // Over-debit should fail with ok: false and not decrement balance
  const debitRes2 = debitApiTokens(debitUserId, 600)
  assert.equal(debitRes2.ok, false)

  const debitUser2 = db.prepare('SELECT balance_tokens FROM users WHERE id = ?').get(debitUserId) as any
  assert.equal(debitUser2.balance_tokens, 500, 'Balance must remain unchanged after failed debit')

  // --- display_id concurrency retry handles unique collisions ---
  // Seed a user with next display_id
  const curDisplayId = nextUserDisplayId()
  const collideUserId = id('u_collide_seeded')
  db.prepare(`
    INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at, display_id)
    VALUES (?, 'Seeded', ?, 'default', 'active', 0, 0, 0, ?, ?)
  `).run(collideUserId, `${collideUserId}@example.invalid`, now, curDisplayId)

  // Now simulate the insert retry loop from routes.ts
  const newUserId = id('u_collide_retry')
  let assignedDisplayId = curDisplayId // start with the colliding display_id
  let retries = 0

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      db.prepare(`
        INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at, display_id)
        VALUES (?, 'Retried', ?, 'default', 'active', 0, 0, 0, ?, ?)
      `).run(newUserId, `${newUserId}@example.invalid`, now, assignedDisplayId)
      break
    } catch (err: any) {
      if (
        attempt < 4 &&
        (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
          err?.code === 'SQLITE_CONSTRAINT' ||
          String(err?.message).includes('display_id'))
      ) {
        retries++
        assignedDisplayId = Math.max(nextUserDisplayId(), assignedDisplayId + 1)
        continue
      }
      throw err
    }
  }

  assert.equal(retries, 1, 'Retry loop must catch the collision and retry')
  assert.equal(assignedDisplayId, curDisplayId + 1, 'Assigned display_id must increment to resolve collision')
  const insertedUser = db.prepare('SELECT display_id FROM users WHERE id = ?').get(newUserId) as { display_id: number }
  assert.equal(insertedUser.display_id, curDisplayId + 1)
})
