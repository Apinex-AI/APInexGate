import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Modal } from './Modal'
import { useToast } from './Toast'

import { useCustomer } from '../auth/CustomerContext'
import { userApi } from '../auth/userApi'
import { IconGift, IconLogout, IconSettings, IconShield, IconUser, IconWallet } from '../admin/Icons'
import { formatUsdBalance, formatUsdExact } from '../../shared/billing'
import { buildReferralLink, sanitizeReferralInput } from '../auth/referral'
import { lockPageScroll } from '../lib/scrollLock'
import { useSiteLinks } from '../lib/siteLinks'
import { useBrand } from '../lib/brand'
import { BrandName } from './BrandName'


import './Layout.css'

type RewardsInfo = {
  enabled: boolean
  code: string
  invited: number
  rewarded: number
  earnedUsd: number
  referredByCode: string | null
  hasReferrer: boolean
  rewardGranted: boolean
  minPurchaseDollars: number
  referrerRewardUsd: number
  refereeRewardUsd: number
}

const navItems: Array<{ to: string; label: string; end: boolean; external?: boolean; icon: () => ReactNode }> = [
  { to: '/overview', label: 'Overview', end: true, icon: IconOverview },
  { to: '/keys', label: 'API Keys', end: false, icon: IconKey },
  { to: '/setup', label: 'Setup', end: false, icon: IconSetup },
  { to: '/usage', label: 'Usage', end: false, icon: IconUsage },
  { to: '/models', label: 'Models', end: false, icon: IconModels },
  { to: '/subscriptions', label: 'Subscriptions', end: false, icon: IconTokens },
  { to: '/billing', label: 'Top up', end: false, icon: IconTopup },
  { to: '/rpm', label: 'RPM', end: false, icon: IconRpm },
  { to: '/playground', label: 'Playground', end: false, icon: IconChat },
  { to: '/status', label: 'Status', end: false, icon: IconStatus },
]

export function Layout() {
  const { user, logout, refresh } = useCustomer()
  const { toast } = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'account' | 'referrals' | 'security' | 'billing'>('account')
  const [rewards, setRewards] = useState<RewardsInfo | null>(null)
  const links = useSiteLinks()
  const brand = useBrand()
  const nav = [
    ...navItems,
    { to: `${brand.siteUrl}/docs`, label: 'Docs', end: false, external: true, icon: IconDocs },
    ...(links.telegramSupport
      ? [{ to: links.telegramSupport, label: 'Support', end: false, external: true, icon: IconSupport }]
      : []),
  ]
  const [referralInput, setReferralInput] = useState('')
  const [referralBusy, setReferralBusy] = useState(false)
  const [referralNotice, setReferralNotice] = useState('')
  const [copiedLink, setCopiedLink] = useState(false)
  const [accountRpm, setAccountRpm] = useState<number | null>(null)
  const [systemHealthy, setSystemHealthy] = useState<boolean | null>(true)

  useEffect(() => {
    let cancelled = false
    fetch('/api/public/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.models) {
          const hasIssue = data.models.some((m: { state?: string }) => m.state === 'outage' || m.state === 'partial')
          setSystemHealthy(!hasIssue)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const unlock = lockPageScroll()
    return () => {
      document.removeEventListener('keydown', onKey)
      unlock()
    }
  }, [menuOpen])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    let dirty = false
    if (params.get('bridged') === 'google') {
      toast(`Google linked — you can sign in on ${brand.siteUrl.replace(/^https?:\/\//, '')}`)
      void refresh()
      params.delete('bridged')
      dirty = true
    }
    if (params.get('signed_up') === '1') {
      params.delete('signed_up')
      dirty = true
    }
    const authError = params.get('auth_error')
    if (authError) {
      const shown = /\bip\b|ip network|only 1 account|one account per|signup network/i.test(authError)
        ? "We can't register you right now."
        : authError
      toast(shown, 'error')
      params.delete('auth_error')
      dirty = true
    }
    if (dirty) {
      const next = `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash || ''}`
      window.history.replaceState({}, '', next)
    }
    // Run once per distinct search string only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])

  useEffect(() => {
    if (!settingsOpen) return
    let active = true
    userApi
      .rewards()
      .then((res) => {
        if (active) setRewards(res.referral)
      })
      .catch(() => undefined)
    userApi
      .rpm()
      .then((res) => {
        if (active) setAccountRpm(res.rpm)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [settingsOpen])

  async function applyFriendReferral() {
    const raw = referralInput.trim()
    const code = sanitizeReferralInput(raw)
    if (!code) {
      toast('Please enter a valid referral code or link', 'error')
      return
    }
    setReferralBusy(true)
    setReferralNotice('')
    try {
      const result = await userApi.applyReferralCode(code)
      setRewards(result.referral)
      setReferralInput('')
      if (result.referral.rewardGranted) {
        setReferralNotice('Bonuses were successfully credited to you and your referrer.')
        toast('Referral bonuses credited')
        void refresh().catch(() => undefined)
      } else {
        setReferralNotice(
          `Code activated (${code}). You will receive the reward after a purchase of $${result.referral.minPurchaseDollars}+.`,
        )
        toast('Referral code linked')
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not apply code'
      setReferralNotice(message)
      toast(message, 'error')
    } finally {
      setReferralBusy(false)
    }
  }

  async function confirmLogout() {
    setLoggingOut(true)
    try {
      await logout()
      navigate('/', { replace: true })
    } finally {
      setLoggingOut(false)
      setLogoutOpen(false)
    }
  }

  function openAccountMenu() {
    setSettingsOpen(true)
    setSettingsTab('account')
  }


  return (
    <div className={`shell ${menuOpen ? 'menu-open' : ''}`}>
      <button
        className="nav-backdrop"
        type="button"
        aria-label="Close menu"
        tabIndex={menuOpen ? 0 : -1}
        onClick={() => setMenuOpen(false)}
      />

      <aside
        className="sidebar"
        id="app-sidebar"
        data-sidebar="sidebar"
        data-slot="sidebar-inner"
      >
        <div className="sidebar-inner">
          <div data-slot="sidebar-header" data-sidebar="header" className="sidebar-header">
            <NavLink
              to="/overview"
              className="sidebar-brand-link"
              end
              onClick={() => setMenuOpen(false)}
            >
              <div className="sidebar-brand-tile" aria-hidden>
                <img src="/brand/mark.png" alt="" />
              </div>
              <span className="sidebar-brand-title"><BrandName /></span>
            </NavLink>
            <button
              className="sidebar-close"
              type="button"
              aria-label="Close menu"
              onClick={() => setMenuOpen(false)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div
            data-slot="sidebar-content"
            data-sidebar="content"
            className="sidebar-content no-scrollbar"
          >
            <nav aria-label="Main navigation">
              <ul data-slot="sidebar-menu" data-sidebar="menu" className="sidebar-menu">
                {nav.map((item) => (
                  <li
                    key={item.label}
                    data-slot="sidebar-menu-item"
                    data-sidebar="menu-item"
                    className="sidebar-menu-item"
                  >
                    {item.external ? (
                      <a
                        href={item.to}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="sidebar-menu-button"
                        data-slot="sidebar-menu-button"
                        data-sidebar="menu-button"
                        onClick={() => setMenuOpen(false)}
                      >
                        <item.icon />
                        <span>{item.label}</span>
                        <IconExternal />
                      </a>
                    ) : (
                      <NavLink
                        to={item.to}
                        end={item.end}
                        className={({ isActive }) =>
                          `sidebar-menu-button ${isActive ? 'is-active' : ''}`
                        }
                        data-slot="sidebar-menu-button"
                        data-sidebar="menu-button"
                        onClick={() => setMenuOpen(false)}
                      >
                        <item.icon />
                        <span>{item.label}</span>
                      </NavLink>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          </div>

          <div data-slot="sidebar-footer" data-sidebar="footer" className="sidebar-footer">
            <nav aria-label="Documents" className="sidebar-doc-links">

            </nav>
            <NavLink
              to="/status"
              className={({ isActive }) => `sidebar-status-pill ${isActive ? 'is-active' : ''}`}
              onClick={() => setMenuOpen(false)}
              title="Gateway System Status"
            >
              <span className="sidebar-status-indicator" aria-hidden>
                <span className={`sidebar-status-dot-ping ${systemHealthy === false ? 'is-warning' : ''}`} />
                <span className={`sidebar-status-dot ${systemHealthy === false ? 'is-warning' : ''}`} />
              </span>
              <span>{systemHealthy === false ? 'Degraded performance' : 'All systems normal'}</span>
            </NavLink>
          </div>
        </div>
      </aside>

      <div className="main-wrap">
        <header
          className="topbar"
        >
          <button
            className="burger-btn"
            type="button"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="app-sidebar"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className={`burger-icon ${menuOpen ? 'is-open' : ''}`} aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </button>

          <div className="topbar-social" aria-label="Community">
            {links.x ? (
            <a
              className="lp-social-btn lp-social-x topbar-social-btn"
              href={links.x}
              target="_blank"
              rel="noreferrer"
              title="X"
              aria-label="Follow on X"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
              </svg>
            </a>
            ) : null}
            {links.telegram ? (
            <a
              className="lp-social-btn lp-social-tg topbar-social-btn"
              href={links.telegram}
              target="_blank"
              rel="noreferrer"
              title="Telegram"
              aria-label="Telegram"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212-.07-.062-.174-.041-.249-.024-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
              </svg>
            </a>
            ) : null}
          </div>

          <div className="topbar-brand">
            <div className="brand-mark" aria-hidden>
              <img src="/brand/mark.png" alt="" />
            </div>
            <strong><BrandName /></strong>
          </div>

          <div className="topbar-center" />

          <div className="topbar-actions">
            <NavLink
              to="/billing"
              className="topbar-balance"
              title="Top up"
              aria-label={`Balance ${formatUsdBalance(user.balanceTokens)}. Top up`}
            >
              <IconWallet size={15} />
              <span className="sr-only">Balance:</span>
              <span className="topbar-balance-amount">{formatUsdBalance(user.balanceTokens)}</span>
            </NavLink>
            <button
              className="user-chip user-chip-button topbar-account"
              type="button"
              onClick={() => openAccountMenu()}
              title="Settings"
              aria-label="Account settings"
            >
              <span className="avatar" aria-hidden>
                <IconUser size={15} />
              </span>
              <span className="topbar-account-copy">
                <strong>{user.name}</strong>
                <small>{user.email}</small>
              </span>
              <IconSettings size={15} className="user-chip-settings-icon" />
            </button>
          </div>
        </header>

        <main className={`content ${location.pathname === '/playground' ? 'content-lock' : ''}`}>
          <Outlet />
        </main>
      </div>

      <Modal
        open={logoutOpen}
        onClose={() => {
          if (!loggingOut) setLogoutOpen(false)
        }}
        title="Sign out?"
        description="This will revoke your current session cookie."
        footer={
          <>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={loggingOut}
              onClick={() => setLogoutOpen(false)}
            >
              Cancel
            </button>
            <button className="btn btn-danger" type="button" disabled={loggingOut} onClick={() => void confirmLogout()}>
              {loggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </>
        }
      >
        <p className="confirm-copy">You will need to log in again to access your dashboard.</p>
      </Modal>

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Settings"
        panelClassName="modal-settings"
      >
        <div className="settings-layout">
          <nav className="settings-sidebar" role="tablist" aria-label="Settings categories">
            <button
              className={`settings-tab-btn ${settingsTab === 'account' ? 'is-active' : ''}`}
              type="button"
              role="tab"
              aria-selected={settingsTab === 'account'}
              onClick={() => setSettingsTab('account')}
            >
              <IconUser size={16} />
              <span>Account</span>
            </button>
            <button
              className={`settings-tab-btn ${settingsTab === 'referrals' ? 'is-active' : ''}`}
              type="button"
              role="tab"
              aria-selected={settingsTab === 'referrals'}
              onClick={() => setSettingsTab('referrals')}
            >
              <IconGift size={16} />
              <span>Referrals</span>
            </button>
            <button
              className={`settings-tab-btn ${settingsTab === 'security' ? 'is-active' : ''}`}
              type="button"
              role="tab"
              aria-selected={settingsTab === 'security'}
              onClick={() => setSettingsTab('security')}
            >
              <IconShield size={16} />
              <span>API & Security</span>
            </button>

            <button
              className={`settings-tab-btn ${settingsTab === 'billing' ? 'is-active' : ''}`}
              type="button"
              role="tab"
              aria-selected={settingsTab === 'billing'}
              onClick={() => setSettingsTab('billing')}
            >
              <IconWallet size={16} />
              <span>Billing & Usage</span>
            </button>
          </nav>

          {settingsTab === 'account' && (
            <div className="settings-pane" role="tabpanel" aria-label="Account settings">
              <div className="settings-pane-header">
                <h3>Account</h3>
                <p>Manage your account profile and authentication details.</p>
              </div>

              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-row-col">
                    <span className="settings-row-label">Name</span>
                    <span className="settings-row-sub">Profile display name</span>
                  </div>
                  <span className="settings-row-value">
                    <strong>{user.name || 'User'}</strong>
                  </span>
                </div>

                <div className="settings-row">
                  <div className="settings-row-col">
                    <span className="settings-row-label">Email</span>
                  </div>
                  <span className="settings-row-value">
                    <strong>{user.loginEmail || user.email}</strong>
                  </span>
                </div>

                <div className="settings-row">
                  <div className="settings-row-col">
                    <span className="settings-row-label">Balance</span>
                    <span className="settings-row-sub">Available usage balance</span>
                  </div>
                  <span className="settings-row-value">
                    <strong>{formatUsdBalance(user.balanceTokens)}</strong>
                  </span>
                </div>
              </div>

              <div className="settings-danger-box">
                <div className="settings-danger-info">
                  <strong>Sign out</strong>
                  <p>Log out of your <BrandName /> session on this device.</p>
                </div>
                <button
                  className="btn btn-danger"
                  type="button"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  onClick={() => {
                    setSettingsOpen(false)
                    setLogoutOpen(true)
                  }}
                >
                  <IconLogout size={14} />
                  <span>Sign out</span>
                </button>
              </div>
            </div>
          )}

          {settingsTab === 'referrals' && (
            <div className="settings-pane" role="tabpanel" aria-label="Referral rewards">
              <div className="settings-pane-header">
                <h3>Referrals</h3>
                <p>
                  {rewards
                    ? `Share your referral link. After a referred user's first crypto top-up of $${rewards.minPurchaseDollars}+, you get ${formatUsdExact(rewards.referrerRewardUsd)}, and they get ${formatUsdExact(rewards.refereeRewardUsd)}.`
                    : 'Share your referral link and earn bonuses when friends top up.'}
                </p>
              </div>

              <div className="settings-referrals-form">
                <div className="settings-field">
                  <span className="settings-field-label">Your referral link</span>
                  <div className="settings-field-row">
                    <input
                      className="input"
                      readOnly
                      value={rewards?.code ? buildReferralLink(rewards.code) : ''}
                      placeholder="Loading referral link..."
                    />
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={!rewards?.code}
                      onClick={() => {
                        if (!rewards?.code) return
                        const link = buildReferralLink(rewards.code)
                        void navigator.clipboard?.writeText(link)
                        setCopiedLink(true)
                        setTimeout(() => setCopiedLink(false), 2000)
                        toast('Referral link copied')
                      }}
                    >
                      {copiedLink ? 'Copied!' : 'Copy link'}
                    </button>
                  </div>
                  <small className="settings-ref-hint">
                    Anyone who visits your referral link has your code activated automatically.
                  </small>
                </div>

                {rewards?.hasReferrer ? (
                  <div className="settings-ref-linked-card">
                    <div className="settings-ref-linked-top">
                      <div className="settings-ref-linked-icon" aria-hidden>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      </div>
                      <div className="settings-ref-linked-meta">
                        <span className="settings-ref-linked-title">
                          Activated Referral code: <strong>{rewards.referredByCode}</strong>
                        </span>
                        <span className="settings-ref-linked-sub">
                          Permanent connection • Cannot be modified
                        </span>
                      </div>
                    </div>
                    <p className="settings-ref-linked-desc">
                      {rewards.rewardGranted
                        ? 'Referral bonuses were credited to you and your referrer.'
                        : `Reward pending: You and your referrer will receive the reward after your first purchase of $${rewards.minPurchaseDollars}+.`}
                    </p>
                  </div>
                ) : rewards?.enabled !== false ? (
                  <div className="settings-field">
                    <span className="settings-field-label">Enter a friend's link or code</span>
                    <div className="settings-field-row">
                      <input
                        className="input"
                        value={referralInput}
                        onChange={(e) => setReferralInput(e.target.value)}
                        placeholder={`${brand.siteUrl}/ref?=CODE or CODE`}
                        autoComplete="off"
                        disabled={referralBusy}
                      />
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={referralBusy || !referralInput.trim()}
                        onClick={() => void applyFriendReferral()}
                      >
                        {referralBusy ? '…' : 'Apply'}
                      </button>
                    </div>
                    <small className="settings-ref-hint">
                      Once activated, your referral connection is permanent and cannot be changed.
                    </small>
                    {referralNotice ? <small className="rewards-referral-hint">{referralNotice}</small> : null}
                  </div>
                ) : null}

                <div className="settings-metrics-grid">
                  <div className="settings-metric-card">
                    <div className="settings-metric-header">
                      <span className="settings-metric-badge">Joined</span>
                    </div>
                    <strong>{rewards?.invited ?? 0}</strong>
                    <span>Invited</span>
                  </div>
                  <div className="settings-metric-card">
                    <div className="settings-metric-header">
                      <span className="settings-metric-badge">Qualified</span>
                    </div>
                    <strong>{rewards?.rewarded ?? 0}</strong>
                    <span>Rewarded</span>
                  </div>
                  <div className="settings-metric-card">
                    <div className="settings-metric-header">
                      <span className="settings-metric-badge">Earnings</span>
                    </div>
                    <strong>{formatUsdExact(rewards?.earnedUsd ?? 0)}</strong>
                    <span>Earned balance</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {settingsTab === 'security' && (
            <div className="settings-pane" role="tabpanel" aria-label="API and security settings">
              <div className="settings-pane-header">
                <h3>API & Security</h3>
                <p>Endpoints, authentication, and security parameters.</p>
              </div>

              <div className="settings-section">
                <div className="settings-field">
                  <span className="settings-field-label">API Base URL</span>
                  <div className="settings-field-row">
                    <input className="input" readOnly value={brand.apiBaseUrl} />
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(brand.apiBaseUrl)
                        toast('API Base URL copied')
                      }}
                    >
                      Copy
                    </button>
                  </div>
                </div>

                <div className="settings-row" style={{ marginTop: 12 }}>
                  <div className="settings-row-col">
                    <span className="settings-row-label">API Keys</span>
                    <span className="settings-row-sub">Secret keys used to authenticate API requests</span>
                  </div>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => {
                      setSettingsOpen(false)
                      navigate('/keys')
                    }}
                  >
                    Manage keys ↗
                  </button>
                </div>

                <div className="settings-row">
                  <div className="settings-row-col">
                    <span className="settings-row-label">Default rate limit</span>
                    <span className="settings-row-sub">Per account, shared by every active key</span>
                  </div>
                  <span className="settings-row-value">
                    <strong>{accountRpm == null ? '…' : `${accountRpm} req/min`}</strong>
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={() => {
                        setSettingsOpen(false)
                        navigate('/rpm')
                      }}
                    >
                      Increase
                    </button>
                  </span>
                </div>
              </div>
            </div>
          )}


          {settingsTab === 'billing' && (
            <div className="settings-pane" role="tabpanel" aria-label="Billing settings">
              <div className="settings-pane-header">
                <h3>Billing & Usage</h3>
                <p>View your available balance and manage payment options.</p>
              </div>

              <div className="settings-section">
                <div className="settings-row">
                  <div className="settings-row-col">
                    <span className="settings-row-label">Available balance</span>
                    <span className="settings-row-sub">Spendable balance for all models</span>
                  </div>
                  <span className="settings-row-value">
                    <strong>{formatUsdBalance(user.balanceTokens)}</strong>
                  </span>
                </div>

                <div className="settings-row">
                  <div className="settings-row-col">
                    <span className="settings-row-label">Top up account</span>
                    <span className="settings-row-sub">Deposit via Crypto</span>
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    type="button"
                    onClick={() => {
                      setSettingsOpen(false)
                      navigate('/billing')
                    }}
                  >
                    Top up ↗
                  </button>
                </div>

                <div className="settings-row">
                  <div className="settings-row-col">
                    <span className="settings-row-label">Subscriptions</span>
                    <span className="settings-row-sub">Timed allowance for free models</span>
                  </div>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => {
                      setSettingsOpen(false)
                      navigate('/subscriptions')
                    }}
                  >
                    Subscriptions ↗
                  </button>
                </div>

                <div className="settings-row">
                  <div className="settings-row-col">
                    <span className="settings-row-label">Models</span>
                    <span className="settings-row-sub">Check live model pricing per 1M tokens</span>
                  </div>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => {
                      setSettingsOpen(false)
                      navigate('/models')
                    }}
                  >
                    View models ↗
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}

function IconOverview() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true">
      <path d="M207.06,72.67A111.24,111.24,0,0,0,128,40h-.4C66.07,40.21,16,91,16,153.13V176a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V152A111.25,111.25,0,0,0,207.06,72.67ZM224,176H119.71l54.76-75.3a8,8,0,0,0-12.94-9.42L99.92,176H32V153.13c0-3.08.15-6.12.43-9.13H56a8,8,0,0,0,0-16H35.27c10.32-38.86,44-68.24,84.73-71.66V80a8,8,0,0,0,16,0V56.33A96.14,96.14,0,0,1,221,128H200a8,8,0,0,0,0,16h23.67c.21,2.65.33,5.31.33,8Z" />
    </svg>
  )
}

function IconKey() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true">
      <path d="M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43ZM224,98.1c-1.09,34.09-29.75,61.86-63.89,61.9H160a63.7,63.7,0,0,1-23.65-4.51,8,8,0,0,0-8.84,1.68L116.69,168H96a8,8,0,0,0-8,8v16H72a8,8,0,0,0-8,8v16H40V187.31l58.83-58.82a8,8,0,0,0,1.68-8.84A63.72,63.72,0,0,1,96,95.92c0-34.14,27.81-62.8,61.9-63.89A64,64,0,0,1,224,98.1ZM192,76a12,12,0,1,1-12-12A12,12,0,0,1,192,76Z" />
    </svg>
  )
}

function IconSetup() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true">
      <path d="M237.66,18.34a8,8,0,0,0-11.32,0l-52.4,52.41-5.37-5.38a32.05,32.05,0,0,0-45.26,0L100,88.69l-6.34-6.35A8,8,0,0,0,82.34,93.66L88.69,100,65.37,123.31a32,32,0,0,0,0,45.26l5.38,5.37-52.41,52.4a8,8,0,0,0,11.32,11.32l52.4-52.41,5.37,5.38a32,32,0,0,0,45.26,0L156,167.31l6.34,6.35a8,8,0,0,0,11.32-11.32L167.31,156l23.32-23.31a32,32,0,0,0,0-45.26l-5.38-5.37,52.41-52.4A8,8,0,0,0,237.66,18.34Zm-116.29,161a16,16,0,0,1-22.62,0L76.69,157.25a16,16,0,0,1,0-22.62L100,111.31,144.69,156Zm57.94-57.94L156,144.69,111.31,100l23.32-23.31a16,16,0,0,1,22.62,0l22.06,22A16,16,0,0,1,179.31,121.37ZM88.57,35A8,8,0,0,1,103.43,29l8,20A8,8,0,0,1,96.57,55ZM24.57,93A8,8,0,0,1,35,88.57l20,8A8,8,0,0,1,49,111.43l-20-8A8,8,0,0,1,24.57,93ZM231.43,163a8,8,0,0,1-10.4,4.46l-20-8A8,8,0,1,1,207,144.57l20,8A8,8,0,0,1,231.43,163Zm-64,58.06A8,8,0,0,1,152.57,227l-8-20A8,8,0,0,1,159.43,201Z" />
    </svg>
  )
}

function IconUsage() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true">
      <path d="M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z" />
    </svg>
  )
}

function IconModels() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true">
      <path d="M223.68,66.15,135.68,18h0a15.88,15.88,0,0,0-15.36,0l-88,48.17a16,16,0,0,0-8.32,14v95.64a16,16,0,0,0,8.32,14l88,48.17a15.88,15.88,0,0,0,15.36,0l88-48.17a16,16,0,0,0,8.32-14V80.18A16,16,0,0,0,223.68,66.15ZM128,32h0l80.34,44L128,120,47.66,76ZM40,90l80,43.78v85.79L40,175.82Zm96,129.57V133.82L216,90v85.78Z" />
    </svg>
  )
}

function IconTokens() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true">
      <path d="M128,24C75,24,32,47.28,32,76v104c0,28.72,43,52,96,52s96-23.28,96-52V76C224,47.28,181,24,128,24Zm80,52c0,17.4-33.87,36-80,36S48,93.4,48,76s33.87-36,80-36S208,58.6,208,76Zm-80,52c46.13,0,80-18.6,80-36v26.79C198.81,133.09,165.74,144,128,144s-70.81-10.91-80-25.21V92C48,109.4,81.87,128,128,128Zm0,52c46.13,0,80-18.6,80-36v26.79C198.81,185.09,165.74,196,128,196s-70.81-10.91-80-25.21V144C48,161.4,81.87,180,128,180Z" />
    </svg>
  )
}

function IconTopup() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true">
      <path d="M216,64H56a8,8,0,0,1,0-16H192a8,8,0,0,0,0-16H56A24,24,0,0,0,32,56V184a24,24,0,0,0,24,24H216a16,16,0,0,0,16-16V80A16,16,0,0,0,216,64Zm0,128H56a8,8,0,0,1-8-8V78.63A23.84,23.84,0,0,0,56,80H216Zm-48-60a12,12,0,1,1,12,12A12,12,0,0,1,168,132Z" />
    </svg>
  )
}

function IconRpm() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true">
      <path d="M224,128a96,96,0,0,1-192,0,94.9,94.9,0,0,1,21.57-60.32,8,8,0,0,1,12.21,10.3A79,79,0,0,0,48,128a80,80,0,1,0,80-80,79,79,0,0,0-50,17.78,8,8,0,0,1-10.3-12.21A96,96,0,0,1,224,128Zm-90.34,5.66a16,16,0,1,0-11.32-11.32l-29-29a8,8,0,0,0-11.32,11.32Z" />
    </svg>
  )
}

function IconChat() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true">
      <path d="M168,112a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,112Zm-8,24H96a8,8,0,0,0,0,16h64a8,8,0,0,0,0-16Zm72-8A104,104,0,0,1,79.12,219.82L45.07,231.17a16,16,0,0,1-20.24-20.24l11.35-34.05A104,104,0,1,1,232,128Zm-16,0A88,88,0,1,0,51.81,172.06a8,8,0,0,1,.66,6.54L40,216,77.4,203.53a7.85,7.85,0,0,1,2.53-.42,8,8,0,0,1,4,1.08A88,88,0,0,0,216,128Z" />
    </svg>
  )
}

function IconStatus() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true">
      <path d="M240,128a8,8,0,0,1-8,8H204.94l-37.78,75.58A8,8,0,0,1,160,216h-.4a8,8,0,0,1-7.08-5.14L95.35,60.76,63.28,131.31A8,8,0,0,1,56,136H24a8,8,0,0,1,0-16H50.85L88.72,36.69a8,8,0,0,1,14.76.46l57.51,151,31.85-63.71A8,8,0,0,1,200,120h32A8,8,0,0,1,240,128Z" />
    </svg>
  )
}

function IconDocs() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true">
      <path d="M232,48H160a40,40,0,0,0-32,16A40,40,0,0,0,96,48H24a8,8,0,0,0-8,8V200a8,8,0,0,0,8,8H96a24,24,0,0,1,24,24,8,8,0,0,0,16,0,24,24,0,0,1,24-24h72a8,8,0,0,0,8-8V56A8,8,0,0,0,232,48ZM96,192H32V64H96a24,24,0,0,1,24,24V200A39.81,39.81,0,0,0,96,192Zm128,0H160a39.81,39.81,0,0,0-24,8V88a24,24,0,0,1,24-24h64ZM160,88h40a8,8,0,0,1,0,16H160a8,8,0,0,1,0-16Zm48,40a8,8,0,0,1-8,8H160a8,8,0,0,1,0-16h40A8,8,0,0,1,208,128Zm0,32a8,8,0,0,1-8,8H160a8,8,0,0,1,0-16h40A8,8,0,0,1,208,160Z" />
    </svg>
  )
}

function IconSupport() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true">
      <path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm39.1,131.79a47.84,47.84,0,0,0,0-55.58l28.5-28.49a87.83,87.83,0,0,1,0,112.56ZM96,128a32,32,0,1,1,32,32A32,32,0,0,1,96,128Zm88.28-67.6L155.79,88.9a47.84,47.84,0,0,0-55.58,0L71.72,60.4a87.83,87.83,0,0,1,112.56,0ZM60.4,71.72l28.5,28.49a47.84,47.84,0,0,0,0,55.58L60.4,184.28a87.83,87.83,0,0,1,0-112.56ZM71.72,195.6l28.49-28.5a47.84,47.84,0,0,0,55.58,0l28.49,28.5a87.83,87.83,0,0,1-112.56,0Z" />
    </svg>
  )
}

function IconExternal() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" width="1em" height="1em" aria-hidden="true" className="sidebar-ext-icon">
      <path d="M200,64V168a8,8,0,0,1-16,0V83.31L69.66,197.66a8,8,0,0,1-11.32-11.32L172.69,72H88a8,8,0,0,1,0-16H192A8,8,0,0,1,200,64Z" />
    </svg>
  )
}


