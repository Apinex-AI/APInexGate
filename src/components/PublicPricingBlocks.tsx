import { Link } from 'react-router-dom'
import { formatTokenCount } from '../../shared/billing'
import { officialPriceForModel } from '../../shared/officialPrices'
import { providerSlug } from '../lib/providerStyle'
import { ProviderIcon } from './ProviderIcon'
import { BrandName } from '../components/BrandName'

export type PublicPlan = {
  key: string
  label: string
  days: number
  priceUsd: number
  kind: 'custom' | 'unlimited'
  tokenLimit: number
  isFeatured?: boolean
}

export type PublicModelPrice = {
  id: string
  provider: string
  name: string
  dollarsPer1M: number
  inputDollarsPer1M?: number
  outputDollarsPer1M?: number
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return '—'
  if (value <= 0) return 'Free'
  if (value >= 1) return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`
  const text = value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return `$${text}`
}

function formatOfficial(min: number, max?: number) {
  if (max != null && max !== min) return `${formatUsd(min)}–${formatUsd(max)}`
  return formatUsd(min)
}

export function PlanGrid({ plans }: { plans: PublicPlan[] }) {
  if (plans.length === 0) return null
  return (
    <div className="lp-plan-grid">
      {plans.map((plan) => (
        <article key={plan.key} className={`lp-plan lp-plan-${plan.key} ${plan.isFeatured ? 'is-featured' : ''}`}>
          <div className="lp-plan-top">
            <strong>{plan.label}</strong>
            {plan.isFeatured ? <span>Best value</span> : null}
          </div>
          <div className="lp-plan-figures">
            <p className="lp-plan-price">{formatUsd(plan.priceUsd)}</p>
            <p className="lp-plan-tokens">
              {plan.kind === 'unlimited' ? 'Unlimited' : formatTokenCount(plan.tokenLimit)}
            </p>
          </div>
          <p className="lp-plan-note">For free-category models. Pay-as-you-go models stay on the wallet.</p>
        </article>
      ))}
    </div>
  )
}

export function PriceCompare({ models }: { models: PublicModelPrice[] }) {
  const rows = models
  if (rows.length === 0) return null
  return (
    <div className="lp-compare-wrap">
      <table className="lp-compare">
        <thead>
          <tr>
            <th>Model</th>
            <th><BrandName /> input</th>
            <th><BrandName /> output</th>
            <th>Official input</th>
            <th>Official output</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((model) => {
            const official = officialPriceForModel(model.id)
            const slug = providerSlug(model.provider)
            const input = Number(model.inputDollarsPer1M ?? model.dollarsPer1M) || 0
            const output = Number(model.outputDollarsPer1M ?? model.dollarsPer1M) || input
            const isFree = model.provider === 'Free' || model.id.startsWith('free/') || (input <= 0 && output <= 0)
            return (
              <tr key={model.id}>
                <td>
                  <span className={`lp-compare-model lp-compare-${slug}`}>
                    <ProviderIcon provider={model.provider} size={18} />
                    <span>
                      <strong>{model.name}</strong>
                      <code>{model.id}</code>
                    </span>
                  </span>
                </td>
                <td>{isFree ? 'free' : <>{formatUsd(input)}<small> / 1M</small></>}</td>
                <td>{isFree ? 'free' : <>{formatUsd(output)}<small> / 1M</small></>}</td>
                <td>{official ? formatOfficial(official.inputPer1M, official.inputPer1MMax) : '—'}</td>
                <td>{official ? formatOfficial(official.outputPer1M, official.outputPer1MMax) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="lp-compare-note">
        <BrandName /> input and output are billed at their own rates per 1M tokens. Free-category models show free in both <BrandName /> columns.
        Official columns are the provider’s published standard API price per 1M tokens. A dash means that model id has
        no matching public price list. DeepSeek ranges are the published cache-miss off-peak to peak rates.
      </p>
    </div>
  )
}

export function PricingCtas({ loggedIn }: { loggedIn: boolean }) {
  return (
    <div className="lp-pricing-cta">
      <Link className="btn btn-primary" to={loggedIn ? '/subscriptions' : '/register'} target="_blank" rel="noreferrer">
        {loggedIn ? 'View subscriptions' : 'Create account'}
      </Link>
      <Link className="btn btn-secondary" to="/pricing" target="_blank" rel="noreferrer">
        Full price list
      </Link>
    </div>
  )
}
