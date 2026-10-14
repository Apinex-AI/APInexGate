import { useEffect, useState } from 'react'
import { adminApi } from '../api'
import { AdminPageHeader, useAdminMutation } from '../AdminShared'
import { useToast } from '../../components/Toast'
import './AdminPages.css'

type Tab = 'referral' | 'billing' | 'links'

export function AdminSettings() {
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('referral')
  const [minTopupDollars, setMinTopupDollars] = useState('5')
  const [refEnabled, setRefEnabled] = useState(true)
  const [refMinDollars, setRefMinDollars] = useState('5')
  const [refReferrerUsd, setRefReferrerUsd] = useState('0.25')
  const [refRefereeUsd, setRefRefereeUsd] = useState('0.13')
  const [linkTelegram, setLinkTelegram] = useState('')
  const [linkX, setLinkX] = useState('')
  const [linkSupport, setLinkSupport] = useState('')

  const refresh = () => {
    void adminApi.settings()
      .then((data) => {
        setMinTopupDollars(String((data.billing.minTopupCents / 100).toFixed(2)).replace(/\.00$/, ''))
        setRefEnabled(data.referral.enabled)
        setRefMinDollars(
          String((data.referral.minPurchaseCents / 100).toFixed(2)).replace(/\.00$/, ''),
        )
        setRefReferrerUsd((data.referral.referrerRewardUsd ?? 0).toFixed(2))
        setRefRefereeUsd((data.referral.refereeRewardUsd ?? 0).toFixed(2))
        setLinkTelegram(data.links?.telegram ?? '')
        setLinkX(data.links?.x ?? '')
        setLinkSupport(data.links?.telegramSupport ?? '')
      })
      .catch(() => undefined)
  }

  useEffect(refresh, [])
  const { run, busy } = useAdminMutation(refresh)

  function saveReferral() {
    const dollars = Number(refMinDollars)
    const referrer = Number(refReferrerUsd)
    const referee = Number(refRefereeUsd)
    if (!Number.isFinite(dollars) || dollars < 1) {
      toast('Minimum purchase must be at least $1', 'error')
      return
    }
    if (!Number.isFinite(referrer) || referrer < 0 || !Number.isFinite(referee) || referee < 0) {
      toast('Rewards must be at least $0.00', 'error')
      return
    }
    void run(
      () =>
        adminApi.updateReferralSettings({
          enabled: refEnabled,
          minPurchaseDollars: dollars,
          referrerRewardUsd: referrer,
          refereeRewardUsd: referee,
        }),
      'Referral settings saved',
    )
  }

  function saveLinks() {
    void run(
      () =>
        adminApi.updateLinks({
          telegram: linkTelegram.trim(),
          x: linkX.trim(),
          telegramSupport: linkSupport.trim(),
        }),
      'Links saved',
    )
  }

  function saveBilling() {
    const dollars = Number(minTopupDollars)
    if (!Number.isFinite(dollars) || dollars < 1) {
      toast('Minimum top-up must be at least $1', 'error')
      return
    }
    void run(
      () => adminApi.updateBillingSettings({ minTopupDollars: dollars }),
      'Minimum top-up updated',
    )
  }

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Settings"
        description="Referral rewards, billing, and public links."
      />

      <div className="admin-toolbar">
        <div className="admin-tabs" role="tablist">
          {(
            [
              ['referral', 'Referral'],
              ['billing', 'Billing'],
              ['links', 'Links'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'is-active' : ''}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'referral' ? (
        <section className="admin-card admin-adjust-card">
          <div>
            <span className="eyebrow">Referral</span>
            <h2>Invite rewards</h2>
            <p>
              USD balance is granted once when a referred user completes their first crypto top-up at or
              above the minimum purchase. Signup itself does not credit rewards.
            </p>
          </div>
          <div className="admin-adjust-fields admin-referral-fields">
            <label className="admin-check">
              <input
                type="checkbox"
                checked={refEnabled}
                onChange={(event) => setRefEnabled(event.target.checked)}
              />
              Enabled
            </label>
            <label className="admin-field">
              <span>Min purchase (USD)</span>
              <input
                className="input"
                inputMode="decimal"
                value={refMinDollars}
                onChange={(event) => setRefMinDollars(event.target.value)}
              />
            </label>
            <label className="admin-field">
              <span>Referrer reward (USD)</span>
              <input
                className="input"
                inputMode="decimal"
                value={refReferrerUsd}
                onChange={(event) => setRefReferrerUsd(event.target.value)}
              />
            </label>
            <label className="admin-field">
              <span>Referee reward (USD)</span>
              <input
                className="input"
                inputMode="decimal"
                value={refRefereeUsd}
                onChange={(event) => setRefRefereeUsd(event.target.value)}
              />
            </label>
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={saveReferral}>
              Save referral
            </button>
          </div>
        </section>
      ) : null}

      {tab === 'links' ? (
        <section className="admin-card admin-adjust-card">
          <div>
            <span className="eyebrow">Public links</span>
            <h2>Telegram, X, Support</h2>
            <p>
              These replace the hardcoded community and support links across the site. Leave a field empty to hide that button. Telegram and support must be https://t.me/…, X must be https://x.com/… or https://twitter.com/….
            </p>
          </div>
          <div className="admin-adjust-fields admin-referral-fields">
            <label className="admin-field">
              <span>Telegram</span>
              <input
                className="input"
                placeholder="https://t.me/…"
                value={linkTelegram}
                onChange={(event) => setLinkTelegram(event.target.value)}
              />
            </label>
            <label className="admin-field">
              <span>X (Twitter)</span>
              <input
                className="input"
                placeholder="https://x.com/…"
                value={linkX}
                onChange={(event) => setLinkX(event.target.value)}
              />
            </label>
            <label className="admin-field">
              <span>Telegram Support</span>
              <input
                className="input"
                placeholder="https://t.me/…"
                value={linkSupport}
                onChange={(event) => setLinkSupport(event.target.value)}
              />
            </label>
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={saveLinks}>
              Save links
            </button>
          </div>
        </section>
      ) : null}

      {tab === 'billing' ? (
        <section className="admin-card admin-adjust-card">
          <div>
            <span className="eyebrow">Top-up settings</span>
            <h2>Minimum top-up amount</h2>
            <p>
              Customers cannot create invoices below this USD amount.
            </p>
          </div>
          <div className="admin-adjust-fields">
            <input
              className="input"
              inputMode="decimal"
              placeholder="e.g. 5"
              value={minTopupDollars}
              onChange={(event) => setMinTopupDollars(event.target.value)}
            />
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={saveBilling}>
              Save minimum
            </button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
