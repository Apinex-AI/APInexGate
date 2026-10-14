import { useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'

import { apiBase } from '../lib/brand'
import { BrandName } from '../components/BrandName'
import './Developers.css'

type NavItem = {
  to: string
  label: string
  end?: boolean
}

type NavGroup = {
  title: string
  items: NavItem[]
}

const NAV: NavGroup[] = [
  {
    title: 'Start',
    items: [
      { to: '/docs', label: 'Overview', end: true },
      { to: '/docs/auth', label: 'Authentication' },
      { to: '/docs/errors', label: 'Errors & limits' },
      { to: '/docs/balance', label: 'Balance' },
    ],
  },
  {
    title: 'Models',
    items: [
      { to: '/docs/models', label: 'Catalog', end: true },
      { to: '/docs/models/billing', label: 'Token weight' },
      { to: '/docs/models/chat', label: 'Chat' },
      { to: '/docs/models/responses', label: 'Responses' },
      { to: '/docs/models/messages', label: 'Messages' },
      { to: '/docs/models/connect', label: 'Connect' },
    ],
  },
]

function Mark() {
  return (
    <svg className="ref-nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 7h16M4 12h10M4 17h7" />
    </svg>
  )
}

export function DevelopersLayout() {
  const location = useLocation()

  useEffect(() => {
    const hash = location.hash.slice(1)
    if (!hash) {
      window.scrollTo(0, 0)
      return
    }
    const jump = () => {
      const target = document.getElementById(hash)
      if (!target) return false
      const top = target.getBoundingClientRect().top + window.scrollY - 88
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
      return true
    }
    if (!jump()) {
      const frame = window.requestAnimationFrame(jump)
      return () => window.cancelAnimationFrame(frame)
    }
  }, [location.pathname, location.hash])

  return (
    <div className="ref-shell">
      <aside className="ref-side">
        <a className="ref-brand" href="/">
          <img src="/brand/mark.png" alt="" width={28} height={28} />
          <span>
            <strong><BrandName /></strong>
            <small>Reference</small>
          </span>
        </a>
        <div className="ref-nav-wrap">
          <nav className="ref-nav" aria-label="Reference">
            {NAV.map((group) => (
              <div key={group.title}>
                <div className="ref-nav-label">{group.title}</div>
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) => `ref-nav-link ${isActive ? 'is-active' : ''}`}
                  >
                    <Mark />
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        </div>
        <div className="ref-origin">
          <span>Base</span>
          <code>{apiBase().replace(/^https?:\/\//, '')}</code>
        </div>
        <div className="ref-side-actions">
          <a className="btn btn-secondary btn-sm" href="/setup">
            Setup
          </a>
          <a className="btn btn-primary btn-sm" href="/register">
            Get key
          </a>
        </div>
      </aside>
      <main className="ref-main">
        <Outlet />
      </main>
    </div>
  )
}
