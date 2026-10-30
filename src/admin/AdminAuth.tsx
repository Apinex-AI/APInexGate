import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { PasswordField } from '../components/PasswordField'
import { adminApi } from './api'
import type { AdminUser } from './types'
import { BrandName } from '../components/BrandName'
import './AdminAuth.css'

type AdminAuthProps = {
  children: (user: AdminUser) => ReactNode
}

export function AdminAuth({ children }: AdminAuthProps) {
  const [user, setUser] = useState<AdminUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    adminApi
      .me()
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (user || !window.location.hostname.startsWith('dev-admin.')) return
    const token = new URLSearchParams(window.location.search).get('access_token')?.trim()
    if (!token) return
    window.localStorage.setItem('dev_admin_access_token', token)
    window.history.replaceState({}, '', window.location.pathname)
    adminApi.me().then((data) => setUser(data.user)).catch(() => undefined)
  }, [user])

  async function login(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const data = await adminApi.login(password)
      setUser(data.user)
      setPassword('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to sign in')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <div className="admin-loading">Checking admin session…</div>
  }

  if (!user) {
    return (
      <main className="admin-login">
        <div className="admin-login-card">
          <div className="admin-login-brand">
            <div className="brand-mark" aria-hidden>
              <img src="/brand/mark.png" alt="" />
            </div>
            <div>
              <strong><BrandName /></strong>
              <small>Admin console</small>
            </div>
          </div>
          <div className="admin-login-copy">
            <span className="eyebrow">Private workspace</span>
            <h1>Sign in to control plane</h1>
            <p>Manage users, models, balances and platform operations from one place.</p>
          </div>

          <form className="admin-login-form" onSubmit={login}>
            <PasswordField
              id="admin-password"
              label="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              autoFocus
            />
            {error ? <p className="admin-login-error">{error}</p> : null}
            <button className="btn btn-primary btn-lg" type="submit" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </main>
    )
  }

  return <>{children(user)}</>
}
