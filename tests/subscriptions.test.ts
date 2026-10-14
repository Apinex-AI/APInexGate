import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbPath = join(
  tmpdir(),
  `gateway-sub-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
)
mkdirSync(tmpdir(), { recursive: true })
process.env.DB_PATH = dbPath

const { db } = await import('../server/db.ts')
const {
  activateSubscription,
  consumeFreeTierTokens,
  expireDueSubscriptions,
  freeTierExhaustedMessage,
  getActiveSubscription,
  getFreeTierAccess,
  getSubscriptionSettings,
  revokeActiveSubscription,
  runSubscriptionExpiryNotifications,
  updateSubscriptionSettings,
} = await import('../server/subscriptions.ts')
const { nextUtcResetIso, utcPeriodKey, DEFAULT_FREE_DAILY_TOKENS } = await import(
  '../shared/subscriptions.ts'
)

function seedUser(userId: string) {
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO users (id,name,email,plan,status,balance_cents,balance_tokens,requests,created_at,telegram_verified_at)
     VALUES (?,?,?,'free','active',0,0,0,?,?)`,
  ).run(userId, userId, `${userId}@example.invalid`, at, at)
}

test('defaults give every user 10M free tokens per day', () => {
  seedUser('free1')
  const settings = getSubscriptionSettings()
  assert.equal(settings.freeDailyTokens, DEFAULT_FREE_DAILY_TOKENS)
  assert.equal(settings.freeDailyTokens, 10_000_000)

  const access = getFreeTierAccess('free1')
  assert.equal(access.allowed, true)
  assert.equal(access.mode, 'free')
  assert.equal(access.planLabel, 'FREE')
  assert.equal(access.limit, 10_000_000)
  assert.equal(access.used, 0)
  assert.equal(access.remaining, 10_000_000)
  assert.equal(access.unlimited, false)
  assert.equal(access.resetsAt, nextUtcResetIso())
})

test('free usage accumulates and blocks exactly at the limit', () => {
  seedUser('free2')
  consumeFreeTierTokens('free2', 4_000_000)
  let access = getFreeTierAccess('free2')
  assert.equal(access.used, 4_000_000)
  assert.equal(access.remaining, 6_000_000)
  assert.equal(access.allowed, true)

  // Exactly at the limit is exhausted, not still allowed.
  consumeFreeTierTokens('free2', 6_000_000)
  access = getFreeTierAccess('free2')
  assert.equal(access.used, 10_000_000)
  assert.equal(access.remaining, 0)
  assert.equal(access.allowed, false)

  // Overshoot never reports negative remaining.
  consumeFreeTierTokens('free2', 5_000_000)
  access = getFreeTierAccess('free2')
  assert.equal(access.used, 15_000_000)
  assert.equal(access.remaining, 0)
  assert.equal(access.allowed, false)
})

test('the 402 message names the free limit and the subscriptions page', () => {
  seedUser('free3')
  consumeFreeTierTokens('free3', 10_000_000)
  const message = freeTierExhaustedMessage(getFreeTierAccess('free3'))
  assert.match(message, /Free daily limit reached/)
  assert.match(message, /\/subscriptions/)
})

test('free tier does not require a linked account', () => {
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO users (id,name,email,plan,status,balance_cents,balance_tokens,requests,created_at)
     VALUES ('checkin_user','checkin_user','checkin@example.invalid','free','active',0,0,0,?)`,
  ).run(at)

  const access = getFreeTierAccess('checkin_user')
  assert.equal(access.allowed, true)
  assert.equal(access.mode, 'free')
  assert.equal(access.remaining, 10_000_000)
})

test('daily bucket is keyed per UTC day, so 00:00 UTC resets it', () => {
  seedUser('free4')
  consumeFreeTierTokens('free4', 9_999_999)
  assert.equal(getFreeTierAccess('free4').allowed, true)

  // Simulate the next UTC day by relabelling today's bucket as yesterday's.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  db.prepare(`UPDATE free_tier_usage SET period_key = ? WHERE user_id = 'free4'`).run(yesterday)

  const access = getFreeTierAccess('free4')
  assert.equal(access.used, 0)
  assert.equal(access.remaining, 10_000_000)
  assert.equal(access.allowed, true)

  // Yesterday's row is retained, so history is not destroyed by the rollover.
  const rows = db
    .prepare(`SELECT period_key FROM free_tier_usage WHERE user_id = 'free4'`)
    .all() as Array<{ period_key: string }>
  assert.equal(rows.length, 1)
  assert.equal(rows[0].period_key, yesterday)
  assert.notEqual(rows[0].period_key, utcPeriodKey())
})

test('an unlimited subscription never exhausts', () => {
  seedUser('sub1')
  updateSubscriptionSettings({
    plans: [{ key: 'day14', kind: 'unlimited', tokenLimit: 0, enabled: true, priceCents: 2500 }],
  })
  activateSubscription({ userId: 'sub1', planKey: 'day14', source: 'admin', priceCents: 0 })

  consumeFreeTierTokens('sub1', 500_000_000)
  const access = getFreeTierAccess('sub1')
  assert.equal(access.mode, 'subscription')
  assert.equal(access.unlimited, true)
  assert.equal(access.allowed, true)
  assert.equal(access.limit, null)
  assert.equal(access.remaining, null)
  assert.equal(access.used, 500_000_000)
  assert.equal(access.planLabel, '20 days')
})

test('a custom subscription blocks on tokens even while time remains', () => {
  seedUser('sub2')
  updateSubscriptionSettings({
    plans: [{ key: 'day7', kind: 'custom', tokenLimit: 20_000_000, enabled: true, priceCents: 1500 }],
  })
  activateSubscription({ userId: 'sub2', planKey: 'day7', source: 'purchase', priceCents: 1500 })

  consumeFreeTierTokens('sub2', 20_000_000)
  const access = getFreeTierAccess('sub2')
  assert.equal(access.mode, 'subscription')
  assert.equal(access.allowed, false)
  assert.equal(access.remaining, 0)

  // Still inside the paid window — the block is purely the token cap.
  const active = getActiveSubscription('sub2')
  assert.ok(active)
  assert.ok(Date.parse(active.expiresAt) > Date.now())

  const message = freeTierExhaustedMessage(access)
  assert.match(message, /Subscription limit reached/)
  assert.match(message, /\/subscriptions/)
})

test('subscription usage does not touch the daily free bucket', () => {
  seedUser('sub3')
  updateSubscriptionSettings({
    plans: [{ key: 'day1', kind: 'custom', tokenLimit: 50_000_000, enabled: true, priceCents: 300 }],
  })
  activateSubscription({ userId: 'sub3', planKey: 'day1', source: 'purchase', priceCents: 300 })
  consumeFreeTierTokens('sub3', 30_000_000)

  const freeRow = db
    .prepare(`SELECT COUNT(*) AS n FROM free_tier_usage WHERE user_id = 'sub3'`)
    .get() as { n: number }
  assert.equal(freeRow.n, 0)

  // When the subscription lapses, the untouched daily allowance takes over.
  db.prepare(
    `UPDATE user_subscriptions SET expires_at = ? WHERE user_id = 'sub3'`,
  ).run(new Date(Date.now() - 1000).toISOString())
  expireDueSubscriptions()

  const access = getFreeTierAccess('sub3')
  assert.equal(access.mode, 'free')
  assert.equal(access.used, 0)
  assert.equal(access.allowed, true)
})

test('expired subscriptions fall back to the free allowance', () => {
  seedUser('sub4')
  activateSubscription({ userId: 'sub4', planKey: 'day1', source: 'purchase', priceCents: 300 })
  db.prepare(`UPDATE user_subscriptions SET expires_at = ? WHERE user_id = 'sub4'`).run(
    new Date(Date.now() - 60_000).toISOString(),
  )

  assert.equal(getActiveSubscription('sub4'), null)
  const access = getFreeTierAccess('sub4')
  assert.equal(access.mode, 'free')
  assert.equal(access.planLabel, 'FREE')
})

test('buying again extends the window and adds another allowance', () => {
  seedUser('sub5')
  updateSubscriptionSettings({
    plans: [{ key: 'day7', kind: 'custom', tokenLimit: 20_000_000, enabled: true, priceCents: 1500 }],
  })
  const first = activateSubscription({
    userId: 'sub5',
    planKey: 'day7',
    source: 'purchase',
    priceCents: 1500,
  })
  assert.equal(first.extended, false)
  consumeFreeTierTokens('sub5', 5_000_000)

  const second = activateSubscription({
    userId: 'sub5',
    planKey: 'day7',
    source: 'purchase',
    priceCents: 1500,
  })
  assert.equal(second.extended, true)
  assert.equal(second.subscription.id, first.subscription.id)
  // The second purchase adds another pool; tokens already spent are preserved.
  assert.equal(second.subscription.tokenLimit, 40_000_000)
  assert.equal(second.subscription.tokensUsed, 5_000_000)
  assert.equal(second.subscription.remaining, 35_000_000)
  assert.ok(Date.parse(second.subscription.expiresAt) > Date.parse(first.subscription.expiresAt))

  const rows = db
    .prepare(`SELECT COUNT(*) AS n FROM user_subscriptions WHERE user_id = 'sub5'`)
    .get() as { n: number }
  assert.equal(rows.n, 1)
})

test('extending a custom plan keeps usage and adds the selected plan allowance', () => {
  seedUser('sub6')
  activateSubscription({ userId: 'sub6', planKey: 'day1', source: 'purchase', priceCents: 300 })
  updateSubscriptionSettings({
    plans: [
      { key: 'day7', kind: 'custom', tokenLimit: 200_000_000, enabled: true, priceCents: 1500 },
    ],
  })
  consumeFreeTierTokens('sub6', 30_000_000)
  const extended = activateSubscription({
    userId: 'sub6',
    planKey: 'day7',
    source: 'purchase',
    priceCents: 1500,
  })
  assert.equal(extended.subscription.unlimited, false)
  assert.equal(extended.subscription.tokenLimit, 250_000_000)
  assert.equal(extended.subscription.tokensUsed, 30_000_000)
  assert.equal(extended.subscription.remaining, 220_000_000)
  assert.equal(getFreeTierAccess('sub6').unlimited, false)
})

test('a purchase after expiry starts a fresh allowance and does not extend the expired pool', () => {
  seedUser('sub-expired-renewal')
  updateSubscriptionSettings({
    plans: [{ key: 'day1', kind: 'custom', tokenLimit: 100_000_000, enabled: true, priceCents: 100 }],
  })
  const first = activateSubscription({
    userId: 'sub-expired-renewal',
    planKey: 'day1',
    source: 'purchase',
    priceCents: 100,
  })
  consumeFreeTierTokens('sub-expired-renewal', 30_000_000)
  db.prepare(`UPDATE user_subscriptions SET expires_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 1_000).toISOString(),
    first.subscription.id,
  )

  const second = activateSubscription({
    userId: 'sub-expired-renewal',
    planKey: 'day1',
    source: 'purchase',
    priceCents: 100,
  })

  assert.equal(second.extended, false)
  assert.notEqual(second.subscription.id, first.subscription.id)
  assert.equal(second.subscription.tokenLimit, 100_000_000)
  assert.equal(second.subscription.tokensUsed, 0)
  assert.equal(getFreeTierAccess('sub-expired-renewal').remaining, 100_000_000)
})

test('revoking returns the user to the free allowance', () => {
  seedUser('sub7')
  activateSubscription({ userId: 'sub7', planKey: 'day1', source: 'admin', priceCents: 0 })
  assert.equal(getFreeTierAccess('sub7').mode, 'subscription')

  const result = revokeActiveSubscription('sub7')
  assert.equal(result.revoked, true)
  assert.equal(getFreeTierAccess('sub7').mode, 'free')
  assert.equal(revokeActiveSubscription('sub7').revoked, false)
})

test('admin can raise the free daily allowance', () => {
  seedUser('free5')
  updateSubscriptionSettings({ freeDailyTokens: 25_000_000 })
  const access = getFreeTierAccess('free5')
  assert.equal(access.limit, 25_000_000)
  assert.equal(access.remaining, 25_000_000)

  consumeFreeTierTokens('free5', 24_000_000)
  assert.equal(getFreeTierAccess('free5').allowed, true)
  consumeFreeTierTokens('free5', 1_000_000)
  assert.equal(getFreeTierAccess('free5').allowed, false)

  updateSubscriptionSettings({ freeDailyTokens: DEFAULT_FREE_DAILY_TOKENS })
})

test('settings persist plan edits and reject nonsense values', () => {
  updateSubscriptionSettings({
    plans: [
      { key: 'day1', enabled: false, priceCents: 499, kind: 'custom', tokenLimit: 60_000_000 },
    ],
  })
  const plan = getSubscriptionSettings().plans.find((row) => row.key === 'day1')
  assert.ok(plan)
  assert.equal(plan.enabled, false)
  assert.equal(plan.priceCents, 499)
  assert.equal(plan.tokenLimit, 60_000_000)
  // Duration and label are structural and cannot be edited away.
  assert.equal(plan.days, 3)
  assert.equal(plan.label, '3 days')

  // Negative values clamp rather than corrupting the stored config.
  updateSubscriptionSettings({ plans: [{ key: 'day1', priceCents: -50, tokenLimit: -1 }] })
  const clamped = getSubscriptionSettings().plans.find((row) => row.key === 'day1')
  assert.ok(clamped)
  assert.equal(clamped.priceCents, 0)
  assert.equal(clamped.tokenLimit, 0)
})

test('default plans are 500M/$5, 1.1B/$10, 2.5B/$20, 5B/$30', () => {
  db.prepare(`DELETE FROM app_settings WHERE key = 'subscription_settings'`).run()
  const settings = getSubscriptionSettings()
  const byKey = Object.fromEntries(settings.plans.map((plan) => [plan.key, plan]))
  assert.equal(byKey.day1.tokenLimit, 500_000_000)
  assert.equal(byKey.day1.priceCents, 500)
  assert.equal(byKey.day7.tokenLimit, 1_100_000_000)
  assert.equal(byKey.day7.priceCents, 1000)
  assert.equal(byKey.day14.tokenLimit, 2_500_000_000)
  assert.equal(byKey.day14.priceCents, 2000)
  assert.equal(settings.plans.length, 4)
  const day30 = byKey.day30
  assert.ok(day30)
  assert.equal(day30.days, 30)
  assert.equal(day30.label, '30 days')
  assert.equal(day30.priceCents, 3000)
  assert.equal(day30.tokenLimit, 5_000_000_000)
  assert.equal(day30.enabled, true)
  assert.equal(day30.isFeatured, true)
})

test('zero and negative consumption are no-ops', () => {
  seedUser('free6')
  consumeFreeTierTokens('free6', 0)
  consumeFreeTierTokens('free6', -500)
  assert.equal(getFreeTierAccess('free6').used, 0)
})

// ---------------------------------------------------------------------------
// Telegram expiry reminders
// ---------------------------------------------------------------------------

/** `users.telegram_id` is UNIQUE, so each fixture user needs its own chat id. */
let nextChatId = 100_000
function linkTelegram(userId: string) {
  nextChatId += 1
  db.prepare(`UPDATE users SET telegram_id = ? WHERE id = ?`).run(String(nextChatId), userId)
}

/** Move a subscription's expiry to a fixed offset from now. */
function setExpiry(userId: string, msFromNow: number) {
  db.prepare(
    `UPDATE user_subscriptions SET expires_at = ? WHERE user_id = ? AND status = 'active'`,
  ).run(new Date(Date.now() + msFromNow).toISOString(), userId)
}

function collector() {
  const sent: Array<{ userId: string; text: string }> = []
  return {
    sent,
    notify: async (userId: string, text: string) => {
      sent.push({ userId, text })
      return true
    },
  }
}

test('warns 24, 12, and 3 hours before expiry while tokens remain', async () => {
  seedUser('warn1')
  linkTelegram('warn1')
  activateSubscription({ userId: 'warn1', planKey: 'day7', source: 'purchase', priceCents: 1500 })
  setExpiry('warn1', 90 * 60 * 1000)

  const { sent, notify } = collector()
  const result = await runSubscriptionExpiryNotifications(notify)
  assert.equal(result.warned, 3)

  const messages = sent.filter((row) => row.userId === 'warn1').map((row) => row.text)
  assert.match(messages.join('\n'), /expires in 24 hours/)
  assert.match(messages.join('\n'), /expires in 12 hours/)
  assert.match(messages.join('\n'), /expires in 3 hours/)
  assert.match(messages.join('\n'), /10 days/)
  assert.doesNotMatch(messages.join('\n'), /[\u0400-\u04FF]/)
})

test('the warning is sent only once', async () => {
  const { sent, notify } = collector()
  await runSubscriptionExpiryNotifications(notify)
  assert.equal(
    sent.filter((row) => row.userId === 'warn1').length,
    0,
    'a second run must not re-warn',
  )
})

test('no reminder without a linked Telegram account', async () => {
  seedUser('warn2')
  activateSubscription({ userId: 'warn2', planKey: 'day1', source: 'purchase', priceCents: 300 })
  setExpiry('warn2', 60 * 60 * 1000)

  const { sent, notify } = collector()
  await runSubscriptionExpiryNotifications(notify)
  assert.equal(sent.filter((row) => row.userId === 'warn2').length, 0)
})

test('a subscription 20 hours out only gets the 24 hour warning', async () => {
  seedUser('warn3')
  linkTelegram('warn3')
  activateSubscription({ userId: 'warn3', planKey: 'day7', source: 'purchase', priceCents: 1500 })
  setExpiry('warn3', 20 * 60 * 60 * 1000)

  const { sent, notify } = collector()
  await runSubscriptionExpiryNotifications(notify)
  const messages = sent.filter((row) => row.userId === 'warn3')
  assert.equal(messages.length, 1)
  assert.match(messages[0].text, /expires in 24 hours/)
})

test('sends an expired notice once the subscription lapses', async () => {
  seedUser('exp1')
  linkTelegram('exp1')
  activateSubscription({ userId: 'exp1', planKey: 'day1', source: 'purchase', priceCents: 300 })
  setExpiry('exp1', -60 * 1000) // already lapsed

  const { sent, notify } = collector()
  const result = await runSubscriptionExpiryNotifications(notify)
  assert.ok(result.expired >= 1)

  const message = sent.find((row) => row.userId === 'exp1')
  assert.ok(message)
  assert.match(message.text, /has ended/)
  assert.match(message.text, /resets at 00:00 UTC/)
  assert.doesNotMatch(message.text, /[\u0400-\u04FF]/)

  // And not again on the next run.
  const second = collector()
  await runSubscriptionExpiryNotifications(second.notify)
  assert.equal(second.sent.filter((row) => row.userId === 'exp1').length, 0)
})

test('renewing re-arms the reminders for the new period', async () => {
  seedUser('renew1')
  linkTelegram('renew1')
  activateSubscription({ userId: 'renew1', planKey: 'day1', source: 'purchase', priceCents: 300 })
  setExpiry('renew1', 30 * 60 * 1000)

  const first = collector()
  await runSubscriptionExpiryNotifications(first.notify)
  assert.equal(first.sent.filter((row) => row.userId === 'renew1').length, 3)

  // Buying again extends the window; the flag must reset.
  activateSubscription({ userId: 'renew1', planKey: 'day1', source: 'purchase', priceCents: 300 })
  const flags = db
    .prepare(
      `SELECT expiry_warn_24_at, expiry_warn_12_at, expiry_warn_3_at, expired_notified_at
       FROM user_subscriptions
       WHERE user_id = 'renew1' AND status = 'active'`,
    )
    .get() as {
    expiry_warn_24_at: string | null
    expiry_warn_12_at: string | null
    expiry_warn_3_at: string | null
    expired_notified_at: string | null
  }
  assert.equal(flags.expiry_warn_24_at, null)
  assert.equal(flags.expiry_warn_12_at, null)
  assert.equal(flags.expiry_warn_3_at, null)
  assert.equal(flags.expired_notified_at, null)

  // Near the new expiry it warns again.
  setExpiry('renew1', 30 * 60 * 1000)
  const second = collector()
  await runSubscriptionExpiryNotifications(second.notify)
  assert.equal(second.sent.filter((row) => row.userId === 'renew1').length, 3)
})

test('a revoked subscription never triggers an expiry notice', async () => {
  seedUser('rev1')
  linkTelegram('rev1')
  activateSubscription({ userId: 'rev1', planKey: 'day1', source: 'admin', priceCents: 0 })
  // Revoked while still live, which is the only state a revoke applies to.
  assert.equal(revokeActiveSubscription('rev1').revoked, true)
  // Now the clock passes the original expiry date.
  db.prepare(`UPDATE user_subscriptions SET expires_at = ? WHERE user_id = 'rev1'`).run(
    new Date(Date.now() - 60 * 1000).toISOString(),
  )

  const { sent, notify } = collector()
  await runSubscriptionExpiryNotifications(notify)
  assert.equal(
    sent.filter((row) => row.userId === 'rev1').length,
    0,
    'a revoked grant must not produce a renewal nag',
  )
})

test('revoke only applies to a live subscription', () => {
  seedUser('rev2')
  activateSubscription({ userId: 'rev2', planKey: 'day1', source: 'admin', priceCents: 0 })
  setExpiry('rev2', -60 * 1000)
  // Nothing to revoke once the period is already over.
  assert.equal(revokeActiveSubscription('rev2').revoked, false)
  assert.equal(getFreeTierAccess('rev2').mode, 'free')
})

test('a failed send is still latched, so it never loops', async () => {
  seedUser('fail1')
  linkTelegram('fail1')
  activateSubscription({ userId: 'fail1', planKey: 'day1', source: 'purchase', priceCents: 300 })
  setExpiry('fail1', 30 * 60 * 1000)

  let attempts = 0
  await runSubscriptionExpiryNotifications(async () => {
    attempts += 1
    return false // delivery failed (user blocked the bot, etc.)
  })
  assert.equal(attempts, 3)

  const flag = db
    .prepare(
      `SELECT expiry_warn_24_at, expiry_warn_3_at FROM user_subscriptions
       WHERE user_id = 'fail1' AND status = 'active'`,
    )
    .get() as { expiry_warn_24_at: string | null; expiry_warn_3_at: string | null }
  assert.ok(flag.expiry_warn_24_at, 'the attempt must be latched even on failure')
  assert.ok(flag.expiry_warn_3_at, 'the attempt must be latched even on failure')
})
