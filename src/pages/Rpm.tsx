import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { userApi, type RpmState } from '../auth/userApi'
import { useToast } from '../components/Toast'

import { lockPageScroll } from '../lib/scrollLock'
import { type RpmCatalogPlan } from '../../shared/rpm'
import './Rpm.css'

// Configuration for RPM upgrades
const RPM_TIERS: Record<number, { planId: string; cardPrice: string; cryptoPrice: string; days: number }> = {
  30: {
    planId: 'plan_hWkTlsb0JkKnQ',
    cardPrice: '10.80',
    cryptoPrice: '10.00',
    days: 30,
  },
  60: {
    planId: 'plan_S0kHbhDSzYQhx',
    cardPrice: '21.20',
    cryptoPrice: '20.00',
    days: 30,
  },
}

function formatPrice(cents: number) {
  const dollars = cents / 100
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
}

function formatUntil(iso: string | null | undefined) {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function Rpm() {
  const { toast } = useToast()
  const [data, setData] = useState<RpmState | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [watchId, setWatchId] = useState<string | null>(null)
  const [checkoutPlan, setCheckoutPlan] = useState<RpmCatalogPlan | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    const next = await userApi.rpm()
    setData(next)
    return next
  }, [])

  useEffect(() => {
    let cancelled = false
    load().catch((reason) => {
      if (!cancelled) toast(reason instanceof Error ? reason.message : 'Could not load RPM plans', 'error')
    })
    return () => {
      cancelled = true
    }
  }, [load, toast])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const paymentId = params.get('rpay')
    if (!paymentId) return
    if (params.get('canceled') === '1') {
      setBanner('Checkout canceled. Your current RPM is unchanged.')
    } else {
      setWatchId(paymentId)
      setBanner('Payment detected — waiting for confirmation…')
    }
    window.history.replaceState({}, '', '/rpm')
  }, [])

  useEffect(() => {
    if (!watchId) {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
      return
    }
    let inFlight = false
    const tick = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const status = await userApi.rpmPaymentStatus(watchId)
        if (status.credited) {
          setBanner(`Active. Your account is now at ${status.rpm.rpm} requests per minute.`)
          toast(`${status.rpm.rpm} RPM is active`)
          setData(status.rpm)
          setWatchId(null)
          return
        }
        if (status.status === 'failed' || status.status === 'expired') {
          setBanner('Payment did not complete. You can try again.')
          setWatchId(null)
          return
        }
        setBanner('Waiting for crypto confirmation…')
      } catch {
        // keep polling
      } finally {
        inFlight = false
      }
    }
    void tick()
    pollRef.current = setInterval(() => void tick(), 2000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [toast, watchId])

  useEffect(() => {
    if (!checkoutPlan) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCheckoutPlan(null)
    }
    document.addEventListener('keydown', onKey)
    const unlock = lockPageScroll()
    return () => {
      document.removeEventListener('keydown', onKey)
      unlock()
    }
  }, [checkoutPlan])




  const plans = data?.plans ?? []
  const activeKey = data?.source === 'grant' ? 'custom' : (data?.planKey ?? 'free')

  const selectedTier = checkoutPlan ? (RPM_TIERS[checkoutPlan.rpm] ?? {
    planId: checkoutPlan.rpm >= 60 ? RPM_TIERS[60].planId : RPM_TIERS[30].planId,
    cardPrice: (checkoutPlan.priceCents * 1.08 / 100).toFixed(2),
    cryptoPrice: (checkoutPlan.priceCents / 100).toFixed(2),
    days: 30,
  }) : null

  return (
    <div className="page rpm-page">
      <div className="studio-hero-header">
        <div className="studio-hero-title-group">
          <h1>RPM</h1>
          <p>
            Requests per minute for this account. One plan covers every API key. Pay cleanly with Card, Apple Pay, or Crypto.
          </p>
        </div>
        {data ? (
          <div className="rpm-current">
            <span>Current</span>
            <strong>{data.rpm} RPM</strong>
            {data.source !== 'free' && data.expiresAt ? (
              <small>until {formatUntil(data.expiresAt)} UTC</small>
            ) : null}
          </div>
        ) : null}
      </div>

      {banner ? (
        <div className="subs-banner" role="status">
          <span className="billing-banner-dot" />
          <strong>Status</strong>
          <span>{banner}</span>
        </div>
      ) : null}

      <div className="rpm-grid">
        {plans.map((plan) => {
          const active = activeKey === plan.key
          const priceLabel = plan.custom ? 'Support' : plan.priceCents <= 0 ? 'FREE' : formatPrice(plan.priceCents)
          return (
            <article key={plan.key} className={`rpm-card ${active ? 'is-active' : ''} ${plan.custom ? 'is-custom' : ''}`}>
              <div className="rpm-card-top">
                <span className="rpm-card-kicker">
                  {plan.custom ? 'Custom' : plan.termLabel || (plan.key === 'free' ? 'Included' : 'Paid plan')}
                </span>
                {active ? <span className="rpm-pill">Active</span> : null}
              </div>
              <h2>{plan.custom ? 'Custom' : `${plan.rpm} RPM`}</h2>
              <p>
                {plan.custom
                  ? 'A custom ceiling set on this account by support.'
                  : plan.key === 'free'
                    ? 'On every account from the start. Enough to try a model and run short loops.'
                    : `${plan.rpm} requests per minute for 30 days, shared across every active API key on this account.`}
              </p>
              {active && data?.expiresAt && plan.key !== 'free' ? (
                <p className="rpm-card-until">Until {formatUntil(data.expiresAt)} UTC</p>
              ) : null}
              <div className="rpm-card-foot">
                {plan.custom ? (
                  <a
                    className="btn btn-secondary rpm-btn"
                    href={data?.supportUrl || undefined}
                    target="_blank"
                    rel="noreferrer"
                    aria-disabled={!data?.supportUrl}
                    onClick={(event) => {
                      if (!data?.supportUrl) event.preventDefault()
                    }}
                  >
                    Contact support
                  </a>
                ) : plan.priceCents <= 0 ? (
                  <button className="btn btn-secondary rpm-btn" type="button" disabled>
                    {active ? 'Active' : 'Included'}
                  </button>
                ) : (
                  <button
                    className={`btn rpm-btn ${active ? 'btn-secondary' : 'btn-primary'}`}
                    type="button"
                    disabled={active || !plan.enabled}
                    onClick={() => {
                      setCheckoutPlan(plan)
                    }}
                  >
                    {active ? 'Active' : `BUY (${priceLabel})`}
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>

      {checkoutPlan && selectedTier ? createPortal(
        <div className="rpm-modal-root" role="dialog" aria-modal="true" aria-labelledby="rpm-modal-title">
          <button className="rpm-modal-backdrop" type="button" aria-label="Close dialog" onClick={() => setCheckoutPlan(null)} />
          <div className="rpm-modal-panel">
            <div className="rpm-modal-header">
              <h2 id="rpm-modal-title">Upgrade to {checkoutPlan.rpm} RPM</h2>
              <button
                className="btn btn-ghost btn-icon modal-close"
                type="button"
                aria-label="Close"
                onClick={() => setCheckoutPlan(null)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <p className="rpm-modal-desc">
              Get {checkoutPlan.rpm} requests per minute for 30 days, active across all API keys on your account.
              Select your payment method:
            </p>

            <div className="rpm-modal-methods">
              <button
                type="button"
                className="rpm-method-btn"
                disabled
                title="Card payments are currently disabled"
                style={{ opacity: 0.5, cursor: 'not-allowed' }}
              >
                <div className="rpm-method-top">
                  <span className="rpm-method-title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="2" y="5" width="20" height="14" rx="2" />
                      <line x1="2" y1="10" x2="22" y2="10" />
                    </svg>
                    Card / Pay (Disabled)
                  </span>
                  <span className="rpm-method-price">${selectedTier.cardPrice}</span>
                </div>
                <span className="rpm-method-note">Payments disabled — configure your card gateway</span>
              </button>

              <button
                type="button"
                className="rpm-method-btn"
                disabled
                title="Crypto payments are currently disabled"
                style={{ opacity: 0.5, cursor: 'not-allowed' }}
              >
                <div className="rpm-method-top">
                  <span className="rpm-method-title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9.5" />
                      <path d="M8.5 8h4.5a2 2 0 0 1 0 4H8.5m0 0H14a2 2 0 0 1 0 4H8.5" />
                      <path d="M8.5 6.5v11" />
                      <path d="M11 5v2m0 10v2m3-14v2m0 10v2" />
                    </svg>
                    Crypto (Disabled)
                  </span>
                  <span className="rpm-method-price">${selectedTier.cryptoPrice}</span>
                </div>
                <span className="rpm-method-note">Crypto gateway disabled</span>
              </button>
            </div>

            <div className="rpm-pay-action">
              <button
                id="rpm-pay-btn"
                className="btn btn-primary rpm-pay-submit"
                type="button"
                disabled
              >
                Payments disabled (configure provider)
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}


    </div>
  )
}
