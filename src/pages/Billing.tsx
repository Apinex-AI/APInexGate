import { useCustomer } from '../auth/CustomerContext'
import { useToast } from '../components/Toast'
import {
  userApi,
  type BillingConfig,
} from '../auth/userApi'
import { formatUsdBalance, formatUsdExact } from '../../shared/billing'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import './Billing.css'

const FALLBACK_PRESETS = [500, 1000, 2000, 5000]

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

export function Billing() {
  const { user, refresh } = useCustomer()
  const { toast } = useToast()
  const [config, setConfig] = useState<BillingConfig | null>(null)
  const [amount, setAmount] = useState('')
  const [watchPaymentId, setWatchPaymentId] = useState<string | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [now, setNow] = useState(() => Date.now())

  const presets = useMemo(() => config?.presets ?? FALLBACK_PRESETS, [config])
  const minTopupDollars = useMemo(() => (config?.minTopupCents ?? 100) / 100, [config?.minTopupCents])
  const numAmount = Number(amount)
  const isAmountValid = Number.isFinite(numAmount) && numAmount >= minTopupDollars && numAmount <= 100_000
  const isAmountBelowMin = amount.trim() !== '' && Number.isFinite(numAmount) && numAmount < minTopupDollars
  const promoBonusPct = config?.promoBoost?.bonusPct ?? 0
  const promoExpiresAt = config?.promoBoost?.expiresAt ?? null

  useEffect(() => {
    if (!promoExpiresAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [promoExpiresAt])

  const bonusUsd = promoBonusPct > 0 && isAmountValid ? Number(((numAmount * promoBonusPct) / 100).toFixed(2)) : 0
  const totalUsdToCredit = isAmountValid ? numAmount + bonusUsd : 0

  const refreshPayments = useCallback(async () => {
    const data = await userApi.billingPayments()
    return data.payments
  }, [])

  useEffect(() => {
    let cancelled = false
    userApi
      .billingConfig()
      .then((billingConfig) => {
        if (cancelled) return
        setConfig(billingConfig)
        const first = billingConfig.presets[0]
        if (first) setAmount(String(first / 100))
      })
      .catch((reason) => {
        toast(reason instanceof Error ? reason.message : 'Could not load billing', 'error')
      })
    return () => {
      cancelled = true
    }
  }, [toast])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const paymentId = params.get('payment')
    const paid = params.get('paid') === '1'
    const canceled = params.get('canceled') === '1'

    if (canceled || params.get('status') === 'canceled' || params.get('status') === 'failed') {
      toast('Payment canceled', 'info')
      setBanner(null)
      window.history.replaceState({}, '', '/billing')
      return
    }

    if (paid || paymentId) {
      setWatchPaymentId(paymentId)
      setBanner(
        paymentId
          ? 'Payment detected — waiting for blockchain confirmation and automatic credit…'
          : 'Payment received — balance updates after confirmation',
      )
      toast('Payment flow returned — watching for credit…')
      void refresh()
      void refreshPayments().catch(() => undefined)
      window.history.replaceState({}, '', paymentId ? `/billing?payment=${encodeURIComponent(paymentId)}` : '/billing')
    }
  }, [refresh, refreshPayments, toast])

  // Poll only while waiting on a specific payment — one status call, not me+payments spam.
  useEffect(() => {
    if (!watchPaymentId) {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }

    let inFlight = false
    const tick = async () => {
      if (inFlight) return
      inFlight = true
      try {
        void refresh()
        const list = await refreshPayments()
        const row = list.find((payment) => payment.id === watchPaymentId || payment.orderId === watchPaymentId)
        if (!row) return
        if (row.uiStatus === 'credited' || row.creditedAt) {
          setBanner(`Credited +$${(row.amountUsd ?? row.amountCents / 100).toFixed(2)}`)
          toast('Balance credited', 'info')
          setWatchPaymentId(null)
          void refresh()
        } else if (row.uiStatus === 'confirming') {
          setBanner('Waiting blockchain confirmations…')
        } else if (row.uiStatus === 'failed' || row.uiStatus === 'expired') {
          setBanner(row.statusLabel)
          setWatchPaymentId(null)
        }
      } catch {
        // keep polling quietly
      } finally {
        inFlight = false
      }
    }

    void tick()
    void refresh()
    pollRef.current = setInterval(() => {
      void tick()
    }, 1_000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [refresh, refreshPayments, toast, watchPaymentId])



  return (
    <div className="page billing-page">
      {banner ? (
        <div className="billing-banner" role="status">
          <span className="billing-banner-dot" />
          <strong>Payment status</strong>
          <span>{banner}</span>
        </div>
      ) : null}

      <div className="billing-layout">
        <section className="card billing-main-card">
          {/* Futuristic Wallet Status Bar */}
          <div className="topup-wallet-bar">
            <div className="topup-wallet-meta">
              <span className="topup-wallet-tag">
                <span className="live-pulse-dot" /> Current Balance
              </span>
              <div className="topup-wallet-amount">
                <strong>{formatUsdBalance(user.balanceTokens)}</strong>
              </div>
            </div>
          </div>

          {/* Amount Selection */}
          <div className="topup-card-section">
            <div className="section-block-header">
              <h2>Amount (USD)</h2>
            </div>

            <div className="amount-input-group">
              <span className="amount-currency-symbol">$</span>
              <input
                type="number"
                inputMode="decimal"
                min={minTopupDollars}
                max={100000}
                step="any"
                placeholder={String(minTopupDollars)}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={`amount-custom-input ${isAmountBelowMin ? 'is-invalid' : ''}`}
                aria-label="Top-up amount in USD"
              />
              <span className="amount-currency-tag">USD</span>
            </div>

            {isAmountBelowMin ? (
              <p className="amount-warn-hint" role="alert">
                ⚠️ Minimum top-up is ${minTopupDollars.toFixed(2)}
              </p>
            ) : null}

            <div className="amount-grid">
              {presets.map((cents) => {
                const dollars = cents / 100
                const label = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
                return (
                  <button
                    key={cents}
                    type="button"
                    className={`amount-chip ${Number(amount) === dollars ? 'is-active' : ''}`}
                    onClick={() => setAmount(String(dollars))}
                  >
                    {label}
                  </button>
                )
              })}
            </div>

            {promoBonusPct > 0 && isAmountValid ? (
              <div className="promo-topup-bonus" role="status">
                <div className="promo-bonus-copy">
                  <span>
                    <strong>Promo bonus active</strong>: +{promoBonusPct}% extra balance added automatically.
                    <em>+{formatUsdExact(bonusUsd)} bonus = {formatUsdExact(totalUsdToCredit)} total</em>
                  </span>
                </div>
                {promoExpiresAt ? (
                  <small className="promo-bonus-timer">
                    Ends in {formatCountdown(promoExpiresAt, now)}
                  </small>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Payment Method */}
          <div className="topup-card-section">
            <h2>Payment Method</h2>
            <div className="method-grid">
              <button
                type="button"
                className="method-card"
                disabled
                title="Crypto payments are currently disabled"
                style={{ opacity: 0.5, cursor: 'not-allowed' }}
              >
                <div className="method-info">
                  <span className="rpm-method-title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9.5" />
                      <path d="M8.5 8h4.5a2 2 0 0 1 0 4H8.5m0 0H14a2 2 0 0 1 0 4H8.5" />
                      <path d="M8.5 6.5v11" />
                      <path d="M11 5v2m0 10v2m3-14v2m0 10v2" />
                    </svg>
                    Crypto Gateway (Disabled)
                  </span>
                  <small>Payments disabled — configure your crypto gateway</small>
                </div>
              </button>
              <button
                type="button"
                className="method-card"
                disabled
                title="Card payments are currently disabled"
                style={{ opacity: 0.5, cursor: 'not-allowed' }}
              >
                <div className="method-info">
                  <span className="rpm-method-title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="2" y="5" width="20" height="14" rx="2" />
                      <line x1="2" y1="10" x2="22" y2="10" />
                    </svg>
                    Card / Pay (Disabled)
                  </span>
                  <small>Payments disabled — configure your card gateway</small>
                </div>
              </button>
            </div>
          </div>

          <button className="btn btn-primary btn-lg pay-btn" type="button" disabled>
            Payments disabled (configure provider)
          </button>
        </section>
      </div>
    </div>
  )
}
