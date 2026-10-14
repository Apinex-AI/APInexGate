import { db } from './db.js'
import { usdFromTokens } from '../shared/billing.js'

const DAY_MS = 86_400_000

export type ModelUsageWindow = '24h' | '7d' | '30d' | 'all'

/** Rows written by non-model gateways (tools, Solana RPC) share usage_events. */
const TOOL_PROVIDERS = new Set(['Tools', 'Solana RPC'])

function isoAgo(ms: number, from = new Date()) {
  return new Date(from.getTime() - ms).toISOString()
}

function windowSince(window: ModelUsageWindow, now = new Date()) {
  switch (window) {
    case '24h':
      return isoAgo(DAY_MS, now)
    case '7d':
      return isoAgo(7 * DAY_MS, now)
    case '30d':
      return isoAgo(30 * DAY_MS, now)
    default:
      return null
  }
}

export function resolveModelUsageWindow(value?: string | null): ModelUsageWindow {
  const raw = String(value ?? '').trim()
  return raw === '24h' || raw === '7d' || raw === '30d' || raw === 'all' ? raw : '7d'
}

type RawModelRow = {
  model_id: string | null
  provider: string | null
  requests: number
  ok_requests: number
  error_requests: number
  input_tokens: number
  output_tokens: number
  cost_tokens: number
  users: number
  keys: number
  avg_latency_ms: number | null
  max_latency_ms: number | null
  last_used_at: string | null
}

/**
 * Per-model request counts for the given window. Tokens and cost come from the
 * same rows the gateway writes, so free models report cost 0 by construction.
 * `token_weight` is joined from the catalog when the model still exists; deleted
 * models keep their historical rows and are reported as unknown weight.
 */
function queryModelRows(window: ModelUsageWindow, now = new Date()): RawModelRow[] {
  const since = windowSince(window, now)
  const params: unknown[] = []
  let where = `e.model_id IS NOT NULL AND e.model_id != ''`
  if (since) {
    where += ` AND e.created_at >= ?`
    params.push(since)
  }
  return db
    .prepare(
      `SELECT e.model_id,
              e.provider,
              COUNT(*) AS requests,
              SUM(CASE WHEN e.status = 'ok' THEN 1 ELSE 0 END) AS ok_requests,
              SUM(CASE WHEN e.status = 'ok' THEN 0 ELSE 1 END) AS error_requests,
              COALESCE(SUM(e.input_tokens), 0) AS input_tokens,
              COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
              COALESCE(SUM(e.cost_tokens), 0) AS cost_tokens,
              COUNT(DISTINCT e.user_id) AS users,
              COUNT(DISTINCT e.api_key_id) AS keys,
              AVG(CASE WHEN e.status = 'ok' THEN e.latency_ms END) AS avg_latency_ms,
              MAX(CASE WHEN e.status = 'ok' THEN e.latency_ms END) AS max_latency_ms,
              MAX(e.created_at) AS last_used_at
       FROM usage_events e
       WHERE ${where}
       GROUP BY e.model_id, e.provider
       ORDER BY requests DESC`,
    )
    .all(...params) as RawModelRow[]
}

/** Median latency per model — resistant to the multi-minute outliers streams produce. */
function queryMedianLatency(window: ModelUsageWindow, now = new Date()) {
  const since = windowSince(window, now)
  const params: unknown[] = []
  let where = `status = 'ok' AND model_id IS NOT NULL AND model_id != '' AND latency_ms > 0`
  if (since) {
    where += ` AND created_at >= ?`
    params.push(since)
  }
  const rows = db
    .prepare(
      `SELECT model_id, ROUND(AVG(latency_ms)) AS median_latency_ms
       FROM (
         SELECT model_id, latency_ms
         FROM usage_events
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT 20000
       )
       GROUP BY model_id`,
    )
    .all(...params) as Array<{ model_id: string; median_latency_ms: number | null }>
  return new Map(rows.map((row) => [row.model_id, Math.round(Number(row.median_latency_ms) || 0)]))
}

type CatalogInfo = { provider: string; tokenWeight: number; name: string; status: string; upstreamProvider: string }

function catalogInfo() {
  const rows = db
    .prepare(
      `SELECT id, provider, name, status, COALESCE(token_weight, 1) AS token_weight,
              COALESCE(upstream_provider, 'apinex') AS upstream_provider
       FROM model_catalog`,
    )
    .all() as Array<{
    id: string
    provider: string
    name: string
    status: string
    token_weight: number
    upstream_provider: string
  }>
  return new Map<string, CatalogInfo>(
    rows.map((row) => [
      row.id,
      {
        provider: row.provider,
        tokenWeight: Number(row.token_weight),
        name: row.name,
        status: row.status,
        upstreamProvider: row.upstream_provider,
      },
    ]),
  )
}

export type ModelUsageRow = {
  modelId: string
  name: string
  provider: string
  upstreamProvider: string | null
  /** 'free' for zero-weight catalog models, 'paid' otherwise, 'tool' for tool routes. */
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

function classify(modelId: string, provider: string, info?: CatalogInfo): ModelUsageRow['kind'] {
  if (TOOL_PROVIDERS.has(provider) || /^(web\.|twitter\.|voice\.|solana\.|captcha\.)/.test(modelId)) return 'tool'
  if (modelId.toLowerCase().startsWith('free/') || provider.toLowerCase() === 'free' || info?.provider?.toLowerCase() === 'free') {
    return 'free'
  }
  if (info) return info.tokenWeight === 0 ? 'free' : 'paid'
  // Deleted from the catalog: the `free/` namespace still identifies zero-cost routes.
  return modelId.toLowerCase().startsWith('free/') ? 'free' : 'paid'
}

function buildRows(window: ModelUsageWindow, now = new Date()): ModelUsageRow[] {
  const raw = queryModelRows(window, now)
  const medians = queryMedianLatency(window, now)
  const catalog = catalogInfo()
  const totalRequests = raw.reduce((sum, row) => sum + Number(row.requests || 0), 0)

  return raw.map((row) => {
    const modelId = String(row.model_id ?? '')
    const provider = String(row.provider ?? '—')
    const info = catalog.get(modelId)
    const requests = Number(row.requests) || 0
    const okRequests = Number(row.ok_requests) || 0
    const errorRequests = Number(row.error_requests) || 0
    const inputTokens = Number(row.input_tokens) || 0
    const outputTokens = Number(row.output_tokens) || 0
    const costTokens = Number(row.cost_tokens) || 0
    const kind = classify(modelId, provider, info)
    return {
      modelId,
      name: info?.name ?? modelId,
      provider,
      upstreamProvider: info?.upstreamProvider ?? null,
      kind,
      inCatalog: Boolean(info),
      catalogStatus: info?.status ?? null,
      requests,
      okRequests,
      errorRequests,
      errorRatePct: requests > 0 ? Math.round((errorRequests / requests) * 1000) / 10 : 0,
      sharePct: totalRequests > 0 ? Math.round((requests / totalRequests) * 1000) / 10 : 0,
      users: Number(row.users) || 0,
      keys: Number(row.keys) || 0,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costTokens,
      costUsd: kind === 'free' ? 0 : Math.round(usdFromTokens(costTokens) * 100) / 100,
      avgLatencyMs: Math.round(Number(row.avg_latency_ms) || 0),
      medianLatencyMs: medians.get(modelId) ?? 0,
      maxLatencyMs: Math.round(Number(row.max_latency_ms) || 0),
      lastUsedAt: row.last_used_at,
    }
  })
}

function summarize(rows: ModelUsageRow[]) {
  const base = {
    models: 0,
    requests: 0,
    okRequests: 0,
    errorRequests: 0,
    errorRatePct: 0,
    totalTokens: 0,
    costTokens: 0,
    costUsd: 0,
  }
  const acc = rows.reduce(
    (sum, row) => {
      sum.models += 1
      sum.requests += row.requests
      sum.okRequests += row.okRequests
      sum.errorRequests += row.errorRequests
      sum.totalTokens += row.totalTokens
      sum.costTokens += row.costTokens
      return sum
    },
    { ...base },
  )
  acc.errorRatePct = acc.requests > 0 ? Math.round((acc.errorRequests / acc.requests) * 1000) / 10 : 0
  acc.costUsd = Math.round(usdFromTokens(acc.costTokens) * 100) / 100
  return acc
}

/** Daily request counts split by tier so the chart shows free vs paid demand. */
function dailySeries(window: ModelUsageWindow, now = new Date()) {
  const since = windowSince(window, now) ?? isoAgo(30 * DAY_MS, now)
  const rows = db
    .prepare(
      `SELECT substr(e.created_at, 1, 10) AS day,
              e.model_id,
              COUNT(*) AS requests,
              SUM(CASE WHEN e.status = 'ok' THEN 0 ELSE 1 END) AS errors,
              COALESCE(SUM(e.cost_tokens), 0) AS cost_tokens
       FROM usage_events e
       WHERE e.created_at >= ? AND e.model_id IS NOT NULL AND e.model_id != ''
       GROUP BY day, e.model_id
       ORDER BY day ASC`,
    )
    .all(since) as Array<{
    day: string
    model_id: string
    requests: number
    errors: number
    cost_tokens: number
  }>

  const catalog = catalogInfo()
  const byDay = new Map<
    string,
    { day: string; requests: number; free: number; paid: number; tool: number; errors: number; costTokens: number }
  >()
  for (const row of rows) {
    const day = String(row.day ?? '')
    if (!day) continue
    const entry =
      byDay.get(day) ?? { day, requests: 0, free: 0, paid: 0, tool: 0, errors: 0, costTokens: 0 }
    const modelId = String(row.model_id ?? '')
    const info = catalog.get(modelId)
    // Provider is not selected here; tool rows are identified by their id prefix.
    const kind = /^(web\.|twitter\.|voice\.|solana\.|captcha\.)/.test(modelId)
      ? 'tool'
      : classify(modelId, '—', info)
    const requests = Number(row.requests) || 0
    entry.requests += requests
    entry[kind] += requests
    entry.errors += Number(row.errors) || 0
    if (kind !== 'free') {
      entry.costTokens += Number(row.cost_tokens) || 0
    }
    byDay.set(day, entry)
  }

  return [...byDay.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((entry) => ({
      ...entry,
      label: entry.day.slice(5).replace('-', '.'),
      costUsd: Math.round(usdFromTokens(entry.costTokens) * 100) / 100,
    }))
}

/** Heaviest consumers in the window, so abuse and cost spikes are attributable. */
function topUsers(window: ModelUsageWindow, now = new Date(), limit = 25) {
  const since = windowSince(window, now)
  const params: unknown[] = []
  let where = `e.model_id IS NOT NULL AND e.model_id != ''`
  if (since) {
    where += ` AND e.created_at >= ?`
    params.push(since)
  }
  params.push(limit)
  const rows = db
    .prepare(
      `WITH top AS (
         SELECT e.user_id,
                COUNT(*) AS requests,
                SUM(CASE WHEN e.status = 'ok' THEN 0 ELSE 1 END) AS errors,
                COALESCE(SUM(e.cost_tokens), 0) AS costTokens,
                COALESCE(SUM(e.input_tokens + e.output_tokens), 0) AS totalTokens,
                COUNT(DISTINCT e.model_id) AS models,
                MAX(e.created_at) AS lastUsedAt
         FROM usage_events e
         WHERE ${where}
         GROUP BY e.user_id
         ORDER BY requests DESC
         LIMIT ?
       )
       SELECT u.display_id AS userId,
              u.email,
              u.name,
              u.solana_wallet AS wallet,
              top.requests, top.errors, top.costTokens, top.totalTokens, top.models, top.lastUsedAt
       FROM top
       JOIN users u ON u.id = top.user_id
       ORDER BY top.requests DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>

  return rows.map((row) => ({
    ...row,
    costUsd: Math.round(usdFromTokens(Number(row.costTokens) || 0) * 100) / 100,
  }))
}

const STATS_CACHE_TTL_MS = 30_000
const statsCache = new Map<string, { expiresAt: number; data: any }>()

/**
 * Model-level request analytics for the admin Statistics page. Everything is
 * derived from `usage_events`, the same table the gateway writes on every call,
 * so free and paid routes are covered without extra bookkeeping.
 */
export function buildModelUsageStats(input: { window?: string } = {}) {
  const window = resolveModelUsageWindow(input.window)
  const now = new Date()
  const cached = statsCache.get(window)
  if (cached && cached.expiresAt > now.getTime()) {
    return cached.data
  }

  const rows = buildRows(window, now)
  const free = rows.filter((row) => row.kind === 'free')
  const paid = rows.filter((row) => row.kind === 'paid')
  const tools = rows.filter((row) => row.kind === 'tool')

  const result = {
    window,
    generatedAt: now.toISOString(),
    totals: {
      all: summarize(rows),
      free: summarize(free),
      paid: summarize(paid),
      tools: summarize(tools),
    },
    models: rows,
    daily: dailySeries(window, now),
    topUsers: topUsers(window, now),
  }

  statsCache.set(window, { expiresAt: now.getTime() + STATS_CACHE_TTL_MS, data: result })
  return result
}
