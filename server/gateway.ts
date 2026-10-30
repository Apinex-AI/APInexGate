import { createHash } from 'node:crypto'
import { fetch as undiciFetch, type Dispatcher } from 'undici'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  markProviderSecretFailed,
  pickProviderSecretTargets,
  type ProviderSecretTarget,
} from './providerKeys.js'
import type { UpstreamProvider } from '../shared/providers.js'
import { dispatcherForProxyIndex } from './providerProxy.js'
import { db, id, nowIso, touchUserLastSeen } from './db.js'
import { assertSafeUpstreamUrl, sanitizeErrorMessage } from './upstreamFallback.js'

import { consumeRateLimit, rateLimitKey, RL, setRateLimitHeaders } from './rateLimit.js'
import { getAccountRpm } from './rpmPlans.js'
import { acquireDispatchSlot, releaseDispatchSlot } from './dispatchQueue.js'
import { chargeTokens, chargeUsdMicros, usdFromTokens } from '../shared/billing.js'
import { applySettledPromoCost, discountedTokenCost, promoBillingPlan } from './promoEvents.js'
import { playgroundSessionUser, stripPlaygroundTools } from './playgroundAuth.js'
import { debitApiTokens } from './restrictedCredits.js'
import {
  estimateModelReservationTokens,
  getOpenReservedTokensForKey,
  getOpenReservedTokensForUser,
  releaseReservation,
  settleReservation,
  tryReserveTokens,
} from './tokenReservations.js'
import { maybeNotifyUserLowBalance } from './userBalanceAlerts.js'
import {
  consumeFreeTierTokens,
  freeTierExhaustedMessage,
  getFreeTierAccess,
} from './subscriptions.js'

import { logUserActivity } from './userActivityLog.js'
import { siteName } from '../shared/brand.js'
import {
  clientSafeUpstreamError,
  isOutputLimitCompatibilityError,
  isReasoningExhaustedResponse,
  raiseReasoningOutputLimit,
  normalizeModelOutputLimits,
  removeOutputLimitsForFreeRetry,
  validateModelInputLimits,
  validateModelOutputLimits,
} from './modelOutputLimits.js'
import {
  chatResponseToResponses,
  normalizeChatResponseFormat,
  responsesRequestToChat,
  ResponsesStreamEncoder,
  rewriteNativeResponsesEvent,
  upstreamSupportsResponses,
} from './responsesCompat.js'

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504])
// Prevent a stalled socket/TLS connection from holding a customer request until
// Undici's multi-minute internal timeout. The retry plan handles the next key.
//
// A streaming upstream sends headers within seconds, so a tight bound is safe and
// the SSE body is never affected (the timer is cleared once headers arrive).
// A non-streaming upstream withholds headers until the whole completion is
// abort work that was about to succeed and push the caller onto a paid fallback.
const UPSTREAM_STREAM_TIMEOUT_MS = 30_000
const UPSTREAM_STREAM_FIRST_CHUNK_TIMEOUT_MS = 30_000
const UPSTREAM_NON_STREAM_TIMEOUT_MS = 180_000

function upstreamTimeoutFor(payload: Record<string, unknown>, hasFallbacks = false, _provider?: GatewayUpstream) {
  if (payload.stream === true) return UPSTREAM_STREAM_TIMEOUT_MS
  // When fallback routes exist, don't hold the client for 180s on a dead provider
  return hasFallbacks ? 45_000 : UPSTREAM_NON_STREAM_TIMEOUT_MS
}

export function upstreamFailureMessage(reason: unknown, payload: Record<string, unknown>, hasFallbacks = false, provider?: GatewayUpstream) {
  if (
    reason instanceof DOMException &&
    (reason.name === 'TimeoutError' || reason.name === 'AbortError')
  ) {
    return `Upstream request timed out after ${upstreamTimeoutFor(payload, hasFallbacks, provider) / 1000}s`
  }
  return sanitizeErrorMessage(reason instanceof Error ? reason.message : 'Upstream connection failed')
}

// Time budget for *finding* a usable upstream, not for streaming a reply. A
// provider that keeps stalling hands over to its fallback instead of spending
// one full timeout per key. Each stage always gets at least one attempt.
const STAGE_RETRY_BUDGET_MS = 100_000
const TOTAL_RETRY_BUDGET_MS = 180_000

type GatewayUpstream = string

function isGatewayUpstream(value: string): value is 'apinex' {
  return value === 'apinex'
}

function baseUrlsForUpstream(provider: GatewayUpstream) {
  if (provider === 'apinex') return ['https://api.apinex.bond/v1']
  return ['https://api.apinex.bond/v1']
}

/**
 * Per-model upstream fallback chains. When the primary upstream is unavailable
 * (connection failure, timeout, 429, 5xx) the same request is replayed on the
 * next upstream instead of surfacing an error to the caller. Only models listed
 * here fail over; every other model keeps its single configured upstream.
 */
export const MODEL_UPSTREAM_FALLBACKS: Record<
  string,
  ReadonlyArray<{ provider: GatewayUpstream; upstreamModelId: string }>
> = {}

export function upstreamFallbacksFor(...modelIds: Array<string | null | undefined>) {
  for (const rawId of modelIds) {
    if (!rawId) continue
    const model = resolveModel(rawId)
    const resolvedId = model?.id ?? rawId.trim().toLowerCase()

    const candidates = [resolvedId, rawId.trim().toLowerCase()]
    if (resolvedId.includes('-')) candidates.push(resolvedId.replace(/-/g, '/'))
    if (resolvedId.includes('/')) candidates.push(resolvedId.replace(/\//g, '-'))

    for (const key of candidates) {
      const routes = db.prepare(`
        SELECT upstream_provider, upstream_id
        FROM model_upstream_routes
        WHERE lower(model_id) = lower(?) AND position > 1
        ORDER BY position ASC
      `).all(key) as Array<{ upstream_provider: string; upstream_id: string }>
      if (routes.length > 0) {
        const valid = routes
          .filter((route): route is { upstream_provider: 'apinex'; upstream_id: string } => isGatewayUpstream(route.upstream_provider))
          .map((route) => ({ provider: route.upstream_provider, upstreamModelId: route.upstream_id }))
        if (valid.length > 0) return valid
      }
      if (MODEL_UPSTREAM_FALLBACKS[key]) {
        const valid = MODEL_UPSTREAM_FALLBACKS[key].filter((r) => isGatewayUpstream(r.provider))
        if (valid.length > 0) return valid
      }
    }
  }
  return []
}

// SHA-256 API-key hashes only. These per-key restrictions intentionally do not
// affect other keys belonging to the same account.
const TEMPORARILY_RESTRICTED_KEY_HASHES = new Set([
  'c52924eaed69f62683da752e0f150a89797a66a10afbb0ffd053266a8f4b13cb',
  '4022f44adea05b6fb4ec022b758e333749ddf5cfd63a91fe69efc84d841f457a',
])
const TEMPORARILY_RESTRICTED_MODELS = new Set([
  'claude/opus-5',
  'claude/sonnet-5',
  'gpt/5.6-sol',
  'gpt/5.6-terra',
  'kimi/k3',
  'claude-opus-5',
  'claude-sonnet-5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'kimi-k3',
])

export function isTemporarilyRestrictedModelForKey(apiKeyHash: string, modelId: string) {
  return TEMPORARILY_RESTRICTED_KEY_HASHES.has(apiKeyHash) && TEMPORARILY_RESTRICTED_MODELS.has(modelId)
}

type ApiKeyAuth = {
  id: string
  user_id: string
  spend_limit_tokens: number | null
  spent_tokens: number
  reserved_tokens: number
  status: string
}

type UserRow = {
  id: string
  balance_tokens: number
  reserved_tokens: number
  status: string
  requests: number
}

type ModelRow = {
  id: string
  upstream_id: string | null
  provider: string
  name: string
  token_weight: number
  input_price_micros: number
  output_price_micros: number
  upstream_provider: string
  status: string
}

type ModelRates = {
  inputDollarsPer1M: number
  outputDollarsPer1M: number
}

type AuthOk = { key: ApiKeyAuth; user: UserRow }
type AuthFailure = { error: string; status: number }
type AuthResult = AuthOk | AuthFailure

function isAuthFailure(auth: AuthResult): auth is AuthFailure {
  return 'error' in auth
}

function hashApiKey(secret: string) {
  return createHash('sha256').update(secret).digest('hex')
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractApiSecret(request: FastifyRequest) {
  const header = request.headers.authorization
  if (header) {
    const [scheme, token] = header.split(' ')
    if (scheme && token && scheme.toLowerCase() === 'bearer') return token.trim()
  }
  const anthropicKey = request.headers['x-api-key']
  if (typeof anthropicKey === 'string' && anthropicKey.trim()) return anthropicKey.trim()
  if (Array.isArray(anthropicKey) && anthropicKey[0]?.trim()) return anthropicKey[0].trim()
  return null
}

function authenticateApiKey(request: FastifyRequest): AuthResult {
  const secret = extractApiSecret(request)
  if (!secret) return { error: 'Missing API key (Bearer or x-api-key)', status: 401 }

  const key = db
    .prepare(
      `SELECT id, user_id, spend_limit_tokens, spent_tokens,
              COALESCE(reserved_tokens, 0) AS reserved_tokens, status
       FROM api_keys WHERE secret_hash = ?`,
    )
    .get(hashApiKey(secret)) as ApiKeyAuth | undefined

  if (!key || key.status !== 'active') {
    return { error: 'Invalid API key', status: 401 }
  }

  const user = db
    .prepare(
      `SELECT id, balance_tokens, COALESCE(reserved_tokens, 0) AS reserved_tokens, status, requests
       FROM users WHERE id = ?`,
    )
    .get(key.user_id) as UserRow | undefined

  if (!user || user.status === 'suspended' || user.status === 'pending' || user.status !== 'active') {
    if (user?.status === 'pending') {
      return { error: 'Account pending activation', status: 403 }
    }
    return { error: 'Account suspended or missing', status: 403 }
  }

  touchUserLastSeen(user.id)
  try {
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), key.id)
  } catch {
    /* ignore */
  }

  return { key, user }
}

function resolveModel(publicId: string) {
  const stmt = db
    .prepare(
      `SELECT id,
              COALESCE((SELECT upstream_id FROM model_upstream_routes r WHERE r.model_id = model_catalog.id AND r.position = 1), upstream_id) AS upstream_id,
              COALESCE((SELECT upstream_provider FROM model_upstream_routes r WHERE r.model_id = model_catalog.id AND r.position = 1), upstream_provider, 'apinex') AS upstream_provider,
              provider, name, COALESCE(token_weight, 1) AS token_weight,
              COALESCE(input_price_micros, 0) AS input_price_micros,
              COALESCE(output_price_micros, 0) AS output_price_micros,
              status
       FROM model_catalog WHERE id = ?`,
    )

  let row = stmt.get(publicId) as ModelRow | undefined
  if (row) return row

  if (publicId.endsWith('-free')) {
    const candidate = 'free/' + publicId.slice(0, -5)
    row = stmt.get(candidate) as ModelRow | undefined
    if (row) return row
  } else if (publicId.startsWith('free-')) {
    const candidate = 'free/' + publicId.slice(5)
    row = stmt.get(candidate) as ModelRow | undefined
    if (row) return row
  }

  if (publicId.includes('/')) {
    row = stmt.get(publicId.replace('/', '-')) as ModelRow | undefined
    if (row) return row
  } else if (publicId.includes('-')) {
    row = stmt.get(publicId.replace('-', '/')) as ModelRow | undefined
    if (row) return row
  }

  return undefined
}

export function costTokensFromUsage(
  inputTokens: number,
  outputTokens: number,
  inputDollarsPer1M: number,
  outputDollarsPer1M = inputDollarsPer1M,
) {
  return chargeUsdMicros(inputTokens, outputTokens, inputDollarsPer1M, outputDollarsPer1M)
}

function dollarsFromMicros(micros: number) {
  const value = Number(micros)
  return Number.isFinite(value) && value > 0 ? value / 1_000_000 : 0
}

function modelRates(model: Pick<ModelRow, 'provider' | 'id' | 'input_price_micros' | 'output_price_micros'>): ModelRates {
  if (model.provider.trim().toLowerCase() === 'free' || model.id.startsWith('free/')) {
    return { inputDollarsPer1M: 0, outputDollarsPer1M: 0 }
  }
  const inputDollarsPer1M = dollarsFromMicros(model.input_price_micros)
  const outputDollarsPer1M = dollarsFromMicros(model.output_price_micros) || inputDollarsPer1M
  return { inputDollarsPer1M, outputDollarsPer1M }
}

function modelHasPrice(rates: ModelRates) {
  return rates.inputDollarsPer1M > 0 || rates.outputDollarsPer1M > 0
}

/**
 * Fields we are willing to echo back from an upstream `usage` object.
 *
 * This is a whitelist, not a blacklist: upstreams add their own accounting keys
 * (e.g. `kiro_credits`, `kiro_credit_unit`, `cost`) that leak both the vendor
 * behind a route and their internal pricing unit to our customers. Anything not
 * listed here is dropped.
 *
 * Cache fields (`prompt_tokens_details.cached_tokens`, `cache_write_tokens`,
 * `input_tokens_details.cached_tokens`) are also stripped: billing here is a
 * the model's input and output rates and exposing upstream cache accounting invites
 * "why am I charged full price for cached tokens" disputes.
 */
const PUBLIC_USAGE_FIELDS = new Set([
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'prompt_tokens_details',
  'completion_tokens_details',
  'input_tokens',
  'output_tokens',
  'input_tokens_details',
  'output_tokens_details',
])

/** Cache-accounting keys removed from usage detail objects before responding. */
const USAGE_CACHE_FIELDS = new Set(['cached_tokens', 'cache_write_tokens', 'cache_read_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'])

function stripUsageCacheFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUsageCacheFields)
  if (!value || typeof value !== 'object') return value
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (USAGE_CACHE_FIELDS.has(key)) continue
    next[key] = stripUsageCacheFields(child)
  }
  return next
}

export function publicUsage(
  usage: unknown,
  costTokens: number,
  fallback?: { inputTokens: number; outputTokens: number },
) {
  if (!usage || typeof usage !== 'object') return usage
  const source = usage as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (PUBLIC_USAGE_FIELDS.has(key)) next[key] = stripUsageCacheFields(value)
  }
  const promptTokens = Number(
    next.prompt_tokens ?? next.input_tokens ?? fallback?.inputTokens ?? 0,
  )
  const completionTokens = Number(
    next.completion_tokens ?? next.output_tokens ?? fallback?.outputTokens ?? 0,
  )
  const totalTokens = Number(next.total_tokens ?? promptTokens + completionTokens)

  next.prompt_tokens = Number.isFinite(promptTokens) ? Math.max(0, Math.floor(promptTokens)) : 0
  next.completion_tokens = Number.isFinite(completionTokens) ? Math.max(0, Math.floor(completionTokens)) : 0
  next.total_tokens = Number.isFinite(totalTokens) ? Math.max(0, Math.floor(totalTokens)) : 0
  // Wallet is dollars. Do not publish the internal ledger unit as a token price.
  void costTokens
  return next
}

function recordUsage(input: {
  userId: string
  apiKeyId: string
  modelId: string
  provider: string
  inputTokens: number
  outputTokens: number
  costTokens: number
  allowanceWeight?: number
  latencyMs: number
  status: 'ok' | 'error'
  /**
   * Internal-only marker: the client went away mid-stream instead of the upstream
   * failing. It is deliberately kept out of `usage_events` so every user-facing
   * response, admin query, and quest counter stays byte-identical to before.
   */
  clientDisconnected?: boolean
  /** When set, charge/release goes through the pre-auth hold instead of a late debit. */
  reservationId?: string | null
}) {
  if (input.status === 'ok') {
    input.costTokens = applySettledPromoCost(
      input.userId,
      input.modelId,
      input.costTokens,
      input.inputTokens + input.outputTokens,
    )
  }

  const createdAt = nowIso()
  const usageId = id('usage')
  db.prepare(
    `INSERT INTO usage_events
      (id, user_id, api_key_id, model_id, provider, input_tokens, output_tokens, cost_cents, cost_tokens, allowance_weight, latency_ms, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  ).run(
    usageId,
    input.userId,
    input.apiKeyId,
    input.modelId,
    input.provider,
    input.inputTokens,
    input.outputTokens,
    input.costTokens,
    input.allowanceWeight ?? 0,
    input.latencyMs,
    input.status,
    createdAt,
  )

  db.prepare(`UPDATE users SET requests = requests + 1, last_seen_at = ? WHERE id = ?`).run(
    createdAt,
    input.userId,
  )
  db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(createdAt, input.apiKeyId)

  // Zero-cost models never touch the balance, so they are metered against the
  // daily free allowance / active subscription instead. Resolved here (one PK
  // lookup) so every call site stays uniform.
  if (input.status === 'ok' && isFreeMeteredModel(input.modelId) && !input.reservationId) {
    const weight = typeof input.allowanceWeight === 'number' && input.allowanceWeight > 0 ? input.allowanceWeight : 1
    const metered = chargeTokens(input.inputTokens, input.outputTokens, weight)
    if (metered > 0) consumeFreeTierTokens(input.userId, metered)
  }

  logUserActivity({
    action: 'api.request',
    userId: input.userId,
    target: input.modelId,
    meta: {
      usageId,
      apiKeyId: input.apiKeyId,
      provider: input.provider,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costTokens: input.costTokens,
      latencyMs: input.latencyMs,
      status: input.status,
      ...(input.clientDisconnected ? { clientDisconnected: true } : {}),
    },
  })

  if (input.reservationId) {
    if (input.status === 'ok' || (input.clientDisconnected && input.costTokens > 0)) {
      const weight = typeof input.allowanceWeight === 'number' && input.allowanceWeight > 0 ? input.allowanceWeight : 1
      const charge = isFreeMeteredModel(input.modelId)
        ? chargeTokens(input.inputTokens, input.outputTokens, weight)
        : Math.max(0, input.costTokens)
      settleReservation(input.reservationId, charge)
      // Hold already debited spendable balance; check after settle/refund.
      maybeNotifyUserLowBalance(input.userId)
    } else {
      releaseReservation(input.reservationId)
    }
    return
  }

  // Legacy path (no reservation) — keep clamp for safety.
  if ((input.status === 'ok' || input.clientDisconnected) && input.costTokens > 0) {
    debitApiTokens(input.userId, input.costTokens)
    db.prepare(`UPDATE api_keys SET spent_tokens = spent_tokens + ? WHERE id = ?`).run(
      input.costTokens,
      input.apiKeyId,
    )
    maybeNotifyUserLowBalance(input.userId)
  }
}

/** True when the model is a zero-cost route metered against the free allowance. */
function freeAllowanceWeight(_userId: string, model: ModelRow) {
  return Number(model.token_weight) > 0 ? Number(model.token_weight) : 1
}

function isFreeMeteredModel(modelId: string) {
  const model = resolveModel(modelId)
  if (model) {
    return model.provider.trim().toLowerCase() === 'free'
  }
  const id = modelId.trim().toLowerCase()
  return id.startsWith('free/') || id.startsWith('free-') || id.endsWith('-free')
}

function parseUsage(data: Record<string, unknown>) {
  const usage = (data.usage ?? {}) as Record<string, unknown>
  const inputTokens = Number(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0,
  )
  const outputTokens = Number(
    usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0,
  )
  return {
    inputTokens: Number.isFinite(inputTokens) ? Math.max(0, Math.floor(inputTokens)) : 0,
    outputTokens: Number.isFinite(outputTokens) ? Math.max(0, Math.floor(outputTokens)) : 0,
  }
}

function textCharCount(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + textCharCount(item), 0)
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    if (typeof row.text === 'string') return row.text.length
    if (typeof row.content === 'string' || Array.isArray(row.content) || (row.content && typeof row.content === 'object')) {
      return textCharCount(row.content)
    }
    if ('input' in row) return textCharCount(row.input)
    if ('messages' in row) return textCharCount(row.messages)
    if ('output' in row) return textCharCount(row.output)
    if ('choices' in row) return textCharCount(row.choices)
    if ('delta' in row) return textCharCount(row.delta)
    if ('message' in row) return textCharCount(row.message)
  }
  return 0
}

function charsToTokens(chars: number) {
  return Math.max(1, Math.ceil(Math.max(0, chars) / 4))
}

/** When upstream omits usage (common on /v1/messages via some providers), estimate so ok ≠ free. */
function estimateUsage(body: Record<string, unknown>, data?: Record<string, unknown>) {
  const inputChars =
    textCharCount(body.messages) +
    textCharCount(body.input) +
    textCharCount(body.state) +
    (body.questions ? JSON.stringify(body.questions).length : 0) +
    textCharCount(body.prompt) +
    textCharCount(body.system)
  const outputChars = data ? textCharCount(data) : 0
  const maxOut = Number(body.max_tokens ?? body.max_output_tokens ?? 0)
  const outputTokens =
    outputChars > 0
      ? charsToTokens(outputChars)
      : Number.isFinite(maxOut) && maxOut > 0
        ? Math.max(1, Math.min(256, Math.floor(maxOut)))
        : 32
  // Providers often hide system/tool overhead when usage is stripped — keep a protective floor.
  const inputTokens = Math.max(charsToTokens(Math.max(inputChars, 16)), 2048)
  return { inputTokens, outputTokens }
}

function resolveBillableUsage(input: {
  body: Record<string, unknown>
  data?: Record<string, unknown>
  parsed: { inputTokens: number; outputTokens: number }
  rates: ModelRates
  freeModel?: boolean
}) {
  let { inputTokens, outputTokens } = input.parsed
  let estimated = false
  if (inputTokens + outputTokens <= 0) {
    const fallback = estimateUsage(input.body, input.data)
    inputTokens = fallback.inputTokens
    outputTokens = fallback.outputTokens
    estimated = true
  }
  const costTokens = input.freeModel
    ? 0
    : costTokensFromUsage(inputTokens, outputTokens, input.rates.inputDollarsPer1M, input.rates.outputDollarsPer1M)
  return {
    inputTokens,
    outputTokens,
    costTokens,
    estimated,
  }
}

function stripUpstreamVendorFields(payload: Record<string, unknown>) {
  delete payload.provider
  delete payload.system_fingerprint
  delete payload.service_tier
}

function isRetryableStatus(status: number) {
  return RETRY_STATUSES.has(status)
}

function extractErrorMessage(errorBody: Record<string, unknown>, status: number) {
  const nested = errorBody.error
  let message = `HTTP ${status}`
  if (typeof nested === 'string') message = nested
  else if (nested && typeof nested === 'object' && 'message' in nested) {
    message = String((nested as { message?: string }).message ?? `HTTP ${status}`)
  } else if (typeof errorBody.message === 'string') {
    message = errorBody.message
  }
  return sanitizeErrorMessage(message)
}

// These upstreams have per-account quotas. Spread independent requests evenly;
// retries still rotate through the same ordered pool and keep each key's proxy.
const providerKeyCursors: Partial<Record<GatewayUpstream, number>> = {}

export function rotateProviderTargets(
  provider: GatewayUpstream,
  targets: ProviderSecretTarget[],
): ProviderSecretTarget[] {
  if (targets.length < 2) return targets
  const start = (providerKeyCursors[provider] ?? 0) % targets.length
  providerKeyCursors[provider] = ((providerKeyCursors[provider] ?? 0) + 1) % Number.MAX_SAFE_INTEGER
  return [...targets.slice(start), ...targets.slice(0, start)]
}

function selectProviderTargets(provider: GatewayUpstream) {
  return rotateProviderTargets(provider, pickProviderSecretTargets(provider as UpstreamProvider))
}

const LANGUAGE_AND_TOOLS_POLICY =
  'Language is mandatory: write every user-facing response entirely in the exact language of the latest user message. ' +
  'Do not use the language of earlier messages, account settings, or examples, and do not switch languages unless the user explicitly asks. ' +
  'When tools are available, use real tool calls only — never invent tool results, never monologue about missing tools, ' +
  'and never paste long self-corrections. Prefer a short plan, then a tool call. For file create/edit/delete use the provided tools/shell instead of describing commands in prose.'

/**
 * Stream-safe think-tag scrubber. Upstreams may split <think>...</think> across
 * chunk boundaries, so a per-chunk regex cannot see the pair. This tracks state
 * across chunks: once an opening <think> arrives, every subsequent chunk is
 * swallowed until the closing </think> (inclusive) is seen.
 */
function partialTagSuffix(text: string, tag: string) {
  const max = Math.min(text.length, tag.length - 1)
  for (let size = max; size > 0; size -= 1) {
    const tail = text.slice(-size)
    if (tag.startsWith(tail)) return tail
  }
  return ''
}

export function createThinkTagScrubber() {
  let insideThink = false
  let carry = ''
  return (text: string): string => {
    if (!text) return text
    let working = carry + text
    carry = ''
    let output = ''
    while (working.length > 0) {
      if (insideThink) {
        const close = working.indexOf('</think>')
        if (close === -1) {
          // The closing tag may be split across chunks. Hold only a real prefix
          // of </think>, not the last N characters of the reasoning text.
          carry = partialTagSuffix(working, '</think>')
          return output
        }
        working = working.slice(close + '</think>'.length)
        insideThink = false
        // Drop one leading newline after the closing tag.
        if (working.startsWith('\n')) working = working.slice(1)
        continue
      }
      const open = working.indexOf('<think>')
      if (open === -1) {
        // No opener. But the tail may be a partial <think> prefix — hold back
        // up to 7 chars ('<think>'.length - 1) so a split tag is not leaked.
        const holdBack = Math.min(working.length, '<think>'.length - 1)
        const tail = working.slice(-holdBack)
        if (tail.includes('>') || '<think>'.startsWith(tail) === false) {
          output += working
          return output
        }
        carry = tail
        output += working.slice(0, working.length - holdBack)
        return output
      }
      output += working.slice(0, open)
      insideThink = true
      working = working.slice(open + '<think>'.length)
    }
    return output
  }
}

/** Public ids of zero-cost models are namespaced under `free/` or end with `-free`. */
export function isFreeTierModelId(publicModelId: string) {
  const id = publicModelId.trim().toLowerCase()
  return id.startsWith('free/') || id.startsWith('free-') || id.endsWith('-free')
}

const FORBIDDEN_UPSTREAM_HEADER_NAMES = new Set([
  'src',
  'cookie',
  'set-cookie',
  'authorization',
  'x-api-key',
  'api-key',
  'x-session-id',
  'x-user-id',
  'x-admin-key',
  'host',
  'connection',
  'content-length',
])

export function buildUpstreamRequestHeaders(
  providerSecret: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      const lower = key.trim().toLowerCase()
      if (
        FORBIDDEN_UPSTREAM_HEADER_NAMES.has(lower) ||
        lower.startsWith('x-internal') ||
        lower.startsWith('x-admin')
      ) {
        continue
      }
      headers[key] = value
    }
  }
  // Ensure no case-variant of Authorization or src remains from extraHeaders
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase()
    if (lower === 'authorization' || lower === 'src') {
      delete headers[k]
    }
  }
  headers.Authorization = `Bearer ${providerSecret}`
  headers.src = 'gate'
  return headers
}

async function upstreamPost(
  baseUrl: string,
  path: 'chat/completions' | 'responses' | 'decisions',
  providerSecret: string,
  payload: Record<string, unknown>,
  dispatcher?: Dispatcher,
  extraHeaders?: Record<string, string>,
  hasFallbacks = false,
  provider?: GatewayUpstream,
  clientSignal?: AbortSignal,
) {
  const targetUrl = `${baseUrl}/${path}`
  assertSafeUpstreamUrl(targetUrl)

  const headers = buildUpstreamRequestHeaders(providerSecret, extraHeaders)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), upstreamTimeoutFor(payload, hasFallbacks, provider))

  const onClientAbort = () => {
    controller.abort()
  }
  if (clientSignal) {
    if (clientSignal.aborted) {
      clearTimeout(timeout)
      controller.abort()
    } else {
      clientSignal.addEventListener('abort', onClientAbort, { once: true })
    }
  }

  try {
    // fetch resolves once response headers arrive. Clear the connection timeout at
    // that point so long-running SSE bodies are not aborted mid-stream.
    return await undiciFetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      dispatcher,
    })
  } finally {
    clearTimeout(timeout)
    if (clientSignal) {
      clientSignal.removeEventListener('abort', onClientAbort)
    }
  }
}

/** JSON Schema meta that native Gemini Function Calling rejects with HTTP 400. */
const GEMINI_UNSUPPORTED_SCHEMA_META = new Set(['$schema', '$id', '$comment'])

export function stripUnsupportedGeminiSchemaMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnsupportedGeminiSchemaMeta)
  if (!value || typeof value !== 'object') return value
  const next: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_META.has(key)) continue
    next[key] = stripUnsupportedGeminiSchemaMeta(nested)
  }
  return next
}


function cleanJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(cleanJsonSchema)
  const obj = { ...(schema as Record<string, unknown>) }
  if ('required' in obj && !Array.isArray(obj.required)) delete obj.required
  if ('pattern' in obj) {
    if (typeof obj.pattern !== 'string') {
      delete obj.pattern
    } else {
      const pattern = obj.pattern
      const unsupported = pattern.includes('\\p') || pattern.includes('\\P') || pattern.includes('(?=') || pattern.includes('(?!') || pattern.includes('(?<')
      if (unsupported) {
        delete obj.pattern
      } else {
        try { new RegExp(pattern) } catch { delete obj.pattern }
      }
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object') obj[key] = cleanJsonSchema(value)
  }
  return obj
}

function sanitizeToolDefinitions(tools: unknown[]): unknown[] {
  if (!Array.isArray(tools)) return []
  return tools
    .filter((tool): tool is Record<string, unknown> => Boolean(tool && typeof tool === 'object'))
    .map((tool) => {
      const row = { ...(tool as Record<string, unknown>) }

      if (row.function && typeof row.function === 'object') {
        const fn = { ...(row.function as Record<string, unknown>) }
        if (!fn.parameters || typeof fn.parameters !== 'object') {
          fn.parameters = { type: 'object', properties: {} }
        } else {
          fn.parameters = cleanJsonSchema(fn.parameters)
        }
        row.function = fn
      } else if (row.type === 'function' && !row.function) {
        row.function = { name: 'tool', parameters: { type: 'object', properties: {} } }
      }

      if (row.parameters && typeof row.parameters === 'object') {
        row.parameters = cleanJsonSchema(row.parameters)
      }

      return row
    })
}

function sanitizeCallIds(payload: Record<string, unknown>) {
  const idMap = new Map<string, string>()

  const truncateId = (id: string): string => {
    if (id.length <= 64) return id
    let mapped = idMap.get(id)
    if (!mapped) {
      mapped = id.slice(0, 64)
      idMap.set(id, mapped)
    }
    return mapped
  }

  // 1. In payload.messages
  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      if (!msg || typeof msg !== 'object') continue
      const row = msg as Record<string, unknown>
      if (row.role === 'assistant' && Array.isArray(row.tool_calls)) {
        for (const tc of row.tool_calls) {
          if (!tc || typeof tc !== 'object') continue
          const tcRow = tc as Record<string, unknown>
          if (typeof tcRow.id === 'string' && tcRow.id.length > 64) {
            tcRow.id = truncateId(tcRow.id)
          }
        }
      } else if (row.role === 'tool' && typeof row.tool_call_id === 'string' && row.tool_call_id.length > 64) {
        row.tool_call_id = truncateId(row.tool_call_id)
      }
    }
  }

  // 2. In payload.input (Responses format)
  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (typeof row.call_id === 'string' && row.call_id.length > 64) {
        row.call_id = truncateId(row.call_id)
      }
      if (typeof row.id === 'string' && row.id.length > 64) {
        row.id = truncateId(row.id)
      }
    }
  }
}

export function applyUpstreamPayloadQuirks(
  payload: Record<string, unknown>,
  _provider?: string,
) {
  // A flat Responses-style `response_format` is invalid on every chat.completions
  // endpoint, so repair it regardless of provider rather than per-upstream.
  if (payload.response_format && typeof payload.response_format === 'object') {
    payload.response_format = normalizeChatResponseFormat(payload.response_format)
  }

  // Clean tools definitions across all providers (fixes regex pattern errors, missing parameters, invalid required)
  if (Array.isArray(payload.tools)) {
    payload.tools = sanitizeToolDefinitions(payload.tools)
  }

  // duplicate function names outright:
  //   "tools[72].function.name is a duplicate of an earlier tool"
  // Clients that repeat a tool definition across turns (or ship several tools whose
  // names collide case-insensitively after upstream normalization) would otherwise
  // burn a fallback hop on every such request. Rename later duplicates with a
  // numeric suffix instead of dropping them, so the tool set survives intact and
  // the request stays on its primary upstream.
  if (Array.isArray(payload.tools) && payload.tools.length > 1) {
    const seenNames = new Set<string>()
    const renameCounts = new Map<string, number>()
    for (const tool of payload.tools) {
      if (!tool || typeof tool !== 'object') continue
      const row = tool as { function?: { name?: unknown } }
      if (!row.function || typeof row.function !== 'object') continue
      const fn = row.function as { name?: unknown }
      if (typeof fn.name !== 'string') continue
      const name = fn.name.trim()
      if (!name) continue
      const key = name.toLowerCase()
      if (!seenNames.has(key)) {
        seenNames.add(key)
        if (name !== fn.name) fn.name = name
        continue
      }
      const count = (renameCounts.get(key) ?? 0) + 1
      renameCounts.set(key, count)
      // 64-char upstream name limit: leave room for the suffix.
      const base = name.slice(0, 64 - `_${count}`.length)
      fn.name = `${base}_${count}`
    }
  }

  // Ensure call_id length <= 64 across messages and input
  sanitizeCallIds(payload)

  // Global quirks across all providers:
  if ('temperature' in payload && payload.temperature != null) {
    const temp = Number(payload.temperature)
    if (Number.isFinite(temp)) {
    } else {
      delete payload.temperature
    }
  }

  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      if (msg && typeof msg === 'object') {
        const row = msg as Record<string, unknown>
        if (Array.isArray(row.content)) {
          if (row.content.length === 0) {
            row.content = ''
          } else {
            // Keep only valid parts or flatten to string if contains non-standard parts
            const _validPartTypes = new Set(['text', 'image_url', 'video_url', 'audio_url', 'input_audio'])
          }
        } else if (row.content != null && typeof row.content === 'object') {
          // If content is an object instead of string or array
          const text = (row.content as { text?: unknown }).text
          row.content = typeof text === 'string' ? text : JSON.stringify(row.content)
        }
      }
    }
  }

  // 3. Normalize tool_choice:
  // "Invalid value for 'tool_choice': 'tool_choice' is only allowed when 'tools' are specified."
  if ('tool_choice' in payload) {
    if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
      delete payload.tool_choice
    }
  }

  // 4. Normalize tool_calls & tool messages pairing for strict OpenAI-compatible upstreams
  // Examples rejected by upstreams:
  // 1) "Validation: Tool messages starting at `messages[3]` are missing results for tool_call_id(s): call_..."
  // 2) "Validation: `messages[78]` tool message must follow assistant tool calls"
  // 3) "messages[84].tool_call_id does not match the preceding assistant tool_calls. Expected one of: ..."
  if (Array.isArray(payload.messages)) {
    const rawMsgs = payload.messages as Array<unknown>
    const newMsgs: Array<Record<string, unknown>> = []

    for (let i = 0; i < rawMsgs.length; i++) {
      const msg = rawMsgs[i]
      if (!msg || typeof msg !== 'object') {
        continue
      }
      const row = { ...(msg as Record<string, unknown>) }

      // When we encounter an assistant message:
      if (row.role === 'assistant') {
        const rawToolCalls = Array.isArray(row.tool_calls)
          ? (row.tool_calls.filter((tc) => tc && typeof tc === 'object') as Array<Record<string, unknown>>)
          : []

        if (rawToolCalls.length === 0) {
          delete row.tool_calls
          newMsgs.push(row)
          continue
        }

        // Collect all consecutive tool messages immediately following this assistant message
        const followingToolMessages: Array<Record<string, unknown>> = []
        let nextIdx = i + 1
        while (nextIdx < rawMsgs.length) {
          const next = rawMsgs[nextIdx]
          if (!next || typeof next !== 'object') break
          const nextRow = { ...(next as Record<string, unknown>) }
          if (nextRow.role === 'tool') {
            followingToolMessages.push(nextRow)
            nextIdx++
          } else {
            break
          }
        }

        if (followingToolMessages.length === 0) {
          // No tool messages follow: prune tool_calls so upstream doesn't error on missing tool results
          delete row.tool_calls
          if (row.content == null || row.content === '') {
            row.content = '...'
          }
          newMsgs.push(row)
          continue
        }

        const assistantCalls = rawToolCalls.map((tc) => ({ ...tc }))
        const matchedToolIndices = new Set<number>()
        const matchedCallIndices = new Set<number>()

        // Pass 1: Exact matches (tool.tool_call_id === tc.id)
        for (let t = 0; t < followingToolMessages.length; t++) {
          const toolMsg = followingToolMessages[t]!
          const tId = typeof toolMsg.tool_call_id === 'string' ? toolMsg.tool_call_id.trim() : ''
          if (!tId) continue

          for (let c = 0; c < assistantCalls.length; c++) {
            if (matchedCallIndices.has(c)) continue
            const cId = typeof assistantCalls[c]!.id === 'string' ? (assistantCalls[c]!.id as string).trim() : ''
            if (tId === cId) {
              matchedToolIndices.add(t)
              matchedCallIndices.add(c)
              break
            }
          }
        }

        // Pass 2: Loose matches (ignoring call_ / toolu_ prefixes or casing)
        for (let t = 0; t < followingToolMessages.length; t++) {
          if (matchedToolIndices.has(t)) continue
          const toolMsg = followingToolMessages[t]!
          const tId = (typeof toolMsg.tool_call_id === 'string' ? toolMsg.tool_call_id : '')
            .trim()
            .toLowerCase()
            .replace(/^call_|^toolu_/, '')
          if (!tId) continue

          for (let c = 0; c < assistantCalls.length; c++) {
            if (matchedCallIndices.has(c)) continue
            const cId = (typeof assistantCalls[c]!.id === 'string' ? (assistantCalls[c]!.id as string) : '')
              .trim()
              .toLowerCase()
              .replace(/^call_|^toolu_/, '')
            if (tId === cId || tId.includes(cId) || cId.includes(tId)) {
              toolMsg.tool_call_id = assistantCalls[c]!.id
              matchedToolIndices.add(t)
              matchedCallIndices.add(c)
              break
            }
          }
        }

        // Pass 3: Positional adaptation for remaining unmatched tool messages.
        // If the preceding assistant message expects an ID (e.g. 'ac9df4c1-3767-40cc-bf9e-3b9e63a44c37'),
        for (let t = 0; t < followingToolMessages.length; t++) {
          if (matchedToolIndices.has(t)) continue
          const toolMsg = followingToolMessages[t]!

          // Find first unmatched assistant call
          let foundCallIdx = -1
          for (let c = 0; c < assistantCalls.length; c++) {
            if (!matchedCallIndices.has(c)) {
              foundCallIdx = c
              break
            }
          }

          if (foundCallIdx !== -1) {
            toolMsg.tool_call_id = assistantCalls[foundCallIdx]!.id
            matchedToolIndices.add(t)
            matchedCallIndices.add(foundCallIdx)
          } else if (assistantCalls.length === 1) {
            // Single tool call in assistant: adapt all following tool messages to that id
            toolMsg.tool_call_id = assistantCalls[0]!.id
            matchedToolIndices.add(t)
          } else {
            // Extra tool message that cannot be paired: convert to user message
            const toolCallId = toolMsg.tool_call_id || 'call'
            const text = typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content ?? '')
            toolMsg.role = 'user'
            toolMsg.content = `[Tool result for ${toolCallId}]: ${text}`
            delete toolMsg.tool_call_id
          }
        }

        // Pass 4: Prune any assistant tool_calls that still have no matching tool message
        const finalCalls = assistantCalls.filter((_, cIdx) => matchedCallIndices.has(cIdx))
        if (finalCalls.length > 0) {
          row.tool_calls = finalCalls
        } else if (followingToolMessages.length > 0) {
          // Tool messages follow, so assistant MUST retain matching tool_calls!
          // Adapt assistant call to first following tool message
          assistantCalls[0]!.id = followingToolMessages[0]!.tool_call_id as string
          row.tool_calls = [assistantCalls[0]!]
        } else {
          delete row.tool_calls
          if (row.content == null || row.content === '') {
            row.content = '...'
          }
        }

        newMsgs.push(row)
        for (const item of followingToolMessages) {
          newMsgs.push(item)
        }

        i = nextIdx - 1
        continue
      }

      // If a tool message did not follow an assistant message: convert to user message
      if (row.role === 'tool') {
        const toolCallId = typeof row.tool_call_id === 'string' ? row.tool_call_id : 'call'
        const text = typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? '')
        newMsgs.push({
          role: 'user',
          content: `[Tool result for ${toolCallId}]: ${text}`,
        })
        continue
      }

      newMsgs.push(row)
    }

    // Final safety sweep for OpenAI spec:
    // Every message with role: 'tool' MUST immediately follow an assistant message with tool_calls
    // OR another tool message that follows that same assistant message.
    // If it does NOT, it MUST be converted to role: 'user'!
    for (let m = 0; m < newMsgs.length; m++) {
      const cur = newMsgs[m]
      if (cur && cur.role === 'tool') {
        let pIdx = m - 1
        while (pIdx >= 0 && newMsgs[pIdx]?.role === 'tool') {
          pIdx--
        }
        const parent = pIdx >= 0 ? newMsgs[pIdx] : null
        const parentToolCalls = Array.isArray(parent?.tool_calls)
          ? (parent!.tool_calls as Array<Record<string, unknown>>)
          : []
        const validParent = parent?.role === 'assistant' && parentToolCalls.length > 0
        const matchesCall = validParent && parentToolCalls.some((tc) => tc.id === cur.tool_call_id)

        if (!validParent) {
          const toolCallId = String(cur.tool_call_id ?? 'call')
          const text = typeof cur.content === 'string' ? cur.content : JSON.stringify(cur.content ?? '')
          cur.role = 'user'
          cur.content = `[Tool result for ${toolCallId}]: ${text}`
          delete cur.tool_call_id
        } else if (!matchesCall) {
          cur.tool_call_id = parentToolCalls[0]?.id ?? 'call_0'
        }
      }
    }

    payload.messages = newMsgs
  }

  // "Model only supports text input; received unsupported content type 'image_url'."

  // 5. Clamp top_p to [0, 1.0] and round to 2 decimal places.
  if ('top_p' in payload && payload.top_p != null) {
    const topP = Number(payload.top_p)
    if (Number.isFinite(topP)) {
      const clamped = Math.min(1.0, Math.max(0, topP))
      payload.top_p = Math.round(clamped * 100) / 100
    } else {
      delete payload.top_p
    }
  }

  // `name` must be at most 64 characters.
  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      if (msg && typeof msg === 'object') {
        const row = msg as Record<string, unknown>
        if (typeof row.name === 'string' && row.name.length > 64) {
          row.name = row.name.slice(0, 64)
        }
      }
    }
  }
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      if (tool && typeof tool === 'object') {
        const fn = (tool as { function?: { name?: string } }).function
        if (fn && typeof fn.name === 'string' && fn.name.length > 64) {
          fn.name = fn.name.slice(0, 64)
        }
      }
    }
  }
  if (
    payload.response_format &&
    typeof payload.response_format === 'object' &&
    (payload.response_format as { type?: unknown }).type === 'json_schema'
  ) {
    payload.response_format = { type: 'json_object' }
  }

  // "Numeric value (1788809705949) out of range of int (-2147483648 - 2147483647)".
  // Clamp or hash seed into valid 32-bit signed integer range [-2147483648, 2147483647].
  if ('seed' in payload && payload.seed != null) {
    const seedVal = Number(payload.seed)
    if (Number.isFinite(seedVal)) {
      if (seedVal > 2147483647 || seedVal < -2147483648) {
        // Map 64-bit timestamp or large seed into a valid 32-bit signed int
        payload.seed = (Math.floor(seedVal) % 2147483647) | 0
      }
    } else {
      delete payload.seed
    }
  }

  // Gemini Function Calling rejects JSON Schema meta such as `$schema`.
  // Also Google backend error: "Requests ending with a model turn are not supported."



  return payload
}

export function isProviderVariantRetryableError(
  _provider: GatewayUpstream,
  _status: number,
  _message: string,
) {
  return false
}

function anthropicSystemText(system: unknown): string {
  if (typeof system === 'string') return system.trim()
  if (!Array.isArray(system)) return ''
  return system
    .map((block) => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object') {
        const row = block as Record<string, unknown>
        if (typeof row.text === 'string') return row.text
        if (typeof row.content === 'string') return row.content
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function flattenAnthropicText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const row = part as Record<string, unknown>
      if (row.type === 'text' && typeof row.text === 'string') return row.text
      if (typeof row.text === 'string') return row.text
      return ''
    })
    .filter(Boolean)
    .join('')
}

/** Convert Anthropic content blocks to the OpenAI-compatible format. */
function anthropicContentToOpenAi(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content

  const blocks = content.flatMap((part) => {
    if (typeof part === 'string') return [{ type: 'text', text: part }]
    if (!part || typeof part !== 'object') return []
    const row = part as Record<string, unknown>

    if (row.type === 'text' && typeof row.text === 'string') {
      return [{ type: 'text', text: row.text }]
    }
    if (row.type === 'image_url' && row.image_url && typeof row.image_url === 'object') {
      return [row]
    }
    if (row.type === 'input_image') {
      const imageUrl = typeof row.image_url === 'string'
        ? row.image_url
        : row.image_url && typeof row.image_url === 'object'
          ? (row.image_url as Record<string, unknown>).url
          : undefined
      return typeof imageUrl === 'string' ? [{ type: 'image_url', image_url: { url: imageUrl } }] : []
    }
    if (row.type !== 'image' || !row.source || typeof row.source !== 'object') return []

    const source = row.source as Record<string, unknown>
    if (source.type === 'base64' && typeof source.data === 'string') {
      const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
      return [{ type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } }]
    }
    if (source.type === 'url' && typeof source.url === 'string') {
      return [{ type: 'image_url', image_url: { url: source.url } }]
    }
    return []
  })

  return blocks.length ? blocks : ''
}

function anthropicToolsToOpenAi(tools: unknown) {
  if (!Array.isArray(tools)) return undefined
  const out = tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return null
      const row = tool as Record<string, unknown>
      const name = String(row.name ?? '').trim()
      if (!name) return null
      const parameters =
        row.input_schema && typeof row.input_schema === 'object'
          ? row.input_schema
          : row.parameters && typeof row.parameters === 'object'
            ? row.parameters
            : { type: 'object', properties: {} }
      return {
        type: 'function',
        function: {
          name,
          description: typeof row.description === 'string' ? row.description : '',
          parameters,
        },
      }
    })
    .filter(Boolean)
  return out.length ? out : undefined
}


function anthropicToolChoiceToOpenAi(toolChoice: unknown) {
  if (toolChoice == null) return undefined
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice
  if (typeof toolChoice === 'object' && toolChoice) {
    const row = toolChoice as Record<string, unknown>
    if (row.type === 'tool' && typeof row.name === 'string') {
      return { type: 'function', function: { name: row.name } }
    }
    if (row.type === 'function') return toolChoice
  }
  return 'auto'
}

function anthropicMessagesToOpenAi(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return []
  const out: Array<Record<string, unknown>> = []

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const msg = raw as Record<string, unknown>
    const role = String(msg.role ?? '')
    const content = msg.content

    if (role === 'user') {
      if (typeof content === 'string') {
        out.push({ role: 'user', content })
        continue
      }
      if (!Array.isArray(content)) continue

      const toolResults = content.filter(
        (part) => part && typeof part === 'object' && (part as { type?: string }).type === 'tool_result',
      ) as Array<Record<string, unknown>>
      const other = content.filter(
        (part) => !(part && typeof part === 'object' && (part as { type?: string }).type === 'tool_result'),
      )

      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: String(tr.tool_use_id ?? tr.id ?? ''),
          content: flattenAnthropicText(tr.content) || (typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? '')),
        })
      }
      const converted = anthropicContentToOpenAi(other)
      if (Array.isArray(converted) && converted.length) {
        out.push({ role: 'user', content: converted })
      }
      continue
    }

    if (role === 'assistant') {
      if (typeof content === 'string') {
        out.push({ role: 'assistant', content })
        continue
      }
      if (!Array.isArray(content)) continue
      const converted = anthropicContentToOpenAi(content)
      const text = flattenAnthropicText(content)
      const toolUses = content.filter(
        (part) => part && typeof part === 'object' && (part as { type?: string }).type === 'tool_use',
      ) as Array<Record<string, unknown>>
      const toolCalls = toolUses.map((tu, index) => ({
        id: String(tu.id ?? `call_${index}`),
        type: 'function',
        function: {
          name: String(tu.name ?? 'tool'),
          arguments: JSON.stringify(tu.input ?? {}),
        },
      }))
      const row: Record<string, unknown> = {
        role: 'assistant',
        content: Array.isArray(converted) && converted.length ? converted : text || null,
      }
      if (toolCalls.length) row.tool_calls = toolCalls
      out.push(row)
      continue
    }

    if (role === 'system') {
      const text = flattenAnthropicText(content)
      if (text) out.push({ role: 'system', content: text })
    }
  }

  return out
}

function latestUserText(messages: Array<Record<string, unknown>>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      return message.content.trim()
    }
  }
  return ''
}

function languageHintForLatestUserMessage(text: string) {
  // One-word greetings such as "hi" are otherwise ambiguous to models when an
  // earlier conversation was in Russian. State the language explicitly.
  if (/^(hi|hello|hey|good morning|good afternoon|good evening)$/i.test(text)) {
    return 'The latest user message is English. You MUST answer entirely in English.'
  }
  return ''
}

function injectOpenAiSystemPolicy(messages: Array<Record<string, unknown>>) {
  const validMessages = Array.isArray(messages)
    ? messages.filter((m): m is Record<string, unknown> => Boolean(m && typeof m === 'object'))
    : []
  const next = validMessages.map((m) => ({ ...m }))
  const languageHint = languageHintForLatestUserMessage(latestUserText(next))
  const policy = languageHint ? `${LANGUAGE_AND_TOOLS_POLICY}\n${languageHint}` : LANGUAGE_AND_TOOLS_POLICY
  const firstSystem = next.find((m) => m && m.role === 'system')
  if (firstSystem) {
    const current = typeof firstSystem.content === 'string' ? firstSystem.content : ''
    if (!current.startsWith(LANGUAGE_AND_TOOLS_POLICY)) {
      firstSystem.content = `${policy}\n\n${current}`.trim()
    } else if (languageHint && !current.includes(languageHint)) {
      firstSystem.content = `${policy}\n\n${current}`
    }
    return next
  }
  next.unshift({ role: 'system', content: policy })
  return next
}

export function buildUpstreamPayload(
  body: Record<string, unknown>,
  upstreamModelId: string,
  path: 'chat/completions' | 'messages' | 'responses',
  _options: { freeTier?: boolean; publicModelId?: string | null } = {},
) {
  // Convert Anthropic Messages to chat completions, then translate the response back.
  if (path === 'messages') {
    const messages = injectOpenAiSystemPolicy([
      ...(anthropicSystemText(body.system)
        ? [{ role: 'system', content: anthropicSystemText(body.system) }]
        : []),
      ...anthropicMessagesToOpenAi(body.messages),
    ])
    const payload: Record<string, unknown> = {
      model: upstreamModelId,
      messages,
      stream: Boolean(body.stream),
    }
    if (body.max_tokens != null) payload.max_tokens = body.max_tokens
    if (body.temperature != null) payload.temperature = body.temperature
    if (body.top_p != null) payload.top_p = body.top_p
    if (body.stop_sequences != null) payload.stop = body.stop_sequences
    const tools = anthropicToolsToOpenAi(body.tools)
    if (tools) payload.tools = tools
    const toolChoice = anthropicToolChoiceToOpenAi(body.tool_choice)
    if (toolChoice != null) payload.tool_choice = toolChoice
    if (payload.stream === true) {
      payload.stream_options = { include_usage: true }
    }
    return payload
  }

  const payload: Record<string, unknown> = {
    ...body,
    model: upstreamModelId,
  }

  if (path === 'chat/completions' && Array.isArray(payload.messages)) {
    payload.messages = injectOpenAiSystemPolicy(payload.messages as Array<Record<string, unknown>>)
  }

  if (path === 'responses') {
    const existing =
      typeof payload.instructions === 'string'
        ? payload.instructions
        : typeof payload.instructions === 'object' && payload.instructions
          ? JSON.stringify(payload.instructions)
          : ''
    const languageHint = languageHintForLatestUserMessage(
      typeof payload.input === 'string' ? payload.input.trim() : '',
    )
    const policy = languageHint ? `${LANGUAGE_AND_TOOLS_POLICY}\n${languageHint}` : LANGUAGE_AND_TOOLS_POLICY
    if (!existing.includes('same language as the latest user message')) {
      payload.instructions = existing ? `${policy}\n\n${existing}` : policy
    }
  }

  if (payload.stream === true) {
    const streamOptions =
      payload.stream_options && typeof payload.stream_options === 'object'
        ? { ...(payload.stream_options as Record<string, unknown>) }
        : {}
    streamOptions.include_usage = true
    payload.stream_options = streamOptions
  }

  return payload
}

function sendOpenAiError(reply: FastifyReply, status: number, message: string, type = 'invalid_request_error') {
  return reply.code(status).send({
    error: {
      message,
      type,
      param: null,
      code: null,
    },
  })
}

function sendAnthropicError(reply: FastifyReply, status: number, message: string, type = 'invalid_request_error') {
  return reply.code(status).send({
    type: 'error',
    error: {
      type,
      message,
    },
  })
}

export function openAiChoiceText(data: Record<string, unknown>) {
  const choices = data.choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first = choices[0] as Record<string, unknown>
  const message = first.message as Record<string, unknown> | undefined
  if (message) {
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => {
          if (typeof part === 'string') return part
          if (part && typeof part === 'object' && 'text' in (part as object)) {
            return String((part as { text?: unknown }).text ?? '')
          }
          return ''
        })
        .join('')
    }
  }
  if (typeof first.text === 'string') return first.text
  return ''
}

function mapOpenAiFinishToAnthropic(reason: unknown) {
  const value = String(reason ?? '').toLowerCase()
  if (value === 'length' || value === 'max_tokens') return 'max_tokens'
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use'
  if (value === 'content_filter') return 'refusal'
  if (value === 'stop' || !value) return 'end_turn'
  return 'end_turn'
}

function openAiToolCalls(data: Record<string, unknown>) {
  const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : []
  const message = choices[0]?.message as Record<string, unknown> | undefined
  const toolCalls = message?.tool_calls
  if (!Array.isArray(toolCalls)) return [] as Array<Record<string, unknown>>
  return toolCalls.filter((c) => c && typeof c === 'object') as Array<Record<string, unknown>>
}

function openAiToolCallToAnthropicContent(toolCall: Record<string, unknown>, index: number) {
  const fn = (toolCall.function && typeof toolCall.function === 'object'
    ? toolCall.function
    : {}) as Record<string, unknown>
  let input: unknown = {}
  const rawArgs = typeof fn.arguments === 'string' ? fn.arguments : ''
  if (rawArgs) {
    try {
      input = JSON.parse(rawArgs)
    } catch {
      input = { raw: rawArgs }
    }
  }
  return {
    type: 'tool_use',
    id: String(toolCall.id ?? `toolu_${index}`),
    name: String(fn.name ?? 'tool'),
    input,
  }
}

/** Convert OpenAI chat.completion (or native Anthropic message) → Anthropic Messages shape. */
function toAnthropicMessageResponse(
  data: Record<string, unknown>,
  publicModelId: string,
  billed: { inputTokens: number; outputTokens: number },
) {
  if (data.type === 'message' || (data.role === 'assistant' && Array.isArray(data.content))) {
    return {
      ...data,
      type: 'message',
      role: data.role ?? 'assistant',
      model: publicModelId,
      usage: {
        input_tokens: billed.inputTokens,
        output_tokens: billed.outputTokens,
        ...((data.usage && typeof data.usage === 'object' ? data.usage : {}) as object),
      },
    }
  }

  const text = openAiChoiceText(data)
  const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : []
  const finish = choices[0]?.finish_reason
  const toolCalls = openAiToolCalls(data)
  const content: Array<Record<string, unknown>> = []
  if (text) content.push({ type: 'text', text })
  toolCalls.forEach((tc, index) => content.push(openAiToolCallToAnthropicContent(tc, index)))

  const id =
    typeof data.id === 'string'
      ? data.id.startsWith('msg_')
        ? data.id
        : `msg_${data.id.replace(/^chatcmpl-/, '')}`
      : `msg_${Date.now()}`

  return {
    id,
    type: 'message',
    role: 'assistant',
    model: publicModelId,
    content,
    stop_reason: mapOpenAiFinishToAnthropic(finish),
    stop_sequence: null,
    usage: {
      input_tokens: billed.inputTokens,
      output_tokens: billed.outputTokens,
    },
  }
}

function isUpstreamTransient(status: number, message: string) {
  if (isRetryableStatus(status) || status === 503) return true
  const lower = message.toLowerCase()
  return (
    lower.includes('temporarily unavailable') ||
    lower.includes('try another model') ||
    lower.includes('overloaded') ||
    lower.includes('capacity') ||
    lower.includes('retry in')
  )
}

function enforceGatewayRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthOk,
  sendError: (status: number, message: string, type?: string) => unknown,
  opts: { keyLimit: number; keyWindowMs: number; scope: string; isPaidModel?: boolean },
) {
  // Model RPM is per account. Extra keys and egress IPs do not multiply it.
  // Every catalog model uses the account's purchased RPM plan (free by default).
  const accountRpm = getAccountRpm(auth.user.id)
  const tierRpm = accountRpm.rpm
  const isPaid = Boolean(opts.isPaidModel)
  const accountLimit = opts.scope === 'v1'
  const limit = accountLimit ? tierRpm : opts.keyLimit
  const bucketScope = accountLimit ? (isPaid ? 'v1-paid' : 'v1-free') : opts.scope
  const rateResult = consumeRateLimit(
    rateLimitKey([bucketScope, 'account', auth.user.id]),
    limit,
    opts.keyWindowMs,
  )
  if (!rateResult.ok) {
    setRateLimitHeaders(reply, {
      limit,
      remaining: 0,
      resetAt: rateResult.resetAt,
      retryAfterSec: rateResult.retryAfterSec,
    })
    return sendError(
      429,
      `Rate limit exceeded. Max ${limit} requests per minute for this account. Retry in ${rateResult.retryAfterSec}s.`,
      'rate_limit_error',
    )
  }

  setRateLimitHeaders(reply, {
    limit,
    remaining: rateResult.remaining,
    resetAt: rateResult.resetAt,
  })
  return null
}

async function proxyModelRequest(input: {
  request: FastifyRequest
  reply: FastifyReply
  path: 'chat/completions' | 'messages' | 'responses'
  errorStyle: 'openai' | 'anthropic'
  playground?: boolean
}) {
  const { request, reply, path, errorStyle, playground } = input
  const started = Date.now()
  const sendError = (status: number, message: string, type?: string) =>
    errorStyle === 'anthropic'
      ? sendAnthropicError(reply, status, message, type)
      : sendOpenAiError(reply, status, message, type)

  const auth = playground ? playgroundSessionUser(request) ?? { error: 'Sign in required', status: 401 } : authenticateApiKey(request)
  if (isAuthFailure(auth)) {
        return sendError(
      auth.status,
      auth.error,
      auth.status === 402 ? 'billing_error' : 'authentication_error',
    )
  }

  const body = (request.body ?? {}) as Record<string, unknown>
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(400, 'Invalid request body, expected a JSON object', 'invalid_request_error')
  }
  if (playground) stripPlaygroundTools(body)
  const publicModelId = typeof body.model === 'string' ? body.model.trim() : ''
  if (!publicModelId) {
    return sendError(400, 'model is required')
  }

  if (path === 'chat/completions' && (body.messages == null || !Array.isArray(body.messages))) {
    return sendError(400, 'messages is required and must be an array', 'invalid_request_error')
  }
  if (path === 'messages' && (body.messages == null || !Array.isArray(body.messages))) {
    return sendError(400, 'messages is required and must be an array', 'invalid_request_error')
  }
  if (path === 'responses' && body.input == null && body.instructions == null) {
    return sendError(400, 'input is required', 'invalid_request_error')
  }

  const model = resolveModel(publicModelId)
  if (!model || model.status !== 'active') {
        return sendError(404, `Model '${publicModelId}' not found`, 'not_found_error')
  }

  if (!playground && isTemporarilyRestrictedModelForKey(hashApiKey(extractApiSecret(request) ?? ''), publicModelId)) {
    return sendError(503, 'Model is temporarily unavailable. Please try another model.', 'api_error')
  }

  const freeModel = model.provider.trim().toLowerCase() === 'free'
  const limited = enforceGatewayRateLimit(request, reply, auth, sendError, {
    keyLimit: RL.gatewayKey.limit,
    keyWindowMs: RL.gatewayKey.windowMs,
    scope: 'v1',
    isPaidModel: !freeModel,
  })
  if (limited) return limited
  const upstreamModelId = (model.upstream_id?.trim() || model.id).trim()
  if (
    isDecisionModelId(upstreamModelId) ||
    isDecisionModelId(publicModelId) ||
    model.provider.trim().toLowerCase() === 'jev group'
  ) {
    const msg = `Model '${publicModelId}' is a Jev Group Decision model and cannot be called on /v1/${path}. Please use POST /v1/decisions instead (docs: /docs/models/decisions).`
    return sendError(400, msg, 'invalid_request_error')
  }
  const outputLimitError = validateModelOutputLimits(body, [publicModelId, upstreamModelId])
  if (outputLimitError) return sendError(400, outputLimitError, 'invalid_request_error')
  const inputLimitError = validateModelInputLimits(body, [publicModelId, upstreamModelId])
  if (inputLimitError) return sendError(400, inputLimitError, 'invalid_request_error')

  // Free models are metered by daily allowance / subscription, not by balance.
  if (freeModel) {
    const access = getFreeTierAccess(auth.user.id)
    if (!access.allowed) {
      const message = freeTierExhaustedMessage(access)
            if (path === 'messages') {
        return reply.code(402).send({
          type: 'error',
          error: { type: 'billing_error', message },
        })
      }
      return sendError(402, message, 'billing_error')
    }
  }

  if (!freeModel && auth.user.balance_tokens <= 0) {
    return sendError(402, 'Insufficient balance', 'billing_error')
  }
  if (
    !freeModel &&
    auth.key.spend_limit_tokens !== null &&
    auth.key.spent_tokens + (auth.key.reserved_tokens || 0) >= auth.key.spend_limit_tokens
  ) {
        return sendError(402, 'API key spend limit reached', 'billing_error')
  }

  const configuredUpstream: GatewayUpstream = isGatewayUpstream(model.upstream_provider)
    ? model.upstream_provider
    : 'apinex'
  const fallbacks = upstreamFallbacksFor(publicModelId, model.id)

  const stream = Boolean(body.stream)
  const freeTier = isFreeTierModelId(publicModelId) || isFreeTierModelId(model.id)

  type UpstreamStage = {
    provider: GatewayUpstream
    upstreamModelId: string
    payload: Record<string, unknown>
    /** The endpoint actually called upstream — may differ from the caller's path. */
    upstreamPath: 'chat/completions' | 'responses'
    /** True when a Responses request is served by a chat-only upstream. */
    emulateResponses: boolean
    attempts: Array<{ secret: string; proxyIndex: number | null; baseUrl: string }>
  }

  const buildStage = (
    provider: GatewayUpstream,
    stageModelId: string,
    retryPasses: number,
  ): UpstreamStage | null => {
    const targets = selectProviderTargets(provider)
    if (targets.length === 0) return null
    const baseUrls = baseUrlsForUpstream(provider)
    // keeps a Codex-style caller on its free primary instead of failing every
    // request into a paid fallback.
    const emulateResponses = path === 'responses' && !upstreamSupportsResponses(provider)
    const upstreamPath: 'chat/completions' | 'responses' =
      path === 'responses' && !emulateResponses ? 'responses' : 'chat/completions'
    const payload = emulateResponses
      ? buildUpstreamPayload(responsesRequestToChat(body), stageModelId, 'chat/completions', {
          freeTier,
          publicModelId,
        })
      : buildUpstreamPayload(body, stageModelId, path, {
          freeTier,
          publicModelId,
        })
    normalizeModelOutputLimits(payload, [publicModelId, stageModelId], upstreamPath)
    applyUpstreamPayloadQuirks(payload, provider)
    // Every provider key with an assigned proxy uses its proxy dispatcher.
    const attempts =
      Array.from(
            { length: Math.max(targets.length * retryPasses, retryPasses) },
            (_, index) => ({
              ...targets[index % targets.length],
              baseUrl: baseUrls[index % baseUrls.length],
              proxyIndex: targets[index % targets.length].proxyIndex ?? null,
            }),
          )
    return { provider, upstreamModelId: stageModelId, payload, upstreamPath, emulateResponses, attempts }
  }

  const stages: UpstreamStage[] = []
  // With a fallback chain the primary upstream gets a single pass per key so a
  // rate-limited provider hands over quickly instead of stalling the caller.
  const primaryPasses = fallbacks.length > 0 ? 1 : 3
  const primary = buildStage(configuredUpstream, upstreamModelId, primaryPasses)
  if (primary) stages.push(primary)
  for (const fallback of fallbacks) {
    // Same-provider fallbacks still build a stage: a different upstream model id
    // on the same provider is a meaningful retry (e.g. primary wb-* model times
    // out on the pool, but AGY-* sibling answers). Only skip an exact duplicate
    // of the primary stage (same provider AND same upstream model).
    if (fallback.provider === configuredUpstream && fallback.upstreamModelId === upstreamModelId) continue
    const stage = buildStage(fallback.provider, fallback.upstreamModelId, 2)
    if (stage) stages.push(stage)
  }

  if (stages.length === 0) {
        return sendError(503, 'Service temporarily unavailable', 'api_error')
  }

  const rates = modelRates(model)
  if (!freeModel && !modelHasPrice(rates)) {
    return sendError(503, 'This model has no price configured yet', 'api_error')
  }
  const promoPlan = promoBillingPlan(auth.user.id, model.id, rates.inputDollarsPer1M, rates.outputDollarsPer1M)
  if ('block' in promoPlan && promoPlan.block) {
    return sendError(409, promoPlan.block, 'promo_event')
  }

  const rawReservation = estimateModelReservationTokens(body, freeModel ? freeAllowanceWeight(auth.user.id, model) : 1)
  const reservationEstimate = freeModel
    ? rawReservation
    : {
        ...rawReservation,
        costTokens: Math.max(
          1,
          Math.ceil(
            chargeUsdMicros(
              rawReservation.inputTokens,
              rawReservation.outputTokens,
              rates.inputDollarsPer1M,
              rates.outputDollarsPer1M,
            ) * 1.08,
          ),
        ),
      }
  const clientAbortController = new AbortController()
  const onClientClose = () => {
    if (!reply.raw.writableEnded) {
      clientAbortController.abort()
    }
  }
  request.raw.on('close', onClientClose)
  reply.raw.on('close', onClientClose)

  const reservation = tryReserveTokens({
    userId: auth.user.id,
    apiKeyId: auth.key.id,
    amount: freeModel
      ? 0
      : promoPlan.discountPct > 0
        ? discountedTokenCost(reservationEstimate.costTokens, promoPlan.discountPct)
        : reservationEstimate.costTokens,
    modelId: model.id,
    path: `/v1/${path}`,
    allowRestrictedCredits: true,
    signal: clientAbortController.signal,
    freeModel,
    estimatedFreeTokens: freeModel ? reservationEstimate.costTokens : undefined,
  })
  if (!reservation.ok) {
    request.raw.off('close', onClientClose)
    reply.raw.off('close', onClientClose)
    return sendError(reservation.status, reservation.error, 'billing_error')
  }

  let reservationSettled = false
  try {
    // Fairness dispatch: when the queue is active (upstream saturation),
    // subscribers and paid requests skip ahead of free users. Once the slot is granted, the request
    // owns it until completion — a queued request is never preempted.
    const accountRpm = getAccountRpm(auth.user.id)
    const dispatch = await acquireDispatchSlot(auth.user.id, {
      priority: accountRpm.source !== 'free' || !freeModel,
    })
    if (dispatch.timedOut) {
      releaseReservation(reservation.reservationId)
      releaseDispatchSlot()
      const retryAfterSec = 5
      setRateLimitHeaders(reply, { limit: 0, remaining: 0, resetAt: Date.now() + retryAfterSec * 1000, retryAfterSec })
      return sendError(
        429,
        'The model is currently busy. Your request was queued behind other users and timed out. Please retry shortly.',
        'rate_limit_error',
      )
    }

    const attemptPlan = stages.flatMap((stage) =>
      stage.attempts.map((attemptTarget) => ({ ...attemptTarget, stage })),
    )

    try {
      const maxAttempts = attemptPlan.length
      let lastError = 'Upstream request failed'
      let lastStatus = 502
      let attempt = 0
      let outputLimitRetried = false
      let reasoningExhaustionRetried = false
      const lastFailureByProvider = new Map<GatewayUpstream, { status: number; error: string }>()
      /**
       * Retry budget. This bounds only the search for a usable upstream: once a
       * response is accepted the loop exits, so a long SSE body is never affected.
       * Without it a stalled provider could burn every key at 60s each and make the
       * caller wait ten minutes for a failure.
       */
      const stageDeadlines = new Map<UpstreamStage, number>()
      const retryBudgetExhausted = (stage: UpstreamStage) => {
        const deadline = stageDeadlines.get(stage)
        if (deadline == null) {
          // First attempt of a stage always runs, however little time is left.
          stageDeadlines.set(stage, Date.now() + STAGE_RETRY_BUDGET_MS)
          return false
        }
        return Date.now() > deadline || Date.now() - started > TOTAL_RETRY_BUDGET_MS
      }

      while (attempt < maxAttempts) {
        const currentAttempt = attemptPlan[attempt]
        const providerSecret = currentAttempt.secret
        const stage = currentAttempt.stage
        const payload = stage.payload
        attempt += 1

        const recordStageFailure = (status: number, error: string) => {
          lastStatus = status
          lastError = error
          lastFailureByProvider.set(stage.provider, { status, error })
        }

        /** Skip the remaining attempts of the current upstream and move to the next one. */
        const advanceToNextStage = () => {
          while (attempt < maxAttempts && attemptPlan[attempt].stage === stage) attempt += 1
          return attempt < maxAttempts
        }

        const hasLaterStage = stages.indexOf(stage) < stages.length - 1

        // Stop hammering a stage that has already spent its budget; hand over to the
        // fallback (which still gets its own first attempt) or fail fast.
        if (retryBudgetExhausted(stage)) {
          if (advanceToNextStage()) continue
          break
        }

        try {
          const upstream = await upstreamPost(
            currentAttempt.baseUrl,
            stage.upstreamPath,
            providerSecret,
            payload,
            dispatcherForProxyIndex(currentAttempt.proxyIndex),
            undefined,
            hasLaterStage,
            stage.provider,
            clientAbortController.signal,
          )

          if (!upstream.ok) {
            const errorBody = (await upstream.json().catch(() => ({}))) as Record<string, unknown>
            recordStageFailure(upstream.status, extractErrorMessage(errorBody, upstream.status))

            if (
              !outputLimitRetried &&
              attempt < maxAttempts &&
              isOutputLimitCompatibilityError(upstream.status, lastError) &&
              removeOutputLimitsForFreeRetry(payload, freeModel)
            ) {
              outputLimitRetried = true
              continue
            }

            if (upstream.status === 401 || upstream.status === 402 || upstream.status === 403) {
              markProviderSecretFailed(providerSecret, lastError, upstream.status)
              // Do not retry another endpoint with a permanently failed key.
              while (attempt < maxAttempts && attemptPlan[attempt].secret === providerSecret) attempt += 1
            }

            const canRotate =
              attempt < maxAttempts &&
              (isUpstreamTransient(upstream.status, lastError) ||
                // A backend-variant 400 is worth one more key on the same provider
                // before handing a free request to a paid fallback.
                (attemptPlan[attempt]?.stage === stage &&
                  isProviderVariantRetryableError(stage.provider, upstream.status, lastError)) ||
                upstream.status === 401 ||
                upstream.status === 402 ||
                upstream.status === 403)
            if (canRotate) {
              // Longer backoff when upstream asks "Retry in Ns". A fallback upstream is
              // tried immediately: waiting on a rate-limited provider helps nobody.
              const nextIsSameStage = attemptPlan[attempt]?.stage === stage
              if (nextIsSameStage) {
                const retryMatch = lastError.match(/retry in\s+(\d+)/i)
                const hinted = retryMatch ? Number(retryMatch[1]) * 1000 : 0
                const waitMs = Math.min(Math.max(hinted || 350 * attempt, 250), 4000)
                await sleep(waitMs)
              }
              continue
            }

            // If upstream failed with 400 because of an invalid client request
            // Return the client error directly to save paid fallback balance.
            const isClientInvalidParamError =
              upstream.status === 400 &&
              (lastError.includes('不支持关闭思考') || lastError.includes('始终思考'))

            // A definitive upstream failure (for example a model id the primary no
            // longer serves) still fails over when another upstream is configured.
            if (!isClientInvalidParamError && advanceToNextStage()) continue

            recordUsage({
              userId: auth.user.id,
              apiKeyId: auth.key.id,
              modelId: model.id,
              provider: model.provider,
              inputTokens: 0,
              outputTokens: 0,
              costTokens: 0,
              latencyMs: Date.now() - started,
              status: 'error',
              reservationId: reservation.reservationId,
            })
            const responseStatus =
              publicModelId === 'free/gpt-6-astra' ||
              upstream.status === 401 ||
              upstream.status === 402 ||
              upstream.status === 403
                ? 503
                : upstream.status >= 400 && upstream.status < 600
                  ? upstream.status
                  : 502
            const publicError = publicModelId === 'free/gpt-6-astra'
              ? 'Model temporarily unavailable'
              : clientSafeUpstreamError(responseStatus, lastError)
            return sendError(responseStatus, publicError, 'api_error')
          }

          if (stream) {
            // If the upstream yielded 200 OK headers but has not sent any body chunks
            // within the timeout window, and we have fallbacks available, advance to next key/provider!
            const firstChunkTimeoutMs = UPSTREAM_STREAM_FIRST_CHUNK_TIMEOUT_MS
            if (stages.indexOf(stage) < stages.length - 1 && upstream.body) {
              const reader = upstream.body.getReader()
              const firstChunkPromise = reader.read()
              const timerPromise = new Promise<{ timeout: true }>((resolve) =>
                setTimeout(() => resolve({ timeout: true }), firstChunkTimeoutMs),
              )
              const raceResult = await Promise.race([firstChunkPromise, timerPromise])
              if ('timeout' in raceResult && raceResult.timeout) {
                void reader.cancel().catch(() => undefined)
                recordStageFailure(502, `Upstream timed out after ${firstChunkTimeoutMs / 1000}s without sending chunks`)
                if (advanceToNextStage()) continue
              } else {
                const firstRead = raceResult as { done: boolean; value?: Uint8Array }
                reservationSettled = true
                return await pipeStreamingCompletion({
                  reply,
                  upstream,
                  auth,
                  model,
                  publicModelId,
                  body,
                  started,
                  reservationId: reservation.reservationId,
                  playground,
                  responseStyle:
                    path === 'messages'
                      ? 'anthropic'
                      : stage.emulateResponses
                        ? 'responses-emulated'
                        : path === 'responses'
                          ? 'responses-native'
                          : 'openai',
                  initialChunk: firstRead.value ?? undefined,
                  initialDone: firstRead.done,
                  existingReader: reader,
                })
              }
            }

            reservationSettled = true
            return await pipeStreamingCompletion({
              reply,
              upstream,
              auth,
              model,
              publicModelId,
              body,
              started,
              reservationId: reservation.reservationId,
              playground,
              responseStyle:
                path === 'messages'
                  ? 'anthropic'
                  : stage.emulateResponses
                    ? 'responses-emulated'
                    : path === 'responses'
                      ? 'responses-native'
                      : 'openai',
            })
          }

          const data = (await upstream.json()) as Record<string, unknown>
          stripUpstreamVendorFields(data)
          if (
            !reasoningExhaustionRetried &&
            isReasoningExhaustedResponse(data) &&
            raiseReasoningOutputLimit(payload)
          ) {
            reasoningExhaustionRetried = true
            // Do not record/bill a zero-content response and do not advance to fallback.
            attempt -= 1
            continue
          }
          const billed = resolveBillableUsage({
            body,
            data,
            parsed: parseUsage(data),
            rates,
            freeModel,
          })

          recordUsage({
            userId: auth.user.id,
            apiKeyId: auth.key.id,
            allowanceWeight: freeModel ? freeAllowanceWeight(auth.user.id, model) : 0,
            modelId: model.id,
            provider: model.provider,
            inputTokens: billed.inputTokens,
            outputTokens: billed.outputTokens,
            costTokens: billed.costTokens,
            latencyMs: Date.now() - started,
            status: 'ok',
            reservationId: reservation.reservationId,
          })
          reservationSettled = true

          if (freeModel && data.choices && Array.isArray(data.choices)) {
            for (const choice of data.choices as Array<Record<string, unknown>>) {
              const msg = choice.message as Record<string, unknown> | undefined
              // Free tier hides the model's chain-of-thought entirely: drop every
              // reasoning field the upstream attached (reasoning, reasoning_content,
              // reasoning_details, thinking, thinking_signature) so callers never
              // see internal thinking.
              if (msg) {
                delete msg.reasoning
                delete msg.reasoning_content
                delete msg.reasoning_details
                delete msg.thinking
                delete msg.thinking_signature
              }
            }
          }

          if (path === 'messages') {
            return toAnthropicMessageResponse(data, publicModelId, billed)
          }

          // A chat-only upstream served a Responses request: hand the caller the
          // Responses shape it expects.
          if (stage.emulateResponses) {
            return chatResponseToResponses(data, publicModelId, billed)
          }

          delete (data as Record<string, unknown>)._manifest

          const usage = publicUsage(data.usage, billed.costTokens, {
            inputTokens: billed.inputTokens,
            outputTokens: billed.outputTokens,
          })
          return {
            ...data,
            usage,
            model: publicModelId,
            ...(playground
              ? {
                  usageMeta: {
                    free: freeModel,
                    costTokens: freeModel
                      ? chargeTokens(billed.inputTokens, billed.outputTokens, freeAllowanceWeight(auth.user.id, model))
                      : billed.costTokens,
                    chargedUsd: freeModel ? null : usdFromTokens(billed.costTokens),
                    latencyMs: Date.now() - started,
                  },
                }
              : {}),
          }
        } catch (reason) {
          const failure = upstreamFailureMessage(reason, payload, hasLaterStage, stage.provider)
          recordStageFailure(502, failure)
          const timedOut =
            reason instanceof DOMException &&
            (reason.name === 'TimeoutError' || reason.name === 'AbortError')

          // A header timeout is a stall, not a bad key. When another provider is
          // already queued, skip the rest of this stage so the caller is not billed
          // another full timeout on the same pool.
          if (timedOut && hasLaterStage && advanceToNextStage()) continue
          if (attempt < maxAttempts) {
            await sleep(300 * Math.min(attempt, 3))
            continue
          }
        }
      }

      recordUsage({
        userId: auth.user.id,
        apiKeyId: auth.key.id,
        modelId: model.id,
        provider: model.provider,
        inputTokens: 0,
        outputTokens: 0,
        costTokens: 0,
        latencyMs: Date.now() - started,
        status: 'error',
        reservationId: reservation.reservationId,
      })

      const finalStatus =
        publicModelId === 'free/gpt-6-astra' || lastStatus === 401 || lastStatus === 402 || lastStatus === 403
          ? 503
          : lastStatus >= 400 && lastStatus < 600
            ? lastStatus
            : 502
      const publicError =
        publicModelId === 'free/gpt-6-astra'
          ? 'Model temporarily unavailable'
          : clientSafeUpstreamError(finalStatus, lastError)
      return sendError(finalStatus, publicError, 'api_error')
    } finally {
      releaseDispatchSlot()
    }
  } finally {
    request.raw.off('close', onClientClose)
    reply.raw.off('close', onClientClose)
    if (!reservationSettled) {
      try {
        releaseReservation(reservation.reservationId)
      } catch {
        /* ignore */
      }
    }
  }
}

function roundUsdFromTokens(tokens: number) {
  const usd = usdFromTokens(Math.max(0, Math.round(Number(tokens) || 0)))
  return Math.round(usd * 1e8) / 1e8
}

/** Prepaid USD wallet, in-flight holds, and calling API key spend limits. */
function balancePayload(auth: AuthOk) {
  const walletReserved = getOpenReservedTokensForUser(auth.user.id)
  const keyReserved = getOpenReservedTokensForKey(auth.key.id)
  const spendLimit = auth.key.spend_limit_tokens
  const spent = Math.max(0, auth.key.spent_tokens)
  const remainingTokens =
    spendLimit === null ? null : Math.max(0, spendLimit - spent - keyReserved)

  return {
    object: 'balance',
    balance_usd: roundUsdFromTokens(auth.user.balance_tokens),
    reserved_usd: roundUsdFromTokens(walletReserved),
    api_key: {
      id: auth.key.id,
      spend_limit_usd: spendLimit === null ? null : roundUsdFromTokens(spendLimit),
      spent_usd: roundUsdFromTokens(spent),
      reserved_usd: roundUsdFromTokens(keyReserved),
      remaining_usd: remainingTokens === null ? null : roundUsdFromTokens(remainingTokens),
      limit_reached: spendLimit !== null && spent + keyReserved >= spendLimit,
    },
  }
}

/** Active subscription or daily free-model token allowance for the calling account. */
function subscriptionPayload(auth: AuthOk) {
  const access = getFreeTierAccess(auth.user.id)
  const plan = access.planKey
  const normalizedPlan =
    plan === 'day1'
      ? '3_days'
      : plan === 'day7'
        ? '10_days'
        : plan === 'day14'
          ? '20_days'
          : plan === 'day30'
            ? '30_days'
            : plan
  return {
    object: 'subscription',
    mode: access.mode,
    active: access.mode === 'subscription',
    plan: normalizedPlan,
    plan_label: access.planLabel,
    unlimited: access.unlimited,
    token_limit: access.limit,
    tokens_used: access.used,
    tokens_remaining: access.remaining,
    expires_at_utc: access.expiresAt ? new Date(access.expiresAt).toISOString() : null,
    resets_at_utc: access.resetsAt ? new Date(access.resetsAt).toISOString() : null,
    allowed: access.allowed,
  }
}

/** Active requests-per-minute (RPM) rate limit and plan for the calling account. */
function rpmPayload(auth: AuthOk) {
  const rpmInfo = getAccountRpm(auth.user.id)
  return {
    object: 'rpm',
    rpm: rpmInfo.rpm,
    plan: rpmInfo.planKey,
    label: rpmInfo.label,
    source: rpmInfo.source,
    expires_at_utc: rpmInfo.expiresAt ? new Date(rpmInfo.expiresAt).toISOString() : null,
  }
}

export async function registerGatewayRoutes(app: FastifyInstance) {
  app.get('/v1/balance', async (request, reply) => {
    const auth = authenticateApiKey(request)
    if (isAuthFailure(auth)) return sendOpenAiError(reply, auth.status, auth.error, 'authentication_error')
    return balancePayload(auth)
  })

  app.get('/v1/subscription', async (request, reply) => {
    const auth = authenticateApiKey(request)
    if (isAuthFailure(auth)) return sendOpenAiError(reply, auth.status, auth.error, 'authentication_error')
    return subscriptionPayload(auth)
  })

  app.get('/v1/rpm', async (request, reply) => {
    const auth = authenticateApiKey(request)
    if (isAuthFailure(auth)) return sendOpenAiError(reply, auth.status, auth.error, 'authentication_error')
    return rpmPayload(auth)
  })

  app.get('/v1/models', async (request, reply) => {
    const auth = authenticateApiKey(request)
    if (isAuthFailure(auth)) return sendOpenAiError(reply, auth.status, auth.error, 'authentication_error')

    const limited = enforceGatewayRateLimit(
      request,
      reply,
      auth,
      (status, message, type) => sendOpenAiError(reply, status, message, type),
      {
        keyLimit: RL.modelsKey.limit,
        keyWindowMs: RL.modelsKey.windowMs,
        scope: 'v1-models',
      },
    )
    if (limited) return limited

    const rows = db
      .prepare(
        `SELECT id, name, created_at FROM model_catalog WHERE status = 'active' ORDER BY provider, name`,
      )
      .all() as Array<{ id: string; name: string; created_at: string }>

    return {
      object: 'list',
      data: rows.map((row) => ({
        id: row.id,
        object: 'model',
        created: Math.floor(new Date(row.created_at).getTime() / 1000),
        owned_by: siteName().toLowerCase(),
      })),
    }
  })

  const GATEWAY_ROUTE_OPTIONS = {
    bodyLimit: 20 * 1024 * 1024,
  }

  app.post('/v1/chat/completions', GATEWAY_ROUTE_OPTIONS, async (request, reply) =>
    proxyModelRequest({ request, reply, path: 'chat/completions', errorStyle: 'openai' }),
  )

  app.post('/v1/chat/completions/playground', GATEWAY_ROUTE_OPTIONS, async (request, reply) =>
    proxyModelRequest({ request, reply, path: 'chat/completions', errorStyle: 'openai', playground: true }),
  )

  // Claude Code / Anthropic-compatible clients
  app.post('/v1/messages', GATEWAY_ROUTE_OPTIONS, async (request, reply) =>
    proxyModelRequest({ request, reply, path: 'messages', errorStyle: 'anthropic' }),
  )

  // Codex (wire_api = "responses") and OpenAI Responses API clients
  app.post('/v1/responses', GATEWAY_ROUTE_OPTIONS, async (request, reply) =>
    proxyModelRequest({ request, reply, path: 'responses', errorStyle: 'openai' }),
  )

  // Jev Group Decisions API (TypeSafe / SubQ / OpenAI Decisions shapes)
  app.post('/v1/decisions', GATEWAY_ROUTE_OPTIONS, async (request, reply) =>
    proxyDecisionRequest({ request, reply }),
  )

  app.post('/v1/decisions/playground', GATEWAY_ROUTE_OPTIONS, async (request, reply) =>
    proxyDecisionRequest({ request, reply, playground: true }),
  )
}

export function isDecisionModelId(modelId: string | null | undefined): boolean {
  const id = String(modelId ?? '').trim().toLowerCase()
  return (
    id.includes('subq-snap') ||
    id.startsWith('subq/') ||
    id.includes('jev-1.') ||
    id.startsWith('jev-') ||
    id.startsWith('free/jev') ||
    id.includes('drex-') ||
    id.startsWith('free/drex') ||
    id.startsWith('free/subq') ||
    id.startsWith('nace/') ||
    id.startsWith('typesafe/') ||
    id.includes('luna-decision') ||
    id.startsWith('decision/') ||
    id.startsWith('decisions/')
  )
}

const BUILTIN_DECISION_MODELS: Record<
  string,
  { upstreamId: string; name: string; provider: string; inputPriceMicros: number; outputPriceMicros: number }
> = {
  'subq/subq-snap-preview': {
    upstreamId: 'subq-snap-preview',
    name: 'SubQ Snap (Preview)',
    provider: 'Jev Group',
    inputPriceMicros: 50_000,
    outputPriceMicros: 0,
  },
  'subq-snap-preview': {
    upstreamId: 'subq-snap-preview',
    name: 'SubQ Snap (Preview)',
    provider: 'Jev Group',
    inputPriceMicros: 50_000,
    outputPriceMicros: 0,
  },
  'typesafe/jev-1.13': {
    upstreamId: 'jev-1.13',
    name: 'Jev 1.13',
    provider: 'Jev Group',
    inputPriceMicros: 42_000,
    outputPriceMicros: 0,
  },
  'jev-1.13': {
    upstreamId: 'jev-1.13',
    name: 'Jev 1.13',
    provider: 'Jev Group',
    inputPriceMicros: 42_000,
    outputPriceMicros: 0,
  },
  'free/jev-1.13': {
    upstreamId: 'free/jev-1.13',
    name: 'Jev 1.13',
    provider: 'Free',
    inputPriceMicros: 0,
    outputPriceMicros: 0,
  },
  'drex-v2.0': {
    upstreamId: 'drex-v2.0',
    name: 'Drex 2.0',
    provider: 'Jev Group',
    inputPriceMicros: 40_000,
    outputPriceMicros: 0,
  },
  'drex-latest': {
    upstreamId: 'drex-v2.0',
    name: 'Drex 2.0',
    provider: 'Jev Group',
    inputPriceMicros: 40_000,
    outputPriceMicros: 0,
  },
  'drex-v1.5': {
    upstreamId: 'drex-v1.5',
    name: 'Drex 1.5',
    provider: 'Jev Group',
    inputPriceMicros: 40_000,
    outputPriceMicros: 0,
  },
  'drex-v1.0': {
    upstreamId: 'drex-v1.0',
    name: 'Drex 1.0',
    provider: 'Jev Group',
    inputPriceMicros: 40_000,
    outputPriceMicros: 0,
  },
  'gpt-6-luna-decisions': {
    upstreamId: 'gpt-6-luna-decisions',
    name: 'GPT-6 Luna (Decisions)',
    provider: 'Jev Group',
    inputPriceMicros: 100_000,
    outputPriceMicros: 0,
  },
}

function resolveDecisionModel(publicId: string): ModelRow | undefined {
  const catalogModel = resolveModel(publicId)
  if (catalogModel && catalogModel.status === 'active') {
    return catalogModel
  }

  const normalized = publicId.trim().toLowerCase()
  const builtin = BUILTIN_DECISION_MODELS[normalized]
  if (!builtin) return undefined

  return {
    id: publicId.trim(),
    upstream_id: builtin.upstreamId,
    provider: builtin.provider,
    name: builtin.name,
    token_weight: 1,
    input_price_micros: builtin.inputPriceMicros,
    output_price_micros: builtin.outputPriceMicros,
    upstream_provider: 'apinex',
    status: 'active',
  }
}

function normalizeOpenAiDecisionQuestions(questions: unknown[]): unknown[] {
  if (!Array.isArray(questions)) return []
  return questions
    .filter((q): q is Record<string, unknown> => Boolean(q && typeof q === 'object'))
    .map((q) => {
      const row = { ...q }
      if (row.type === 'score' && Array.isArray(row.levels)) {
        row.levels = row.levels
          .filter((lvl): lvl is Record<string, unknown> => Boolean(lvl && typeof lvl === 'object'))
          .map((lvl) => {
            const lRow = { ...lvl }
            if (!('label' in lRow) && 'value' in lRow) {
              lRow.label = String(lRow.value)
              delete lRow.value
            }
            return lRow
          })
      }
      return row
    })
}

function normalizeTypeSafeDecisionQuestions(
  rawObj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, rawVal] of Object.entries(rawObj)) {
    if (!rawVal || typeof rawVal !== 'object' || Array.isArray(rawVal)) continue
    const q = rawVal as Record<string, unknown>
    const rawType = String(q.type ?? 'noul').toLowerCase()
    const instructions = String(q.instructions ?? q.question ?? `Evaluate ${key}`)
    if (rawType === 'noul' || rawType === 'predicate' || rawType === 'binary') {
      out[key] = { type: 'noul', instructions }
    } else if (rawType === 'choice') {
      const criteria: Record<string, string> = {}
      const rawCriteria = q.criteria ?? q.options ?? q.choices
      if (Array.isArray(rawCriteria)) {
        for (const item of rawCriteria) {
          if (typeof item === 'string' && item.trim()) {
            criteria[item.trim()] = item.trim()
          } else if (item && typeof item === 'object') {
            const row = item as Record<string, unknown>
            const val = String(row.value ?? row.name ?? row.label ?? '').trim()
            if (val) criteria[val] = String(row.description ?? row.label ?? val)
          }
        }
      } else if (rawCriteria && typeof rawCriteria === 'object') {
        for (const [k, v] of Object.entries(rawCriteria as Record<string, unknown>)) {
          if (k.trim()) criteria[k.trim()] = String(v ?? k)
        }
      }
      out[key] = { type: 'choice', instructions, criteria }
    } else if (rawType === 'score') {
      const rawScale = q.criteria ?? q.scale ?? q.levels ?? q.options
      const criteria: string[] = []
      if (Array.isArray(rawScale)) {
        for (const item of rawScale) {
          if (typeof item === 'string' && item.trim()) {
            criteria.push(item.trim())
          } else if (item && typeof item === 'object') {
            const row = item as Record<string, unknown>
            const label = String(row.label ?? row.name ?? row.value ?? '').trim()
            if (label) criteria.push(label)
          }
        }
      } else if (rawScale && typeof rawScale === 'object') {
        for (const k of Object.keys(rawScale as Record<string, unknown>)) {
          if (k.trim()) criteria.push(k.trim())
        }
      }
      out[key] = {
        type: 'score',
        instructions,
        criteria: criteria.length >= 2 ? criteria : ['low', 'medium', 'high'],
      }
    } else {
      out[key] = q
    }
  }
  return out
}

export function buildDecisionPayload(
  body: Record<string, unknown>,
  upstreamModelId: string,
): Record<string, unknown> {
  // 1. Native OpenAI Decisions API shape: { model, input, questions: [...] }
  if ('input' in body && Array.isArray(body.questions)) {
    const payload: Record<string, unknown> = {
      model: upstreamModelId,
      input: body.input,
      questions: normalizeOpenAiDecisionQuestions(body.questions),
    }
    if (typeof body.safety_identifier === 'string' && body.safety_identifier.trim()) {
      payload.safety_identifier = body.safety_identifier.trim()
    }
    return payload
  }

  // 2. Native TypeSafe / SubQ shape: { model, state, questions: {...}, images? }
  if ('state' in body && body.questions && typeof body.questions === 'object' && !Array.isArray(body.questions)) {
    const payload: Record<string, unknown> = {
      model: upstreamModelId,
      state: body.state,
      questions: normalizeTypeSafeDecisionQuestions(body.questions as Record<string, unknown>),
    }
    if (Array.isArray(body.images) && body.images.length > 0) {
      payload.images = body.images.slice(0, 4)
    }
    return payload
  }

  // 3. Mixed: caller sent `state` with array `questions` -> convert to OpenAI shape
  if ('state' in body && Array.isArray(body.questions)) {
    return {
      model: upstreamModelId,
      input: typeof body.state === 'string' ? body.state : JSON.stringify(body.state),
      questions: normalizeOpenAiDecisionQuestions(body.questions),
    }
  }

  // 4. Mixed: caller sent `input` with object `questions` -> convert to TypeSafe shape
  if ('input' in body && body.questions && typeof body.questions === 'object' && !Array.isArray(body.questions)) {
    return {
      model: upstreamModelId,
      state: body.input,
      questions: normalizeTypeSafeDecisionQuestions(body.questions as Record<string, unknown>),
    }
  }

  // 5. Chat messages fallback (e.g. Playground)
  if (Array.isArray(body.messages)) {
    const textParts: string[] = []
    const images: Array<{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string }> = []
    for (const raw of body.messages) {
      if (!raw || typeof raw !== 'object') continue
      const msg = raw as Record<string, unknown>
      if (String(msg.role ?? 'user').trim() === 'system') continue
      const content = msg.content
      if (typeof content === 'string' && content.trim()) {
        textParts.push(content.trim())
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'string' && part.trim()) {
            textParts.push(part.trim())
          } else if (part && typeof part === 'object') {
            const p = part as Record<string, unknown>
            if (typeof p.text === 'string' && p.text.trim()) textParts.push(p.text.trim())
            const imgUrlObj = p.image_url
            const rawUrl =
              typeof imgUrlObj === 'string'
                ? imgUrlObj
                : imgUrlObj && typeof imgUrlObj === 'object'
                  ? String((imgUrlObj as { url?: unknown }).url ?? '')
                  : ''
            const match = rawUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/i)
            if (match && images.length < 4) {
              images.push({
                mediaType: match[1].toLowerCase() as 'image/png' | 'image/jpeg' | 'image/webp',
                base64: match[2],
              })
            }
          }
        }
      }
    }
    const text = textParts.join('\n\n').trim() || 'Evaluate this input.'
    if (text.startsWith('{') && text.endsWith('}')) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        if (parsed && typeof parsed === 'object' && 'questions' in parsed && ('state' in parsed || 'input' in parsed)) {
          return buildDecisionPayload(parsed, upstreamModelId)
        }
      } catch {
        /* treat as plain text */
      }
    }
    const payload: Record<string, unknown> = {
      model: upstreamModelId,
      state: text,
      questions: {
        assessment: {
          type: 'noul',
          instructions: text.length <= 400 ? text : 'Is the statement or request valid, accurate, and affirmative?',
        },
        is_safe: {
          type: 'noul',
          instructions: 'Is this content safe, benign, and policy-compliant?',
        },
        category: {
          type: 'choice',
          instructions: 'Which category best fits this content?',
          criteria: {
            coding: 'Software engineering, code, DevOps, or technical debugging',
            general: 'General knowledge, question answering, or conversation',
            analysis: 'Data analysis, classification, moderation, or reasoning',
            creative: 'Creative writing, brainstorming, or storytelling',
          },
        },
        complexity: {
          type: 'score',
          instructions: 'How complex is this content or request?',
          criteria: ['trivial', 'easy', 'moderate', 'hard', 'expert'],
        },
      },
    }
    if (images.length > 0) payload.images = images
    return payload
  }

  return {
    ...body,
    model: upstreamModelId,
  }
}

async function proxyDecisionRequest(input: {
  request: FastifyRequest
  reply: FastifyReply
  playground?: boolean
}) {
  const { request, reply, playground } = input
  const started = Date.now()
  const sendError = (status: number, message: string, type?: string) =>
    sendOpenAiError(reply, status, message, type)

  const auth = playground
    ? playgroundSessionUser(request) ?? { error: 'Sign in required', status: 401 }
    : authenticateApiKey(request)
  if (isAuthFailure(auth)) {
    return sendError(
      auth.status,
      auth.error,
      auth.status === 402 ? 'billing_error' : 'authentication_error',
    )
  }

  const body = (request.body ?? {}) as Record<string, unknown>
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendError(400, 'Invalid request body, expected a JSON object', 'invalid_request_error')
  }
  const publicModelId = typeof body.model === 'string' ? body.model.trim() : ''
  if (!publicModelId) {
    return sendError(400, 'model is required', 'invalid_request_error')
  }

  const model = resolveDecisionModel(publicModelId)
  if (!model || model.status !== 'active') {
    return sendError(404, `Model '${publicModelId}' not found`, 'not_found_error')
  }

  const upstreamModelId = (model.upstream_id?.trim() || model.id).trim()
  if (
    !isDecisionModelId(upstreamModelId) &&
    !isDecisionModelId(publicModelId) &&
    model.provider.trim().toLowerCase() !== 'jev group'
  ) {
    return sendError(
      400,
      `Model '${publicModelId}' is not a Jev Group Decision model. Use /v1/chat/completions, /v1/responses, or /v1/messages instead.`,
      'invalid_request_error',
    )
  }

  if (!('input' in body) && !('state' in body) && !('questions' in body) && !('messages' in body)) {
    return sendError(400, 'Invalid decision request: input, state, questions, or messages is required', 'invalid_request_error')
  }

  const inputLimitError = validateModelInputLimits(body, [publicModelId, upstreamModelId])
  if (inputLimitError) return sendError(400, inputLimitError, 'invalid_request_error')

  const freeModel = model.provider.trim().toLowerCase() === 'free' || model.id.startsWith('free/')
  const limited = enforceGatewayRateLimit(request, reply, auth, sendError, {
    keyLimit: RL.gatewayKey.limit,
    keyWindowMs: RL.gatewayKey.windowMs,
    scope: 'v1',
    isPaidModel: !freeModel,
  })
  if (limited) return limited

  if (freeModel) {
    const access = getFreeTierAccess(auth.user.id)
    if (!access.allowed) {
      return sendError(402, freeTierExhaustedMessage(access), 'billing_error')
    }
  } else {
    if (auth.user.balance_tokens <= 0) {
      return sendError(402, 'Insufficient balance', 'billing_error')
    }
    if (
      auth.key.spend_limit_tokens !== null &&
      auth.key.spent_tokens + (auth.key.reserved_tokens || 0) >= auth.key.spend_limit_tokens
    ) {
      return sendError(402, 'API key spend limit reached', 'billing_error')
    }
  }

  const targets = selectProviderTargets('apinex')
  if (targets.length === 0) {
    return sendError(503, 'Service temporarily unavailable', 'api_error')
  }

  const rates: ModelRates = freeModel
    ? { inputDollarsPer1M: 0, outputDollarsPer1M: 0 }
    : {
        inputDollarsPer1M: dollarsFromMicros(model.input_price_micros),
        outputDollarsPer1M: dollarsFromMicros(model.output_price_micros),
      }
  if (!freeModel && !modelHasPrice(rates)) {
    return sendError(503, 'This model has no price configured yet', 'api_error')
  }

  const promoPlan = promoBillingPlan(auth.user.id, model.id, rates.inputDollarsPer1M, rates.outputDollarsPer1M)
  if ('block' in promoPlan && promoPlan.block) {
    return sendError(409, promoPlan.block, 'promo_event')
  }

  const rawReservation = estimateModelReservationTokens(body, 1)
  const reservationEstimate = freeModel
    ? rawReservation
    : {
        ...rawReservation,
        costTokens: Math.max(
          1,
          Math.ceil(
            chargeUsdMicros(
              rawReservation.inputTokens,
              0,
              rates.inputDollarsPer1M,
              rates.outputDollarsPer1M,
            ) * 1.08,
          ),
        ),
      }
  const clientAbortController = new AbortController()
  const onClientClose = () => {
    if (!reply.raw.writableEnded) {
      clientAbortController.abort()
    }
  }
  request.raw.on('close', onClientClose)
  reply.raw.on('close', onClientClose)

  const reservation = tryReserveTokens({
    userId: auth.user.id,
    apiKeyId: auth.key.id,
    amount: freeModel
      ? 0
      : promoPlan.discountPct > 0
        ? discountedTokenCost(reservationEstimate.costTokens, promoPlan.discountPct)
        : reservationEstimate.costTokens,
    modelId: model.id,
    path: '/v1/decisions',
    allowRestrictedCredits: true,
    signal: clientAbortController.signal,
    freeModel,
    estimatedFreeTokens: freeModel ? reservationEstimate.costTokens : undefined,
  })
  if (!reservation.ok) {
    request.raw.off('close', onClientClose)
    reply.raw.off('close', onClientClose)
    return sendError(reservation.status, reservation.error, 'billing_error')
  }

  let reservationSettled = false
  try {
    const payload = buildDecisionPayload(body, upstreamModelId)
    const baseUrls = baseUrlsForUpstream('apinex')
    let lastStatus = 502
    let lastError = 'Upstream decision request failed'

    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i]!
      const baseUrl = baseUrls[i % baseUrls.length]!
      try {
        const upstream = await upstreamPost(
          baseUrl,
          'decisions',
          target.secret,
          payload,
          dispatcherForProxyIndex(target.proxyIndex ?? null),
          undefined,
          i < targets.length - 1,
          'apinex',
          clientAbortController.signal,
        )

        if (!upstream.ok) {
          const errorBody = (await upstream.json().catch(() => ({}))) as Record<string, unknown>
          lastStatus = upstream.status
          lastError = extractErrorMessage(errorBody, upstream.status)
          if (upstream.status === 401 || upstream.status === 402 || upstream.status === 403) {
            markProviderSecretFailed(target.secret, lastError, upstream.status)
            continue
          }
          if (isUpstreamTransient(upstream.status, lastError) && i < targets.length - 1) {
            continue
          }
          break
        }

        const data = (await upstream.json()) as Record<string, unknown>
        stripUpstreamVendorFields(data)

        const billed = resolveBillableUsage({
          body,
          data,
          parsed: parseUsage(data),
          rates,
          freeModel,
        })

        recordUsage({
          userId: auth.user.id,
          apiKeyId: auth.key.id,
          allowanceWeight: freeModel ? 1 : 0,
          modelId: model.id,
          provider: model.provider,
          inputTokens: billed.inputTokens,
          outputTokens: billed.outputTokens,
          costTokens: billed.costTokens,
          latencyMs: Date.now() - started,
          status: 'ok',
          reservationId: reservation.reservationId,
        })
        reservationSettled = true

        const usage = publicUsage(data.usage, billed.costTokens, {
          inputTokens: billed.inputTokens,
          outputTokens: billed.outputTokens,
        })

        return {
          ...data,
          model: publicModelId,
          usage,
          ...(playground
            ? {
                usageMeta: {
                  free: freeModel,
                  costTokens: freeModel
                    ? chargeTokens(billed.inputTokens, billed.outputTokens, 1)
                    : billed.costTokens,
                  chargedUsd: freeModel ? null : usdFromTokens(billed.costTokens),
                  latencyMs: Date.now() - started,
                },
              }
            : {}),
        }
      } catch (reason) {
        lastStatus = 502
        lastError = upstreamFailureMessage(reason, payload, i < targets.length - 1, 'apinex')
      }
    }

    recordUsage({
      userId: auth.user.id,
      apiKeyId: auth.key.id,
      modelId: model.id,
      provider: model.provider,
      inputTokens: 0,
      outputTokens: 0,
      costTokens: 0,
      latencyMs: Date.now() - started,
      status: 'error',
      reservationId: reservation.reservationId,
    })
    const responseStatus =
      lastStatus === 401 || lastStatus === 402 || lastStatus === 403
        ? 503
        : lastStatus >= 400 && lastStatus < 600
          ? lastStatus
          : 502
    return sendError(responseStatus, clientSafeUpstreamError(responseStatus, lastError), 'api_error')
  } finally {
    request.raw.off('close', onClientClose)
    reply.raw.off('close', onClientClose)
    if (!reservationSettled) {
      try {
        releaseReservation(reservation.reservationId)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * A hijacked SSE response fails for two unrelated reasons, and both surface as
 * one throw from the pipe loop:
 *
 * - the client (IDE, CLI, browser tab) went away mid-stream — normal cancellation;
 * - the upstream dropped the connection — a real provider incident.
 *
 * Only the second one is an operator problem, so they must be told apart before
 * an alert is raised. A destroyed/ended client socket is the decisive signal;
 * the write-side error codes cover the race where the socket dies mid-write.
 */
const CLIENT_DISCONNECT_CODES = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_ALREADY_FINISHED',
])

export function isClientDisconnect(
  reason: unknown,
  socket: { destroyed?: boolean; writableEnded?: boolean } | null | undefined,
) {
  if (socket?.destroyed || socket?.writableEnded) return true
  const code = (reason as { code?: unknown } | null)?.code
  return typeof code === 'string' && CLIENT_DISCONNECT_CODES.has(code)
}

async function pipeStreamingCompletion(input: {
  reply: FastifyReply
  upstream: Response
  auth: AuthOk
  model: ModelRow
  publicModelId: string
  body: Record<string, unknown>
  started: number
  reservationId: string
  responseStyle: 'anthropic' | 'openai' | 'responses-native' | 'responses-emulated'
  playground?: boolean
  initialChunk?: Uint8Array
  initialDone?: boolean
  existingReader?: ReadableStreamDefaultReader<Uint8Array>
}) {
  const {
    reply,
    upstream,
    auth,
    model,
    publicModelId,
    body,
    started,
    reservationId,
    responseStyle,
    playground,
    initialChunk,
    initialDone,
    existingReader,
  } = input
  reply.hijack()
  reply.raw.writeHead(upstream.status, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const reader = existingReader ?? upstream.body?.getReader()
  if (!reader) {
    reply.raw.end()
    recordUsage({ userId: auth.user.id, apiKeyId: auth.key.id, modelId: model.id, provider: model.provider, inputTokens: 0, outputTokens: 0, costTokens: 0, latencyMs: Date.now() - started, status: 'error', reservationId })
    return
  }

  let streamFinished = false
  const onStreamDisconnect = () => {
    try { void reader.cancel().catch(() => {}) } catch { /* ignore */ }
  }
  reply.raw.on('close', onStreamDisconnect)

  const streamRates = modelRates(model)
  const writeAnthropicEvent = (event: string, data: Record<string, unknown>) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const decoder = new TextDecoder()
  let pending = ''
  let inputTokens = 0
  let outputTokens = 0
  let streamedChars = 0
  let sawUsage = false
  let messageStarted = false
  let textStarted = false
  let textStopped = false
  let finishReason: unknown = 'stop'
  const toolBlocks = new Map<number, { contentIndex: number; id: string; name: string; started: boolean }>()
  let nextContentIndex = 1

  const sendMessageStart = (chunk: Record<string, unknown>) => {
    if (messageStarted) return
    messageStarted = true
    const chunkId = typeof chunk.id === 'string' ? chunk.id.replace(/^chatcmpl-/, '') : `${Date.now()}`
    writeAnthropicEvent('message_start', {
      type: 'message_start',
      message: { id: `msg_${chunkId}`, type: 'message', role: 'assistant', model: publicModelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } },
    })
  }
  const sendTextStart = () => {
    sendMessageStart({})
    if (textStarted) return
    textStarted = true
    writeAnthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  }
  const sendTextStop = () => {
    if (!textStarted || textStopped) return
    textStopped = true
    writeAnthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
  }

  const processOpenAiChunk = (chunk: Record<string, unknown>) => {
    const usage = parseUsage(chunk)
    if (usage.inputTokens || usage.outputTokens) {
      inputTokens = usage.inputTokens || inputTokens
      outputTokens = usage.outputTokens || outputTokens
      sawUsage = true
    }
    sendMessageStart(chunk)
    const choices = Array.isArray(chunk.choices) ? (chunk.choices as Array<Record<string, unknown>>) : []
    const choice = choices[0]
    if (!choice) return
    const delta = (choice.delta && typeof choice.delta === 'object' ? choice.delta : {}) as Record<string, unknown>
    if (typeof delta.content === 'string' && delta.content) {
      streamedChars += delta.content.length
      if (!sawUsage) outputTokens = Math.max(outputTokens, charsToTokens(streamedChars))
      sendTextStart()
      writeAnthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } })
    }
    if (Array.isArray(delta.tool_calls)) {
      sendTextStop()
      for (const rawCall of delta.tool_calls) {
        if (!rawCall || typeof rawCall !== 'object') continue
        const call = rawCall as Record<string, unknown>
        const sourceIndex = typeof call.index === 'number' ? call.index : toolBlocks.size
        const fn = (call.function && typeof call.function === 'object' ? call.function : {}) as Record<string, unknown>
        let block = toolBlocks.get(sourceIndex)
        if (!block) {
          block = { contentIndex: nextContentIndex++, id: String(call.id ?? `toolu_${sourceIndex}`), name: String(fn.name ?? 'tool'), started: true }
          toolBlocks.set(sourceIndex, block)
          writeAnthropicEvent('content_block_start', { type: 'content_block_start', index: block.contentIndex, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
        }
        const args = typeof fn.arguments === 'string' ? fn.arguments : ''
        if (args) {
          streamedChars += args.length
          if (!sawUsage) outputTokens = Math.max(outputTokens, charsToTokens(streamedChars))
          writeAnthropicEvent('content_block_delta', { type: 'content_block_delta', index: block.contentIndex, delta: { type: 'input_json_delta', partial_json: args } })
        }
      }
    }
    if (choice.finish_reason != null) finishReason = choice.finish_reason
  }

  const responsesEncoder =
    responseStyle === 'responses-emulated' ? new ResponsesStreamEncoder(publicModelId) : null
  // Per-request scrubber state: swallows <think>...</think> across chunk boundaries.
  const thinkScrubber = createThinkTagScrubber()

  const rewriteOpenAiLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) {
      // Native Responses streams carry `event:` lines; emulated ones are generated
      // locally, so an upstream event name must not be forwarded.
      return responsesEncoder ? '' : line
    }
    const raw = trimmed.slice(5).trim()
    if (!raw || raw === '[DONE]') {
      // Keep the upstream terminator for pass-through styles; Anthropic and the
      // emulated Responses stream generate their own closing events.
      return responseStyle === 'openai' || responseStyle === 'responses-native' ? line : ''
    }
    try {
      const chunk = JSON.parse(raw) as Record<string, unknown>
      stripUpstreamVendorFields(chunk)
      if (responseStyle === 'anthropic') {
        processOpenAiChunk(chunk)
        return ''
      }
      if (chunk.choices && Array.isArray(chunk.choices)) {
        for (const choice of chunk.choices as Array<Record<string, unknown>>) {
          const delta = choice.delta as Record<string, unknown> | undefined
          if (delta) {
            if (typeof delta.content === 'string') streamedChars += delta.content.length
            if (typeof delta.reasoning_content === 'string') streamedChars += delta.reasoning_content.length
            if (typeof delta.reasoning === 'string') streamedChars += delta.reasoning.length
            if (Array.isArray(delta.tool_calls)) {
              for (const call of delta.tool_calls) {
                const fn = (call as Record<string, unknown>)?.function as Record<string, unknown> | undefined
                if (typeof fn?.arguments === 'string') streamedChars += fn.arguments.length
                if (typeof fn?.name === 'string') streamedChars += fn.name.length
              }
            }
          }
        }
        if (!sawUsage) {
          outputTokens = Math.max(outputTokens, charsToTokens(streamedChars))
        }
      }
      if (responsesEncoder) {
        // Track usage from the chat stream so billing matches a native reply.
        const usage = parseUsage(chunk)
        if (usage.inputTokens || usage.outputTokens) {
          inputTokens = usage.inputTokens || inputTokens
          outputTokens = usage.outputTokens || outputTokens
          sawUsage = true
        }
        return responsesEncoder.chunk(chunk)
      }
      if (responseStyle === 'responses-native') {
        const { usage } = rewriteNativeResponsesEvent(chunk, publicModelId)
        if (usage) {
          inputTokens = usage.inputTokens || inputTokens
          outputTokens = usage.outputTokens || outputTokens
          sawUsage = true
        }
        return `data: ${JSON.stringify(chunk)}`
      }
      delete (chunk as Record<string, unknown>)._manifest
      chunk.model = publicModelId
      if (isFreeTierModelId(publicModelId) && chunk.choices && Array.isArray(chunk.choices)) {
        for (const choice of chunk.choices as Array<Record<string, unknown>>) {
          const delta = choice.delta as Record<string, unknown> | undefined
          if (delta && typeof delta.content === 'string') {
            // Stateful scrubber: <think>...</think> blocks may span chunk
            // boundaries, so a per-chunk regex is not enough.
            delta.content = thinkScrubber(delta.content)
          }
          // Free tier hides the model's chain-of-thought entirely: drop reasoning
          // deltas and reasoning fields on every streamed chunk.
          if (delta) {
            delete delta.reasoning
            delete delta.reasoning_content
            delete delta.reasoning_details
            delete delta.thinking
            delete delta.thinking_signature
          }
          const msg = choice.message as Record<string, unknown> | undefined
          if (msg) {
            delete msg.reasoning
            delete msg.reasoning_content
            delete msg.reasoning_details
            delete msg.thinking
            delete msg.thinking_signature
          }
        }
      }

      if (chunk.usage && typeof chunk.usage === 'object') {
        const usage = parseUsage(chunk)
        if (usage.inputTokens || usage.outputTokens) {
          inputTokens = usage.inputTokens || inputTokens
          outputTokens = usage.outputTokens || outputTokens
          sawUsage = true
        }
        const costTokens = chargeUsdMicros(usage.inputTokens, usage.outputTokens, streamRates.inputDollarsPer1M, streamRates.outputDollarsPer1M)
        chunk.usage = publicUsage(chunk.usage, costTokens) as Record<string, unknown>
      }
      return `data: ${JSON.stringify(chunk)}`
    } catch {
      return responseStyle === 'openai' || responseStyle === 'responses-native' ? line : ''
    }
  }

  // SSE events must end with a blank line. A single newline only separates
  // fields within one event, so standards-compliant clients such as the AI SDK
  // will otherwise buffer the entire stream and emit no chunks.
  const writeRewritten = (rewritten: string) => {
    if (!rewritten) return
    if (responseStyle === 'openai') {
      reply.raw.write(`${rewritten.replace(/\n+$/, '')}\n\n`)
      return
    }
    if (responseStyle === 'responses-native') {
      const suffix = rewritten.trimStart().startsWith('event:') ? '\n' : '\n\n'
      reply.raw.write(`${rewritten.replace(/\n+$/, '')}${suffix}`)
      return
    }
    // Emulated Responses events are already `\n\n`-terminated.
    reply.raw.write(rewritten.endsWith('\n') ? rewritten : `${rewritten}\n`)
  }

  try {
    if (initialChunk && initialChunk.length > 0) {
      pending += decoder.decode(initialChunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        writeRewritten(rewriteOpenAiLine(line))
      }
    }
    if (!initialDone) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        pending += decoder.decode(value, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          writeRewritten(rewriteOpenAiLine(line))
        }
      }
    }
    if (pending) {
      writeRewritten(rewriteOpenAiLine(pending))
    }
    if (responseStyle === 'anthropic') {
      sendTextStop()
      for (const block of toolBlocks.values()) writeAnthropicEvent('content_block_stop', { type: 'content_block_stop', index: block.contentIndex })
      writeAnthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: mapOpenAiFinishToAnthropic(finishReason), stop_sequence: null }, usage: { output_tokens: outputTokens } })
      writeAnthropicEvent('message_stop', { type: 'message_stop' })
    }
    if (responsesEncoder) {
      // Close the emulated Responses stream with the same billed usage that is
      // recorded below, then send the OpenAI-style terminator Codex expects.
      const closing = resolveBillableUsage({
        body,
        parsed: sawUsage ? { inputTokens, outputTokens } : { inputTokens: 0, outputTokens: 0 },
        rates: streamRates,
        freeModel: model.provider.trim().toLowerCase() === 'free',
      })
      reply.raw.write(
        responsesEncoder.finish({
          inputTokens: closing.inputTokens,
          outputTokens: closing.outputTokens,
          costTokens: closing.costTokens,
        }),
      )
      reply.raw.write('data: [DONE]\n\n')
    }
    if (playground) {
      const meta = resolveBillableUsage({
        body,
        parsed: sawUsage ? { inputTokens, outputTokens } : { inputTokens: 0, outputTokens: 0 },
        rates: streamRates,
        freeModel: model.provider.trim().toLowerCase() === 'free',
      })
      const free = model.provider.trim().toLowerCase() === 'free'
      const shownTokens = free
        ? chargeTokens(meta.inputTokens, meta.outputTokens, freeAllowanceWeight(auth.user.id, model))
        : meta.costTokens
      reply.raw.write(
        `event: playground\ndata: ${JSON.stringify({
          free,
          costTokens: shownTokens,
          chargedUsd: free ? null : usdFromTokens(meta.costTokens),
          latencyMs: Date.now() - started,
        })}\n\n`,
      )
    }
    streamFinished = true
    reply.raw.end()
  } catch (reason) {
    // The client is already committed to a 200 SSE stream, so the wire behaviour
    // is identical either way: end the response. Only the local bookkeeping and
    // the operator alert differ.
    const clientGone = isClientDisconnect(reason, reply.raw)
    try { reply.raw.end() } catch { /* ignore */ }
    try { void reader.cancel().catch(() => {}) } catch { /* ignore */ }
    if (clientGone) {
      const actualOutput = sawUsage && outputTokens > 0
        ? outputTokens
        : (outputTokens || (streamedChars > 0 ? charsToTokens(streamedChars) : 0))
      const actualInput = sawUsage && inputTokens > 0
        ? inputTokens
        : (inputTokens || estimateUsage(body).inputTokens)
      const billed = resolveBillableUsage({
        body,
        parsed: { inputTokens: actualInput, outputTokens: actualOutput },
        rates: streamRates,
        freeModel: model.provider.trim().toLowerCase() === 'free',
      })
      const free = model.provider.trim().toLowerCase() === 'free'
      recordUsage({
        userId: auth.user.id,
        apiKeyId: auth.key.id,
        modelId: model.id,
        provider: model.provider,
        inputTokens: billed.inputTokens,
        outputTokens: billed.outputTokens,
        costTokens: billed.costTokens,
        allowanceWeight: free ? freeAllowanceWeight(auth.user.id, model) : 0,
        latencyMs: Date.now() - started,
        status: 'ok',
        clientDisconnected: true,
        reservationId,
      })
      return
    }
    recordUsage({ userId: auth.user.id, apiKeyId: auth.key.id, modelId: model.id, provider: model.provider, inputTokens: 0, outputTokens: 0, costTokens: 0, latencyMs: Date.now() - started, status: 'error', clientDisconnected: false, reservationId })
    // A cancelled request is normal IDE behaviour, not an incident.
    return
  } finally {
    reply.raw.off('close', onStreamDisconnect)
    if (!streamFinished) {
      try { void reader.cancel().catch(() => {}) } catch { /* ignore */ }
    }
  }

  const clientGone = isClientDisconnect(null, reply.raw)
  const finalOutput = sawUsage && outputTokens > 0
    ? outputTokens
    : (outputTokens || (streamedChars > 0 ? charsToTokens(streamedChars) : 0))
  const finalInput = sawUsage && inputTokens > 0
    ? inputTokens
    : (inputTokens || 0)
  const billed = resolveBillableUsage({
    body,
    parsed: { inputTokens: finalInput, outputTokens: finalOutput },
    rates: streamRates,
    freeModel: model.provider.trim().toLowerCase() === 'free',
  })
  const free = model.provider.trim().toLowerCase() === 'free'
  recordUsage({
    userId: auth.user.id,
    apiKeyId: auth.key.id,
    modelId: model.id,
    provider: model.provider,
    inputTokens: billed.inputTokens,
    outputTokens: billed.outputTokens,
    costTokens: billed.costTokens,
    allowanceWeight: free ? freeAllowanceWeight(auth.user.id, model) : 0,
    latencyMs: Date.now() - started,
    status: 'ok',
    clientDisconnected: clientGone,
    reservationId,
  })
}
