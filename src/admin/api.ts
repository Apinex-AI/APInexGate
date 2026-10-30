import type {
  AdminModel,
  AdminOverview,
  AdminUser,
  AdminUserRecord,
  ApiKeyRecord,
  AuditLog,
  BalanceTransaction,
  CatalogModelOption,
  ModelUsagePayload,
  PromoCodeRow,
  PromoType,
  ProviderKeysPayload,
  UsageEvent,
} from './types'
import type { UpstreamProvider } from '../../shared/providers'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  // Optional local-only developer access token; release ignores this header.
  if (typeof window !== 'undefined' && window.location.hostname.startsWith('dev-admin.')) {
    const token = window.localStorage.getItem('dev_admin_access_token')?.trim()
    if (token) headers.set('X-Admin-Access-Token', token)
  }
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
  })
  const data = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? 'Request failed')
  return data
}

export type AdminLoginResponse = { user: AdminUser; expiresAt: string }

export const adminApi = {
  me: () => request<{ user: AdminUser; expiresAt: string }>('/api/auth/me'),
  statistics: (opts?: { q?: string; period?: string; from?: string; to?: string } | string) => {
    const params = new URLSearchParams()
    if (typeof opts === 'string') {
      if (opts.trim()) params.set('q', opts.trim())
    } else if (opts) {
      if (opts.q?.trim()) params.set('q', opts.q.trim())
      if (opts.period) params.set('period', opts.period)
      if (opts.from) params.set('from', opts.from)
      if (opts.to) params.set('to', opts.to)
    }
    const qs = params.toString()
    return request<any>(`/api/admin/statistics${qs ? `?${qs}` : ''}`)
  },
  modelUsage: (window?: string) => {
    const qs = window ? `?window=${encodeURIComponent(window)}` : ''
    return request<ModelUsagePayload>(`/api/admin/statistics/models${qs}`)
  },
  login: (password: string) =>
    request<AdminLoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  overview: () => request<AdminOverview>('/api/admin/overview'),
  users: (params?: { limit?: number; offset?: number; q?: string; sort?: string; dir?: 'asc' | 'desc' }) => {
    const query = new URLSearchParams()
    query.set('limit', String(params?.limit ?? 100))
    query.set('offset', String(params?.offset ?? 0))
    if (params?.q?.trim()) query.set('q', params.q.trim())
    if (params?.sort) query.set('sort', params.sort)
    if (params?.dir) query.set('dir', params.dir)
    return request<{ users: AdminUserRecord[]; total: number; offset: number; limit: number; hasMore: boolean }>(
      `/api/admin/users?${query.toString()}`,
    )
  },
  createUser: (body: { email: string; balanceUsd?: number; balanceTokens?: number }) =>
    request<{ ok: boolean; id: string; displayId?: number }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateUser: (id: string, body: { status: 'active' | 'suspended' }) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  providers: () => request<ProviderKeysPayload>('/api/admin/providers'),
  addProviderKey: (body: {
    provider: string
    email: string
    secret: string
    cookies?: string
    projectId?: string
    orgId?: string
    consolePassword?: string
    newApiUserId?: string
  }) =>
    request<{ ok: boolean } & ProviderKeysPayload>('/api/admin/providers/keys', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteProviderKey: (id: string) =>
    request<ProviderKeysPayload>(`/api/admin/providers/keys/${id}`, { method: 'DELETE' }),
  reorderProviderKey: (id: string, direction: 'up' | 'down') =>
    request<{ ok: boolean; moved: boolean }>('/api/admin/providers/keys/reorder', {
      method: 'POST',
      body: JSON.stringify({ id, direction }),
    }),
  syncProviderKeys: () => request<ProviderKeysPayload>('/api/admin/providers/sync', { method: 'POST' }),
  syncProviderKey: (id: string) =>
    request<{ key: ProviderKeysPayload['keys'][number] } & Omit<ProviderKeysPayload, 'keys'>>(
      `/api/admin/providers/keys/${id}/sync`,
      { method: 'POST' },
    ),
  catalogModels: (category: string, upstreamProvider: UpstreamProvider = 'apinex') =>
    request<{ models: CatalogModelOption[] }>(
      `/api/admin/providers/catalog?category=${encodeURIComponent(category)}&upstreamProvider=${encodeURIComponent(upstreamProvider)}`,
    ),
  models: () => request<{ models: AdminModel[] }>('/api/admin/models'),
  importApinexModels: () =>
    request<{ ok: boolean; imported: number; updated: number; total: number }>(
      '/api/admin/models/import-apinex',
      { method: 'POST' },
    ),
  refreshModelStatus: (id: string) =>
    request<{ ok: boolean; health: AdminModel['health']; healthCheckedAt: string | null }>(
      `/api/admin/models/${encodeURIComponent(id)}/refresh-status`,
      { method: 'POST' },
    ),
  setModelHealthStatus: (id: string, status: 'auto' | 'live' | 'partial' | 'unavailable') =>
    request<{ ok: boolean; id: string; health: string }>(
      `/api/admin/models/${encodeURIComponent(id)}/set-status`,
      { method: 'POST', body: JSON.stringify({ status }) },
    ),
  createModel: (body: {
    id: string
    upstreamId?: string
    upstreamProvider?: UpstreamProvider
    name: string
    provider: string
    contextWindow?: string
    inputPrice?: number
    outputPrice?: number
    tokenWeight?: number
    tags?: string[]
  }) => request<{ ok: boolean; id: string }>('/api/admin/models', { method: 'POST', body: JSON.stringify(body) }),
  updateModel: (id: string, body: {
    id?: string
    status?: string
    upstreamId?: string
    upstreamProvider?: string
    upstreamRoutes?: Array<{ upstreamProvider: string; upstreamId: string }>
    name?: string
    provider?: string
    contextWindow?: string
    inputPrice?: number
    outputPrice?: number
    tokenWeight?: number
    tags?: string[]
  }) =>
    request<{ ok: boolean }>(`/api/admin/models/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  reorderModel: (id: string, direction: 'up' | 'down', providerFilter?: string) =>
    request<{ ok: boolean; moved: boolean }>('/api/admin/models/reorder', {
      method: 'POST',
      body: JSON.stringify({ id, direction, providerFilter }),
    }),
  bulkUpdateFreeRoutes: (body: { routes: Array<{ upstreamProvider: string; upstreamId: string }> }) =>
    request<{ success: boolean; count: number }>('/api/admin/models/bulk-free-routes', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteModel: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  updatePricing: (id: string, body: { tokenWeight?: number; dollarsPer1M?: number; inputDollarsPer1M?: number; outputDollarsPer1M?: number }) =>
    request<{ ok: boolean; tokenWeight: number; dollarsPer1M: number; inputDollarsPer1M?: number; outputDollarsPer1M?: number }>(
      `/api/admin/pricing/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    ),
  balances: () =>
    request<{
      transactions: BalanceTransaction[]
      settings: {
        minTopupCents: number
        telegramBonusEnabled?: boolean
        telegramBonusUsd?: number
        telegramBonusTokens?: number
        telegramConfigured?: boolean
        telegramBotUsername?: string
      }
    }>('/api/admin/balances'),
  settings: () =>
    request<{
      billing: { minTopupCents: number }
      telegram: {
        enabled: boolean
        bonusUsd?: number
        bonusTokens: number
        configured: boolean
        botUsername: string
      }
      referral: {
        enabled: boolean
        minPurchaseCents: number
        referrerRewardUsd: number
        refereeRewardUsd: number
        referrerRewardXp: number
        refereeRewardXp: number
      }
      subscriptions: {
        freeDailyTokens: number
        plans: AdminSubscriptionPlan[]
        payMethods: AdminSubscriptionPayMethod[]
        solanaConfigured?: boolean
      }
      fairness: { rpmFree: number; rpmSubscription: number; subscriberPriority: boolean }
      links?: { telegram: string; x: string; telegramSupport: string }
    }>('/api/admin/settings'),
  fairnessQueueStats: () =>
    request<{
      active: number
      maxConcurrent: number
      waiting: number
      waitingPriority: number
      oldestWaitMs: number
    }>('/api/admin/fairness/queue'),

  updateLinks: (body: { telegram: string; x: string; telegramSupport: string }) =>
    request<{ ok: boolean; links: { telegram: string; x: string; telegramSupport: string } }>(
      '/api/admin/settings/links',
      { method: 'PATCH', body: JSON.stringify(body) },
    ),
  updateBillingSettings: (body: { minTopupDollars: number }) =>
    request<{ ok: boolean; minTopupCents: number }>('/api/admin/settings/billing', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  updateTelegramBonus: (body: { enabled: boolean; bonusUsd?: number; bonusTokens?: number }) =>
    request<{ ok: boolean; settings: { enabled: boolean; bonusUsd?: number; bonusTokens: number } }>(
      '/api/admin/settings/telegram-bonus',
      { method: 'PATCH', body: JSON.stringify(body) },
    ),
  updateReferralSettings: (body: {
    enabled: boolean
    minPurchaseDollars: number
    referrerRewardUsd: number
    refereeRewardUsd: number
  }) =>
    request<{
      ok: boolean
      settings: {
        enabled: boolean
        minPurchaseCents: number
        referrerRewardUsd: number
        refereeRewardUsd: number
      }
    }>('/api/admin/settings/referral', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  updateSubscriptionSettings: (body: AdminSubscriptionSettingsInput) =>
    request<{ ok: boolean; settings: unknown }>('/api/admin/settings/subscriptions', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  levels: () => request<{ levels: Array<{ level: number; topupUsd: number; weight: number }> }>('/api/admin/levels'),
  updateLevels: (levels: Array<{ level: number; topupUsd: number; weight: number }>) =>
    request<{ ok: boolean; levels: Array<{ level: number; topupUsd: number; weight: number }> }>('/api/admin/levels', {
      method: 'PATCH',
      body: JSON.stringify({ levels }),
    }),
  rpmPlans: () =>
    request<{ plans: Array<{ key: 'free' | 'standard' | 'high' | 'custom'; rpm: number; priceCents: number; enabled: boolean; custom: boolean }>; cryptoEnabled: boolean }>(
      '/api/admin/rpm',
    ),
  updateRpmPlans: (plans: Array<{ key: string; rpm: number; priceUsd: number; enabled: boolean }>) =>
    request<{ ok: boolean; plans: unknown[] }>('/api/admin/rpm', {
      method: 'PATCH',
      body: JSON.stringify({ plans }),
    }),
  grantRpm: (body: { recipient: string; rpm: number | null }) =>
    request<{ ok: boolean }>('/api/admin/rpm/grant', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateFairnessSettings: (body: { rpmFree?: number; rpmSubscription?: number; subscriberPriority?: boolean }) =>
    request<{
      ok: boolean
      settings: { rpmFree: number; rpmSubscription: number; subscriberPriority: boolean }
      queue: { active: number; maxConcurrent: number; waiting: number; waitingPriority: number; oldestWaitMs: number }
    }>('/api/admin/settings/fairness', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  subscriptionsOverview: () =>
    request<AdminSubscriptionsOverview>('/api/admin/subscriptions'),
  grantSubscription: (body: { recipient: string; plan: string }) =>
    request<{ ok: boolean; extended: boolean; subscription: AdminActiveSubscription }>(
      '/api/admin/subscriptions/grant',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  revokeSubscription: (body: { recipient: string }) =>
    request<{ ok: boolean }>('/api/admin/subscriptions/revoke', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  promos: () => request<{ promos: PromoCodeRow[]; plans?: AdminSubscriptionPlan[] }>('/api/admin/promos'),
  generatePromoCode: () => request<{ code: string }>('/api/admin/promos/generate'),
  createPromo: (body: {
    code: string
    type?: PromoType
    planKey?: string | null
    customDays?: number | null
    customTokenLimit?: number | null
    discountMode?: 'usd' | 'percent' | null
    discountUsd?: number | null
    discountPercent?: number | null
    offerUnit?: 'hours' | 'days' | null
    offerAmount?: number | null
    bonusTarget?: 'both' | 'subscription' | 'topup' | null
    bonusPercent?: number | null
    bonusDurationUnit?: 'minutes' | 'hours' | null
    bonusDurationValue?: number | null
    rewardUsd?: number
    maxUses: number
    expiresAt: string | null
    note?: string
    status?: 'active' | 'disabled'
  }) =>
    request<{ ok: boolean; promo: PromoCodeRow }>('/api/admin/promos', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updatePromo: (
    id: string,
    body: {
      code: string
      type?: PromoType
      planKey?: string | null
      customDays?: number | null
      customTokenLimit?: number | null
      discountMode?: 'usd' | 'percent' | null
      discountUsd?: number | null
      discountPercent?: number | null
      offerUnit?: 'hours' | 'days' | null
      offerAmount?: number | null
      bonusTarget?: 'both' | 'subscription' | 'topup' | null
      bonusPercent?: number | null
      bonusDurationUnit?: 'minutes' | 'hours' | null
      bonusDurationValue?: number | null
      rewardUsd?: number
      maxUses: number
      expiresAt: string | null
      note?: string
      status?: 'active' | 'disabled'
    },
  ) =>
    request<{ ok: boolean; promo: PromoCodeRow }>(`/api/admin/promos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deletePromo: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/promos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  adjustBalance: (body: { email: string; amountUsd: number; amountTokens?: number; note: string }) =>
    request<{ ok: boolean; amountUsd?: number }>('/api/admin/balances/adjust', { method: 'POST', body: JSON.stringify(body) }),
  apiKeys: () => request<{ keys: ApiKeyRecord[] }>('/api/admin/api-keys'),
  updateKey: (id: string, body: { status: string }) =>
    request<{ ok: boolean }>(`/api/admin/api-keys/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  usage: (user?: string) => {
    const qs = user ? `?user=${encodeURIComponent(user)}` : ''
    return request<{ events: UsageEvent[]; userNotFound?: boolean }>(`/api/admin/usage${qs}`)
  },
  promoEvent: () =>
    request<{
      phase: 'off' | 'upcoming' | 'live' | 'cooldown' | 'ended'
      catalog: Array<{ id: string; name: string; provider: string }>
      event: null | {
        startsAt: string
        endsAt: string
        tokenLimit: number
        tokensUsed: number
        minTopupUsd: number
        cooldownUntil: string | null
        models: Array<{ modelId: string; discountPct: number }>
      }
    }>('/api/admin/promo-event'),
  grantPromoAccess: (email: string) =>
    request<{ ok: boolean; email: string }>('/api/admin/promo-event/grant', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  savePromoEvent: (body: {
    startsAt: string
    endsAt: string
    tokenLimit: number
    tokensUsed: number
    minTopupUsd: number
    models: Array<{ modelId: string; discountPct: number }>
  }) =>
    request<{ ok: boolean }>('/api/admin/promo-event', { method: 'PUT', body: JSON.stringify(body) }),
  audit: () => request<{ logs: AuditLog[] }>('/api/admin/audit-logs'),
}

export type AdminSubscriptionPlanKey = 'day1' | 'day7' | 'day14' | 'day30' | 'custom'

export type AdminSubscriptionKind = 'custom' | 'unlimited'

export type AdminSubscriptionPayMethod = string

export type AdminSubscriptionPlan = {
  key: AdminSubscriptionPlanKey
  /** Structural label from the server ('1 day' | '7 days' | '14 days') — not editable. */
  label: string
  /** Structural duration in days (1 | 7 | 14) — not editable. */
  days: number
  enabled: boolean
  priceCents: number
  kind: AdminSubscriptionKind
  /** Meaningful only when kind === 'custom'. */
  tokenLimit: number
  isFeatured?: boolean
}

/** Prices go up as dollars; the server converts to cents. */
export type AdminSubscriptionSettingsInput = {
  freeDailyTokens?: number
  plans?: Array<{
    key: string
    days?: number
    label?: string
    enabled?: boolean
    priceUsd?: number
    kind?: AdminSubscriptionKind
    tokenLimit?: number
    isFeatured?: boolean
  }>
}

export type AdminSubscriptionPlanStat = {
  planKey: string
  count: number
  revenueCents: number
}

export type AdminSubscriptionFreeTierToday = {
  periodKey: string
  users: number
  tokensUsed: number
  resetsAt: string
}

export type AdminSubscriptionStats = {
  totalSubscriptions: number
  activeSubscriptions: number
  revenueCents: number
  byPlan: AdminSubscriptionPlanStat[]
  freeTierToday: AdminSubscriptionFreeTierToday
}

export type AdminActiveSubscription = {
  id: string
  userId: string
  email: string
  displayId: number | null
  planKey: string
  planLabel: string
  kind: AdminSubscriptionKind
  tokenLimit: number
  tokensUsed: number
  source: string
  priceCents: number
  startedAt: string
  expiresAt: string
}

export type AdminSubscriptionsOverview = {
  settings: { freeDailyTokens: number; plans: AdminSubscriptionPlan[] }
  stats: AdminSubscriptionStats
  active: AdminActiveSubscription[]
  payMethods: AdminSubscriptionPayMethod[]
  solanaConfigured?: boolean
}
