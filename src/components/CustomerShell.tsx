import { useEffect, useMemo, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { CustomerProvider } from '../auth/CustomerContext'
import { userApi, type CustomerUser } from '../auth/userApi'
import { Layout } from './Layout'
import { PublicChrome } from './PublicChrome'

/** Paths that guests may open without login (SEO + pricing). */
const PUBLIC_APP_PATHS = new Set(['/models', '/status'])

type Actions = { logout: () => Promise<void>; refresh: () => Promise<void> }

/**
 * Single shell for the whole customer app so sidebar Layout does not remount
 * when switching Overview ↔ Models ↔ Billing, etc.
 *
 * - logged in → Layout (always)
 * - guest on /models → PublicChrome
 * - guest elsewhere → /login
 */
export function CustomerShell({
  loginPath = '/login',
}: {
  loginPath?: string
}) {
  const location = useLocation()
  const [user, setUser] = useState<CustomerUser | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    userApi
      .me()
      .then((data) => {
        if (!cancelled) setUser(data.user)
      })
      .catch(() => {
        if (!cancelled) setUser(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const actions: Actions = useMemo(
    () => ({
      logout: async () => {
        await userApi.logout()
        setUser(null)
        window.location.href = '/'
      },
      refresh: async (patchUser?: CustomerUser) => {
        if (patchUser) {
          setUser(patchUser)
          return
        }
        try {
          const next = await userApi.me()
          setUser(next.user)
        } catch {
          setUser(null)
        }
      },
    }),
    [],
  )

  const providerValue = useMemo(
    () => (user ? { user, ...actions } : null),
    [user, actions],
  )

  if (user === undefined) {
    return <div className="admin-loading" style={{ minHeight: '40vh' }} />
  }

  const path = location.pathname.replace(/\/$/, '') || '/'
  const isPublicPath = PUBLIC_APP_PATHS.has(path)

  if (!user || !providerValue) {
    if (isPublicPath) {
      return (
        <PublicChrome newTab>
          <Outlet />
        </PublicChrome>
      )
    }
    return <Navigate to={loginPath} replace state={{ from: location }} />
  }

  return (
    <CustomerProvider value={providerValue}>
      <Layout />
    </CustomerProvider>
  )
}
