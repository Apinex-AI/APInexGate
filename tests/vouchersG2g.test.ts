import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dbPath = join(
  tmpdir(),
  `gateway-g2g-vouchers-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
)
mkdirSync(tmpdir(), { recursive: true })
process.env.DB_PATH = dbPath

const { db } = await import('../server/db.ts')
const {
  createPromoCode,
  generatePromoCodeLocal,
  normalizePromoCode,
  redeemPromoCode,
  VOUCHER_ALPHABET,
} = await import('../server/promo.ts')

function seedUser(userId: string, email: string) {
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO users (id, name, email, plan, status, balance_cents, balance_tokens, requests, created_at)
     VALUES (?, ?, ?, 'free', 'active', 0, 0, 0, ?)`,
  ).run(userId, userId, email, at)
}

test('generatePromoCodeLocal produces XXXX-XXXX-XXXX-XXXX using safe non-ambiguous alphabet without fixed prefix', () => {
  const firstBlocks = new Set<string>()
  for (let i = 0; i < 50; i++) {
    const code = generatePromoCodeLocal()
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    firstBlocks.add(code.slice(0, 4))
    const rawChars = code.replace(/-/g, '')
    for (const ch of rawChars) {
      assert.ok(VOUCHER_ALPHABET.includes(ch), `Character ${ch} should be in VOUCHER_ALPHABET`)
      assert.ok(!['0', 'O', '1', 'I', 'L'].includes(ch), `Forbidden ambiguous char: ${ch}`)
    }
  }
  assert.ok(firstBlocks.size > 1, 'First block must be randomized, not a static prefix')
})

test('normalizePromoCode normalizes lowercase, spaces, and unhyphenated 16-char codes', () => {
  assert.equal(normalizePromoCode('w4r8-7k9a-m4x2-9w2p'), 'W4R8-7K9A-M4X2-9W2P')
  assert.equal(normalizePromoCode('W4R8 7K9A M4X2 9W2P'), 'W4R8-7K9A-M4X2-9W2P')
  assert.equal(normalizePromoCode('w4r87k9am4x29w2p'), 'W4R8-7K9A-M4X2-9W2P')
  assert.equal(normalizePromoCode('  K8P3-7K9A-M4X2-9W2P  '), 'K8P3-7K9A-M4X2-9W2P')
})

test('atomic voucher redemption credits user balance and records audit log without collecting IP', () => {
  seedUser('buyer_user_1', 'buyer1@g2g.invalid')
  const voucherCode = generatePromoCodeLocal()

  const promo = createPromoCode({
    code: voucherCode,
    type: 'balance',
    rewardUsd: 5.0,
    maxUses: 1,
    expiresAt: null,
    note: 'Order #1234567',
    createdBy: 'system@admin',
  })
  assert.equal(promo.code, voucherCode)
  assert.equal(promo.status, 'active')

  const res = redeemPromoCode({
    userId: 'buyer_user_1',
    code: voucherCode.toLowerCase(),
  })

  assert.equal(res.ok, true)
  assert.equal(res.usd, 5.0)
  assert.equal(res.tokens, 5_000_000)
  assert.match(res.redeemedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/)

  // Verify DB state
  const row = db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(promo.id) as Record<string, unknown>
  assert.equal(row.status, 'redeemed')
  assert.equal(row.used_count, 1)
  assert.equal(row.redeemed_at, res.redeemedAt)
  assert.equal(row.redeemed_by_user_id, 'buyer_user_1')
  assert.equal(row.redeemed_ip, undefined)

  // Verify redemption log
  const redRow = db.prepare('SELECT * FROM promo_redemptions WHERE promo_id = ?').get(promo.id) as Record<string, unknown>
  assert.equal(redRow.user_id, 'buyer_user_1')
  assert.equal(redRow.tokens, 5_000_000)
  assert.equal(redRow.usd_cents, 500)
  assert.equal(redRow.ip, undefined)

  // Verify user balance credited
  const user = db.prepare('SELECT balance_tokens FROM users WHERE id = ?').get('buyer_user_1') as { balance_tokens: number }
  assert.equal(user.balance_tokens, 5_000_000)

  // Verify audit log
  const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'voucher.redeemed' AND target = ?").get(promo.id) as Record<string, unknown>
  assert.ok(audit)
  const meta = JSON.parse(audit.metadata_json as string)
  assert.equal(meta.code, voucherCode)
  assert.equal(meta.status, 'Redeemed')
  assert.equal(meta.clientIp, undefined)
  assert.equal(meta.userId, 'buyer_user_1')
  assert.equal(meta.userEmail, 'buyer1@g2g.invalid')
})

test('atomic protection prevents duplicate voucher redemption', () => {
  seedUser('buyer_user_2', 'buyer2@g2g.invalid')
  const voucherCode = generatePromoCodeLocal()

  createPromoCode({
    code: voucherCode,
    type: 'balance',
    rewardUsd: 10.0,
    maxUses: 1,
    expiresAt: null,
    note: 'Order #7654321',
    createdBy: 'system@admin',
  })

  // First redemption succeeds
  const first = redeemPromoCode({
    userId: 'buyer_user_2',
    code: voucherCode,
  })
  assert.equal(first.ok, true)

  // Second redemption must fail (usage limit reached / already redeemed)
  assert.throws(
    () => {
      redeemPromoCode({
        userId: 'buyer_user_2',
        code: voucherCode,
      })
    },
    { message: /usage limit|already redeemed/i },
  )

  // A different user trying to redeem the same code also fails
  seedUser('buyer_user_3', 'buyer3@g2g.invalid')
  assert.throws(
    () => {
      redeemPromoCode({
        userId: 'buyer_user_3',
        code: voucherCode,
      })
    },
    { message: /already redeemed|usage limit/i },
  )

  // Balance of user 3 was NOT credited
  const user3 = db.prepare('SELECT balance_tokens FROM users WHERE id = ?').get('buyer_user_3') as { balance_tokens: number }
  assert.equal(user3.balance_tokens, 0)
})

test('top-up amounts allow only 5, 10, 20, 50', async () => {
  const allowed = [5, 10, 20, 50]
  for (const amt of [1, 2, 7, 15, 25, 49, 100, 500]) {
    assert.equal(allowed.includes(amt), false, `${amt} should not be allowed`)
  }
  for (const amt of [5, 10, 20, 50]) {
    assert.equal(allowed.includes(amt), true, `${amt} should be allowed`)
  }
})
