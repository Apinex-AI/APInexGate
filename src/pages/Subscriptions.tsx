import { useCallback, useEffect, useMemo, useState } from 'react'

import { useToast } from '../components/Toast'
import { userApi, type SubscriptionPlanOption, type SubscriptionsResponse } from '../auth/userApi'
import { formatFullTokenCount, formatTokenCount } from '../../shared/billing'

import './Subscriptions.css'

function formatCountdown(expiresAt: string, now: number) {
  const left = Math.max(0, Date.parse(expiresAt) - now)
  const total = Math.floor(left / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

function money(usd: number) {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`
}

function allowance(plan: SubscriptionPlanOption) {
  if (plan.kind === 'unlimited') return 'Unlimited'
  return formatTokenCount(plan.tokenLimit ?? 0)
}

export function Subscriptions() {
  const { toast } = useToast()
  const [data, setData] = useState<SubscriptionsResponse | null>(null)
  const [selected, setSelected] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    const next = await userApi.subscriptions()
    setData(next)
    return next
  }, [])

  useEffect(() => {
    let cancelled = false
    load()
      .then((next) => {
        if (cancelled) return
        const featured = next.plans?.find((plan) => plan.isFeatured) ?? next.plans?.[0]
        if (featured) setSelected(featured.key)
      })
      .catch((reason) => {
        if (!cancelled) toast(reason instanceof Error ? reason.message : 'Could not load subscriptions', 'error')
      })
    return () => {
      cancelled = true
    }
  }, [load, toast])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const plans = data?.plans ?? []
  const access = data?.access ?? null
  const plan = useMemo(() => plans.find((item) => item.key === selected) ?? plans[0] ?? null, [plans, selected])
  const subscribed = access?.mode === 'subscription'
  const offerActive = Boolean(data?.offer && Date.parse(data.offer.expiresAt) > now)

  return (
    <div className="page subscriptions-page">
      <div className="studio-hero-header">
        <div className="studio-hero-title-group">
          <h1>Subscriptions</h1>
          <p>
            A timed token pool for the <strong>Free</strong> models. Paid models still bill the USD wallet.
          </p>
        </div>
      </div>

      <section className="subs-status" aria-label="Current allowance">
        <div>
          <span className="subs-kicker">{subscribed ? 'Active plan' : 'Daily free'}</span>
          <h2>{access?.planLabel ?? 'FREE'}</h2>
          <p>
            {subscribed && access?.expiresAt
              ? `Expires in ${formatCountdown(access.expiresAt, now)}`
              : `Resets in ${access?.resetsAt ? formatCountdown(access.resetsAt, now) : '—'}`}
          </p>
        </div>
        <strong>
          {access?.unlimited ? 'Unlimited' : `${formatTokenCount(access?.remaining ?? 0)} left`}
        </strong>
      </section>

      <section className="subs-plan-grid" aria-label="Subscription plans">
        {plans.map((item) => {
          const active = item.key === (plan?.key ?? '')
          return (
            <button
              key={item.key}
              type="button"
              className={`subs-plan ${active ? 'is-selected' : ''} ${item.isFeatured ? 'is-featured' : ''}`}
              onClick={() => setSelected(item.key)}
            >
              <span className="subs-plan-top">
                <em>{item.days} day{item.days === 1 ? '' : 's'}</em>
                {item.isFeatured ? <span className="subs-pill">Best value</span> : null}
              </span>
              <b>{allowance(item)}</b>
              <span className="subs-plan-price">
                {offerActive && (item.listPriceUsd ?? 0) > item.priceUsd ? (
                  <s>{money(item.listPriceUsd ?? item.priceUsd)}</s>
                ) : null}
                {money(item.priceUsd)}
              </span>
              <small>
                {item.kind === 'unlimited'
                  ? 'No token cap for the period'
                  : `${formatFullTokenCount(item.tokenLimit ?? 0)} tokens`}
              </small>
            </button>
          )
        })}
      </section>

      {offerActive && data?.offer ? (
        <div className="promo-boost-banner" role="status">
          <span>
            <strong>Subscription discount active</strong>: {data.offer.label} on subscription plans.
          </span>
          <small>Ends in {formatCountdown(data.offer.expiresAt, now)}</small>
        </div>
      ) : null}

      {data?.promoBoost && data.promoBoost.bonusPct > 0 ? (
        <div className="promo-boost-banner" role="status">
          <span>
            <strong>Promo bonus active</strong>: +{data.promoBoost.bonusPct}% tokens on the next subscription.
          </span>
          <small>Ends in {formatCountdown(data.promoBoost.expiresAt, now)}</small>
        </div>
      ) : null}

      <section className="card subs-pay" aria-labelledby="subs-pay-heading">
        <h2 id="subs-pay-heading">Payment</h2>
        <div className="subs-pay-summary">
          <span>
            {plan ? `${plan.days} day${plan.days === 1 ? '' : 's'} · ${allowance(plan)}` : 'Select a plan'}
          </span>
          <strong>{plan ? money(plan.priceUsd) : '—'}</strong>
        </div>
        <div className="method-grid">
          <button type="button" className="method-card" disabled title="Crypto payments are currently disabled">
            <div className="method-info">
              <span className="rpm-method-title">Crypto (Disabled)</span>
              <small>Payments disabled — configure your crypto gateway</small>
            </div>
          </button>
          <button type="button" className="method-card" disabled title="Card payments are currently disabled">
            <div className="method-info">
              <span className="rpm-method-title">Card (Disabled)</span>
              <small>Payments disabled — configure your card gateway</small>
            </div>
          </button>
        </div>
        <button className="btn btn-primary btn-lg pay-btn" type="button" disabled>
          Payments disabled
        </button>
      </section>
    </div>
  )
}
