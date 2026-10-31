import { Suspense, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  IconActivity,
  IconCube,
  IconEvent,
  IconGauge,
  IconGrid,
  IconKey,
  IconLevels,
  IconLogout,
  IconPlug,
  IconPulse,
  IconRefresh,
  IconSettings,
  IconShield,
  IconTag,
  IconTicket,
  IconUsers,
  IconWallet,
} from './Icons'
import { BrandName } from '../components/BrandName'
import { adminApi } from './api'
import { useAdminAuth } from './AdminAuth'
import './AdminLayout.css'

const sections = [
  { to: '/admin', label: 'Dashboard', end: true, icon: IconGrid },
  { to: '/admin/users', label: 'Users', end: false, icon: IconUsers },
  { to: '/admin/api-keys', label: 'API Keys', end: false, icon: IconKey },
  { to: '/admin/providers', label: 'Providers', end: false, icon: IconPlug },
  { to: '/admin/models', label: 'Models', end: false, icon: IconCube },
  { to: '/admin/pricing', label: 'Pricing', end: false, icon: IconTag },
  { to: '/admin/balances', label: 'Balances', end: false, icon: IconWallet },
  { to: '/admin/promos', label: 'Promo Codes', end: false, icon: IconTicket },
  { to: '/admin/promo-event', label: 'Event', end: false, icon: IconEvent },
  { to: '/admin/levels', label: 'Levels', end: false, icon: IconLevels },
  { to: '/admin/settings', label: 'Settings', end: false, icon: IconSettings },
  { to: '/admin/rpm', label: 'RPM', end: false, icon: IconGauge },
  { to: '/admin/subscriptions', label: 'Subscriptions', end: false, icon: IconRefresh },
  { to: '/admin/usage', label: 'Usage', end: false, icon: IconPulse },
  { to: '/admin/statistics', label: 'Statistics', end: false, icon: IconActivity },
  { to: '/admin/audit-logs', label: 'Audit Logs', end: false, icon: IconShield },
]

export function AdminLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const { resetAdminAuth } = useAdminAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await adminApi.logout()
    } catch {
      // ignore
    }
    resetAdminAuth()
    navigate('/admin/login', { replace: true })
  }

  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [menuOpen])

  return (
    <div className={`admin-shell ${menuOpen ? 'menu-open' : ''}`}>
      <button
        className="admin-nav-backdrop"
        type="button"
        aria-label="Close menu"
        tabIndex={menuOpen ? 0 : -1}
        onClick={() => setMenuOpen(false)}
      />

      <aside className="admin-sidebar" id="admin-sidebar">
        <div className="admin-brand">
          <div className="brand-mark" aria-hidden>
            <img src="/brand/mark.png" alt="" />
          </div>
          <div>
            <strong><BrandName /></strong>
            <small>Control plane</small>
          </div>
          <button
            className="admin-sidebar-close"
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="admin-nav-label">Workspace</div>
        <nav className="admin-nav">
          {sections.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `admin-nav-item ${isActive ? 'is-active' : ''}`}
            >
              <item.icon size={17} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div style={{ marginTop: 'auto', paddingTop: '10px', borderTop: '1px solid var(--border)' }}>
          <button
            type="button"
            className="admin-nav-item"
            style={{ width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
            onClick={handleLogout}
            disabled={loggingOut}
          >
            <IconLogout size={17} />
            <span>{loggingOut ? 'Signing out…' : 'Sign out'}</span>
          </button>
        </div>
      </aside>

      <div className="admin-main-wrap">
        <header className="admin-topbar">
          <button
            className="admin-burger-btn"
            type="button"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="admin-sidebar"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className={`admin-burger-icon ${menuOpen ? 'is-open' : ''}`} aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </button>

          <div className="admin-topbar-brand">
            <div className="brand-mark" aria-hidden>
              <img src="/brand/mark.png" alt="" />
            </div>
            <strong><BrandName /></strong>
          </div>

          <div className="admin-breadcrumb">
            <span><BrandName /></span>
            <b>/</b>
            <strong>Admin console</strong>
          </div>
          <div className="admin-top-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleLogout}
              disabled={loggingOut}
              title="Sign out of admin console"
            >
              <IconLogout size={15} />
              <span>{loggingOut ? 'Signing out…' : 'Logout'}</span>
            </button>
          </div>
        </header>
        <main className="admin-content">
          <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }}>Loading…</div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  )
}
