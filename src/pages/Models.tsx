import { useEffect, useMemo, useState } from 'react'
import { userApi, type CustomerModel, type ModelHealthStatus } from '../auth/userApi'
import { useToast } from '../components/Toast'
import { ProviderIcon } from '../components/ProviderIcon'
import { providerSlug } from '../lib/providerStyle'


import { sortProviders } from '../../shared/providers'
import { isFreeWeight } from '../../shared/billing'
import { ModelPreviewModal, setStatusModelsCache, type PreviewModel } from '../components/ModelPreviewModal'
import './Models.css'

export function displayModelId(id: string, provider: string): string {
  if (provider === 'Free' || id.startsWith('free/')) return id
  return id.replace('/', '-')
}

export function Models() {
  const { toast } = useToast()
  const [models, setModels] = useState<CustomerModel[]>([])
  const [loading, setLoading] = useState(true)
  const [provider, setProvider] = useState('All')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewModel | null>(null)
  const [uptimeMap, setUptimeMap] = useState<Record<string, number | null>>({})

  useEffect(() => {
    let cancelled = false
    fetch('/api/public/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.models) return
        setStatusModelsCache(data.models)
        const map: Record<string, number | null> = {}
        for (const m of data.models) {
          map[m.id] = m.uptimePct
          map[m.id.replace('/', '-')] = m.uptimePct
          map[m.name.toLowerCase()] = m.uptimePct
        }
        setUptimeMap(map)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    async function load() {
      try {
        // Prefer authed catalog (includes health) when session exists.
        const data = await userApi.models()
        if (cancelled) return
        setModels(data.models)
      } catch {
        /* guest → public catalog */
        try {
          const res = await fetch('/api/public/models')
          if (!res.ok) throw new Error('Could not load models')
          const data = (await res.json()) as {
            models?: Array<{
              id: string
              provider: string
              name: string
              contextWindow: string
              weight: number
              dollarsPer1M: number
              inputDollarsPer1M?: number
              outputDollarsPer1M?: number
              eventDiscountPct?: number | null
              health?: ModelHealthStatus
            }>
          }
          if (cancelled) return
          setModels(
            (data.models ?? []).map((m) => ({
              ...m,
              tags: [],
              health: m.health ?? 'no_data',
            })),
          )
        } catch (reason) {
          if (!cancelled) {
            toast(reason instanceof Error ? reason.message : 'Could not load models', 'error')
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast identity can thrash; load once on mount
  }, [])

  const providers = useMemo(
    () => ['All', ...sortProviders(Array.from(new Set(models.map((model) => model.provider))))],
    [models],
  )

  const filtered = useMemo(() => {
    return models.filter((model) => {
      return provider === 'All' || model.provider === provider
    })
  }, [models, provider])


  return (
    <div className="page models-page">
      <div className="page-header models-page-header">
        <div>
          <h1>Models & Pricing</h1>
          <p>
            {loading && models.length === 0
              ? 'Loading catalog…'
              : `${models.length} active models across OpenAI, Anthropic, Gemini, DeepSeek & open weights`}
          </p>
        </div>
      </div>

      <div className="models-toolbar">
        <div className="models-provider-bar" role="tablist" aria-label="Filter models by provider">
          {providers.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={provider === item}
              className={`models-provider-tab ${provider === item ? 'is-active' : ''} ${item !== 'All' ? `tab-${providerSlug(item)}` : ''}`}
              onClick={() => setProvider(item)}
            >
              {item !== 'All' && <ProviderIcon provider={item} size={13} />}
              <span>{item}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="models-table-container">
        <table className="models-table">
          <thead>
            <tr>
              <th className="th-name">Name</th>
              <th className="th-ctx">Context</th>
              <th className="th-price">Input / 1M</th>
              <th className="th-price">Output / 1M</th>
              <th className="th-uptime">Uptime</th>
              <th className="th-action" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((model) => {
              const slug = providerSlug(model.provider)
              const isFree = model.provider === 'Free' || model.id.startsWith('free/') || isFreeWeight(model.weight)
              const displayId = displayModelId(model.id, model.provider)
              const isCopied = copiedId === displayId
              const uptime = getModelUptime(model.id, model.name, uptimeMap)

              return (
                <tr
                  key={model.id}
                  className={`model-row model-row-${slug}${isFree ? ' is-free' : ''}`}
                  onClick={() =>
                    setPreview({
                      kind: 'chat',
                      id: displayId,
                      catalogId: model.id,
                      name: model.name,
                      provider: model.provider,
                      dollarsPer1M: modelPrice(model).input,
                      outputDollarsPer1M: modelPrice(model).output,
                      eventDiscountPct: model.eventDiscountPct,
                      isFree,
                      healthLabel: '',
                      healthStatus: 'no_data',
                    })
                  }
                >
                  <td className="td-name">
                    <div className="model-name-cell">
                      <div className="model-cell-icon" aria-hidden>
                        <ProviderIcon provider={model.provider} modelId={model.id} size={18} />
                      </div>
                      <div className="model-name-info">
                        <strong className="model-cell-title">{model.name}</strong>
                        <div className="model-cell-id-row">
                          <code className="model-cell-code">{displayId}</code>
                          <button
                            className={`model-cell-copy ${isCopied ? 'is-copied' : ''}`}
                            type="button"
                            title="Copy model ID"
                            aria-label={`Copy ${displayId}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              void navigator.clipboard?.writeText(displayId)
                              toast(`Copied ${displayId}`)
                              setCopiedId(displayId)
                              setTimeout(() => setCopiedId(null), 1800)
                            }}
                          >
                            {isCopied ? (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.8" aria-hidden>
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            ) : (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  </td>

                  <td className="td-ctx">
                    <span className="model-cell-badge">
                      {formatContextWindowLabel(model.contextWindow)}
                    </span>
                  </td>

                  <td className="td-price">
                    <div className="model-cell-rate">
                      <EventPrice
                        isFree={isFree}
                        dollars={modelPrice(model).input}
                        discountPct={model.eventDiscountPct}
                      />
                    </div>
                  </td>

                  <td className="td-price">
                    <div className="model-cell-rate">
                      <EventPrice
                        isFree={isFree}
                        dollars={modelPrice(model).output}
                        discountPct={model.eventDiscountPct}
                      />
                    </div>
                  </td>

                  <td className="td-uptime">
                    <UptimeBadge uptime={uptime} />
                  </td>

                  <td className="td-action">
                    <button
                      className="model-more-btn"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPreview({
                          kind: 'chat',
                          id: displayId,
                          catalogId: model.id,
                          name: model.name,
                          provider: model.provider,
                          dollarsPer1M: modelPrice(model).input,
                          outputDollarsPer1M: modelPrice(model).output,
                          eventDiscountPct: model.eventDiscountPct,
                          isFree,
                          healthLabel: '',
                          healthStatus: 'no_data',
                        })
                      }}
                    >
                      <span>More</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                        <path d="M5 12h14M12 5l7 7-7 7" />
                      </svg>
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {!loading && filtered.length === 0 ? (
        <div className="empty-state card">
          <p>{models.length === 0 ? 'No models available yet.' : 'No models match that filter.'}</p>
          {models.length > 0 ? (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => {
                setProvider('All')
              }}
            >
              Reset filters
            </button>
          ) : null}
        </div>
      ) : null}

      <ModelPreviewModal
        model={preview}
        onClose={() => setPreview(null)}
        onCopy={(text) => {
          void navigator.clipboard?.writeText(text)
          toast(text.includes('\n') ? 'Copied' : `Copied ${text}`)
        }}
      />
    </div>
  )
}

export function getModelUptime(modelId: string, modelName: string, map: Record<string, number | null>): number {
  if (map[modelId] != null) return map[modelId]!
  const dashed = modelId.replace('/', '-')
  if (map[dashed] != null) return map[dashed]!
  const lower = modelName.toLowerCase()
  if (map[lower] != null) return map[lower]!
  return 100.0
}

export function UptimeBadge({ uptime }: { uptime: number }) {
  const tone = uptime >= 99.0 ? 'is-good' : uptime >= 95.0 ? 'is-mid' : 'is-poor'
  return (
    <span className={`model-uptime-badge ${tone}`}>
      <span className="uptime-dot" />
      <span>{uptime.toFixed(1)}%</span>
    </span>
  )
}

function modelPrice(model: { id?: string; provider?: string; dollarsPer1M: number; inputDollarsPer1M?: number; outputDollarsPer1M?: number }) {
  const input = Number(model.inputDollarsPer1M ?? model.dollarsPer1M) || 0
  const isJev = model.provider === 'Jev Group' || /jev-|drex|subq|decision/i.test(model.id ?? '')
  const rawOut = model.outputDollarsPer1M
  const output = rawOut != null && Number.isFinite(Number(rawOut)) && (Number(rawOut) > 0 || isJev)
    ? Number(rawOut)
    : isJev
      ? 0
      : input
  return { input: Math.max(0, input), output: Math.max(0, output) }
}

function formatPrice(value: number) {
  if (!Number.isFinite(value)) return '0.00'
  const milli = Math.round(value * 1000)
  if (milli % 10 !== 0) return value.toFixed(3)
  return value.toFixed(2)
}

export function EventPrice({
  isFree,
  dollars,
  discountPct,
}: {
  isFree: boolean
  dollars: number
  discountPct?: number | null
}) {
  if (isFree) {
    return <strong>free</strong>
  }
  const pct = Number(discountPct)
  if (!Number.isFinite(pct) || pct <= 0) {
    return <strong>{`$${formatPrice(dollars)}`}</strong>
  }
  const next = pct >= 100 ? 0 : Math.round(dollars * (100 - pct)) / 100
  return (
    <strong className="price-event">
      <s>${formatPrice(dollars)}</s>
      <em>{pct >= 100 ? 'FREE' : `$${formatPrice(next)}`}</em>
      <small className="price-event-pct">{pct}% off</small>
    </strong>
  )
}

export function discountedDollars(dollars: number, discountPct?: number | null) {
  const pct = Number(discountPct)
  if (!Number.isFinite(pct) || pct <= 0) return dollars
  if (pct >= 100) return 0
  return Math.round(dollars * (100 - pct)) / 100
}

export function formatWeight(weight: number) {
  if (!Number.isFinite(weight)) return '1'
  return Number.isInteger(weight) ? String(weight) : String(Math.round(weight * 100) / 100)
}



/** Show 1M / 1.04M / 1.2M instead of 1000K / 1040K / 1200K. */
export function formatContextWindowLabel(raw: string) {
  const value = (raw || '').trim()
  if (!value || value === '—') return value || '—'

  const match = value.match(/^([\d.,]+)\s*([kKmM])?$/)
  if (!match) return value

  const amount = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(amount) || amount <= 0) return value

  const unit = (match[2] || '').toUpperCase()
  let tokens = amount
  if (unit === 'K') tokens = amount * 1_000
  if (unit === 'M') tokens = amount * 1_000_000

  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    const label = Number.isInteger(m)
      ? String(m)
      : m
          .toFixed(2)
          .replace(/0+$/, '')
          .replace(/\.$/, '')
    return `${label}M`
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000
    const label = Number.isInteger(k) ? String(k) : k.toFixed(1).replace(/\.0$/, '')
    return `${label}K`
  }
  return String(Math.round(tokens))
}
