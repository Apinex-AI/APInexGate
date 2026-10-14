import { siteUrl } from './brand.js'

export const SUBSCRIPTIONS_PATH = '/subscriptions'
export const subscriptionsUrl = () => `${siteUrl()}${SUBSCRIPTIONS_PATH}`
/** @deprecated use subscriptionsUrl() */
export const SUBSCRIPTIONS_URL = subscriptionsUrl()

export type SubscriptionPlanKey = 'day1' | 'day7' | 'day14' | 'day30' | 'custom'
export type SubscriptionGrantKind = 'custom' | 'unlimited'

export type SubscriptionPlanConfig = {
  key: SubscriptionPlanKey
  label: string
  days: number
  enabled: boolean
  priceCents: number
  kind: SubscriptionGrantKind
  tokenLimit: number
  isFeatured?: boolean
}

export type SubscriptionSettings = {
  freeDailyTokens: number
  plans: SubscriptionPlanConfig[]
}

export const SUBSCRIPTION_PLAN_KEYS: SubscriptionPlanKey[] = ['day1', 'day7', 'day14', 'day30']

export function isSubscriptionPlanKey(value: unknown): value is SubscriptionPlanKey {
  return value === 'custom' || (typeof value === 'string' && (SUBSCRIPTION_PLAN_KEYS as string[]).includes(value))
}

export const DEFAULT_SUBSCRIPTION_PLANS: SubscriptionPlanConfig[] = [
  {
    key: 'day1',
    label: '3 days',
    days: 3,
    enabled: true,
    priceCents: 500,
    kind: 'custom',
    tokenLimit: 500_000_000,
  },
  {
    key: 'day7',
    label: '10 days',
    days: 10,
    enabled: true,
    priceCents: 1000,
    kind: 'custom',
    tokenLimit: 1_100_000_000,
  },
  {
    key: 'day14',
    label: '20 days',
    days: 20,
    enabled: true,
    priceCents: 2000,
    kind: 'custom',
    tokenLimit: 2_500_000_000,
  },
  {
    key: 'day30',
    label: '30 days',
    days: 30,
    enabled: true,
    priceCents: 3000,
    kind: 'custom',
    tokenLimit: 5_000_000_000,
    isFeatured: true,
  },
]

export function defaultSubscriptionSettings(): SubscriptionSettings {
  return {
    freeDailyTokens: DEFAULT_FREE_DAILY_TOKENS,
    plans: DEFAULT_SUBSCRIPTION_PLANS.map((plan) => ({ ...plan })),
  }
}

export const DEFAULT_FREE_DAILY_TOKENS = 10_000_000

export function utcPeriodKey(date: Date = new Date()) {
  return date.toISOString().slice(0, 10)
}

export function nextUtcResetIso(date: Date = new Date()) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1))
  return next.toISOString()
}

export function isRoundTokenLimit(tokens: number) {
  if (!Number.isFinite(tokens) || tokens <= 0) return false
  return tokens % 1_000 === 0
}

export type FreeTierAccessMode = 'free' | 'subscription'

export type FreeTierAccess = {
  allowed: boolean
  mode: FreeTierAccessMode
  unlimited: boolean
  limit: number | null
  used: number
  remaining: number | null
  planKey: string | null
  planLabel: string
  expiresAt: string | null
  resetsAt: string | null
  telegramVerified?: boolean
}
