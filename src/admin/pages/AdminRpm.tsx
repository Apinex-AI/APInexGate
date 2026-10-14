import { useEffect, useState } from 'react'
import { adminApi } from '../api'
import { AdminPageHeader, useAdminMutation } from '../AdminShared'
import { useToast } from '../../components/Toast'
import './AdminPages.css'

type Draft = {
  key: 'free' | 'standard' | 'high' | 'custom'
  title: string
  rpm: string
  price: string
  enabled: boolean
}

const EMPTY: Draft[] = [
  { key: 'free', title: 'Free', rpm: '5', price: '0', enabled: true },
  { key: 'standard', title: '30 RPM', rpm: '30', price: '10', enabled: true },
  { key: 'high', title: '60 RPM', rpm: '60', price: '20', enabled: true },
  { key: 'custom', title: 'Custom', rpm: '0', price: '0', enabled: true },
]

export function AdminRpm() {
  const { toast } = useToast()
  const [drafts, setDrafts] = useState<Draft[]>(EMPTY)
  const [recipient, setRecipient] = useState('')
  const [grantRpm, setGrantRpm] = useState('')
  const [loading, setLoading] = useState(true)
  const { run, busy } = useAdminMutation(() => undefined)

  useEffect(() => {
    void adminApi
      .rpmPlans()
      .then((data) => {
        setDrafts(
          EMPTY.map((slot) => {
            const plan = data.plans.find((row) => row.key === slot.key)
            if (!plan) return slot
            return {
              ...slot,
              title: plan.key === 'custom' ? 'Custom' : plan.key === 'free' ? 'Free' : `${plan.rpm} RPM`,
              rpm: String(plan.rpm),
              price: (plan.priceCents / 100).toFixed(2).replace(/\.00$/, ''),
              enabled: plan.enabled,
            }
          }),
        )
      })
      .catch(() => toast('Could not load RPM plans', 'error'))
      .finally(() => setLoading(false))
  }, [toast])

  function update(key: Draft['key'], patch: Partial<Draft>) {
    setDrafts((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  function save() {
    for (const row of drafts) {
      if (row.key === 'custom') continue
      const rpm = Number(row.rpm)
      if (!Number.isFinite(rpm) || rpm < 1 || rpm > 600) {
        toast(`${row.title} RPM must be between 1 and 600`, 'error')
        return
      }
      if (row.key !== 'free') {
        const price = Number(row.price)
        if (!Number.isFinite(price) || price < 0.01) {
          toast(`${row.title} needs a price of at least $0.01`, 'error')
          return
        }
      }
    }
    void run(
      () =>
        adminApi.updateRpmPlans(
          drafts.map((row) => ({
            key: row.key,
            rpm: row.key === 'custom' ? 0 : Math.round(Number(row.rpm)),
            priceUsd: row.key === 'free' || row.key === 'custom' ? 0 : Number(row.price),
            enabled: row.enabled,
          })),
        ),
      'RPM plans saved',
    )
  }

  function grant(clear = false) {
    const who = recipient.trim()
    if (!who) {
      toast('Enter a user email or id', 'error')
      return
    }
    const rpm = clear ? null : Number(grantRpm)
    if (!clear && (!Number.isFinite(rpm) || (rpm ?? 0) < 1)) {
      toast('Enter the custom RPM to grant', 'error')
      return
    }
    void run(() => adminApi.grantRpm({ recipient: who, rpm }), clear ? 'Custom RPM cleared' : 'Custom RPM granted')
  }

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="RPM"
        description="Four plans shown on the customer RPM page. Prices and request ceilings apply immediately."
      />
      {loading ? <p className="admin-hint">Loading plans…</p> : null}
      <section className="admin-card" style={{ padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 16 }}>
          <div>
            <span className="eyebrow">Catalog</span>
            <h2 style={{ margin: '4px 0 0' }}>Plans</h2>
          </div>
          <button className="btn btn-primary" type="button" disabled={busy || loading} onClick={save}>
            {busy ? 'Saving…' : 'Save plans'}
          </button>
        </div>
        <div className="admin-rpm-grid">
          {drafts.map((row) => (
            <article key={row.key} className="admin-rpm-card">
              <strong>{row.key === 'custom' ? 'Custom' : row.key === 'free' ? 'Free · always on' : row.title}</strong>
              {row.key === 'custom' ? (
                <p>No price. The customer button opens the Telegram Support link from Settings → Links. Grant a number below if you agree a custom ceiling.</p>
              ) : (
                <>
                  <label className="admin-field">
                    RPM
                    <input className="input" inputMode="numeric" value={row.rpm} onChange={(event) => update(row.key, { rpm: event.target.value })} />
                  </label>
                  {row.key === 'free' ? (
                    <p>Price stays FREE. Every account starts here.</p>
                  ) : (
                    <label className="admin-field">
                      Price, USD
                      <input className="input" inputMode="decimal" value={row.price} onChange={(event) => update(row.key, { price: event.target.value })} />
                    </label>
                  )}
                </>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="admin-card" style={{ padding: 22, marginTop: 16 }}>
        <span className="eyebrow">Support deals</span>
        <h2 style={{ margin: '4px 0 8px' }}>Grant a custom RPM</h2>
        <p className="admin-hint">Overrides the purchased plan for one account. Clear it to fall back to the plan they bought, or Free.</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <input className="input" placeholder="email or user id" value={recipient} onChange={(event) => setRecipient(event.target.value)} />
          <input className="input" inputMode="numeric" placeholder="RPM" value={grantRpm} onChange={(event) => setGrantRpm(event.target.value)} style={{ maxWidth: 120 }} />
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => grant(false)}>
            Grant
          </button>
          <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => grant(true)}>
            Clear
          </button>
        </div>
      </section>
    </div>
  )
}
