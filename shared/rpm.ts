export type RpmPlanKey = 'free' | 'standard' | 'high' | 'custom'

export type RpmCatalogPlan = {
  key: RpmPlanKey
  rpm: number
  priceCents: number
  enabled: boolean
  custom: boolean
}

/** Purchased 30/60 RPM plans last 30 days, then fall back to the free plan. */
export const RPM_PLAN_DAYS = 30
export const RPM_PAID_KEYS = ['standard', 'high'] as const
export const MIN_RPM = 1
export const MAX_RPM = 600

export const DEFAULT_RPM_CATALOG: RpmCatalogPlan[] = [
  { key: 'free', rpm: 5, priceCents: 0, enabled: true, custom: false },
  { key: 'standard', rpm: 30, priceCents: 1000, enabled: true, custom: false },
  { key: 'high', rpm: 60, priceCents: 2000, enabled: true, custom: false },
  { key: 'custom', rpm: 0, priceCents: 0, enabled: true, custom: true },
]

export function isPaidRpmKey(key: string): key is 'standard' | 'high' {
  return key === 'standard' || key === 'high'
}
