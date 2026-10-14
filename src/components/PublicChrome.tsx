import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { BrandName } from '../components/BrandName'
import './PublicChrome.css'

/** Minimal marketing chrome for public SEO pages (logged-out). */
export function PublicChrome({ children, newTab = true }: { children: ReactNode; newTab?: boolean }) {
  const onPricing = useLocation().pathname === '/pricing'
  const item = (to: string, label: ReactNode, className?: string) =>
    newTab ? (
      <a className={className} href={to} target="_blank" rel="noreferrer">
        {label}
      </a>
    ) : (
      <Link className={className} to={to}>
        {label}
      </Link>
    )

  return (
    <div className="pub-chrome">
      <header className="pub-topbar">
        {item('/', <><img src="/brand/mark.png" alt="" width={28} height={28} /><strong><BrandName /></strong></>, 'pub-brand')}
        <nav className="pub-nav" aria-label="Public">
          {onPricing ? null : item('/pricing', 'Pricing')}
          {item('/models', 'Models')}
          {item('/docs', 'Documentation')}
          {item('/status', 'Status')}

          {item('/login', 'Log in', 'btn btn-secondary btn-sm')}
          {item('/register', 'Sign up', 'btn btn-primary btn-sm')}
        </nav>
      </header>
      <main className="pub-main">{children}</main>
      <footer className="pub-footer">
        {item('/', <BrandName />)}
        {item('/docs', 'Documentation')}
        {item('/models', 'Models')}

      </footer>
    </div>
  )
}
