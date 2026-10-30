import { useCallback, useEffect, useState } from 'react'
import { adminApi, type AdminSubscriptionKind, type AdminSubscriptionsOverview } from '../api'
import { AdminPageHeader, useAdminMutation } from '../AdminShared'
import { formatFullTokenCount, formatTokenCount } from '../../../shared/billing'
import { useToast } from '../../components/Toast'
import './AdminPages.css'

type PlanDraft = {
  key: string
  label: string
  days: string
  enabled: boolean
  priceUsd: string
  kind: AdminSubscriptionKind
  tokenLimit: string
  isFeatured: boolean
}

type Tab = 'plans' | 'grant'

function centsToDollar(cents: number) {
  return (cents / 100).toFixed(2).replace(/\.00$/, '')
}

function parseTokens(raw: string) {
  const cleaned = raw.trim().toLowerCase().replace(/[, ]/g, '')
  const match = /^(\d+(?:\.\d+)?)(m|b)?$/.exec(cleaned)
  if (!match) return Number.NaN
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return Number.NaN
  if (match[2] === 'b') return Math.round(amount * 1_000_000_000)
  if (match[2] === 'm') return Math.round(amount * 1_000_000)
  return Math.round(amount)
}

export function AdminSubscriptions() {
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('plans')
  const [data, setData] = useState<AdminSubscriptionsOverview | null>(null)
  const [freeDaily, setFreeDaily] = useState('10M')
  const [plans, setPlans] = useState<PlanDraft[]>([])
  const [recipient, setRecipient] = useState('')
  const [grantPlan, setGrantPlan] = useState('day1')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(() => {
    void adminApi
      .subscriptionsOverview()
      .then((result) => {
        setData(result)
        setFreeDaily(formatTokenCount(result.settings.freeDailyTokens))
        setPlans(
          result.settings.plans.map((plan) => ({
            key: plan.key,
            label: plan.label,
            days: String(plan.days),
            enabled: plan.enabled,
            priceUsd: centsToDollar(plan.priceCents),
            kind: plan.kind,
            tokenLimit: formatTokenCount(plan.tokenLimit),
            isFeatured: Boolean(plan.isFeatured),
          })),
        )
        setGrantPlan((current) =>
          result.settings.plans.some((plan) => plan.key === current) ? current : result.settings.plans[0]?.key ?? 'day1',
        )
      })
      .catch(() => toast('Could not load subscriptions', 'error'))
      .finally(() => setLoading(false))
  }, [toast])

  useEffect(() => {
    refresh()
  }, [refresh])
  const { run, busy } = useAdminMutation(refresh)

  function saveAllowance() {
    const tokens = parseTokens(freeDaily)
    if (!Number.isFinite(tokens) || tokens < 0) {
      toast('Enter a daily allowance such as 10M', 'error')
      return
    }
    void run(() => adminApi.updateSubscriptionSettings({ freeDailyTokens: tokens }), 'Daily allowance saved')
  }

  function savePlans() {
    for (const row of plans) {
      const days = Math.round(Number(row.days))
      const price = Number(row.priceUsd)
      const limit = parseTokens(row.tokenLimit)
      if (!Number.isFinite(days) || days < 1) {
        toast(`${row.label || row.key} needs a duration of at least 1 day`, 'error')
        return
      }
      if (!Number.isFinite(price) || price < 0.01) {
        toast(`${row.label || row.key} price must be at least $0.01`, 'error')
        return
      }
      if (row.kind === 'custom' && (!Number.isFinite(limit) || limit < 1)) {
        toast(`${row.label || row.key} needs a token amount`, 'error')
        return
      }
    }
    void run(
      () =>
        adminApi.updateSubscriptionSettings({
          plans: plans.map((row) => ({
            key: row.key,
            label: row.label.trim() || `${row.days} days`,
            days: Math.round(Number(row.days)),
            enabled: row.enabled,
            priceUsd: Number(row.priceUsd),
            kind: row.kind,
            tokenLimit: row.kind === 'unlimited' ? 0 : parseTokens(row.tokenLimit),
            isFeatured: row.isFeatured,
          })),
        }),
      'Subscription plans saved',
    )
  }

  function grant() {
    const target = recipient.trim()
    if (!target) {
      toast('Enter an email', 'error')
      return
    }
    void run(async () => {
      const result = await adminApi.grantSubscription({ recipient: target, plan: grantPlan })
      setRecipient('')
      return result
    }, 'Subscription granted')
  }

  function patch(key: string, next: Partial<PlanDraft>) {
    setPlans((current) => current.map((row) => (row.key === key ? { ...row, ...next } : row)))
  }

  const parsedDaily = parseTokens(freeDaily)
  const active = data?.active ?? []
  const selected = plans.find((plan) => plan.key === grantPlan)

  return (
    <div className="admin-page admin-subs-page">
      <AdminPageHeader
        title="Subscriptions"
        description="Duration, price, and free-model allowance. A grant uses the same term and token pool as a purchase."
      />

      <div className="admin-tabs" role="tablist">
        <button type="button" className={tab === 'plans' ? 'is-active' : ''} onClick={() => setTab('plans')}>
          Plans
        </button>
        <button type="button" className={tab === 'grant' ? 'is-active' : ''} onClick={() => setTab('grant')}>
          Grant
        </button>
      </div>

      {loading ? <p className="admin-hint">Loading settings…</p> : null}

      {tab === 'plans' ? (
        <>
          <section className="admin-card admin-subs-card">
            <div className="admin-subs-head">
              <div>
                <span className="eyebrow">Daily allowance</span>
                <h2>Free tokens per day</h2>
                <p>Used when the account has no active subscription. Resets at 00:00 UTC.</p>
              </div>
              <button className="btn btn-primary" type="button" disabled={busy || loading} onClick={saveAllowance}>
                Save allowance
              </button>
            </div>
            <label className="admin-field" htmlFor="daily-free-tokens">
              <span>Daily free tokens</span>
              <input
                id="daily-free-tokens"
                className="input"
                value={freeDaily}
                placeholder="10M"
                onChange={(event) => setFreeDaily(event.target.value)}
              />
              <small className="field-hint">
                {Number.isFinite(parsedDaily) ? `${formatFullTokenCount(parsedDaily)} tokens` : 'Example: 10M'}
              </small>
            </label>
          </section>

          <section className="admin-card admin-subs-card">
            <div className="admin-subs-head">
              <div>
                <span className="eyebrow">Plans</span>
                <h2>Duration and price</h2>
                <p>Disabled plans stay hidden on the customer page.</p>
              </div>
              <button className="btn btn-primary" type="button" disabled={busy || loading} onClick={savePlans}>
                Save plans
              </button>
            </div>
            <div className="admin-subs-plans">
              {plans.map((plan) => (
                <article key={plan.key} className="admin-subs-plan">
                  <header>
                    <strong>{plan.label || plan.key}</strong>
                    <label>
                      <input
                        type="checkbox"
                        checked={plan.enabled}
                        onChange={(event) => patch(plan.key, { enabled: event.target.checked })}
                      />
                      Enabled
                    </label>
                  </header>
                  <label>
                    <span>Label</span>
                    <input className="input" value={plan.label} onChange={(event) => patch(plan.key, { label: event.target.value })} />
                  </label>
                  <div className="admin-subs-plan-row">
                    <label>
                      <span>Days</span>
                      <input className="input" inputMode="numeric" value={plan.days} onChange={(event) => patch(plan.key, { days: event.target.value })} />
                    </label>
                    <label>
                      <span>Price, USD</span>
                      <input className="input" inputMode="decimal" value={plan.priceUsd} onChange={(event) => patch(plan.key, { priceUsd: event.target.value })} />
                    </label>
                  </div>
                  <div className="admin-subs-plan-row">
                    <label>
                      <span>Pool</span>
                      <select
                        className="input"
                        value={plan.kind}
                        onChange={(event) => patch(plan.key, { kind: event.target.value as AdminSubscriptionKind })}
                      >
                        <option value="custom">Fixed tokens</option>
                        <option value="unlimited">Unlimited</option>
                      </select>
                    </label>
                    <label>
                      <span>Tokens</span>
                      <input
                        className="input"
                        value={plan.tokenLimit}
                        placeholder="500M"
                        disabled={plan.kind === 'unlimited'}
                        onChange={(event) => patch(plan.key, { tokenLimit: event.target.value })}
                      />
                    </label>
                  </div>
                  <label className="admin-subs-featured">
                    <input
                      type="checkbox"
                      checked={plan.isFeatured}
                      onChange={(event) => {
                        const featured = event.target.checked
                        setPlans((current) =>
                          current.map((row) => ({
                            ...row,
                            isFeatured: featured ? row.key === plan.key : row.key === plan.key ? false : row.isFeatured,
                          })),
                        )
                      }}
                    />
                    Featured
                  </label>
                </article>
              ))}
            </div>
          </section>

          <section className="admin-card admin-subs-card">
            <div className="admin-subs-head">
              <div>
                <span className="eyebrow">Live</span>
                <h2>Active subscriptions</h2>
                <p>{active.length} active</p>
              </div>
            </div>
            {active.length === 0 ? (
              <p className="admin-muted">No active subscriptions.</p>
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Plan</th>
                      <th>Used</th>
                      <th>Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.map((row) => (
                      <tr key={row.id}>
                        <td>{row.email}</td>
                        <td>{row.planLabel}</td>
                        <td>
                          {row.kind === 'unlimited'
                            ? 'Unlimited'
                            : `${formatTokenCount(row.tokensUsed)} / ${formatTokenCount(row.tokenLimit)}`}
                        </td>
                        <td>{row.expiresAt?.slice(0, 16).replace('T', ' ') ?? '—'} UTC</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : (
        <section className="admin-card admin-subs-card">
          <div className="admin-subs-head">
            <div>
              <span className="eyebrow">Grant</span>
              <h2>Give a subscription</h2>
              <p>Same duration and token pool as a paid purchase. Extends an active plan instead of stacking a second one.</p>
            </div>
          </div>
          <div className="admin-subs-grant">
            <label>
              <span>Email</span>
              <input
                className="input"
                value={recipient}
                placeholder="user@email.com"
                onChange={(event) => setRecipient(event.target.value)}
              />
            </label>
            <label>
              <span>Plan</span>
              <select className="input" value={grantPlan} onChange={(event) => setGrantPlan(event.target.value)}>
                {plans.map((plan) => (
                  <option key={plan.key} value={plan.key}>
                    {plan.label} · {plan.days} days · {plan.kind === 'unlimited' ? 'Unlimited' : plan.tokenLimit}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary" type="button" disabled={busy || !selected} onClick={grant}>
              Grant
            </button>
          </div>
          {selected ? (
            <p className="admin-muted">
              Grants {selected.label}: {selected.days} days and {selected.kind === 'unlimited' ? 'an unlimited pool' : `${selected.tokenLimit} tokens`}.
            </p>
          ) : null}
        </section>
      )}
    </div>
  )
}
