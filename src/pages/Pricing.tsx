import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatTokenCount } from '../../shared/billing'
import { PROVIDER_ORDER } from '../../shared/providers'

type PublicPlan = {
  key: string
  label: string
  days: number
  kind: 'custom' | 'unlimited'
  tokenLimit: number | null
  priceUsd: number
  isFeatured?: boolean
}
import { BrandName } from '../components/BrandName'
import { providerSlug } from '../lib/providerStyle'

import { PublicChrome } from '../components/PublicChrome'
import { ProviderIcon } from '../components/ProviderIcon'
import { useToast } from '../components/Toast'
import { ModelPreviewModal, type PreviewModel } from '../components/ModelPreviewModal'
import {
  displayModelId,
  getModelUptime,
  UptimeBadge,
  EventPrice,
  formatContextWindowLabel,
} from './Models'
import './Models.css'
import './Subscriptions.css'
import './Pricing.css'

type PublicModel = {
  id: string
  provider: string
  name: string
  contextWindow: string
  weight: number
  dollarsPer1M: number
  eventDiscountPct?: number | null
}

export function PricingPage() {
  const { toast } = useToast()
  const [plans, setPlans] = useState<PublicPlan[]>([])
  const [models, setModels] = useState<PublicModel[]>([])
  const [provider, setProvider] = useState('All')
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<PreviewModel | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [uptimeMap, setUptimeMap] = useState<Record<string, number | null>>({})

  useEffect(() => {
    let cancelled = false
    fetch('/api/public/subscriptions')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data?.plans)) return
        setPlans(data.plans)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    fetch('/api/public/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.models) return
        const map: Record<string, number | null> = {}
        for (const m of data.models) {
          map[m.id] = m.uptimePct
          map[m.id.replace('/', '-')] = m.uptimePct
          map[m.name.toLowerCase()] = m.uptimePct
        }
        setUptimeMap(map)
      })
      .catch(() => undefined)

    fetch('/api/public/models')
      .then(async (res) => {
        if (!res.ok) return
        const data = (await res.json()) as { models?: PublicModel[] }
        setModels(Array.isArray(data.models) ? data.models : [])
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [])

  const providers = useMemo(() => {
    const present = new Set(models.map((model) => model.provider))
    return ['All', ...PROVIDER_ORDER.filter((name) => present.has(name))]
  }, [models])

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase()
    return models.filter((m) => {
      const matchProv = provider === 'All' || m.provider === provider
      const matchSearch = !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
      return matchProv && matchSearch
    })
  }, [models, provider, search])

  return (
    <PublicChrome newTab>
      <div className="pricing-page-wrap">
        {/* Hero Header */}
        <header className="pricing-hero-head">
          <h1>Model &amp; Token Pricing</h1>
        </header>

        <section className="card" aria-labelledby="subs-heading">
          <div className="subscriptions-header">
            <div>
              <span className="subscriptions-tag">Free models</span>
              <h2 id="subs-heading">Subscriptions</h2>
              <p>A timed token pool. When it ends, the daily free allowance takes over.</p>
            </div>
          </div>
          <div className="subs-plan-grid">
            {plans.map((plan) => (
              <article key={plan.key} className={`subs-plan ${plan.isFeatured ? 'is-featured' : ''}`}>
                <strong>{plan.label}</strong>
                <em>{plan.days} day{plan.days === 1 ? '' : 's'}</em>
                <b>{plan.kind === 'unlimited' ? 'Unlimited' : formatTokenCount(plan.tokenLimit ?? 0)}</b>
                <span>${Number.isInteger(plan.priceUsd) ? plan.priceUsd : plan.priceUsd.toFixed(2)}</span>
              </article>
            ))}
          </div>
          <div className="pricing-action-bar">
            <div className="pricing-action-btns">
              <Link className="btn btn-primary" to="/register" target="_blank" rel="noreferrer">
                Get started
              </Link>
              <Link className="btn btn-secondary" to="/subscriptions" target="_blank" rel="noreferrer">
                View subscriptions
              </Link>
            </div>
          </div>
        </section>

        {/* Section 2: Pay As You Go Models (format of Models.tsx) */}
        <section className="pricing-models-card">
          <div className="pricing-section-top">
            <div className="pricing-section-title-wrap">
              <h2>Pay-As-You-Go Models</h2>
              <p>One flat <BrandName /> rate covers both input and output. Zero split markup.</p>
            </div>
          </div>

          <div className="pricing-models-toolbar">
            <div className="models-provider-bar" role="tablist" aria-label="Filter models by provider">
              {providers.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={provider === p}
                  className={`models-provider-tab ${provider === p ? 'is-active' : ''} ${p !== 'All' ? `tab-${providerSlug(p)}` : ''}`}
                  onClick={() => setProvider(p)}
                >
                  {p !== 'All' && <ProviderIcon provider={p} size={13} />}
                  <span>{p}</span>
                </button>
              ))}
            </div>

            <input
              type="text"
              placeholder="Search models…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pricing-search-input"
            />
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
                {filteredModels.map((model) => {
                  const slug = providerSlug(model.provider)
                  const isFree = model.provider === 'Free' || model.id.startsWith('free/') || model.dollarsPer1M <= 0
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
                          dollarsPer1M: model.dollarsPer1M,
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
                            <ProviderIcon provider={model.provider} size={18} />
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
                            dollars={model.dollarsPer1M}
                            discountPct={model.eventDiscountPct}
                          />
                        </div>
                      </td>

                      <td className="td-price">
                        <div className="model-cell-rate">
                          <EventPrice
                            isFree={isFree}
                            dollars={model.dollarsPer1M}
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
                              dollarsPer1M: model.dollarsPer1M,
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
        </section>

        {/* Modal Inspector for Model Details */}
        <ModelPreviewModal
          model={preview}
          onClose={() => setPreview(null)}
          onCopy={(text) => {
            void navigator.clipboard?.writeText(text)
            toast(text.includes('\n') ? 'Copied' : `Copied ${text}`)
          }}
        />
      </div>
    </PublicChrome>
  )
}