export type PublicLevel = {
  level: number
  topupUsd: number
  weight: number
}

export type AccountLevel = {
  level: number
  weight: number
  progressUsd: number | null
  remainingUsd: number | null
  nextLevel: number | null
  nextWeight: number | null
  nextTopupUsd: number | null
  maxLevel: number
  celebrateLevel: number | null
}

export type CustomerUser = {
  id: string
  email: string
  name: string
  status: string
  balanceTokens: number
  authMethod?: string
  loginEmail?: string | null
  hasPassword?: boolean
  googleLinked?: boolean
  telegramId?: string | null
  telegramUsername?: string | null
  telegramVerified?: boolean
  level?: AccountLevel | null
}

let memorySessionToken: string | null = null

export function setPersistedSessionToken(token: string | null | undefined) {
  memorySessionToken = token || null
}

export function clearClientSessionToken() {
  memorySessionToken = null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const token = memorySessionToken
  if (token && !headers.has('X-Session-Id')) {
    headers.set('X-Session-Id', token)
  }
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    credentials: 'include',
    headers,
  })
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string
  }
  if (!response.ok) throw new Error(data.error ?? 'Request failed')
  return data
}

export type AuthChallenge = {
  enabled: boolean
  siteKey: string | null
  emailConfigured?: boolean
  googleEnabled?: boolean
}

export type AuthSuccess = {
  user: CustomerUser
  expiresAt: string
  needsVerification?: false
}

export const userApi = {
  me: () => request<{ user: CustomerUser; expiresAt: string }>('/api/user/me'),
  ackLevel: () => request<{ level: AccountLevel }>('/api/user/level/ack', { method: 'POST' }),
  publicLevels: () => request<{ levels: PublicLevel[]; totalToMaxUsd: number }>('/api/public/levels'),

  authChallenge: () => request<AuthChallenge>('/api/user/auth/challenge'),

  logout: async () => {
    try {
      return await request<{ ok: boolean }>('/api/user/logout', { method: 'POST' })
    } finally {
      clearClientSessionToken()
    }
  },

  keys: () => request<{ keys: CustomerApiKey[] }>('/api/user/keys'),
  createKey: (body: { name: string; spendLimitDollars?: number | null }) =>
    request<{ key: CustomerApiKey; secret: string }>('/api/user/keys', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  revokeKey: (id: string) =>
    request<{ ok: boolean }>(`/api/user/keys/${id}/revoke`, { method: 'POST' }),

  models: () =>
    request<{ models: CustomerModel[]; anthropicBonusNotice?: boolean }>('/api/user/models'),
  stats: () => request<CustomerStats>('/api/user/stats'),
  usage: (query?: { keyId?: string; status?: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams()
    if (query?.keyId) params.set('keyId', query.keyId)
    if (query?.status) params.set('status', query.status)
    if (query?.limit != null) params.set('limit', String(query.limit))
    if (query?.offset != null) params.set('offset', String(query.offset))
    const qs = params.toString()
    return request<CustomerUsageResponse>(`/api/user/usage${qs ? `?${qs}` : ''}`)
  },

  billingConfig: () => request<BillingConfig>('/api/user/billing/config'),
  billingPayments: () => request<{ payments: BillingPayment[] }>('/api/user/billing/payments'),
  createTopup: (amountDollars: number) =>
    request<{ ok: boolean; paymentId: string; invoiceUrl: string; amountCents: number }>(
      '/api/user/billing/topup',
      {
        method: 'POST',
        body: JSON.stringify({ amountDollars }),
      },
    ),

  subscriptions: () => request<SubscriptionsResponse>('/api/user/subscriptions'),
  subscriptionQuote: (plan: string, tokens?: number) => {
    const params = new URLSearchParams({ plan, asset: 'CRYPTO' })
    if (tokens != null && tokens > 0) params.set('tokens', String(tokens))
    return request<SubscriptionQuote>(`/api/user/subscriptions/quote?${params.toString()}`)
  },
  createSubscriptionPurchase: (body: {
    plan: string
    method?: string
    tokens?: number
  }) =>
    request<SubscriptionPurchaseCreated>('/api/user/subscriptions/purchase', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  rpm: () =>
    request<RpmState>('/api/user/rpm'),
  purchaseRpm: (plan: string) =>
    request<{ paymentId: string; invoiceUrl: string; amountUsd: number; rpm: number; label: string }>(
      '/api/user/rpm/purchase',
      { method: 'POST', body: JSON.stringify({ plan }) },
    ),
  rpmPaymentStatus: (paymentId: string) =>
    request<{ credited: boolean; status: string; rpm: RpmState }>(
      `/api/user/rpm/payment-status?paymentId=${encodeURIComponent(paymentId)}`,
    ),

  subscriptionPaymentStatus: (paymentId: string) =>
    request<SubscriptionPaymentStatus>(
      `/api/user/subscriptions/payment-status?paymentId=${encodeURIComponent(paymentId)}`,
    ),

  telegramBonus: async () => ({
    enabled: false,
    bonusTokens: 0,
    linked: false,
    verified: true,
    claimed: false,
    configured: false,
  }),
  telegramStatus: async () => ({
    ok: true,
    linked: false,
    verified: true,
    claimed: false,
    telegramId: null,
    telegramUsername: null,
    telegramVerifiedAt: null,
    channelUrl: '',
    groupUrl: '',
    botUsername: '',
  }),
  verifyTelegram: async () => ({
    ok: true,
    verified: true,
    message: 'Verified',
  }),
  createTelegramLink: async () => ({
    ok: false,
    url: '',
    expiresAt: '',
  }),
  rewards: () =>
    request<{
      referral: {
        enabled: boolean
        code: string
        invited: number
        rewarded: number
        earnedUsd: number
        referredByCode: string | null
        hasReferrer: boolean
        rewardGranted: boolean
        minPurchaseDollars: number
        referrerRewardUsd: number
        refereeRewardUsd: number
      }
    }>('/api/user/rewards'),
  applyReferralCode: (code: string) =>
    request<{
      ok: boolean
      referral: {
        enabled: boolean
        code: string
        invited: number
        rewarded: number
        earnedUsd: number
        referredByCode: string | null
        hasReferrer: boolean
        rewardGranted: boolean
        minPurchaseDollars: number
        referrerRewardUsd: number
        refereeRewardUsd: number
      }
    }>('/api/user/rewards/apply', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  redeemPromo: (body: { code: string }) =>
    request<{
      ok: boolean
      type?: 'balance' | 'subscription' | 'subscription_custom' | 'subscription_offer' | 'topup_bonus' | 'free_reset'
      usd: number
      tokens: number
      code: string
      bonusPercent?: number
      bonusTarget?: string
      planLabel?: string | null
      expiresAt?: string | null
      extended?: boolean
      user?: CustomerUser
      freeTier?: SubscriptionAccess
    }>('/api/user/promo/redeem', {
      method: 'POST',
      body: JSON.stringify({
        code: body.code,
      }),
    }),
  lowBalanceAlert: () =>
    request<{
      enabled: boolean
      levels: number[]
      budgetBaseTokens: number
      balanceTokens: number
      spentPercent: number
      notifiedLevel: number
      telegramLinked: boolean
      canReceive: boolean
    }>('/api/user/alerts/low-balance'),
  setLowBalanceAlert: (body: { enabled: boolean }) =>
    request<{
      enabled: boolean
      levels: number[]
      budgetBaseTokens: number
      balanceTokens: number
      spentPercent: number
      notifiedLevel: number
      telegramLinked: boolean
      canReceive: boolean
    }>('/api/user/alerts/low-balance', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}

export type RpmPlan = {
  key: 'free' | 'standard' | 'high' | 'custom'
  rpm: number
  priceCents: number
  priceUsd: number
  enabled: boolean
  custom: boolean
  label: string
  termLabel?: string | null
}

export type RpmState = {
  rpm: number
  planKey: 'free' | 'standard' | 'high' | 'custom'
  label: string
  source: 'plan' | 'grant' | 'free'
  expiresAt?: string | null
  termLabel?: string | null
  supportUrl: string
  cryptoEnabled: boolean
  grantRpm: number | null
  grantExpiresAt?: string | null
  plans: RpmPlan[]
}

export type CustomerApiKey = {
  id: string
  name: string
  prefix: string
  secret: string | null
  spendLimitTokens: number | null
  spentTokens: number
  status: string
  createdAt: string
  lastUsedAt: string | null
}

export type ModelHealthStatus = 'live' | 'partial' | 'unavailable' | 'no_data'

export type CustomerModel = {
  id: string
  provider: string
  name: string
  contextWindow: string
  weight: number
  dollarsPer1M: number
  inputDollarsPer1M?: number
  outputDollarsPer1M?: number
  eventDiscountPct?: number | null
  tags: string[]
  health?: ModelHealthStatus
}

export type CustomerStats = {
  spendMonthTokens: number
  requestsMonth: number
  requestsTotal: number
  avgLatencyMs?: number
  activeKeys: number
  hasTopup?: boolean
  telegramVerified?: boolean
  freeTier: SubscriptionAccess
  weekly: Array<{ day: string; spend_tokens: number; requests: number }>
  recent: Array<{
    id: string
    modelId: string | null
    provider: string
    inputTokens: number
    outputTokens: number
    costTokens: number
    latencyMs: number
    status: string
    createdAt: string
    keyPrefix: string | null
  }>
}

export type BillingConfig = {
  minTopupCents: number
  presets: number[]
  configured: boolean
  currency: string
  method: string
  provider: string | null
  tokensPerUsd: number
  promoBoost?: {
    bonusPct: number
    target: string
    expiresAt: string
  } | null
  card?: {
    enabled: boolean
  }
}

export type BillingPayment = {
  id: string
  provider?: string
  amountCents: number
  amountUsd: number
  currency: string
  status: string
  statusLabel: string
  uiStatus: 'pending' | 'confirming' | 'credited' | 'expired' | 'failed' | 'unknown'
  invoiceId: string | null
  invoiceUrl: string | null
  paymentId: string | null
  orderId: string
  payCurrency: string | null
  payAmount: string | null
  tokensCredited: number
  createdAt: string
  creditedAt: string | null
  canOpenInvoice: boolean
}

export type CustomerUsageEvent = {
  id: string
  modelId: string | null
  provider: string
  inputTokens: number
  outputTokens: number
  costTokens: number
  tokenWeight: number
  freeModel: boolean
  costUsd: number
  latencyMs: number
  status: string
  createdAt: string
  apiKeyId: string | null
  keyPrefix: string | null
  keyName: string | null
}

export type CustomerUsageResponse = {
  total: number
  limit: number
  offset: number
  keys: Array<{ id: string; name: string; prefix: string }>
  events: CustomerUsageEvent[]
}

export type SubscriptionAccess = {
  allowed: boolean
  mode: 'free' | 'subscription'
  unlimited: boolean
  limit: number | null
  used: number
  remaining: number | null
  planKey: 'day1' | 'day7' | 'day14' | 'day30' | null
  planLabel: string
  expiresAt: string | null
  resetsAt: string | null
}

export type SubscriptionPlanKey = 'day1' | 'day7' | 'day14' | 'day30'

export type SubscriptionRecord = {
  id: string
  planKey: string | null
  planLabel: string
  kind: 'custom' | 'unlimited'
  unlimited: boolean
  tokenLimit: number
  tokensUsed: number
  remaining: number | null
  startedAt: string
  expiresAt: string
  source: string
}

export type SubscriptionPlanOption = {
  key: SubscriptionPlanKey
  label: string
  days: number
  kind: 'custom' | 'unlimited'
  tokenLimit: number | null
  baseTokenLimit?: number | null
  bonusTokens?: number
  bonusPct?: number
  promoBonusPct?: number
  priceCents: number
  priceUsd: number
  listPriceCents?: number | null
  listPriceUsd?: number | null
  isFeatured?: boolean
}

export type SubscriptionOffer = {
  mode: 'usd' | 'percent'
  value: number
  expiresAt: string
  label: string
}

export type SubscriptionHistoryEntry = {
  id: string
  planKey: string
  planLabel: string
  kind: 'custom' | 'unlimited'
  tokenLimit: number
  tokensUsed: number
  status: string
  source: string
  priceCents: number
  startedAt: string
  expiresAt: string
  createdAt: string
}

export type SubscriptionsResponse = {
  access: SubscriptionAccess
  subscription: SubscriptionRecord | null
  freeDailyTokens: number
  resetsAt: string
  rpmFree?: number
  rpmSubscription?: number
  promoBoost?: {
    bonusPct: number
    target: string
    expiresAt: string
  } | null
  plans?: SubscriptionPlanOption[]
  offer?: SubscriptionOffer | null
  payMethods: string[]
  solanaEnabled: boolean
  cardEnabled?: boolean
  history?: SubscriptionHistoryEntry[]
}

export type SubscriptionQuote = {
  planKey: string
  planLabel: string
  days: number
  kind: 'custom' | 'unlimited'
  tokenLimit: number | null
  amountCents: number
  amountUsd: number
  asset: string
  provider: string
  priceUsd: number
  decimals: number
  rawAmount: string
  displayAmount: string
  mint: string | null
  treasury: string
}

export type SubscriptionPurchaseCreated = {
  paymentId: string
  orderId: string
  planKey: string
  planLabel: string
  days: number
  kind: 'custom' | 'unlimited'
  tokenLimit: number | null
  amountUsd: number
  amountCents: number
  invoiceUrl?: string
  invoiceId?: string
  provider: string
}

export type SubscriptionPaymentStatus = {
  credited: boolean
  already?: boolean
  status?: string
  confirming?: boolean
  error?: string
  access?: SubscriptionAccess
  subscription?: SubscriptionRecord | null
}
