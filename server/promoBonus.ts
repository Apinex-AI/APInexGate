import { db, nowIso } from './db.js'

export type PromoBonusTarget = 'both' | 'subscription' | 'topup'
export type PromoBonusDurationUnit = 'minutes' | 'hours'

export type ActivePromoBonus = {
  promoId: string | null
  target: PromoBonusTarget
  bonusPercent: number
  expiresAt: string
  label: string
}

export function normalizeBonusTarget(raw: unknown): PromoBonusTarget | null {
  if (raw === 'both' || raw === 'subscription' || raw === 'topup') return raw
  return null
}

export function normalizeBonusDurationUnit(raw: unknown): PromoBonusDurationUnit | null {
  if (raw === 'minutes' || raw === 'hours') return raw
  return null
}

export function bonusDurationMs(unit: PromoBonusDurationUnit, amount: number) {
  const n = Math.floor(amount)
  if (!Number.isFinite(n) || n < 1) throw new Error('Bonus duration must be at least 1')
  if (unit === 'minutes') {
    if (n > 60 * 24 * 90) throw new Error('Bonus duration cannot exceed 90 days')
    return n * 60 * 1000
  }
  if (n > 24 * 90) throw new Error('Bonus duration cannot exceed 90 days')
  return n * 60 * 60 * 1000
}

export function parseBonusFields(input: {
  bonusTarget?: unknown
  bonusPercent?: number | null
  bonusDurationUnit?: unknown
  bonusDurationValue?: number | null
}) {
  const target = normalizeBonusTarget(input.bonusTarget) ?? 'both'
  const unit = normalizeBonusDurationUnit(input.bonusDurationUnit)
  if (!unit) throw new Error('Choose minutes or hours for the bonus duration')
  const durationValue = Math.floor(Number(input.bonusDurationValue))
  bonusDurationMs(unit, durationValue)

  const percent = Math.floor(Number(input.bonusPercent))
  if (!Number.isFinite(percent) || percent < 1 || percent > 1000) {
    throw new Error('Bonus percent must be between 1 and 1000%')
  }

  return { target, percent, durationUnit: unit, durationValue }
}

export function bonusLabel(
  target: PromoBonusTarget,
  percent: number,
  unit: PromoBonusDurationUnit,
  amount: number,
) {
  const targetName =
    target === 'both' ? 'Top up & Subs' : target === 'subscription' ? 'Subs only' : 'Top up only'
  const window =
    unit === 'minutes'
      ? `${amount} min${amount === 1 ? '' : 's'}`
      : `${amount} hour${amount === 1 ? '' : 's'}`
  return `+${percent}% (${targetName}) · ${window}`
}

export function grantUserPromoBonus(input: {
  userId: string
  promoId: string
  target: PromoBonusTarget
  bonusPercent: number
  durationUnit: PromoBonusDurationUnit
  durationValue: number
}) {
  const ms = bonusDurationMs(input.durationUnit, input.durationValue)
  const expiresAt = new Date(Date.now() + ms).toISOString()
  const createdAt = nowIso()

  db.prepare(
    `INSERT INTO user_promo_bonuses
      (user_id, promo_id, target, bonus_percent, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       promo_id = excluded.promo_id,
       target = excluded.target,
       bonus_percent = excluded.bonus_percent,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`,
  ).run(input.userId, input.promoId, input.target, input.bonusPercent, expiresAt, createdAt)

  const label = bonusLabel(input.target, input.bonusPercent, input.durationUnit, input.durationValue)
  return { expiresAt, label }
}

export function getActivePromoBonus(userId: string): ActivePromoBonus | null {
  const row = db
    .prepare(
      `SELECT promo_id, target, bonus_percent, expires_at
       FROM user_promo_bonuses WHERE user_id = ?`,
    )
    .get(userId) as
    | { promo_id: string | null; target: string; bonus_percent: number; expires_at: string }
    | undefined
  if (!row) return null
  if (Date.parse(row.expires_at) <= Date.now()) return null
  const target = normalizeBonusTarget(row.target)
  if (!target) return null
  const bonusPercent = Math.max(0, Math.floor(Number(row.bonus_percent) || 0))
  if (bonusPercent <= 0) return null
  const label = `+${bonusPercent}% (${target === 'both' ? 'Top up & Subs' : target === 'subscription' ? 'Subs only' : 'Top up only'})`
  return {
    promoId: row.promo_id,
    target,
    bonusPercent,
    expiresAt: row.expires_at,
    label,
  }
}

export function getPromoBonusPct(userId: string, context: 'topup' | 'subscription'): number {
  const active = getActivePromoBonus(userId)
  if (!active) return 0
  if (active.target === 'both' || active.target === context) {
    return active.bonusPercent
  }
  return 0
}

export function applyCombinedTopupBonus(userId: string, baseTokens: number) {
  const promoBonusPct = getPromoBonusPct(userId, 'topup')
  const base = Math.max(0, Math.round(Number(baseTokens) || 0))
  const bonusTokens = base > 0 && promoBonusPct > 0 ? Math.round((base * promoBonusPct) / 100) : 0
  const activePromo = getActivePromoBonus(userId)

  return {
    tokens: base + bonusTokens,
    bonusTokens,
    baseTokens: base,
    promoBonusPct,
    totalBonusPct: promoBonusPct,
    promoExpiresAt: activePromo?.expiresAt ?? null,
  }
}

export function applyCombinedSubscriptionBonus(userId: string, baseTokens: number) {
  const promoBonusPct = getPromoBonusPct(userId, 'subscription')
  const base = Math.max(0, Math.round(Number(baseTokens) || 0))
  const bonusTokens = base > 0 && promoBonusPct > 0 ? Math.round((base * promoBonusPct) / 100) : 0
  const activePromo = getActivePromoBonus(userId)

  return {
    tokens: base + bonusTokens,
    bonusTokens,
    baseTokens: base,
    promoBonusPct,
    totalBonusPct: promoBonusPct,
    promoExpiresAt: activePromo?.expiresAt ?? null,
  }
}
