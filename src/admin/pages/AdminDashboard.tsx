import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminApi } from '../api'
import type { AdminOverview } from '../types'
import {
  AdminPageHeader,
  formatNumber,
} from '../AdminShared'
import { SpendChart } from '../../components/SpendChart'
import { IconPulse, IconTicket, IconUsers, IconWallet } from '../Icons'
import './AdminPages.css'

export function AdminDashboard() {
  const [data, setData] = useState<AdminOverview | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    adminApi
      .overview()
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load overview'))
  }, [])

  if (!data) {
    return (
      <div className="admin-page">
        <div className="admin-empty-state">
          <strong>{error || 'Loading control plane…'}</strong>
        </div>
      </div>
    )
  }

  const apinexKey = data.providerKeys?.find((k) => k.provider === 'apinex') || data.providerKeys?.[0]
  const balanceUsd = apinexKey?.balanceUsd != null ? apinexKey.balanceUsd : (apinexKey?.balanceUsdCents ? apinexKey.balanceUsdCents / 100 : 0)
  const balanceUsdFormatted = `$${Number(balanceUsd).toFixed(2)}`

  let subTokensFormatted = '0 tok'
  if (apinexKey?.subscriptionTokensRemaining != null) {
    const tokens = apinexKey.subscriptionTokensRemaining
    if (tokens >= 1_000_000_000) {
      subTokensFormatted = `${(Math.floor(tokens / 10_000_000) / 100).toFixed(2)}B tok`
    } else {
      subTokensFormatted = `${(tokens / 1_000_000).toFixed(1)}M tok`
    }
  } else if (apinexKey?.subscriptionPlan) {
    subTokensFormatted = apinexKey.subscriptionPlan
  } else {
    subTokensFormatted = '—'
  }

  const rpmValue = apinexKey?.rpm ?? 5
  const rpmPlan = apinexKey?.rpmPlan ?? 'free'

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Dashboard"
        description="Users, spend, keys and request health."
        actions={
          <Link className="btn btn-primary" to="/admin/users">
            Manage users
          </Link>
        }
      />

      {/* 3 cards in one row on desktop, stacked on mobile: APInex USD Balance, Subscription Tokens, and RPM */}
      <section className="admin-overview-hero-grid">
        <article className="admin-stat-card">
          <div className="admin-stat-label">
            <IconWallet size={16} />
            <span>APInex Balance</span>
          </div>
          <strong className="provider-balance">{balanceUsdFormatted}</strong>
          <small>{apinexKey ? 'Available USD wallet' : 'No key configured'}</small>
          <div style={{ marginTop: 12 }}>
            <a
              href="https://apinex.bond/billing"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%', justifyContent: 'center' }}
            >
              Top Up ↗
            </a>
          </div>
        </article>

        <article className="admin-stat-card">
          <div className="admin-stat-label">
            <IconTicket size={16} />
            <span>Subscription Balance</span>
          </div>
          <strong className="provider-balance">{subTokensFormatted}</strong>
          <small>{apinexKey?.subscriptionPlan ? apinexKey.subscriptionPlan : 'Tokens remaining'}</small>
          <div style={{ marginTop: 12 }}>
            <a
              href="https://apinex.bond/subscriptions"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%', justifyContent: 'center' }}
            >
              Subscriptions ↗
            </a>
          </div>
        </article>

        <article className="admin-stat-card">
          <div className="admin-stat-label">
            <IconPulse size={16} />
            <span>RPM</span>
          </div>
          <strong className="provider-balance">{rpmValue} RPM</strong>
          <small>{`Rate limit (${rpmPlan})`}</small>
          <div style={{ marginTop: 12 }}>
            <a
              href="https://apinex.bond/rpm"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%', justifyContent: 'center' }}
            >
              Increase RPM ↗
            </a>
          </div>
        </article>
      </section>

      <section className="admin-stat-grid">
        <article className="admin-stat-card">
          <div className="admin-stat-label">
            <IconPulse size={16} />
            <span>Daily earnings</span>
          </div>
          <strong className="provider-balance">
            {(() => {
              const usd = data.dailyReportRevenue?.totalRevenueUsd ?? 0
              return `$${usd.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}`
            })()}
          </strong>
        </article>

        <article className="admin-stat-card">
          <div className="admin-stat-label">
            <IconUsers size={16} />
            <span>Total users</span>
          </div>
          <strong>{formatNumber(data.stats.users)}</strong>
          <small>{data.stats.activeUsers} active</small>
        </article>

        <article className={`admin-stat-card ${data.stats.errorRate > 5 ? 'danger' : ''}`}>
          <div className="admin-stat-label">
            <IconPulse size={16} />
            <span>Error rate</span>
          </div>
          <strong>{data.stats.errorRate.toFixed(1)}%</strong>
          <small>Last 7 days</small>
        </article>
      </section>

      <section className="admin-chart-full">
        <article className="admin-card">
          <div className="admin-card-header">
            <div>
              <h2>Usage spend</h2>
              <p>Total tokens processed by day (free & paid)</p>
            </div>
            <span className="admin-chip">Last 7 days</span>
          </div>
          <div className="admin-spend-chart">
            <SpendChart
              tone="admin"
              points={data.usage}
              emptyTitle="No usage yet"
              emptyDescription="Token usage will appear here after the gateway starts recording traffic."
            />
          </div>
        </article>
      </section>
    </div>
  )
}
