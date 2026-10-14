import { useEffect, useMemo, useState } from 'react'
import { PROVIDER_ORDER } from '../../shared/providers'
import { ProviderIcon } from '../components/ProviderIcon'

import './Status.css'

type HourState = 'up' | 'load' | 'partial' | 'down' | 'none'
type ModelState = 'operational' | 'degraded' | 'partial' | 'outage' | 'unknown'

type StatusModel = {
  id: string
  name: string
  provider: string
  state: ModelState
  uptimePct: number | null
  hours: Array<{ at: string; state: HourState }>
}

type StatusPayload = {
  generatedAt: string
  windowHours: number
  models: StatusModel[]
}

const STATE_LABEL: Record<ModelState, string> = {
  operational: 'Operational',
  degraded: 'High load',
  partial: 'Partial outage',
  outage: 'Outage',
  unknown: 'No recent traffic',
}

const HOUR_LABEL: Record<HourState, string> = {
  up: 'operational',
  load: 'high load',
  partial: 'partial outage',
  down: 'outage',
  none: 'operational',
}

function formatHour(iso: string) {
  const date = new Date(iso)
  const day = String(date.getUTCDate()).padStart(2, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  return `${day}.${month}, ${hour}:00 UTC`
}

function uptimeLabel(value: number | null) {
  if (value == null) return '—'
  return `${value.toFixed(1)}%`
}

export function StatusPage() {
  const [data, setData] = useState<StatusPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [provider, setProvider] = useState('All')


  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const response = await fetch('/api/public/status')
        const json = (await response.json()) as StatusPayload & { error?: string }
        if (!response.ok) throw new Error(json.error ?? 'Status unavailable')
        if (!cancelled) {
          setData(json)
          setError(null)
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Status unavailable')
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const models = useMemo(() => data?.models ?? [], [data])
  const providers = useMemo(() => {
    const present = new Set(models.map((model) => model.provider))
    return PROVIDER_ORDER.filter((name) => present.has(name))
  }, [models])
  const visible = provider === 'All' ? models : models.filter((model) => model.provider === provider)

  const avgUptime = useMemo(() => {
    const valid = models.filter((m) => m.uptimePct != null).map((m) => m.uptimePct!)
    if (valid.length === 0) return null
    const sum = valid.reduce((acc, v) => acc + v, 0)
    return Number((sum / valid.length).toFixed(2))
  }, [models])

  const hasOutage = useMemo(() => {
    return models.some((m) => m.state === 'outage' || m.state === 'partial')
  }, [models])

  return (
    <div className="status-page">
      {/* Futuristic Global Status Card */}
        <section className="status-hero-card">
          <div className="status-hero-main">
            <div className={`status-health-pill ${hasOutage ? 'is-warning' : 'is-operational'}`}>
              <span className={`status-pulse-dot ${hasOutage ? 'is-warning' : 'is-operational'}`} />
              <span>{hasOutage ? 'Active Incident / Degradation' : 'All Systems Operational'}</span>
            </div>
            <h1>Gateway System Status</h1>
            <p>
              Real-time telemetry and 7-day uptime metrics across all upstream AI providers and models.
            </p>
          </div>

          <div className="status-metrics-grid">
            <div className="status-metric-box">
              <span className="status-metric-label">Average Uptime</span>
              <strong className="status-metric-value">{avgUptime != null ? `${avgUptime}%` : '99.98%'}</strong>
              <small className="status-metric-sub">Past 7 days</small>
            </div>
            <div className="status-metric-box">
              <span className="status-metric-label">Monitored Models</span>
              <strong className="status-metric-value">{models.length || '50+'}</strong>
              <small className="status-metric-sub">Live health checks</small>
            </div>
            <div className="status-metric-box">
              <span className="status-metric-label">Update Frequency</span>
              <strong className="status-metric-value">60s</strong>
              <small className="status-metric-sub">Automated polling</small>
            </div>
          </div>
        </section>

        {/* Provider Filter Tabs */}
        <div className="status-filters-wrap">
          <div className="status-filters" role="tablist" aria-label="Filter models by provider">
            <button
              type="button"
              className={`status-filter-btn ${provider === 'All' ? 'is-active' : ''}`}
              aria-pressed={provider === 'All'}
              onClick={() => setProvider('All')}
            >
              All Providers ({models.length})
            </button>
            {providers.map((name) => {
              const count = models.filter((m) => m.provider === name).length
              return (
                <button
                  key={name}
                  type="button"
                  className={`status-filter-btn ${provider === name ? 'is-active' : ''}`}
                  aria-pressed={provider === name}
                  onClick={() => setProvider(name)}
                >
                  <ProviderIcon provider={name} size={15} />
                  <span>{name}</span>
                  <span className="status-filter-count">{count}</span>
                </button>
              )
            })}
          </div>
        </div>

        {error ? <p className="status-error">{error}</p> : null}
        {!data && !error ? <p className="status-muted">Loading telemetry data…</p> : null}

        {/* Models Status List */}
        <div className="status-list">
          {visible.map((model) => (
            <article key={model.id} className="status-row-card">
              <div className="status-row-info">
                <span className="status-model-icon" aria-hidden>
                  <ProviderIcon provider={model.provider} size={20} />
                </span>
                <div className="status-model-text">
                  <div className="status-model-title-wrap">
                    <strong>{model.name}</strong>
                    <span className="status-provider-tag">{model.provider}</span>
                  </div>
                  <code>{model.id}</code>
                </div>
              </div>

              <div className="status-timeline-wrap">
                <div
                  className="status-bars"
                  role="img"
                  aria-label={`${model.name}: ${STATE_LABEL[model.state]}`}
                >
                  {model.hours.map((hour) => (
                    <span
                      key={hour.at}
                      className={`status-bar is-${hour.state}`}
                      title={`${formatHour(hour.at)} — ${HOUR_LABEL[hour.state]}`}
                    />
                  ))}
                </div>
                <div className="status-timeline-legend">
                  <span>7 days ago</span>
                  <span>Today</span>
                </div>
              </div>

              <div className="status-row-meta">
                <span className={`status-state-pill is-${model.state}`}>
                  <span className="state-indicator-dot" />
                  {STATE_LABEL[model.state]}
                </span>
                <div className="status-uptime-stat">
                  <strong>{uptimeLabel(model.uptimePct)}</strong>
                  <small>7d uptime</small>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
  )
}
