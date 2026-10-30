import { db, id, nowIso } from './db.js'
import {
  isUpstreamProvider,
  UPSTREAM_PROVIDER_LABELS,
  type UpstreamProvider,
} from '../shared/providers.js'
import { isFreeWeight } from '../shared/billing.js'
import { proxiedFetch } from './providerProxy.js'
import {
  displayNameFromId,
  isValidModelId,
  isValidModelName,
  sanitizeModelName,
} from '../shared/modelValidation.js'

export {
  displayNameFromId,
  isValidModelId,
  isValidModelName,
  sanitizeModelName,
}

export const APINEX_BASE_URL = 'https://api.apinex.bond/v1'
export const APINEX_PUBLIC_MODELS_URL = 'https://apinex.bond/api/public/models'

export const MODEL_CATEGORIES = [
  'Free',
  'GPT',
  'Claude',
  'Gemini',
  'Kimi',
  'DeepSeek',
  'GLM',
  'Grok',
  'Tencent',
  'Muse',
  'Jev Group',
] as const
export type ModelCategory = (typeof MODEL_CATEGORIES)[number]

export const FAMILY_CATEGORIES = MODEL_CATEGORIES.filter((name) => name !== 'Free')
export type FamilyCategory = (typeof FAMILY_CATEGORIES)[number]

export function isDecisionCatalogModelId(modelId: string | null | undefined): boolean {
  const lower = String(modelId ?? '').trim().toLowerCase()
  return (
    lower.includes('jev') ||
    lower.includes('drex') ||
    lower.includes('subq') ||
    lower.includes('typesafe') ||
    lower.includes('decision')
  )
}

export function isSupportedGptModel(modelId: string) {
  const normalized = modelId.trim().toLowerCase()
  const isOpenAi = normalized.includes('openai') || normalized.includes('gpt') || normalized.includes('codex')
  if (!isOpenAi) return true

  const version = normalized.match(/(?:gpt[-_/ ]*)?(\d+)\.(\d+)/)
  if (!version) return false
  const major = Number(version[1])
  const minor = Number(version[2])
  return major > 5 || (major === 5 && minor >= 6)
}

export function isSupportedGeminiModel(modelId: string) {
  const normalized = modelId.trim().toLowerCase()
  const isGemini = normalized.includes('gemini') || normalized.includes('google-antigravity') || normalized.includes('agy-')
  if (!isGemini) return true

  return (
    normalized === 'agy-3.1-pro' ||
    normalized === 'agy-3.7-medium' ||
    normalized === 'gemini-3.1-pro' ||
    normalized === 'gemini-3.7-flash' ||
    normalized.endsWith('/gemini-3.1-pro') ||
    normalized.endsWith('/gemini-3.7-flash')
  )
}

export const CATEGORY_MATCHERS: Record<ModelCategory, (modelId: string) => boolean> = {
  Free: () => false,
  'Jev Group': (modelId) => isDecisionCatalogModelId(modelId),
  Gemini: (modelId) => modelId.includes('gemini') || modelId.includes('google-antigravity') || modelId.includes('agy-'),
  Kimi: (modelId) => modelId.includes('kimi'),
  GPT: (modelId) =>
    !isDecisionCatalogModelId(modelId) &&
    (modelId.includes('openai') || modelId.includes('gpt') || modelId.includes('codex')),
  Claude: (modelId) => modelId.includes('anthropic') || modelId.includes('claude'),
  DeepSeek: (modelId) => modelId.includes('deepseek'),
  GLM: (modelId) => modelId.includes('glm') || modelId.includes('zhipu'),
  Grok: (modelId) => modelId.includes('grok') || modelId.includes('xai'),
  Tencent: (modelId) =>
    modelId.startsWith('tencent/') ||
    modelId.includes('tencent') ||
    modelId.includes('hunyuan') ||
    modelId === 'hy4' ||
    modelId.startsWith('hy4-'),
  Muse: (modelId) => modelId.includes('muse'),
}

export function familyFromUpstreamId(upstreamId: string | null | undefined): FamilyCategory | null {
  const raw = String(upstreamId ?? '').trim().toLowerCase()
  if (!raw) return null
  if (CATEGORY_MATCHERS['Jev Group'](raw)) return 'Jev Group'
  for (const family of FAMILY_CATEGORIES) {
    if (CATEGORY_MATCHERS[family](raw)) return family
  }
  return null
}

export function providerForTokenWeight(
  tokenWeight: number,
  upstreamId: string | null | undefined,
  currentProvider?: string | null,
) {
  if (isFreeWeight(tokenWeight)) return 'Free'
  const currentNorm = currentProvider?.trim().toLowerCase() ?? ''
  if (currentNorm === 'jev group' || currentNorm === 'jev' || currentNorm === 'decisions') {
    return 'Jev Group'
  }
  return familyFromUpstreamId(upstreamId) ?? currentProvider?.trim() ?? 'GPT'
}

export type ProviderKeyRow = {
  id: string
  provider: string
  email: string
  secret: string
  secret_hint: string
  balance_tokens: number
  balance_usd_cents: number
  status: string
  last_synced_at: string | null
  last_error: string | null
  low_balance_notified_at: string | null
  low_balance_notified_json: string | null
  exhausted_notified_at: string | null
  priority: number
  proxy_index: number | null
  meta_json: string | null
  created_at: string
}

export type ProviderKeyMeta = {
  balanceUsd?: number
  spendLimitUsd?: number | null
  spentUsd?: number
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

export function secretHint(secret: string) {
  const trimmed = secret.trim()
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}…`
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`
}

export function parseProviderMeta(raw: string | null | undefined): ProviderKeyMeta {
  if (!raw) return {}
  try {
    const data = JSON.parse(raw) as ProviderKeyMeta
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

export function serializeProviderMeta(meta: ProviderKeyMeta) {
  return JSON.stringify(meta ?? {})
}

export function publicProviderKey(row: ProviderKeyRow) {
  const provider = row.provider || 'apinex'
  const meta = parseProviderMeta(row.meta_json)
  return {
    id: row.id,
    provider,
    providerLabel: UPSTREAM_PROVIDER_LABELS[provider] ?? provider,
    email: row.email,
    secretHint: secretHint(row.secret),
    balanceTokens: row.balance_tokens ?? 0,
    balanceUsdCents: row.balance_usd_cents ?? 0,
    status: row.status,
    priority: Number(row.priority ?? 100),
    proxyIndex: row.proxy_index ?? null,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    balanceUsd: meta.balanceUsd ?? (row.balance_usd_cents ? row.balance_usd_cents / 100 : 0),
    spendLimitUsd: meta.spendLimitUsd ?? null,
    spentUsd: meta.spentUsd ?? null,
    remainingUsd: meta.remainingUsd ?? null,
    limitReached: meta.limitReached ?? false,
    rpm: meta.rpm ?? null,
    rpmPlan: meta.rpmPlan ?? null,
    subscriptionMode: meta.subscriptionMode ?? null,
    subscriptionPlan: meta.subscriptionPlan ?? null,
    subscriptionUnlimited: meta.subscriptionUnlimited ?? false,
    subscriptionTokenLimit: meta.subscriptionTokenLimit ?? null,
    subscriptionTokensUsed: meta.subscriptionTokensUsed ?? null,
    subscriptionTokensRemaining: meta.subscriptionTokensRemaining ?? null,
    subscriptionExpiresAt: meta.subscriptionExpiresAt ?? null,
    subscriptionAllowed: meta.subscriptionAllowed ?? null,
  }
}

export function providerBalanceTotals(provider?: UpstreamProvider) {
  if (provider) {
    const row = db
      .prepare(
        `SELECT
           COUNT(*) AS key_count,
           COALESCE(SUM(balance_tokens), 0) AS balance_tokens,
           COALESCE(SUM(balance_usd_cents), 0) AS balance_usd_cents
         FROM provider_keys WHERE provider = ?`,
      )
      .get(provider) as { key_count: number; balance_tokens: number; balance_usd_cents: number }
    return {
      keyCount: row.key_count,
      balanceTokens: row.balance_tokens,
      balanceUsdCents: row.balance_usd_cents,
    }
  }

  const rows = db
    .prepare(
      `SELECT provider,
         COUNT(*) AS key_count,
         COALESCE(SUM(balance_tokens), 0) AS balance_tokens,
         COALESCE(SUM(balance_usd_cents), 0) AS balance_usd_cents
       FROM provider_keys
       GROUP BY provider`,
    )
    .all() as Array<{
    provider: string
    key_count: number
    balance_tokens: number
    balance_usd_cents: number
  }>

  const byProvider: Record<string, { keyCount: number; balanceTokens: number; balanceUsdCents: number }> = {}
  let keyCount = 0
  let balanceTokens = 0
  let balanceUsdCents = 0
  for (const row of rows) {
    byProvider[row.provider] = {
      keyCount: row.key_count,
      balanceTokens: row.balance_tokens,
      balanceUsdCents: row.balance_usd_cents,
    }
    keyCount += row.key_count
    balanceTokens += row.balance_tokens
    balanceUsdCents += row.balance_usd_cents
  }

  return { keyCount, balanceTokens, balanceUsdCents, byProvider }
}

export async function fetchApinexBalanceAndSubscription(secret: string, proxyIndex: number | null = null) {
  let balanceUsd: number | null = null
  let balanceUsdCents: number | null = null
  let spendLimitUsd: number | null = null
  let spentUsd: number | null = null
  let remainingUsd: number | null = null
  let limitReached = false
  let rpm: number | null = null
  let rpmPlan: string | null = null

  let subscriptionMode: string | null = null
  let subscriptionPlan: string | null = null
  let subscriptionUnlimited = false
  let subscriptionTokenLimit: number | null = null
  let subscriptionTokensUsed: number | null = null
  let subscriptionTokensRemaining: number | null = null
  let subscriptionExpiresAt: string | null = null
  let subscriptionAllowed: boolean | null = null

  let lastError: string | null = null

  try {
    const balRes = await proxiedFetch(
      `${APINEX_BASE_URL}/balance`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secret}`,
          Accept: 'application/json',
          src: 'gate',
        },
        signal: AbortSignal.timeout(10_000),
      },
      proxyIndex,
    )

    const balData = (await balRes.json().catch(() => ({}))) as {
      balance_usd?: number
      rpm?: number
      rpm_plan?: string | null
      api_key?: {
        spend_limit_usd?: number | null
        spent_usd?: number
        remaining_usd?: number | null
        limit_reached?: boolean
      }
      error?: { message?: string }
    }

    if (!balRes.ok) {
      lastError = balData.error?.message || `HTTP ${balRes.status} on /v1/balance`
    } else {
      balanceUsd = typeof balData.balance_usd === 'number' ? balData.balance_usd : 0
      balanceUsdCents = Math.round(balanceUsd * 100)
      if (typeof balData.rpm === 'number') rpm = balData.rpm
      if (balData.rpm_plan) rpmPlan = balData.rpm_plan
      if (balData.api_key) {
        spendLimitUsd = balData.api_key.spend_limit_usd ?? null
        spentUsd = balData.api_key.spent_usd ?? 0
        remainingUsd = balData.api_key.remaining_usd ?? null
        limitReached = Boolean(balData.api_key.limit_reached)
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
  }

  try {
    const subRes = await proxiedFetch(
      `${APINEX_BASE_URL}/subscription`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secret}`,
          Accept: 'application/json',
          src: 'gate',
        },
        signal: AbortSignal.timeout(10_000),
      },
      proxyIndex,
    )

    const subData = (await subRes.json().catch(() => ({}))) as {
      mode?: string
      plan?: string | null
      plan_label?: string | null
      unlimited?: boolean
      token_limit?: number | null
      tokens_used?: number
      tokens_remaining?: number | null
      expires_at_utc?: string | null
      allowed?: boolean
      error?: { message?: string }
    }

    if (subRes.ok) {
      subscriptionMode = subData.mode ?? null
      subscriptionPlan = subData.plan_label || subData.plan || null
      subscriptionUnlimited = Boolean(subData.unlimited)
      subscriptionTokenLimit = subData.token_limit ?? null
      subscriptionTokensUsed = subData.tokens_used ?? null
      subscriptionTokensRemaining = subData.tokens_remaining ?? null
      subscriptionExpiresAt = subData.expires_at_utc ?? null
      subscriptionAllowed = subData.allowed ?? null
    } else if (!lastError) {
      lastError = subData.error?.message || `HTTP ${subRes.status} on /v1/subscription`
    }
  } catch (err) {
    if (!lastError) lastError = err instanceof Error ? err.message : String(err)
  }

  const status = lastError && balanceUsdCents === null ? 'error' : limitReached ? 'exhausted' : 'active'

  return {
    status,
    balanceUsd,
    balanceUsdCents,
    spendLimitUsd,
    spentUsd,
    remainingUsd,
    limitReached,
    rpm,
    rpmPlan,
    subscriptionMode,
    subscriptionPlan,
    subscriptionUnlimited,
    subscriptionTokenLimit,
    subscriptionTokensUsed,
    subscriptionTokensRemaining,
    subscriptionExpiresAt,
    subscriptionAllowed,
    error: lastError,
  }
}

export async function syncProviderKey(keyId: string) {
  const row = db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(keyId) as ProviderKeyRow | undefined
  if (!row) return null

  const provider = (row.provider || 'apinex') as UpstreamProvider
  const syncedAt = nowIso()

  if (provider !== 'apinex') {
    db.prepare(
      `UPDATE provider_keys SET status = 'error', last_synced_at = ?, last_error = ? WHERE id = ?`,
    ).run(syncedAt, 'Only APInex is supported', keyId)
    return db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(keyId) as ProviderKeyRow
  }

  const meta = parseProviderMeta(row.meta_json)
  const result = await fetchApinexBalanceAndSubscription(row.secret, row.proxy_index ?? null)
  const nextMeta: ProviderKeyMeta = {
    ...meta,
    balanceUsd: result.balanceUsd ?? undefined,
    spendLimitUsd: result.spendLimitUsd,
    spentUsd: result.spentUsd ?? undefined,
    remainingUsd: result.remainingUsd,
    limitReached: result.limitReached,
    rpm: result.rpm ?? meta.rpm,
    rpmPlan: result.rpmPlan ?? meta.rpmPlan,
    subscriptionMode: result.subscriptionMode,
    subscriptionPlan: result.subscriptionPlan,
    subscriptionUnlimited: result.subscriptionUnlimited,
    subscriptionTokenLimit: result.subscriptionTokenLimit,
    subscriptionTokensUsed: result.subscriptionTokensUsed,
    subscriptionTokensRemaining: result.subscriptionTokensRemaining,
    subscriptionExpiresAt: result.subscriptionExpiresAt,
    subscriptionAllowed: result.subscriptionAllowed,
  }

  if (result.balanceUsdCents === null && result.error) {
    db.prepare(
      `UPDATE provider_keys SET status = ?, last_synced_at = ?, last_error = ?, meta_json = ? WHERE id = ?`,
    ).run(result.status, syncedAt, result.error, serializeProviderMeta(nextMeta), keyId)
  } else {
    db.prepare(
      `UPDATE provider_keys
       SET balance_usd_cents = ?, balance_tokens = 0, status = ?, last_synced_at = ?, last_error = ?, meta_json = ?
       WHERE id = ?`,
    ).run(
      result.balanceUsdCents ?? 0,
      result.status,
      syncedAt,
      result.error ?? null,
      serializeProviderMeta(nextMeta),
      keyId,
    )
  }

  return db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(keyId) as ProviderKeyRow
}

let providerBalanceSyncTimer: ReturnType<typeof setInterval> | null = null
let providerBalanceSyncInFlight: Promise<void> | null = null

async function runProviderBalanceSync() {
  if (providerBalanceSyncInFlight) return providerBalanceSyncInFlight
  providerBalanceSyncInFlight = syncAllProviderKeys()
    .then(() => undefined)
    .catch((error) => {
      console.error('[provider-balance-sync] failed', error)
    })
    .finally(() => {
      providerBalanceSyncInFlight = null
    })
  return providerBalanceSyncInFlight
}

export function startProviderBalanceSyncJob() {
  if (providerBalanceSyncTimer) return
  const initial = setTimeout(() => {
    void runProviderBalanceSync()
  }, 15_000)
  initial.unref?.()

  providerBalanceSyncTimer = setInterval(() => {
    void runProviderBalanceSync()
  }, 5 * 60_000)
  providerBalanceSyncTimer.unref?.()
}

export async function syncAllProviderKeys() {
  const rows = db
    .prepare(
      `SELECT id FROM provider_keys
       WHERE provider = 'apinex'
       ORDER BY COALESCE(priority, 100) ASC, datetime(created_at) DESC`,
    )
    .all() as Array<{ id: string }>
  for (const row of rows) {
    try {
      await syncProviderKey(row.id)
    } catch (error) {
      console.error('[provider-balance-sync] failed', row.id, error)
    }
  }
  return listProviderKeys()
}

export function listProviderKeys() {
  const rows = db
    .prepare(
      `SELECT * FROM provider_keys
       ORDER BY provider ASC, COALESCE(priority, 100) ASC, datetime(created_at) ASC, id ASC`,
    )
    .all() as ProviderKeyRow[]
  return {
    keys: rows.map(publicProviderKey),
    ...providerBalanceTotals(),
    providers: [{ id: 'apinex', label: 'APInex (api.apinex.bond/v1)' }],
  }
}

export function createProviderKey(input: { provider?: string; email: string; secret: string }) {
  const countRow = db.prepare('SELECT COUNT(*) AS count FROM provider_keys').get() as { count: number }
  if (countRow.count >= 1) {
    throw new Error('Only 1 APInex provider key is allowed. Delete the existing key to configure a new one.')
  }

  const email = input.email.trim().toLowerCase() || '—'
  const secret = input.secret.trim()
  const providerRaw = (input.provider ?? 'apinex').trim().toLowerCase()
  if (!secret) throw new Error('API key is required')
  if (!isUpstreamProvider(providerRaw)) throw new Error('Invalid provider: only APInex is supported')

  const duplicate = db.prepare('SELECT id FROM provider_keys WHERE secret = ?').get(secret)
  if (duplicate) throw new Error('This API key is already added')

  const keyId = id('pkey')
  db.prepare(
    `INSERT INTO provider_keys
      (id, provider, email, secret, secret_hint, balance_tokens, balance_usd_cents, status,
       last_synced_at, last_error, low_balance_notified_at, low_balance_notified_json, priority, proxy_index, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 'pending', NULL, NULL, NULL, '{}', 100, NULL, '{}', ?)`,
  ).run(keyId, providerRaw, email, secret, secretHint(secret), nowIso())

  return keyId
}

export function deleteProviderKey(keyId: string) {
  db.prepare('DELETE FROM provider_keys WHERE id = ?').run(keyId)
}

export type ProviderSecretTarget = {
  secret: string
  proxyIndex: number | null
}

export function pickProviderSecretTargets(provider: UpstreamProvider = 'apinex'): ProviderSecretTarget[] {
  const rows = db
    .prepare(
      `SELECT secret, proxy_index FROM provider_keys
       WHERE provider = ? AND status IN ('healthy', 'active', 'pending')
       ORDER BY COALESCE(priority, 100) ASC, created_at ASC, id ASC`,
    )
    .all(provider) as Array<{ secret: string; proxy_index: number | null }>
  return rows.map((row) => ({ secret: row.secret, proxyIndex: row.proxy_index ?? null }))
}

export function pickProviderSecrets(provider: UpstreamProvider = 'apinex'): string[] {
  return pickProviderSecretTargets(provider).map((row) => row.secret)
}

export function proxyIndexForSecret(secret: string): number | null {
  const row = db.prepare(`SELECT proxy_index FROM provider_keys WHERE secret = ?`).get(secret) as
    | { proxy_index: number | null }
    | undefined
  return row?.proxy_index ?? null
}

function countUsableKeys(provider: UpstreamProvider) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM provider_keys
       WHERE provider = ? AND status IN ('healthy', 'active', 'pending')`,
    )
    .get(provider) as { n: number }
  return row.n
}

export function markProviderSecretFailed(secret: string, errorMessage: string, statusCode?: number) {
  const row = db
    .prepare(`SELECT id, provider, status FROM provider_keys WHERE secret = ?`)
    .get(secret) as { id: string; provider: string; status: string } | undefined
  if (!row) return

  const msg = errorMessage.toLowerCase()
  if (msg.includes('only with a subscription') || msg.includes('daily free')) {
    return
  }
  const isTemporaryInfrastructureFailure =
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('connection reset') ||
    msg.includes('connection refused') ||
    msg.includes('service unavailable') ||
    msg.includes('gateway timeout')
  const isAuth =
    !isTemporaryInfrastructureFailure &&
    (msg.includes('invalid') ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden') ||
      msg.includes('api key') ||
      msg.includes('expired') ||
      msg.includes('authentication failed'))
  const isBalance =
    msg.includes('insufficient') ||
    msg.includes('balance') ||
    msg.includes('credit') ||
    msg.includes('quota') ||
    msg.includes('payment')

  const confirmedFailure =
    !isTemporaryInfrastructureFailure && (statusCode === 401 || statusCode === 402 || isAuth || isBalance)
  if (!confirmedFailure) return

  db.prepare(
    `UPDATE provider_keys SET status = 'exhausted', last_error = ?, last_synced_at = ? WHERE id = ?`,
  ).run(errorMessage.slice(0, 400), nowIso(), row.id)
  countUsableKeys(row.provider as UpstreamProvider)
}

export type CatalogModel = {
  id: string
  name: string
  provider: string
  contextWindow: string
  inputPrice: number
  outputPrice: number
  tokenWeight?: number
  allowFree?: boolean
}

type ApinexCatalogSpec = {
  name: string
  provider: ModelCategory
  contextWindow: string
  dollarsPer1M: number
  outputDollarsPer1M?: number
  tokenWeight: number
  allowFree?: boolean
}

export const APINEX_CATALOG_DEFAULTS: Record<string, ApinexCatalogSpec> = {
  'claude-sonnet-5.5': { name: 'Claude Sonnet 5.5', provider: 'Claude', contextWindow: '1M', dollarsPer1M: 0.4, tokenWeight: 0 },
  'claude-sonnet-5': { name: 'Claude Sonnet 5', provider: 'Claude', contextWindow: '1M', dollarsPer1M: 0.4, tokenWeight: 0 },
  'claude-opus-5.5': { name: 'Claude Opus 5.5', provider: 'Claude', contextWindow: '1M', dollarsPer1M: 0.5, tokenWeight: 0 },
  'claude-opus-5': { name: 'Claude Opus 5', provider: 'Claude', contextWindow: '1M', dollarsPer1M: 0.5, tokenWeight: 0 },
  'claude-fable-5.1': { name: 'Claude Fable 5.1', provider: 'Claude', contextWindow: '1M', dollarsPer1M: 2, tokenWeight: 0 },
  'deepseek-v4.1-flash': { name: 'Deepseek V4.1 Flash', provider: 'DeepSeek', contextWindow: '1M', dollarsPer1M: 0.06, tokenWeight: 0 },
  'deepseek-v4-flash': { name: 'Deepseek V4 Flash', provider: 'DeepSeek', contextWindow: '1M', dollarsPer1M: 0.05, tokenWeight: 0 },
  'deepseek-v4-pro': { name: 'Deepseek V4 Pro', provider: 'DeepSeek', contextWindow: '1M', dollarsPer1M: 0.07, tokenWeight: 0 },
  'gemini-4-argon': { name: 'Gemini 4 Argon', provider: 'Gemini', contextWindow: '1M', dollarsPer1M: 0.6, tokenWeight: 0 },
  'gemini-3.8-flash': { name: 'Gemini 3.8 Flash', provider: 'Gemini', contextWindow: '1M', dollarsPer1M: 0.1, tokenWeight: 0 },
  'gemini-3.1-pro': { name: 'Gemini 3.1 Pro', provider: 'Gemini', contextWindow: '1M', dollarsPer1M: 0.15, tokenWeight: 0 },
  'gpt-6.1-sol': { name: 'Gpt 6.1 Sol', provider: 'GPT', contextWindow: '1M', dollarsPer1M: 0.3, tokenWeight: 0 },
  'gpt-6-astra': { name: 'Gpt 6 Astra', provider: 'GPT', contextWindow: '1M', dollarsPer1M: 0.5, tokenWeight: 0 },
  'gpt-6-luna': { name: 'Gpt 6 Luna', provider: 'GPT', contextWindow: '1M', dollarsPer1M: 0.075, tokenWeight: 0 },
  'gpt-5.6-terra': { name: 'Gpt 5.6 Terra', provider: 'GPT', contextWindow: '1M', dollarsPer1M: 0.175, tokenWeight: 0 },
  'grok-4.7': { name: 'grok-4.7', provider: 'Grok', contextWindow: '500K', dollarsPer1M: 0.3, tokenWeight: 0 },
  'glm-5.3-flash': { name: 'GLM-5.3 Flash', provider: 'GLM', contextWindow: '1M', dollarsPer1M: 0.05, tokenWeight: 0 },
  'glm-5.3': { name: 'GLM 5.3', provider: 'GLM', contextWindow: '1M', dollarsPer1M: 0.15, tokenWeight: 0 },
  'kimi-k3': { name: 'Kimi K3', provider: 'Kimi', contextWindow: '1M', dollarsPer1M: 0.3, tokenWeight: 0 },
  'muse-spark-1.3': { name: 'Muse Spark 1.3', provider: 'Muse', contextWindow: '1M', dollarsPer1M: 0.3, tokenWeight: 0 },
  'hy4-preview': { name: 'Hy4 Preview', provider: 'Tencent', contextWindow: '1M', dollarsPer1M: 0.3, tokenWeight: 0 },
  'drex-v2.0': { name: 'Drex 2.0', provider: 'Jev Group', contextWindow: '131K', dollarsPer1M: 0.04, outputDollarsPer1M: 0, tokenWeight: 0 },
  'jev-1.13': { name: 'Jev 1.13', provider: 'Jev Group', contextWindow: '64K', dollarsPer1M: 0.042, outputDollarsPer1M: 0, tokenWeight: 0 },
  'subq-snap-preview': { name: 'SubQ Snap (Preview)', provider: 'Jev Group', contextWindow: '313K', dollarsPer1M: 0.05, outputDollarsPer1M: 0, tokenWeight: 0 },
  'gpt-6-luna-decisions': { name: 'GPT-6 Luna (Decisions)', provider: 'Jev Group', contextWindow: '1M', dollarsPer1M: 0.1, outputDollarsPer1M: 0, tokenWeight: 0 },
  'free/jev-1.13': { name: 'Jev 1.13', provider: 'Free', contextWindow: '64K', dollarsPer1M: 0, outputDollarsPer1M: 0, tokenWeight: 1 },
  'free/glm-5.3': { name: 'GLM 5.3', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/gemini-3.8-flash': { name: 'Gemini 3.8 Flash', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/qwen-3.8-max': { name: 'Qwen 3.8 MAX', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/deepseek-v4.1-flash': { name: 'Deepseek V4.1 Flash', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/deepseek-v4-flash-0731': { name: 'Deepseek V4 Flash', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/deepseek-v4-pro-0813': { name: 'Deepseek V4 Pro', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/gpt-6-luna': { name: 'Gpt 6 Luna', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 3 },
  'free/glm-5.3-flash': { name: 'GLM-5.3 Flash', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/mimo-v2.6-pro': { name: 'Mimo V2.6 Pro', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/minimax-m3.1': { name: 'MiniMax M3.1', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/minimax-m3': { name: 'MiniMax M3', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/mimo-v2.6-flash': { name: 'Mimo V2.6 Flash', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/claude-sonnet-4.6': { name: 'Claude 4.6 Sonnet', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/hy4': { name: 'HY 4', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/kimi-k3': { name: 'Kimi K3', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/claude-opus-4.6': { name: 'Claude 4.6 Opus', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/muse-spark-1.3': { name: 'Muse Spark 1.3', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/gemini-3.1-pro': { name: 'Gemini 3.1 Pro', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
  'free/kimi-k2.8': { name: 'Kimi K2.8', provider: 'Free', contextWindow: '1M', dollarsPer1M: 0, tokenWeight: 1 },
}

async function fetchApinexPublicMetadata(proxyIndex: number | null = null): Promise<Map<string, ApinexCatalogSpec>> {
  const map = new Map<string, ApinexCatalogSpec>(Object.entries(APINEX_CATALOG_DEFAULTS))
  try {
    const res = await proxiedFetch(
      APINEX_PUBLIC_MODELS_URL,
      {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', src: 'gate' },
        signal: AbortSignal.timeout(10_000),
      },
      proxyIndex,
    )
    if (!res.ok) return map
    const payload = (await res.json().catch(() => ({}))) as {
      models?: Array<{
        id?: unknown
        provider?: unknown
        name?: unknown
        contextWindow?: unknown
        weight?: unknown
        dollarsPer1M?: unknown
        outputDollarsPer1M?: unknown
        allowFree?: unknown
      }>
    }
    for (const item of payload.models ?? []) {
      const modelId = String(item.id ?? '').trim()
      if (!modelId || !isValidModelId(modelId)) continue
      const allowFree = item.allowFree !== false
      const rawProvider = String(item.provider ?? '').trim()
      const isFree = allowFree && (modelId.startsWith('free/') || rawProvider.toLowerCase() === 'free')
      const provider: ModelCategory = isFree
        ? 'Free'
        : isDecisionCatalogModelId(modelId) || rawProvider.toLowerCase() === 'jev group' || rawProvider.toLowerCase() === 'jev'
          ? 'Jev Group'
          : (MODEL_CATEGORIES.find((c) => c.toLowerCase() === rawProvider.toLowerCase() && c.toLowerCase() !== 'free') ??
             familyFromUpstreamId(modelId) ??
             'GPT')
      const dollars = Number(item.dollarsPer1M)
      const outDollars = item.outputDollarsPer1M !== undefined ? Number(item.outputDollarsPer1M) : undefined
      const weight = Number(item.weight)
      const isJev = provider === 'Jev Group' || isDecisionCatalogModelId(modelId)
      const resolvedInput = isFree
        ? 0
        : Number.isFinite(dollars) && dollars > 0
          ? dollars
          : (map.get(modelId)?.dollarsPer1M ?? 0.1)
      const resolvedOutput = isFree
        ? 0
        : outDollars !== undefined && Number.isFinite(outDollars) && outDollars >= 0
          ? outDollars
          : isJev
            ? 0
            : resolvedInput
      const safeName = sanitizeModelName(item.name, modelId)
      const tokenWeight = isFree
        ? (Number.isFinite(weight) && weight > 0 ? weight : (map.get(modelId)?.tokenWeight ?? 1))
        : 0
      map.set(modelId, {
        name: safeName,
        provider,
        contextWindow: String(item.contextWindow ?? '').trim() || '1M',
        dollarsPer1M: resolvedInput,
        outputDollarsPer1M: resolvedOutput,
        tokenWeight,
        allowFree,
      })
    }
  } catch {
    // Fallback to built-in APInex catalog defaults when public metadata endpoint is unreachable.
  }
  return map
}

export async function fetchCatalogModels(
  category: ModelCategory,
  upstreamProvider: UpstreamProvider = 'apinex',
): Promise<CatalogModel[]> {
  if (upstreamProvider !== 'apinex') {
    throw new Error('Only APInex is supported')
  }

  const keys = db
    .prepare(
      `SELECT secret, proxy_index FROM provider_keys
       WHERE provider = 'apinex' AND status != 'error'
       ORDER BY datetime(created_at) DESC`,
    )
    .all() as Array<{ secret: string; proxy_index: number | null }>

  if (keys.length === 0) {
    throw new Error('Add an APInex provider key first')
  }

  let lastError = 'Unable to load models'
  for (const key of keys) {
    try {
      const [publicMeta, response] = await Promise.all([
        fetchApinexPublicMetadata(key.proxy_index ?? null),
        proxiedFetch(
          `${APINEX_BASE_URL}/models`,
          {
            headers: {
              Authorization: `Bearer ${key.secret}`,
              Accept: 'application/json',
              'Cache-Control': 'no-cache',
              src: 'gate',
            },
            signal: AbortSignal.timeout(10_000),
          },
          key.proxy_index ?? null,
        ),
      ])
      const payload = (await response.json().catch(() => ({}))) as {
        data?: Array<{ id?: unknown; name?: unknown; context_window?: unknown }>
        message?: unknown
        error?: { message?: string }
      }
      if (!response.ok) {
        lastError = String(payload.error?.message ?? payload.message ?? `HTTP ${response.status}`)
        continue
      }
      const models: CatalogModel[] = []
      const seen = new Set<string>()
      for (const item of payload.data ?? []) {
        const modelId = String(item.id ?? '').trim()
        if (!modelId || seen.has(modelId) || !isValidModelId(modelId)) continue
        seen.add(modelId)
        const spec = publicMeta.get(modelId)
        const allowFree = spec?.allowFree !== false
        const isFree = allowFree && (modelId.startsWith('free/') || spec?.provider === 'Free')
        const resolvedProvider: ModelCategory = isFree
          ? 'Free'
          : isDecisionCatalogModelId(modelId) || spec?.provider === 'Jev Group'
            ? 'Jev Group'
            : (spec?.provider && spec.provider !== 'Free' ? spec.provider : (familyFromUpstreamId(modelId) ?? 'GPT'))
        const price = spec?.dollarsPer1M ?? (isFree ? 0 : 0.1)
        const outPrice = spec?.outputDollarsPer1M !== undefined ? spec.outputDollarsPer1M : (resolvedProvider === 'Jev Group' ? 0 : price)
        const rawName = String(item.name ?? '').trim() || spec?.name || displayNameFromId(modelId)
        const safeName = sanitizeModelName(rawName, modelId)
        models.push({
          id: modelId,
          name: safeName,
          provider: resolvedProvider,
          contextWindow: item.context_window ? String(item.context_window) : (spec?.contextWindow ?? '1M'),
          inputPrice: price,
          outputPrice: outPrice,
          tokenWeight: isFree ? (spec?.tokenWeight && spec.tokenWeight > 0 ? spec.tokenWeight : 1) : 0,
          allowFree,
        })
      }
      for (const [modelId, spec] of publicMeta.entries()) {
        if (seen.has(modelId) || !isValidModelId(modelId)) continue
        seen.add(modelId)
        const safeName = sanitizeModelName(spec.name, modelId)
        const allowFree = spec.allowFree !== false
        const isFree = allowFree && (modelId.startsWith('free/') || spec.provider === 'Free')
        const resolvedProvider: ModelCategory = isFree
          ? 'Free'
          : isDecisionCatalogModelId(modelId) || spec.provider === 'Jev Group'
            ? 'Jev Group'
            : (spec.provider !== 'Free' ? spec.provider : (familyFromUpstreamId(modelId) ?? 'GPT'))
        models.push({
          id: modelId,
          name: safeName,
          provider: resolvedProvider,
          contextWindow: spec.contextWindow,
          inputPrice: spec.dollarsPer1M,
          outputPrice: spec.outputDollarsPer1M ?? (resolvedProvider === 'Jev Group' ? 0 : spec.dollarsPer1M),
          tokenWeight: isFree ? (spec.tokenWeight && spec.tokenWeight > 0 ? spec.tokenWeight : 1) : 0,
          allowFree,
        })
      }
      const filtered =
        category === 'Free'
          ? models
          : models.filter((m) => m.provider === category || CATEGORY_MATCHERS[category](m.id.toLowerCase()))
      return filtered.sort((a, b) => a.name.localeCompare(b.name))
    } catch (reason) {
      lastError = reason instanceof Error ? reason.message : lastError
    }
  }
  throw new Error(lastError)
}

export async function importApinexCatalogModels(): Promise<{
  imported: number
  updated: number
  total: number
}> {
  const models = await fetchCatalogModels('Free', 'apinex')
  const createdAt = nowIso()
  let nextOrder =
    (
      db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS n FROM model_catalog`).get() as {
        n: number
      }
    ).n ?? 0

  let imported = 0
  let updated = 0

  const insertModel = db.prepare(`
    INSERT INTO model_catalog
      (id, provider, name, context_window, input_price_micros, output_price_micros, status, tags_json, created_at, upstream_id, upstream_provider, token_weight, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, 'active', '[]', ?, ?, 'apinex', ?, ?)
  `)
  const insertPrice = db.prepare(`
    INSERT INTO pricing_rules (id, model_id, input_multiplier, output_multiplier, active, updated_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `)
  const updateModel = db.prepare(`
    UPDATE model_catalog
    SET provider = ?,
        name = ?,
        context_window = ?,
        input_price_micros = ?,
        output_price_micros = ?,
        token_weight = ?,
        upstream_id = COALESCE(upstream_id, ?),
        upstream_provider = 'apinex'
    WHERE id = ?
  `)

  const tx = db.transaction((items: CatalogModel[]) => {
    for (const item of items) {
      if (!isValidModelId(item.id)) continue
      const safeName = sanitizeModelName(item.name, item.id)
      const allowFree = item.allowFree !== false
      const isFree = allowFree && (item.provider === 'Free' || item.id.startsWith('free/'))
      const isJev = !isFree && (item.provider === 'Jev Group' || isDecisionCatalogModelId(item.id))
      const storedProvider = isFree
        ? 'Free'
        : isJev
          ? 'Jev Group'
          : item.provider !== 'Free'
            ? item.provider
            : (familyFromUpstreamId(item.id) ?? 'GPT')
      const inputMicros = isFree ? 0 : Math.round((item.inputPrice || 0.1) * 1_000_000)
      const outputMicros = isFree
        ? 0
        : isJev && item.outputPrice === 0
          ? 0
          : Math.round((item.outputPrice || item.inputPrice || 0.1) * 1_000_000)
      const tokenWeight = isFree ? (item.tokenWeight && item.tokenWeight > 0 ? item.tokenWeight : 1) : 0
      const contextWindow = item.contextWindow && item.contextWindow !== '—' ? item.contextWindow : '1M'

      const existing = db
        .prepare(
          'SELECT id, provider, context_window, input_price_micros, output_price_micros, token_weight FROM model_catalog WHERE id = ?',
        )
        .get(item.id) as
        | {
            id: string
            provider: string
            context_window: string
            input_price_micros: number
            output_price_micros: number
            token_weight: number
          }
        | undefined

      if (!existing) {
        nextOrder += 10
        insertModel.run(
          item.id,
          storedProvider,
          safeName,
          contextWindow,
          inputMicros,
          outputMicros,
          createdAt,
          item.id,
          tokenWeight,
          nextOrder,
        )
        insertPrice.run(
          id('price'),
          item.id,
          tokenWeight > 0 ? tokenWeight : 1,
          tokenWeight > 0 ? tokenWeight : 1,
          createdAt,
        )
        imported += 1
      } else {
        const needsUpdate =
          existing.provider !== storedProvider ||
          existing.context_window === '—' ||
          (isFree && existing.token_weight !== tokenWeight) ||
          (!isFree && existing.input_price_micros === 0)
        if (needsUpdate) {
          updateModel.run(
            storedProvider,
            safeName,
            existing.context_window === '—' ? contextWindow : existing.context_window,
            !isFree && existing.input_price_micros === 0 ? inputMicros : existing.input_price_micros,
            !isFree && existing.output_price_micros === 0 ? outputMicros : existing.output_price_micros,
            isFree ? tokenWeight : 0,
            item.id,
            item.id,
          )
          db.prepare(`UPDATE pricing_rules SET input_multiplier = ?, output_multiplier = ?, updated_at = ? WHERE model_id = ?`).run(
            tokenWeight > 0 ? tokenWeight : 1,
            tokenWeight > 0 ? tokenWeight : 1,
            createdAt,
            item.id,
          )
          updated += 1
        }
      }
    }
  })

  tx(models)
  return { imported, updated, total: models.length }
}
