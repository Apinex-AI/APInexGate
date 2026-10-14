import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { captureReferralFromUrl, getStoredReferralCode } from './referral'
import { userApi, type CustomerUser } from './userApi'

import { BrandName } from '../components/BrandName'
import '../admin/AdminAuth.css'
import './UserAuth.css'

type GateProps = {
  variant: 'gate'
  children: (user: CustomerUser, actions: { logout: () => Promise<void>; refresh: () => Promise<void> }) => ReactNode
}

type PageProps = {
  variant: 'page'
  initialMode: 'login' | 'register'
}

type UserAuthProps = GateProps | PageProps

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-20c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.3 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l.1.1 6.2 5.2C39.2 37 44 32.5 44 24c0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  )
}

function publicAuthError(raw: string) {
  return raw
}

export function UserAuth(props: UserAuthProps) {
  const location = useLocation()
  const [user, setUser] = useState<CustomerUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [googleEnabled, setGoogleEnabled] = useState(true)

  const [error, setError] = useState('')
  const [activeReferralCode, setActiveReferralCode] = useState<string | null>(() => getStoredReferralCode())

  async function refresh() {
    const data = await userApi.me()
    setUser(data.user)
  }

  useEffect(() => {
    userApi.me().then((data) => setUser(data.user)).catch(() => setUser(null)).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    userApi.authChallenge().then((data) => setGoogleEnabled(Boolean(data.googleEnabled))).catch(() => setGoogleEnabled(false))
  }, [])


  useEffect(() => {
    const code = captureReferralFromUrl() || getStoredReferralCode()
    if (code) setActiveReferralCode(code)
    const params = new URLSearchParams(window.location.search)
    const authError = params.get('auth_error')
    if (!authError) return
    setError(publicAuthError(authError))
    params.delete('auth_error')
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`
    window.history.replaceState({}, '', next)
  }, [])

  async function logout() {
    try {
      await userApi.logout()
    } catch {
      // Clear local state even if the network request fails.
    }
    setUser(null)
  }

  if (loading) return <div className="admin-loading">Checking session…</div>

  if (props.variant === 'gate') {
    if (!user) return <Navigate to="/login" replace state={{ from: location }} />
    return <>{props.children(user, { logout, refresh })}</>
  }

  if (user) {
    const target = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname || '/overview'
    return <Navigate to={target} replace />
  }

  const registering = props.initialMode === 'register'

  return (
    <main className="auth-shell">
      <aside className="auth-rail">
        <Link to="/" className="auth-rail-brand">
          <img src="/brand/mark.png" alt="" />
          <span><BrandName /></span>
        </Link>
        <div className="auth-rail-copy">
          <p className="auth-rail-kicker">One key</p>
          <h2>Every model. One balance.</h2>
          <ul>
            <li>OpenAI-compatible base URL</li>
            <li>Prepaid wallet, no monthly plan</li>
          </ul>
        </div>
      </aside>

      <section className="auth-panel">
        <div className="auth-panel-inner">
          <Link to="/" className="auth-mobile-brand">
            <img src="/brand/mark.png" alt="" />
            <span><BrandName /></span>
          </Link>

          <p className="auth-kicker">{registering ? 'Create account' : 'Sign in'}</p>
          <h1>{registering ? 'Start with Google' : 'Welcome back'}</h1>
          <p className="auth-lead">
            Same button either way. An existing Google account signs in. A new one creates the account.
          </p>

          {error ? <p className="auth-error" role="alert">{error}</p> : null}

          {activeReferralCode ? (
            <div className="user-auth-referral-tag">
              <span>Referral <strong>{activeReferralCode}</strong></span>
            </div>
          ) : null}

          {googleEnabled ? (
            <a
              className="auth-google"
              href="/api/user/auth/google"
            >
              <GoogleIcon />
              Continue with Google
            </a>
          ) : (
            <p className="auth-error">Google sign-in is temporarily unavailable.</p>
          )}


          <p className="auth-switch">
            {registering ? 'Already have an account?' : 'New here?'}
            {' '}
            <Link to={registering ? '/login' : '/register'}>
              {registering ? 'Sign in' : 'Create an account'}
            </Link>
          </p>
        </div>
      </section>
    </main>
  )
}
