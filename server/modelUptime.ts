import { db } from './db.js'
import { PROVIDER_ORDER } from '../shared/providers.js'

export const UPTIME_HOURS = 24 * 7

export type HourState = 'up' | 'load' | 'partial' | 'down' | 'none'

export type PublicModelState = 'operational' | 'degraded' | 'partial' | 'outage' | 'unknown'

const LOAD_LATENCY_MS = 25_000
const MIN_SAMPLE = 3

export function classifyHour(input: { total: number; ok: number; avgLatencyMs: number | null }): HourState {
  const total = input.total
  if (total <= 0) return 'up'
  if (total < MIN_SAMPLE) return input.ok === total ? 'up' : 'none'
  const rate = input.ok / total
  if (rate < 0.5) return 'down'
  if (rate < 0.9) return 'partial'
  if ((input.avgLatencyMs ?? 0) >= LOAD_LATENCY_MS) return 'load'
  return 'up'
}

export function publicStateFromHour(state: HourState): PublicModelState {
  if (state === 'up') return 'operational'
  if (state === 'load') return 'degraded'
  if (state === 'partial') return 'partial'
  if (state === 'down') return 'outage'
  return 'unknown'
}

/** Share of observed hours that fully served traffic. Partial hours count as half. */
export function uptimePercent(hours: HourState[]): number | null {
  let weight = 0
  let observed = 0
  for (const hour of hours) {
    if (hour === 'none') continue
    observed += 1
    if (hour === 'up' || hour === 'load') weight += 1
    else if (hour === 'partial') weight += 0.5
  }
  if (observed === 0) return null
  return Math.round((weight / observed) * 1000) / 10
}

function hourStart(date: Date) {
  const next = new Date(date)
  next.setUTCMinutes(0, 0, 0)
  return next
}

function hourKey(date: Date) {
  return date.toISOString().slice(0, 13)
}

export function buildModelUptime(now = new Date()) {
  const end = hourStart(now)
  const start = new Date(end.getTime() - (UPTIME_HOURS - 1) * 3_600_000)
  const slots = Array.from({ length: UPTIME_HOURS }, (_, index) => new Date(start.getTime() + index * 3_600_000))

  const models = db
    .prepare(
      `SELECT id, provider, name, COALESCE(sort_order, 0) AS sort_order
       FROM model_catalog
       WHERE status = 'active'
       ORDER BY provider ASC, sort_order ASC, name ASC`,
    )
    .all() as Array<{ id: string; provider: string; name: string; sort_order: number }>

  const rows = db
    .prepare(
      `SELECT e.model_id AS model_id,
              substr(e.created_at, 1, 13) AS hour_key,
              COUNT(*) AS total,
              SUM(CASE WHEN e.status = 'ok' THEN 1 ELSE 0 END) AS ok,
              AVG(CASE WHEN e.status = 'ok' THEN e.latency_ms END) AS avg_latency_ms
       FROM usage_events e
       INNER JOIN model_catalog m ON m.id = e.model_id AND m.status = 'active'
       WHERE e.created_at >= ?
       GROUP BY e.model_id, hour_key`,
    )
    .all(start.toISOString()) as Array<{
    model_id: string
    hour_key: string
    total: number
    ok: number
    avg_latency_ms: number | null
  }>

  const byModel = new Map<string, Map<string, { total: number; ok: number; avgLatencyMs: number | null }>>()
  for (const row of rows) {
    let hours = byModel.get(row.model_id)
    if (!hours) {
      hours = new Map()
      byModel.set(row.model_id, hours)
    }
    hours.set(row.hour_key, {
      total: Number(row.total) || 0,
      ok: Number(row.ok) || 0,
      avgLatencyMs: row.avg_latency_ms == null ? null : Number(row.avg_latency_ms),
    })
  }

  return {
    generatedAt: now.toISOString(),
    windowHours: UPTIME_HOURS,
    models: models
    .map((model) => {
      const buckets = byModel.get(model.id)
      const hours = slots.map((slot) => {
        const sample = buckets?.get(hourKey(slot))
        const state = classifyHour({
          total: sample?.total ?? 0,
          ok: sample?.ok ?? 0,
          avgLatencyMs: sample?.avgLatencyMs ?? null,
        })
        return { at: slot.toISOString(), state }
      })
      let latest: HourState = 'none'
      for (let index = hours.length - 1; index >= 0; index -= 1) {
        if (hours[index].state !== 'none') {
          latest = hours[index].state
          break
        }
      }
      return {
        id: model.id,
        name: model.name,
        provider: model.provider,
        state: publicStateFromHour(latest),
        uptimePct: uptimePercent(hours.map((hour) => hour.state)),
        hours,
      }
    })
    .sort((a, b) => {
      const rank = (provider: string) => {
        const index = PROVIDER_ORDER.indexOf(provider as (typeof PROVIDER_ORDER)[number])
        return index === -1 ? PROVIDER_ORDER.length : index
      }
      const byProvider = rank(a.provider) - rank(b.provider)
      if (byProvider !== 0) return byProvider
      return a.name.localeCompare(b.name)
    }),
  }
}
