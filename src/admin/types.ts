export type AdminUser = {
  id: string
  email: string
  role: string
}

export type AdminModel = {
  id: string
  upstream_id?: string | null
  upstream_provider?: 'apinex' | string
  upstream_routes?: Array<{ position: number; upstream_provider: string; upstream_id: string }>
  provider: string
  name: string
  context_window: string
  input_price_micros: number
  output_price_micros: number
  token_weight?: number
  status: string
  health?: 'live' | 'partial' | 'unavailable' | 'no_data'
  /** Admin-pinned health; null/undefined when automatic. */
  healthOverride?: 'live' | 'partial' | 'unavailable' | null
  healthCheckedAt?: string | null
  tags: string[]
  inputMultiplier: number | null
  outputMultiplier: number | null
}

export type AdminOverview = {
  stats: {
    users: number
    activeUsers: number
    activeKeys: number
    requests: number
    revenueCents: number
    spendTokens: number
    errorRate: number
  }
  provider: {
    keyCount: number
    balanceTokens: number
    balanceUsdCents?: number
    byProvider?: Record<
      string,
      { keyCount: number; balanceTokens: number; balanceUsdCents: number }
    >
  }
  usage: Array<{ day: string; requests: number; spend_tokens: number; free_tokens?: number; paid_tokens?: number }>
  dailyReportRevenue?: {
    totalRevenueUsd: number
    sinceIso: string
    sol: number
    cardUsd?: number
  }
  providerKeys?: ProviderKey[]
  activity: Array<{
    id: string
    displayId?: number | null
    email: string
    status: string
    createdAt: string
  }>
}

export type ProviderKey = {
  id: string
  provider: 'apinex' | string
  providerLabel: string
  email: string
  secretHint: string
  proxyIndex?: number | null
  balanceTokens: number
  balanceUsdCents: number
  status: string
  lastSyncedAt: string | null
  lastError: string | null
  createdAt: string
  hasCookies?: boolean
  cookieCount?: number
  projectId?: string | null
  orgId?: string | null
  /** APInex balance, subscription & rpm info */
  balanceUsd?: number
  spendLimitUsd?: number | null
  spentUsd?: number | null
  remainingUsd?: number | null
  limitReached?: boolean
  rpm?: number | null
  rpmPlan?: string | null
  subscriptionMode?: string | null
  subscriptionPlan?: string | null
  subscriptionUnlimited?: boolean
  subscriptionTokenLimit?: number | null
  subscriptionTokensUsed?: number | null
  subscriptionTokensRemaining?: number | null
  subscriptionExpiresAt?: string | null
  subscriptionAllowed?: boolean | null
}

export type ProviderKeysPayload = {
  keys: ProviderKey[]
  keyCount: number
  balanceTokens: number
  balanceUsdCents?: number
  byProvider?: Record<
    string,
    { keyCount: number; balanceTokens: number; balanceUsdCents: number }
  >
  providers?: Array<{ id: string; label: string }>
}

export type ModelUsageRow = {
  modelId: string
  name: string
  provider: string
  upstreamProvider: string | null
  kind: 'free' | 'paid' | 'tool'
  inCatalog: boolean
  catalogStatus: string | null
  requests: number
  okRequests: number
  errorRequests: number
  errorRatePct: number
  sharePct: number
  users: number
  keys: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costTokens: number
  costUsd: number
  avgLatencyMs: number
  medianLatencyMs: number
  maxLatencyMs: number
  lastUsedAt: string | null
}

export type ModelUsageTotals = {
  models: number
  requests: number
  okRequests: number
  errorRequests: number
  errorRatePct: number
  totalTokens: number
  costTokens: number
  costUsd: number
}

export type ModelUsageDailyPoint = {
  day: string
  label: string
  requests: number
  free: number
  paid: number
  tool: number
  errors: number
  costTokens: number
  costUsd: number
}

export type ModelUsageTopUser = {
  userId: number | null
  email: string | null
  name: string | null
  wallet: string | null
  requests: number
  errors: number
  models: number
  totalTokens: number
  costTokens: number
  costUsd: number
  lastUsedAt: string | null
}

export type ModelUsagePayload = {
  window: '24h' | '7d' | '30d' | 'all'
  generatedAt: string
  totals: {
    all: ModelUsageTotals
    free: ModelUsageTotals
    paid: ModelUsageTotals
    tools: ModelUsageTotals
  }
  models: ModelUsageRow[]
  daily: ModelUsageDailyPoint[]
  topUsers: ModelUsageTopUser[]
}

export type AdminUserRecord = {
  id: string
  displayId: number | null
  email: string
  status: string
  balance_tokens: number
  requests: number
  /** Free-model allowance. `subscription_plan` is null while on the daily free tier. */
  subscription_plan?: string | null
  subscription_kind?: 'custom' | 'unlimited' | null
  subscription_expires_at?: string | null
  allowance_unlimited?: boolean
  allowance_used?: number
  /** null when the active plan is unlimited. */
  allowance_limit?: number | null
  /** 0–100, null when unlimited. */
  allowance_percent?: number | null
  created_at: string
  last_seen_at: string | null
  telegram_username: string | null
  auth_method?: string | null
  promo_codes?: string[]
}

export type CatalogModelOption = {
  id: string
  name: string
  provider: string
  contextWindow: string
  inputPrice: number
  outputPrice: number
  tokenWeight?: number
}

export type ProviderRecord = {
  id: string
  provider: string
  label: string
  status: string
  endpoint: string
  secret_hint: string
  created_at: string
}

export type BalanceTransaction = {
  id: string
  user_id: string
  name: string
  email: string
  type: string
  amount_cents: number
  amount_tokens: number
  note: string
  status: string
  created_at: string
}

export type PromoType =
  | 'balance'
  | 'subscription'
  | 'subscription_custom'
  | 'subscription_offer'
  | 'topup_bonus'
  | 'free_reset'


export type PromoCodeRow = {
  id: string
  code: string
  type: PromoType
  plan_key: string | null
  plan_label?: string | null
  custom_days?: number | null
  custom_token_limit?: number | null
  discount_mode?: 'usd' | 'percent' | null
  discount_value?: number | null
  offer_unit?: 'hours' | 'days' | null
  offer_amount?: number | null
  bonus_target?: 'both' | 'subscription' | 'topup' | null
  bonus_percent?: number | null
  bonus_duration_unit?: 'minutes' | 'hours' | null
  bonus_duration_value?: number | null
  /** USD reward in cents (legacy token rows converted server-side; 0 for subscriptions). */
  reward_cents: number
  reward_tokens: number
  max_uses: number
  used_count: number
  expires_at: string | null
  note: string
  created_at: string
  created_by: string
  status: 'active' | 'disabled' | 'redeemed'
  redeemed_at?: string | null
  redeemed_by_user_id?: string | null
}

export type ApiKeyRecord = {
  id: string
  user_id: string
  name: string
  email: string
  prefix: string
  spend_limit_tokens: number | null
  spent_tokens: number
  status: string
  created_at: string
  last_used_at: string | null
}

export type UsageEvent = {
  id: string
  user_name: string | null
  email: string | null
  model_id: string | null
  provider: string
  key_prefix: string | null
  input_tokens: number
  output_tokens: number
  cost_tokens: number
  latency_ms: number
  status: string
  created_at: string
  model_weight?: number
  usage_plan_label?: string | null
  usage_tokens_used?: number
  usage_tokens_limit?: number | null
}

export type AuditLog = {
  id: string
  actor_email: string
  action: string
  target: string
  metadata_json: string
  created_at: string
}
