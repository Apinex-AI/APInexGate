import { db, nowIso } from './db.js'

export type SubscriptionOfferMode = 'usd' | 'percent'
export type SubscriptionOfferUnit = 'hours' | 'days'

export type ActiveSubscriptionOffer = {
  mode: SubscriptionOfferMode
  /** USD: cents off. Percent: integer 1–99. */
  value: number
  expiresAt: string
  label: string
}

export function normalizeOfferMode(raw: unknown): SubscriptionOfferMode | null {
  if (raw === 'usd' || raw === 'percent') return raw
  return null
}

export function normalizeOfferUnit(raw: unknown): SubscriptionOfferUnit | null {
  if (raw === 'hours' || raw === 'days') return raw
  return null
}

export function offerWindowMs(unit: SubscriptionOfferUnit, amount: number) {
  const n = Math.floor(amount)
  if (!Number.isFinite(n) || n < 1) throw new Error('Offer duration must be at least 1')
  if (unit === 'hours') {
    if (n > 24 * 90) throw new Error('Offer duration cannot exceed 90 days')
    return n * 60 * 60 * 1000
  }
  if (n > 90) throw new Error('Offer duration cannot exceed 90 days')
  return n * 24 * 60 * 60 * 1000
}

export function parseOfferFields(input: {
  discountMode?: unknown
  discountUsd?: number | null
  discountPercent?: number | null
  offerUnit?: unknown
  offerAmount?: number | null
}) {
  const mode = normalizeOfferMode(input.discountMode)
  if (!mode) throw new Error('Choose a discount in $ or %')
  const unit = normalizeOfferUnit(input.offerUnit)
  if (!unit) throw new Error('Choose hours or days for the offer')
  const amount = Math.floor(Number(input.offerAmount))
  offerWindowMs(unit, amount)

  let value = 0
  if (mode === 'percent') {
    value = Math.floor(Number(input.discountPercent))
    if (!Number.isFinite(value) || value < 1 || value > 99) {
      throw new Error('Percent discount must be between 1 and 99')
    }
  } else {
    const usd = Number(input.discountUsd)
    if (!Number.isFinite(usd) || usd < 0.01) throw new Error('Dollar discount must be at least $0.01')
    value = Math.round(usd * 100)
    if (value < 1) throw new Error('Dollar discount must be at least $0.01')
    if (value > 100_000_00) throw new Error('Dollar discount is too large')
  }
  return { mode, value, unit, amount }
}

export function offerLabel(mode: SubscriptionOfferMode, value: number, unit: SubscriptionOfferUnit, amount: number) {
  const discount = mode === 'percent' ? `${value}% off` : `$${(value / 100).toFixed(2)} off`
  const window = unit === 'hours' ? `${amount} hour${amount === 1 ? '' : 's'}` : `${amount} day${amount === 1 ? '' : 's'}`
  return `${discount} Subscriptions · ${window}`
}

export const MIN_SUBSCRIPTION_OFFER_PRICE_CENTS = 50

export function applyOfferCents(
  priceCents: number,
  offer: { mode: SubscriptionOfferMode; value: number } | null,
  minCents: number = MIN_SUBSCRIPTION_OFFER_PRICE_CENTS,
) {
  const base = Math.max(0, Math.round(Number(priceCents) || 0))
  if (!offer || base < 1) return base
  const floor = Math.max(1, Math.min(base, minCents))
  if (offer.mode === 'percent') {
    const pct = Math.min(99, Math.max(0, Math.floor(Number(offer.value) || 0)))
    return Math.max(floor, Math.round((base * (100 - pct)) / 100))
  }
  const discount = Math.max(0, Math.floor(Number(offer.value) || 0))
  return Math.max(floor, base - discount)
}

export function getActiveSubscriptionOffer(userId: string): ActiveSubscriptionOffer | null {
  const row = db
    .prepare(
      `SELECT discount_mode, discount_value, expires_at
       FROM user_subscription_offers WHERE user_id = ?`,
    )
    .get(userId) as
    | { discount_mode: string; discount_value: number; expires_at: string }
    | undefined
  if (!row) return null
  if (Date.parse(row.expires_at) <= Date.now()) return null
  const mode = normalizeOfferMode(row.discount_mode)
  if (!mode) return null
  const value = Math.floor(Number(row.discount_value))
  if (!Number.isFinite(value) || value < 1) return null
  const label = mode === 'percent' ? `${value}% off` : `$${(value / 100).toFixed(2)} off`
  return { mode, value, expiresAt: row.expires_at, label }
}

export function consumeSubscriptionOffer(userId: string): boolean {
  if (!userId) return false
  const result = db.prepare(`DELETE FROM user_subscription_offers WHERE user_id = ?`).run(userId)
  return result.changes > 0
}

export function grantSubscriptionOffer(input: {
  userId: string
  promoId: string
  mode: SubscriptionOfferMode
  value: number
  unit: SubscriptionOfferUnit
  amount: number
}) {
  const expiresAt = new Date(Date.now() + offerWindowMs(input.unit, input.amount)).toISOString()
  const when = nowIso()
  db.prepare(
    `INSERT INTO user_subscription_offers
      (user_id, promo_id, discount_mode, discount_value, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       promo_id = excluded.promo_id,
       discount_mode = excluded.discount_mode,
       discount_value = excluded.discount_value,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`,
  ).run(input.userId, input.promoId, input.mode, input.value, expiresAt, when)
  return { expiresAt, label: offerLabel(input.mode, input.value, input.unit, input.amount) }
}
