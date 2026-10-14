import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { PasswordField } from '../components/PasswordField'
import { adminApi } from './api'
import type { AdminUser } from './types'
import { BrandName } from '../components/BrandName'
import './AdminAuth.css'

type AdminAuthProps = {
  children: (user: AdminUser) => ReactNode
}

type PendingLogin = {
  requestId: string
  expiresAt: string
}

export function AdminAuth({ children }: AdminAuthProps) {
  const [user, setUser] = useState<AdminUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pending, setPending] = useState<PendingLogin | null>(null)
  const [pendingNote, setPendingNote] = useState('Waiting for Telegram approval…')
  const pollRef = useRef<number | null>(null)

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

  useEffect(() => {
    if (!pending) {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }

    let cancelled = false
    const poll = async () => {
      try {
        const result = await adminApi.loginStatus(pending.requestId)
        if (cancelled) return
        if (result.status === 'approved' && 'user' in result) {
          setUser(result.user)
          setPending(null)
          setPassword('')
          setPendingNote('')
          setError('')
          return
        }
        if (result.status === 'denied') {
          setPending(null)
          setError('Login was denied in Telegram.')
          setPendingNote('')
          return
        }
        if (result.status === 'expired') {
          setPending(null)
          setError('Login request expired. Try again.')
          setPendingNote('')
          return
        }
        if (result.status === 'consumed') {
          // Cookie may already be set from a prior poll — try /me.
          try {
            const me = await adminApi.me()
            if (!cancelled) {
              setUser(me.user)
              setPending(null)
            }
          } catch {
            if (!cancelled) {
              setPending(null)
              setError('Login session was already claimed. Refresh or try again.')
            }
          }
          return
        }
        setPendingNote('Password accepted. Approve this login in Telegram to continue…')
      } catch (reason) {
        if (!cancelled) {
          const message = reason instanceof Error ? reason.message : 'Waiting for approval…'
          // Don't surface transient 429s as a broken request.
          if (!/too many status|try again later/i.test(message)) {
            setPendingNote(message)
          }
        }
      }
    }

    void poll()
    pollRef.current = window.setInterval(() => {
      void poll()
    }, 2000)

    return () => {
      cancelled = true
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [pending])

  async function login(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const data = await adminApi.login(password)
      if (data.pending) {
        setPending({ requestId: data.requestId, expiresAt: data.expiresAt })
        setPendingNote(data.message || 'Waiting for Telegram approval…')
        return
      }
      setUser(data.user)
      setPassword('')
      setPending(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to sign in')
      setPending(null)
    } finally {
      setSubmitting(false)
    }
  }

  function cancelPending() {
    setPending(null)
    setPendingNote('')
    setError('Login cancelled. Approve was not completed.')
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
            <h1>{pending ? 'Waiting for approval' : 'Sign in to control plane'}</h1>
            <p>
              {pending
                ? 'Password is correct. Open Telegram topic Admin login and tap Approve or Deny.'
                : 'Manage users, models, balances and platform operations from one place.'}
            </p>
          </div>

          {pending ? (
            <div className="admin-login-pending">
              <div className="admin-login-pending-pulse" aria-hidden />
              <p className="admin-login-pending-copy">{pendingNote}</p>
              <p className="admin-muted admin-login-pending-meta">
                Request <code>{pending.requestId}</code>
              </p>
              <button className="btn btn-secondary" type="button" onClick={cancelPending}>
                Cancel
              </button>
            </div>
          ) : (
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
          )}

          {pending && error ? <p className="admin-login-error" style={{ marginTop: 14 }}>{error}</p> : null}
        </div>
      </main>
    )
  }

  return <>{children(user)}</>
}
