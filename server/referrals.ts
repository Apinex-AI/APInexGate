import { randomBytes } from 'node:crypto'
import { db, getSetting, id, nowIso, setSetting } from './db.js'
import { onUserBalanceCredited } from './userBalanceAlerts.js'
import { TOKENS_PER_USD, formatUsdExact, tokensFromUsdCents } from '../shared/billing.js'

const DEFAULT_MIN_PURCHASE_CENTS = 500
/** Legacy defaults kept for migration math: $0.25 / $0.125. */
const DEFAULT_REFERRER_TOKENS = 1_000_000
const DEFAULT_REFEREE_TOKENS = 500_000
const DEFAULT_REFERRER_CENTS = 25
const DEFAULT_REFEREE_CENTS = 13

export type ReferralSettings = {
  enabled: boolean
  minPurchaseCents: number
  referrerRewardCents: number
  refereeRewardCents: number
}

function centsFromSetting(key: string, legacyTokensKey: string, legacyDefault: number, fallbackCents: number) {
  const storedCents = Number(getSetting(key, ''))
  if (Number.isFinite(storedCents) && storedCents > 0) return Math.round(storedCents)
  const legacyTokens = Number(getSetting(legacyTokensKey, String(legacyDefault)))
  if (Number.isFinite(legacyTokens) && legacyTokens > 0) {
    return Math.max(1, Math.round((legacyTokens / 4_000_000) * 100))
  }
  return fallbackCents
}

export function getReferralSettings(): ReferralSettings {
  const enabled = getSetting('referral_enabled', '1') === '1'
  const minRaw = Number(getSetting('referral_min_purchase_cents', String(DEFAULT_MIN_PURCHASE_CENTS)))
  return {
    enabled,
    minPurchaseCents:
      Number.isFinite(minRaw) && minRaw >= 100 ? Math.round(minRaw) : DEFAULT_MIN_PURCHASE_CENTS,
    referrerRewardCents: centsFromSetting(
      'referral_referrer_cents',
      'referral_referrer_tokens',
      DEFAULT_REFERRER_TOKENS,
      DEFAULT_REFERRER_CENTS,
    ),
    refereeRewardCents: centsFromSetting(
      'referral_referee_cents',
      'referral_referee_tokens',
      DEFAULT_REFEREE_TOKENS,
      DEFAULT_REFEREE_CENTS,
    ),
  }
}

export function setReferralSettings(input: {
  enabled?: boolean
  minPurchaseCents?: number
  referrerRewardUsd?: number
  refereeRewardUsd?: number
}) {
  const current = getReferralSettings()
  const enabled = input.enabled ?? current.enabled
  const minPurchaseCents = Math.round(Number(input.minPurchaseCents ?? current.minPurchaseCents))
  const referrerRewardCents = Math.round(
    Number(input.referrerRewardUsd != null ? input.referrerRewardUsd * 100 : current.referrerRewardCents),
  )
  const refereeRewardCents = Math.round(
    Number(input.refereeRewardUsd != null ? input.refereeRewardUsd * 100 : current.refereeRewardCents),
  )

  if (!Number.isFinite(minPurchaseCents) || minPurchaseCents < 100) {
    throw new Error('Minimum purchase must be at least $1.00')
  }
  if (!Number.isFinite(referrerRewardCents) || referrerRewardCents < 0) {
    throw new Error('Referrer reward must be at least $0.00')
  }
  if (!Number.isFinite(refereeRewardCents) || refereeRewardCents < 0) {
    throw new Error('Referee reward must be at least $0.00')
  }

  setSetting('referral_enabled', enabled ? '1' : '0')
  setSetting('referral_min_purchase_cents', String(minPurchaseCents))
  setSetting('referral_referrer_cents', String(referrerRewardCents))
  setSetting('referral_referee_cents', String(refereeRewardCents))
  return getReferralSettings()
}

function randomReferralCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i += 1) out += alphabet[bytes[i]! % alphabet.length]
  return out
}

export function ensureUserReferralCode(userId: string): string {
  const row = db.prepare(`SELECT referral_code FROM users WHERE id = ?`).get(userId) as
    | { referral_code: string | null }
    | undefined
  if (!row) throw new Error('User not found')
  if (row.referral_code?.trim()) return row.referral_code.trim()

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomReferralCode()
    try {
      db.prepare(`UPDATE users SET referral_code = ? WHERE id = ? AND (referral_code IS NULL OR referral_code = '')`).run(
        code,
        userId,
      )
      const check = db.prepare(`SELECT referral_code FROM users WHERE id = ?`).get(userId) as {
        referral_code: string | null
      }
      if (check.referral_code) return check.referral_code
    } catch {
      // unique collision — retry
    }
  }
  throw new Error('Could not allocate referral code')
}

export function findReferrerIdByCode(code: string | null | undefined): string | null {
  const normalized = String(code ?? '')
    .trim()
    .toUpperCase()
  if (!normalized) return null
  const row = db
    .prepare(`SELECT id FROM users WHERE upper(referral_code) = ? LIMIT 1`)
    .get(normalized) as { id: string } | undefined
  return row?.id ?? null
}

/** Bind referred_by once (signup or later code entry). */
export function bindReferrerOnSignup(userId: string, refCode: string | null | undefined) {
  const referrerId = findReferrerIdByCode(refCode)
  if (!referrerId) return null
  db.prepare(
    `UPDATE users SET referred_by = ? WHERE id = ? AND (referred_by IS NULL OR referred_by = '')`,
  ).run(referrerId, userId)
  return referrerId
}

/**
 * Apply a referral code from the in-app Rewards screen.
 * Codes stay the same; binding is one-time.
 */
export function applyReferralCode(userId: string, rawCode: string | null | undefined) {
  const code = String(rawCode ?? '')
    .trim()
    .toUpperCase()
  if (!code) throw Object.assign(new Error('Enter a referral code'), { statusCode: 400 })

  const user = db
    .prepare(`SELECT id, referral_code, referred_by FROM users WHERE id = ?`)
    .get(userId) as { id: string; referral_code: string | null; referred_by: string | null } | undefined
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 })

  if (user.referred_by) {
    throw Object.assign(new Error('A referral code is already linked to this account'), {
      statusCode: 400,
    })
  }

  const own = String(user.referral_code ?? '')
    .trim()
    .toUpperCase()
  if (own && own === code) {
    throw Object.assign(new Error('You cannot use your own referral code'), { statusCode: 400 })
  }

  const referrerId = findReferrerIdByCode(code)
  if (!referrerId) {
    throw Object.assign(new Error('Referral code not found'), { statusCode: 404 })
  }
  if (referrerId === userId) {
    throw Object.assign(new Error('You cannot use your own referral code'), { statusCode: 400 })
  }

  const updated = db
    .prepare(
      `UPDATE users SET referred_by = ? WHERE id = ? AND (referred_by IS NULL OR referred_by = '')`,
    )
    .run(referrerId, userId)
  if (!updated.changes) {
    throw Object.assign(new Error('A referral code is already linked to this account'), {
      statusCode: 400,
    })
  }

  const referrer = db
    .prepare(`SELECT referral_code FROM users WHERE id = ?`)
    .get(referrerId) as { referral_code: string | null } | undefined

  // If the user already made a qualifying purchase, try to settle the one-time bonus now.
  let granted: ReturnType<typeof tryGrantReferralReward> = { granted: false }
  try {
    const settings = getReferralSettings()
    const qualPay = db
      .prepare(
        `SELECT id, amount_cents FROM (
           SELECT id, amount_cents, credited_at FROM crypto_payments WHERE user_id = ? AND credited_at IS NOT NULL
           UNION ALL
           SELECT id, amount_cents, credited_at FROM subscription_payments WHERE user_id = ? AND credited_at IS NOT NULL
           UNION ALL
           SELECT id, amount_cents, credited_at FROM rpm_payments WHERE user_id = ? AND credited_at IS NOT NULL
           UNION ALL
           SELECT id, amount_cents, created_at AS credited_at FROM wallet_purchases WHERE user_id = ?
         ) WHERE amount_cents > 0 ORDER BY datetime(credited_at) ASC LIMIT 1`,
      )
      .get(userId, userId, userId, userId) as { id: string; amount_cents: number } | undefined
    if (qualPay) {
      granted = tryGrantReferralReward({
        userId,
        paymentId: qualPay.id,
        amountCents: qualPay.amount_cents,
        forceIfQualified: true,
      })
    }
  } catch (error) {
    console.error('[referral] post-apply grant failed', error)
  }

  return {
    ok: true as const,
    referredByCode: String(referrer?.referral_code ?? code).trim().toUpperCase(),
    rewardGranted: Boolean(granted.granted),
  }
}

export function userReferralStats(userId: string) {
  const code = ensureUserReferralCode(userId)
  const invited = (
    db.prepare(`SELECT COUNT(*) AS n FROM users WHERE referred_by = ?`).get(userId) as { n: number }
  ).n
  const rewarded = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM referral_rewards WHERE referrer_user_id = ?`)
      .get(userId) as { n: number }
  ).n
  const earnedCents = (
    db
      .prepare(
        `SELECT COALESCE(SUM(referrer_tokens), 0) * 100.0 / ${TOKENS_PER_USD} AS n FROM referral_rewards WHERE referrer_user_id = ?`,
      )
      .get(userId) as { n: number }
  ).n
  const me = db
    .prepare(`SELECT referred_by FROM users WHERE id = ?`)
    .get(userId) as { referred_by: string | null } | undefined
  const referredById = me?.referred_by ?? null
  let referredByCode: string | null = null
  if (referredById) {
    const ref = db
      .prepare(`SELECT referral_code FROM users WHERE id = ?`)
      .get(referredById) as { referral_code: string | null } | undefined
    referredByCode = ref?.referral_code?.trim() || null
  }
  const rewardGranted = Boolean(
    db
      .prepare(`SELECT referee_user_id FROM referral_rewards WHERE referee_user_id = ?`)
      .get(userId),
  )

  return {
    code,
    invited,
    rewarded,
    /** USD earned via referrals. */
    earnedUsd: earnedCents / 100,
    referredByCode,
    hasReferrer: Boolean(referredById),
    rewardGranted,
  }
}

/**
 * After a successful crypto top-up credit: if this is the referee's first qualifying
 * payment (>= minPurchaseCents) and no reward yet, credit both sides once.
 */
export function tryGrantReferralReward(input: {
  userId: string
  paymentId: string
  amountCents: number
  /** When true, allow grant even if this is not the first top-up row (e.g. code applied later). */
  forceIfQualified?: boolean
}): {
  granted: boolean
  referrerUsd?: number
  refereeUsd?: number
} {
  const settings = getReferralSettings()
  if (!settings.enabled) return { granted: false }
  if (
    settings.referrerRewardCents <= 0 &&
    settings.refereeRewardCents <= 0
  ) {
    return { granted: false }
  }

  // Count all historical purchases (Crypto, Card, Balance: Top-up, Subscriptions, RPM)
  const totalSpentCents = ((db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total FROM (
      SELECT amount_cents FROM crypto_payments WHERE user_id = ? AND credited_at IS NOT NULL
      UNION ALL
      SELECT amount_cents FROM subscription_payments WHERE user_id = ? AND credited_at IS NOT NULL
      UNION ALL
      SELECT amount_cents FROM rpm_payments WHERE user_id = ? AND credited_at IS NOT NULL
      UNION ALL
      SELECT amount_cents FROM wallet_purchases WHERE user_id = ?
    )
  `).get(input.userId, input.userId, input.userId, input.userId) as { total: number } | undefined)?.total ?? 0)

  if (!input.forceIfQualified && totalSpentCents < settings.minPurchaseCents) {
    return { granted: false }
  }

  const user = db
    .prepare(`SELECT id, referred_by FROM users WHERE id = ?`)
    .get(input.userId) as { id: string; referred_by: string | null } | undefined
  if (!user?.referred_by) return { granted: false }

  const existing = db
    .prepare(`SELECT referee_user_id FROM referral_rewards WHERE referee_user_id = ?`)
    .get(user.id)
  if (existing) return { granted: false }

  const referrerId = user.referred_by
  const referrerExists = db.prepare(`SELECT id FROM users WHERE id = ?`).get(referrerId)
  if (!referrerExists) return { granted: false }

  const when = nowIso()
  const referrerCents = settings.referrerRewardCents
  const refereeCents = settings.refereeRewardCents
  const referrerTokens = tokensFromUsdCents(referrerCents)
  const refereeTokens = tokensFromUsdCents(refereeCents)

  const tx = db.transaction(() => {
    const again = db
      .prepare(`SELECT referee_user_id FROM referral_rewards WHERE referee_user_id = ?`)
      .get(user.id)
    if (again) return false

    db.prepare(
      `INSERT INTO referral_rewards
        (referee_user_id, referrer_user_id, payment_id, referrer_tokens, referee_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(user.id, referrerId, input.paymentId, referrerTokens, refereeTokens, when)

    if (referrerTokens > 0) {
      db.prepare(`UPDATE users SET balance_tokens = balance_tokens + ? WHERE id = ?`).run(
        referrerTokens,
        referrerId,
      )
      db.prepare(
        `INSERT INTO balance_transactions
          (id, user_id, type, amount_cents, amount_tokens, note, status, created_at)
         VALUES (?, ?, 'referral_bonus', ?, ?, ?, 'completed', ?)`,
      ).run(
        id('txn'),
        referrerId,
        referrerCents,
        referrerTokens,
        `Referral reward · +${formatUsdExact(referrerCents / 100)} (invited user top-up)`,
        when,
      )
    }

    if (refereeTokens > 0) {
      db.prepare(`UPDATE users SET balance_tokens = balance_tokens + ? WHERE id = ?`).run(
        refereeTokens,
        user.id,
      )
      db.prepare(
        `INSERT INTO balance_transactions
          (id, user_id, type, amount_cents, amount_tokens, note, status, created_at)
         VALUES (?, ?, 'referral_bonus', ?, ?, ?, 'completed', ?)`,
      ).run(
        id('txn'),
        user.id,
        refereeCents,
        refereeTokens,
        `Referral welcome bonus · +${formatUsdExact(refereeCents / 100)} (first qualifying top-up)`,
        when,
      )
    }
    return { referrerId, refereeId: user.id, referrerCents, refereeCents }
  })

  const result = tx()
  if (result) {
    if (result.referrerCents > 0) onUserBalanceCredited(result.referrerId)
    if (result.refereeCents > 0) onUserBalanceCredited(result.refereeId)
    return {
      granted: true,
      referrerUsd: result.referrerCents / 100,
      refereeUsd: result.refereeCents / 100,
    }
  }
  return { granted: false }
}

if (!getSetting('referral_enabled')) {
  setSetting('referral_enabled', '1')
  setSetting('referral_min_purchase_cents', String(DEFAULT_MIN_PURCHASE_CENTS))
  setSetting('referral_referrer_cents', String(DEFAULT_REFERRER_CENTS))
  setSetting('referral_referee_cents', String(DEFAULT_REFEREE_CENTS))
}
