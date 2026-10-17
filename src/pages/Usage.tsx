import { useCallback, useEffect, useMemo, useState } from 'react'
import { userApi, type CustomerUsageEvent, type CustomerUsageResponse } from '../auth/userApi'
import { useToast } from '../components/Toast'
import { ProviderIcon } from '../components/ProviderIcon'
import { formatFullTokenCount, formatUsdFromTokens } from '../../shared/billing'
import './Usage.css'

export function Usage({ embedded = false }: { embedded?: boolean } = {}) {
  const { toast } = useToast()
  const [data, setData] = useState<CustomerUsageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true)
    else setLoading(true)
    try {
      const response = await userApi.usage({
        limit: 100,
        offset: 0,
      })
      setData(response)
      if (isManual) toast('Telemetry updated', 'info')
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Could not load usage', 'error')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  // Computed summary stats
  const metrics = useMemo(() => {
    if (!data || data.events.length === 0) {
      return {
        totalEvents: data?.total ?? 0,
        successRate: 100,
        totalTokens: 0,
        avgLatencyMs: 0,
        totalBilledDollars: 0,
      }
    }
    const events = data.events
    let successfulCount = 0
    let totalTokens = 0
    let totalLatency = 0
    let totalCostTokens = 0

    for (const ev of events) {
      if (ev.status === 'ok') successfulCount++
      totalTokens += (ev.inputTokens || 0) + (ev.outputTokens || 0)
      totalLatency += ev.latencyMs || 0
      totalCostTokens += ev.costTokens || 0
    }

    return {
      totalEvents: data.total,
      successRate: Math.round((successfulCount / events.length) * 1000) / 10,
      totalTokens,
      avgLatencyMs: Math.round(totalLatency / events.length),
      totalBilledDollars: totalCostTokens,
    }
  }, [data])

  return (
    <div className={embedded ? 'usage-page usage-page-embedded' : 'page usage-page'}>
      {embedded ? null : (
        <div className="page-header usage-header-cockpit">
          <div>
            <h1>Usage &amp; Telemetry</h1>
          </div>
          <div className="usage-header-actions">
            <button
              type="button"
              className={`btn btn-secondary btn-sm usage-refresh-btn ${refreshing ? 'is-spinning' : ''}`}
              onClick={() => void load(true)}
              disabled={loading || refreshing}
              title="Refresh telemetry"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
              <span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Metrics HUD summary strip */}
      <section className="usage-metrics-grid" aria-label="Usage overview metrics">
        <div className="card usage-metric-card">
          <div className="usage-metric-head">
            <span className="usage-metric-label">Total Requests</span>
            <span className="usage-metric-dot" aria-hidden="true" />
          </div>
          <strong className="usage-metric-value">{metrics.totalEvents.toLocaleString()}</strong>
          <span className="usage-metric-sub">Recorded in gateway</span>
        </div>

        <div className="card usage-metric-card">
          <div className="usage-metric-head">
            <span className="usage-metric-label">Success Rate</span>
            <span className="usage-metric-badge is-good">200 OK</span>
          </div>
          <strong className="usage-metric-value">{metrics.successRate}%</strong>
          <span className="usage-metric-sub">Across logged calls</span>
        </div>

        <div className="card usage-metric-card">
          <div className="usage-metric-head">
            <span className="usage-metric-label">Token Volume</span>
            <span className="usage-metric-badge">Throughput</span>
          </div>
          <strong className="usage-metric-value">{formatFullTokenCount(metrics.totalTokens)}</strong>
          <span className="usage-metric-sub">Prompt + completion</span>
        </div>

        <div className="card usage-metric-card">
          <div className="usage-metric-head">
            <span className="usage-metric-label">Average Latency</span>
            <span className="usage-metric-badge">TTFT</span>
          </div>
          <strong className="usage-metric-value">{formatLatencySec(metrics.avgLatencyMs)}</strong>
          <span className="usage-metric-sub">Time to first token</span>
        </div>
      </section>

      {/* Main telemetry table */}
      <div className="card usage-table-wrap">
        {loading && !data ? (
          <div className="usage-empty">
            <div className="usage-loader-spin" aria-hidden="true" />
            <p>Streaming telemetry records…</p>
          </div>
        ) : !data || data.events.length === 0 ? (
          <div className="usage-empty">
            <div className="usage-empty-icon" aria-hidden="true">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </div>
            <strong>No requests recorded yet</strong>
            <p>API requests sent via your keys will appear in this telemetry stream with model, latency, and token metrics.</p>
          </div>
        ) : (
          <>
            {/* Desktop / Tablet Table */}
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Model / Provider</th>
                  <th>Token Usage</th>
                  <th>Cost / Billed</th>
                  <th>TTFT</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => (
                  <UsageRow key={event.id} event={event} />
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}

function UsageRow({ event }: { event: CustomerUsageEvent }) {
  const isErr = event.status !== 'ok'
  const isHighLatency = event.latencyMs >= 50000
  const isMidLatency = event.latencyMs >= 20000

  return (
    <tr className={`usage-row ${isErr ? 'is-row-error' : ''}`}>
      <td className="usage-cell-time">
        <time dateTime={event.createdAt}>{formatWhen(event.createdAt)}</time>
      </td>
      <td className="usage-cell-model">
        <div className="usage-model-block">
          <div className="usage-model-icon-frame" aria-hidden="true">
            <ProviderIcon provider={event.provider || ''} modelId={event.modelId} size={15} />
          </div>
          <div className="usage-model-info">
            <strong>{event.modelId || '—'}</strong>
            <small>{event.provider || 'Gateway'}</small>
          </div>
        </div>
      </td>
      <td className="usage-cell-tokens mono">
        <div className="usage-tokens-block">
          <span>{formatUsage(event)}</span>
          <small>{usageHint(event)}</small>
        </div>
      </td>
      <td className="usage-cell-billed mono">
        <strong>
          {event.freeModel
            ? formatFullTokenCount(event.inputTokens + event.outputTokens)
            : formatUsdFromTokens(event.costTokens)}
        </strong>
      </td>
      <td className="usage-cell-latency mono">
        <span
          className={`usage-latency-pill ${
            isHighLatency ? 'is-high' : isMidLatency ? 'is-mid' : 'is-fast'
          }`}
        >
          {formatLatencySec(event.latencyMs)}
        </span>
      </td>
      <td className="usage-cell-status">
        <span className={`usage-status-pill is-${event.status}`}>
          <i className="status-dot-indicator" aria-hidden="true" />
          {event.status === 'ok' ? '200 OK' : 'ERR'}
        </span>
      </td>
    </tr>
  )
}

function formatLatencySec(ms: number) {
  if (!ms || ms <= 0) return '0.0s'
  const sec = ms / 1000
  return sec < 10 ? sec.toFixed(1) + 's' : Math.round(sec) + 's'
}

function isToolEvent(event: CustomerUsageEvent) {
  const provider = (event.provider || '').toLowerCase()
  const model = (event.modelId || '').toLowerCase()
  return (
    provider === 'tools' ||
    model.startsWith('web.') ||
    model.startsWith('twitter.') ||
    model.startsWith('voice.')
  )
}

function formatUsage(event: CustomerUsageEvent) {
  if (isToolEvent(event)) {
    const units = Math.max(event.inputTokens, 0)
    if ((event.modelId || '').startsWith('voice.stt')) return `${units.toLocaleString()} sec`
    if ((event.modelId || '').startsWith('voice.tts')) return `${units.toLocaleString()} chars`
    if (units <= 1) return '1 call'
    return `${units.toLocaleString()} units`
  }
  return `${event.inputTokens.toLocaleString()} in · ${event.outputTokens.toLocaleString()} out`
}

function usageHint(event: CustomerUsageEvent) {
  if (isToolEvent(event)) return 'tool units'
  return 'tokens'
}

function formatWhen(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 19)
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
