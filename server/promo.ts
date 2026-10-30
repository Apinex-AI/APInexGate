import { randomBytes } from 'node:crypto'
import { db, id, nowIso } from './db.js'
import { formatTokenCount, formatUsdExact, tokensFromUsdCents } from '../shared/billing.js'
import { activateSubscription, getActiveSubscription, getSubscriptionPlan, resetFreeTierDailyUsage } from './subscriptions.js'
import { isSubscriptionPlanKey, type SubscriptionPlanKey } from '../shared/subscriptions.js'
import {
  grantSubscriptionOffer,
  normalizeOfferMode,
  normalizeOfferUnit,
  offerLabel,
  parseOfferFields,
  type SubscriptionOfferMode,
  type SubscriptionOfferUnit,
} from './subscriptionOffers.js'
import {
  bonusLabel,
  grantUserPromoBonus,
  normalizeBonusDurationUnit,
  normalizeBonusTarget,
  parseBonusFields,
  type PromoBonusDurationUnit,
  type PromoBonusTarget,
} from './promoBonus.js'

const CODE_RE = /^(?:[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}|[A-Za-z0-9-]{6,32})$/i

export type PromoStatus = 'active' | 'disabled' | 'redeemed'
export type PromoType =
  | 'balance'
  | 'subscription'
  | 'subscription_custom'
  | 'subscription_offer'
  | 'topup_bonus'
  | 'free_reset'

export const VOUCHER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function formatUtcSeconds(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`
}

export function normalizePromoCode(raw: string) {
  let s = String(raw ?? '')
    .trim()
    .toUpperCase()
  if (/^[A-Z0-9]{16}$/.test(s)) {
    s = `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`
  } else if (/^[A-Z0-9]{4}\s+[A-Z0-9]{4}\s+[A-Z0-9]{4}\s+[A-Z0-9]{4}$/.test(s)) {
    s = s.replace(/\s+/g, '-')
  }
  return s
}

export function validatePromoCodeFormat(code: string) {
  if (!CODE_RE.test(code)) {
    throw new Error('Code must follow the format XXXX-XXXX-XXXX-XXXX or be 6–32 valid characters')
  }
}

export function normalizePromoStatus(raw: unknown): PromoStatus {
  if (raw === 'disabled') return 'disabled'
  if (raw === 'redeemed') return 'redeemed'
  return 'active'
}

export function normalizePromoType(raw: unknown): PromoType {
  if (raw === 'subscription') return 'subscription'
  if (raw === 'subscription_custom') return 'subscription_custom'
  if (raw === 'subscription_offer') return 'subscription_offer'
  if (raw === 'topup_bonus') return 'topup_bonus'
  if (raw === 'free_reset') return 'free_reset'
  if (raw === 'extra_tokens') return 'subscription_custom'
  return 'balance'
}

export function generatePromoCodeLocal(_length = 16) {
  const bytes = randomBytes(16)
  let chars = ''
  for (let i = 0; i < 16; i += 1) {
    chars += VOUCHER_ALPHABET[bytes[i]! % VOUCHER_ALPHABET.length]
  }
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`
}

export type PromoCodeRow = {
  id: string
  code: string
  type: PromoType
  plan_key: string | null
  plan_label: string | null
  custom_days: number | null
  custom_token_limit: number | null
  discount_mode: SubscriptionOfferMode | null
  discount_value: number | null
  offer_unit: SubscriptionOfferUnit | null
  offer_amount: number | null
  bonus_target: PromoBonusTarget | null
  bonus_percent: number | null
  bonus_duration_unit: PromoBonusDurationUnit | null
  bonus_duration_value: number | null
  /** Reward in USD cents (legacy rows store token amounts converted on read; 0 for subscriptions). */
  reward_cents: number
  reward_tokens: number
  max_uses: number
  used_count: number
  expires_at: string | null
  note: string
  created_at: string
  created_by: string
  status: PromoStatus
  redeemed_at?: string | null
  redeemed_by_user_id?: string | null
}

function parseExpiresAt(raw: string | null | undefined, opts: { requireFuture: boolean }) {
  if (!raw) return null
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) throw new Error('Invalid expiration datetime')
  if (opts.requireFuture && t <= Date.now()) throw new Error('Expiration must be in the future')
  return new Date(t).toISOString()
}

export function rowFromDb(row: Record<string, unknown>): PromoCodeRow {
  const legacyTokens = Number(row.reward_tokens ?? 0)
  const storedCents = Number(row.reward_cents ?? 0)
  const rewardCents =
    storedCents > 0 ? storedCents : Math.max(0, Math.round((legacyTokens / 4_000_000) * 100))
  const type = normalizePromoType(row.type)
  const planKey = typeof row.plan_key === 'string' && row.plan_key.trim() ? row.plan_key.trim() : null
  const customDays =
    row.custom_days != null && Number(row.custom_days) > 0 ? Math.floor(Number(row.custom_days)) : null
  const customTokenLimit =
    row.custom_token_limit != null && Number(row.custom_token_limit) > 0
      ? Math.floor(Number(row.custom_token_limit))
      : null

  let planLabel: string | null = null
  if (type === 'subscription' && planKey) {
    const plan = getSubscriptionPlan(planKey as SubscriptionPlanKey)
    planLabel = plan?.label ?? planKey
  } else if (type === 'subscription_custom') {
    const days = customDays ?? 1
    const tokens = customTokenLimit ?? 0
    planLabel = `${days} day${days === 1 ? '' : 's'} (${formatTokenCount(tokens)})`
  } else if (type === 'subscription_offer') {
    const mode = normalizeOfferMode(row.discount_mode)
    const unit = normalizeOfferUnit(row.offer_unit)
    const value = Math.floor(Number(row.discount_value ?? 0))
    const amount = Math.floor(Number(row.offer_amount ?? 0))
    planLabel = mode && unit && value > 0 && amount > 0 ? offerLabel(mode, value, unit, amount) : 'Subscription offer'
  } else if (type === 'topup_bonus') {
    const target = normalizeBonusTarget(row.bonus_target) ?? 'both'
    const pct = Math.floor(Number(row.bonus_percent ?? 0))
    const unit = normalizeBonusDurationUnit(row.bonus_duration_unit) ?? 'hours'
    const value = Math.floor(Number(row.bonus_duration_value ?? 0))
    planLabel = pct > 0 && value > 0 ? bonusLabel(target, pct, unit, value) : 'Top Up Bonus'
  } else if (type === 'free_reset') {
    planLabel = 'Daily Free Limit Reset'
  }

  return {
    ...(row as unknown as PromoCodeRow),
    type,
    plan_key: planKey,
    plan_label: planLabel,
    custom_days: customDays,
    custom_token_limit: customTokenLimit,
    discount_mode: normalizeOfferMode(row.discount_mode),
    discount_value:
      row.discount_value != null && Number(row.discount_value) > 0 ? Math.floor(Number(row.discount_value)) : null,
    offer_unit: normalizeOfferUnit(row.offer_unit),
    offer_amount:
      row.offer_amount != null && Number(row.offer_amount) > 0 ? Math.floor(Number(row.offer_amount)) : null,
    bonus_target: normalizeBonusTarget(row.bonus_target),
    bonus_percent:
      row.bonus_percent != null && Number(row.bonus_percent) > 0 ? Math.floor(Number(row.bonus_percent)) : null,
    bonus_duration_unit: normalizeBonusDurationUnit(row.bonus_duration_unit),
    bonus_duration_value:
      row.bonus_duration_value != null && Number(row.bonus_duration_value) > 0
        ? Math.floor(Number(row.bonus_duration_value))
        : null,
    reward_cents: type === 'balance' ? rewardCents : 0,
    redeemed_at: typeof row.redeemed_at === 'string' ? row.redeemed_at : null,
    redeemed_by_user_id: typeof row.redeemed_by_user_id === 'string' ? row.redeemed_by_user_id : null,
  }
}

export function listPromoCodes(): PromoCodeRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM promo_codes
       ORDER BY datetime(created_at) DESC`,
    )
    .all() as Array<Record<string, unknown>>
  return rows.map(rowFromDb)
}

export function createPromoCode(input: {
  code: string
  type?: PromoType
  planKey?: string | null
  customDays?: number | null
  customTokenLimit?: number | null
  discountMode?: string | null
  discountUsd?: number | null
  discountPercent?: number | null
  offerUnit?: string | null
  offerAmount?: number | null
  bonusTarget?: string | null
  bonusPercent?: number | null
  bonusDurationUnit?: string | null
  bonusDurationValue?: number | null
  rewardUsd?: number
  maxUses: number
  expiresAt: string | null
  note: string
  createdBy: string
  status?: PromoStatus
}) {
  const code = normalizePromoCode(input.code)
  validatePromoCodeFormat(code)
  const type = normalizePromoType(input.type)
  const maxUses = Math.round(Number(input.maxUses))
  if (!Number.isFinite(maxUses) || maxUses < 1) {
    throw new Error('Max uses must be at least 1')
  }

  let rewardCents = 0
  let planKey: string | null = null
  let customDays: number | null = null
  let customTokenLimit: number | null = null
  let discountMode: SubscriptionOfferMode | null = null
  let discountValue: number | null = null
  let offerUnit: SubscriptionOfferUnit | null = null
  let offerAmount: number | null = null
  let bonusTarget: PromoBonusTarget | null = null
  let bonusPercent: number | null = null
  let bonusDurationUnit: PromoBonusDurationUnit | null = null
  let bonusDurationValue: number | null = null

  if (type === 'subscription') {
    const rawKey = String(input.planKey ?? '').trim()
    if (!isSubscriptionPlanKey(rawKey)) {
      throw new Error('Please select a valid subscription plan')
    }
    const plan = getSubscriptionPlan(rawKey)
    if (!plan) {
      throw new Error('Unknown subscription plan')
    }
    planKey = plan.key
    rewardCents = 0
  } else if (type === 'subscription_custom') {
    const days = Math.floor(Number(input.customDays))
    if (!Number.isFinite(days) || days < 1) {
      throw new Error('Subscription duration must be at least 1 day')
    }
    const tokens = Math.floor(Number(input.customTokenLimit))
    if (!Number.isFinite(tokens) || tokens < 1) {
      throw new Error('Token limit must be at least 1 token')
    }
    customDays = days
    customTokenLimit = tokens
    rewardCents = 0
  } else if (type === 'subscription_offer') {
    const offer = parseOfferFields(input)
    discountMode = offer.mode
    discountValue = offer.value
    offerUnit = offer.unit
    offerAmount = offer.amount
    rewardCents = 0
  } else if (type === 'topup_bonus') {
    const bonus = parseBonusFields(input)
    bonusTarget = bonus.target
    bonusPercent = bonus.percent
    bonusDurationUnit = bonus.durationUnit
    bonusDurationValue = bonus.durationValue
    rewardCents = 0
  } else if (type === 'free_reset') {
    rewardCents = 0
    planKey = null
  } else {
    const rawReward = Number(input.rewardUsd ?? 0)
    if (!Number.isFinite(rawReward) || rawReward < 0.01) {
      throw new Error('Reward must be at least $0.01')
    }
    rewardCents = Math.round(rawReward * 100)
    if (!Number.isFinite(rewardCents) || rewardCents < 1) {
      throw new Error('Reward must be at least $0.01')
    }
  }

  const expiresAt = parseExpiresAt(input.expiresAt, { requireFuture: true })
  const status = normalizePromoStatus(input.status)

  const promoId = id('promo')
  const createdAt = nowIso()
  try {
    db.prepare(
      `INSERT INTO promo_codes
        (id, code, type, plan_key, custom_days, custom_token_limit, discount_mode, discount_value, offer_unit, offer_amount, bonus_target, bonus_percent, bonus_duration_unit, bonus_duration_value, reward_cents, reward_tokens, max_uses, used_count, expires_at, note, created_at, created_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(
      promoId,
      code,
      type,
      planKey,
      customDays,
      customTokenLimit,
      discountMode,
      discountValue,
      offerUnit,
      offerAmount,
      bonusTarget,
      bonusPercent,
      bonusDurationUnit,
      bonusDurationValue,
      rewardCents,
      tokensFromUsdCents(rewardCents),
      maxUses,
      expiresAt,
      String(input.note ?? '').slice(0, 4000),
      createdAt,
      input.createdBy,
      status,
    )
  } catch (reason) {
    const msg = reason instanceof Error ? reason.message : ''
    if (msg.includes('UNIQUE')) throw new Error('Promo code already exists')
    throw reason
  }

  return rowFromDb(
    db.prepare(`SELECT * FROM promo_codes WHERE id = ?`).get(promoId) as Record<string, unknown>,
  )
}

export function updatePromoCode(
  promoId: string,
  input: {
    code: string
    type?: PromoType
    planKey?: string | null
    customDays?: number | null
    customTokenLimit?: number | null
    discountMode?: string | null
    discountUsd?: number | null
    discountPercent?: number | null
    offerUnit?: string | null
    offerAmount?: number | null
    bonusTarget?: string | null
    bonusPercent?: number | null
    bonusDurationUnit?: string | null
    bonusDurationValue?: number | null
    rewardUsd?: number
    maxUses: number
    expiresAt: string | null
    note: string
    status: PromoStatus
  },
) {
  const code = normalizePromoCode(input.code)
  validatePromoCodeFormat(code)
  const type = normalizePromoType(input.type)
  const maxUses = Math.round(Number(input.maxUses))
  if (!Number.isFinite(maxUses) || maxUses < 1) {
    throw new Error('Max uses must be at least 1')
  }

  let rewardCents = 0
  let planKey: string | null = null
  let customDays: number | null = null
  let customTokenLimit: number | null = null
  let discountMode: SubscriptionOfferMode | null = null
  let discountValue: number | null = null
  let offerUnit: SubscriptionOfferUnit | null = null
  let offerAmount: number | null = null
  let bonusTarget: PromoBonusTarget | null = null
  let bonusPercent: number | null = null
  let bonusDurationUnit: PromoBonusDurationUnit | null = null
  let bonusDurationValue: number | null = null

  if (type === 'subscription') {
    const rawKey = String(input.planKey ?? '').trim()
    if (!isSubscriptionPlanKey(rawKey)) {
      throw new Error('Please select a valid subscription plan')
    }
    const plan = getSubscriptionPlan(rawKey)
    if (!plan) {
      throw new Error('Unknown subscription plan')
    }
    planKey = plan.key
    rewardCents = 0
  } else if (type === 'subscription_custom') {
    const days = Math.floor(Number(input.customDays))
    if (!Number.isFinite(days) || days < 1) {
      throw new Error('Subscription duration must be at least 1 day')
    }
    const tokens = Math.floor(Number(input.customTokenLimit))
    if (!Number.isFinite(tokens) || tokens < 1) {
      throw new Error('Token limit must be at least 1 token')
    }
    customDays = days
    customTokenLimit = tokens
    rewardCents = 0
  } else if (type === 'subscription_offer') {
    const offer = parseOfferFields(input)
    discountMode = offer.mode
    discountValue = offer.value
    offerUnit = offer.unit
    offerAmount = offer.amount
    rewardCents = 0
  } else if (type === 'topup_bonus') {
    const bonus = parseBonusFields(input)
    bonusTarget = bonus.target
    bonusPercent = bonus.percent
    bonusDurationUnit = bonus.durationUnit
    bonusDurationValue = bonus.durationValue
    rewardCents = 0
  } else if (type === 'free_reset') {
    rewardCents = 0
    planKey = null
  } else {
    const rawReward = Number(input.rewardUsd ?? 0)
    if (!Number.isFinite(rawReward) || rawReward < 0.01) {
      throw new Error('Reward must be at least $0.01')
    }
    rewardCents = Math.round(rawReward * 100)
    if (!Number.isFinite(rewardCents) || rewardCents < 1) {
      throw new Error('Reward must be at least $0.01')
    }
  }

  const expiresAt = parseExpiresAt(input.expiresAt, { requireFuture: false })
  const status = normalizePromoStatus(input.status)

  try {
    db.prepare(
      `UPDATE promo_codes
       SET code = ?, type = ?, plan_key = ?, custom_days = ?, custom_token_limit = ?, discount_mode = ?, discount_value = ?, offer_unit = ?, offer_amount = ?, bonus_target = ?, bonus_percent = ?, bonus_duration_unit = ?, bonus_duration_value = ?, reward_cents = ?, reward_tokens = ?, max_uses = ?, expires_at = ?, note = ?, status = ?
       WHERE id = ?`,
    ).run(
      code,
      type,
      planKey,
      customDays,
      customTokenLimit,
      discountMode,
      discountValue,
      offerUnit,
      offerAmount,
      bonusTarget,
      bonusPercent,
      bonusDurationUnit,
      bonusDurationValue,
      rewardCents,
      tokensFromUsdCents(rewardCents),
      maxUses,
      expiresAt,
      String(input.note ?? '').slice(0, 4000),
      status,
      promoId,
    )
  } catch (reason) {
    const msg = reason instanceof Error ? reason.message : ''
    if (msg.includes('UNIQUE')) throw new Error('Promo code already exists')
    throw reason
  }

  return rowFromDb(
    db.prepare(`SELECT * FROM promo_codes WHERE id = ?`).get(promoId) as Record<string, unknown>,
  )
}

export function deletePromoCode(promoId: string) {
  const result = db.prepare(`DELETE FROM promo_codes WHERE id = ?`).run(promoId)
  return result.changes > 0
}

export type RedeemPromoResult = {
  ok: true
  type: PromoType
  code: string
  usd: number
  tokens: number
  bonusPercent?: number
  bonusTarget?: string
  planLabel?: string | null
  expiresAt?: string | null
  offerLabel?: string | null
  extended?: boolean
  redeemedAt: string
}

export function redeemPromoCode(input: {
  userId: string
  code: string
}): RedeemPromoResult {
  const code = normalizePromoCode(input.code)
  validatePromoCodeFormat(code)

  const tx = db.transaction(() => {
    const promoRaw = db
      .prepare(
        `SELECT * FROM promo_codes WHERE code = ?`,
      )
      .get(code) as Record<string, unknown> | undefined
    const promo = promoRaw ? rowFromDb(promoRaw) : null

    if (!promo) throw new Error('Invalid promo code')
    if (promo.status === 'disabled') throw new Error('This promo code is disabled')
    if (promo.status === 'redeemed' || promo.used_count >= promo.max_uses) {
      throw new Error('This promo code has reached its usage limit')
    }
    if (promo.expires_at && Date.parse(promo.expires_at) <= Date.now()) {
      throw new Error('This promo code has expired')
    }

    const already = db
      .prepare(`SELECT 1 AS ok FROM promo_redemptions WHERE promo_id = ? AND user_id = ?`)
      .get(promo.id, input.userId)
    if (already) throw new Error('You already redeemed this promo code')

    if (promo.type === 'free_reset') {
      const activeSub = getActiveSubscription(input.userId)
      if (activeSub) {
        throw new Error(
          'This promo code cannot be redeemed while you have an active subscription. You can redeem it once your subscription expires.',
        )
      }
    }

    const nowDate = new Date()
    const when = nowDate.toISOString()
    const whenUtc = formatUtcSeconds(nowDate)

    const updated = db
      .prepare(
        `UPDATE promo_codes
         SET used_count = used_count + 1,
             status = CASE WHEN used_count + 1 >= max_uses THEN 'redeemed' ELSE status END,
             redeemed_at = COALESCE(redeemed_at, ?),
             redeemed_by_user_id = COALESCE(redeemed_by_user_id, ?)
         WHERE id = ? AND used_count < max_uses AND COALESCE(status, 'active') = 'active'`,
      )
      .run(whenUtc, input.userId, promo.id)
    if (!updated.changes) throw new Error('This code has already been redeemed')

    // Fetch user details for audit trail
    const userRow = db.prepare('SELECT email FROM users WHERE id = ?').get(input.userId) as { email?: string } | undefined
    const userEmail = userRow?.email || input.userId

    if (promo.type === 'topup_bonus') {
      const target = promo.bonus_target ?? 'both'
      const percent = promo.bonus_percent ?? 0
      const durationUnit = promo.bonus_duration_unit ?? 'hours'
      const durationValue = promo.bonus_duration_value ?? 1
      if (percent < 1 || durationValue < 1) {
        throw new Error('This bonus promo is misconfigured')
      }
      const granted = grantUserPromoBonus({
        userId: input.userId,
        promoId: promo.id,
        target,
        bonusPercent: percent,
        durationUnit,
        durationValue,
      })
      db.prepare(
        `INSERT INTO promo_redemptions (promo_id, user_id, tokens, usd_cents, created_at)
         VALUES (?, ?, 0, 0, ?)`,
      ).run(promo.id, input.userId, when)
      db.prepare(
        `INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at)
         VALUES (?, ?, 'voucher.redeemed', ?, ?, ?)`,
      ).run(
        id('audit'),
        userEmail,
        promo.id,
        JSON.stringify({
          code: promo.code,
          status: 'Redeemed',
          redeemedTimestamp: whenUtc,
          userId: input.userId,
          userEmail,
          type: promo.type,
          bonus: granted.label,
          bonusExpiresAt: granted.expiresAt,
        }),
        when,
      )
      return {
        ok: true as const,
        type: promo.type,
        code: promo.code,
        usd: 0,
        tokens: 0,
        bonusPercent: percent,
        bonusTarget: target,
        planLabel: granted.label,
        offerLabel: granted.label,
        expiresAt: granted.expiresAt,
        extended: false,
        redeemedAt: whenUtc,
      }
    }

    if (promo.type === 'subscription_offer') {
      const mode = normalizeOfferMode(promo.discount_mode)
      const unit = normalizeOfferUnit(promo.offer_unit)
      const value = promo.discount_value ?? 0
      const amount = promo.offer_amount ?? 0
      if (!mode || !unit || value < 1 || amount < 1) {
        throw new Error('This offer is misconfigured')
      }
      const granted = grantSubscriptionOffer({
        userId: input.userId,
        promoId: promo.id,
        mode,
        value,
        unit,
        amount,
      })
      db.prepare(
        `INSERT INTO promo_redemptions (promo_id, user_id, tokens, usd_cents, created_at)
         VALUES (?, ?, 0, 0, ?)`,
      ).run(promo.id, input.userId, when)
      db.prepare(
        `INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at)
         VALUES (?, ?, 'voucher.redeemed', ?, ?, ?)`,
      ).run(
        id('audit'),
        userEmail,
        promo.id,
        JSON.stringify({
          code: promo.code,
          status: 'Redeemed',
          redeemedTimestamp: whenUtc,
          userId: input.userId,
          userEmail,
          type: promo.type,
          offer: granted.label,
          offerExpiresAt: granted.expiresAt,
        }),
        when,
      )
      return {
        ok: true as const,
        type: promo.type,
        code: promo.code,
        usd: 0,
        tokens: 0,
        planLabel: granted.label,
        offerLabel: granted.label,
        expiresAt: granted.expiresAt,
        extended: false,
        redeemedAt: whenUtc,
      }
    }

    if (promo.type === 'free_reset') {
      resetFreeTierDailyUsage(input.userId)

      db.prepare(
        `INSERT INTO promo_redemptions (promo_id, user_id, tokens, usd_cents, created_at)
         VALUES (?, ?, 0, 0, ?)`,
      ).run(promo.id, input.userId, when)

      db.prepare(
        `INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at)
         VALUES (?, ?, 'voucher.redeemed', ?, ?, ?)`,
      ).run(
        id('audit'),
        userEmail,
        promo.id,
        JSON.stringify({
          code: promo.code,
          status: 'Redeemed',
          redeemedTimestamp: whenUtc,
          userId: input.userId,
          userEmail,
          type: 'free_reset',
        }),
        when,
      )

      return {
        ok: true as const,
        type: 'free_reset' as const,
        code: promo.code,
        usd: 0,
        tokens: 0,
        planLabel: 'Daily Free Limit Reset',
        expiresAt: null,
        extended: false,
        redeemedAt: whenUtc,
      }
    }

    if (promo.type === 'subscription' || promo.type === 'subscription_custom') {
      let activation
      let planLabel: string
      let grantedTokens: number

      if (promo.type === 'subscription_custom') {
        const days = Math.max(1, promo.custom_days ?? 1)
        const tokenLimit = Math.max(1, promo.custom_token_limit ?? 1)
        planLabel = `${days} day${days === 1 ? '' : 's'} (${formatTokenCount(tokenLimit)})`
        activation = activateSubscription({
          userId: input.userId,
          planKey: 'custom',
          planLabel,
          grantedDays: days,
          grantedTokenLimit: tokenLimit,
          source: 'promo',
          sourceRef: `promo:${promo.code}`,
          priceCents: 0,
        })
        grantedTokens = tokenLimit
      } else {
        const planKey = promo.plan_key as SubscriptionPlanKey
        const plan = planKey ? getSubscriptionPlan(planKey) : null
        if (!plan) throw new Error('Subscription plan for this promo is no longer available')
        planLabel = plan.label
        activation = activateSubscription({
          userId: input.userId,
          planKey: plan.key,
          source: 'promo',
          sourceRef: `promo:${promo.code}`,
          priceCents: 0,
        })
        grantedTokens = activation.subscription.tokenLimit
      }

      db.prepare(
        `INSERT INTO promo_redemptions (promo_id, user_id, tokens, usd_cents, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      ).run(promo.id, input.userId, grantedTokens, when)

      db.prepare(
        `INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at)
         VALUES (?, ?, 'voucher.redeemed', ?, ?, ?)`,
      ).run(
        id('audit'),
        userEmail,
        promo.id,
        JSON.stringify({
          code: promo.code,
          status: 'Redeemed',
          redeemedTimestamp: whenUtc,
          userId: input.userId,
          userEmail,
          type: promo.type,
          plan: planLabel,
          tokens: grantedTokens,
        }),
        when,
      )

      return {
        ok: true as const,
        type: promo.type,
        code: promo.code,
        usd: 0,
        tokens: grantedTokens,
        planLabel,
        expiresAt: activation.subscription.expiresAt,
        extended: activation.extended,
        redeemedAt: whenUtc,
      }
    }

    const rewardTokens = tokensFromUsdCents(promo.reward_cents)
    db.prepare(
      `INSERT INTO promo_redemptions (promo_id, user_id, tokens, usd_cents, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(promo.id, input.userId, rewardTokens, promo.reward_cents, when)

    db.prepare(`UPDATE users SET balance_tokens = balance_tokens + ? WHERE id = ?`).run(
      rewardTokens,
      input.userId,
    )
    db.prepare(
      `INSERT INTO balance_transactions
        (id, user_id, type, amount_cents, amount_tokens, note, status, created_at)
       VALUES (?, ?, 'promo_credit', ?, ?, ?, 'completed', ?)`,
    ).run(
      id('txn'),
      input.userId,
      promo.reward_cents,
      rewardTokens,
      `Promo code ${promo.code} · +${formatUsdExact(promo.reward_cents / 100)}`,
      when,
    )

    db.prepare(
      `INSERT INTO audit_logs (id, actor_email, action, target, metadata_json, created_at)
       VALUES (?, ?, 'voucher.redeemed', ?, ?, ?)`,
    ).run(
      id('audit'),
      userEmail,
      promo.id,
      JSON.stringify({
        code: promo.code,
        status: 'Redeemed',
        redeemedTimestamp: whenUtc,
        userId: input.userId,
        userEmail,
        creditedTokens: rewardTokens,
        creditedUsd: formatUsdExact(promo.reward_cents / 100),
      }),
      when,
    )

    return {
      ok: true as const,
      type: 'balance' as const,
      code: promo.code,
      usd: promo.reward_cents / 100,
      tokens: rewardTokens,
      planLabel: null,
      expiresAt: null,
      extended: false,
      redeemedAt: whenUtc,
    }
  })

  const result = tx.immediate()
  return result
}
