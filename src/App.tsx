import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { CustomerShell } from './components/CustomerShell'

import { ToastProvider } from './components/Toast'
import { userApi } from './auth/userApi'
import { ApiKeys } from './pages/ApiKeys'
import { Docs } from './pages/Docs'
import { Usage } from './pages/Usage'
import { Billing } from './pages/Billing'
import { Dashboard } from './pages/Dashboard'
import { Landing } from './pages/Landing'
import { PricingPage } from './pages/Pricing'
import { StatusPage } from './pages/Status'


import { Models } from './pages/Models'
import { Subscriptions } from './pages/Subscriptions'
import { Playground } from './pages/Playground'
import { Rpm } from './pages/Rpm'

const AdminAuth = lazy(() => import('./admin/AdminAuth').then((m) => ({ default: m.AdminAuth })))
const AdminLayout = lazy(() => import('./admin/AdminLayout').then((m) => ({ default: m.AdminLayout })))
const AdminDashboard = lazy(() => import('./admin/pages/AdminDashboard').then((m) => ({ default: m.AdminDashboard })))
const AdminUsers = lazy(() => import('./admin/pages/AdminUsers').then((m) => ({ default: m.AdminUsers })))
const AdminProviders = lazy(() => import('./admin/pages/AdminProviders').then((m) => ({ default: m.AdminProviders })))
const AdminModels = lazy(() => import('./admin/pages/AdminModels').then((m) => ({ default: m.AdminModels })))
const AdminBalances = lazy(() => import('./admin/pages/AdminBalances').then((m) => ({ default: m.AdminBalances })))
const AdminPromos = lazy(() => import('./admin/pages/AdminPromos').then((m) => ({ default: m.AdminPromos })))
const AdminSettings = lazy(() => import('./admin/pages/AdminSettings').then((m) => ({ default: m.AdminSettings })))
const AdminSubscriptions = lazy(() => import('./admin/pages/AdminSubscriptions').then((m) => ({ default: m.AdminSubscriptions })))
const AdminUsage = lazy(() => import('./admin/pages/AdminUsage').then((m) => ({ default: m.AdminUsage })))
const AdminStatistics = lazy(() => import('./admin/pages/AdminStatistics').then((m) => ({ default: m.AdminStatistics })))
const AdminRpm = lazy(() => import('./admin/pages/AdminRpm').then((m) => ({ default: m.AdminRpm })))
const AdminPricing = lazy(() => import('./admin/pages/AdminPricing').then((m) => ({ default: m.AdminPricing })))
const AdminApiKeys = lazy(() => import('./admin/pages/AdminApiKeys').then((m) => ({ default: m.AdminApiKeys })))
const AdminAuditLogs = lazy(() => import('./admin/pages/AdminAuditLogs').then((m) => ({ default: m.AdminAuditLogs })))
const AdminLevels = lazy(() => import('./admin/pages/AdminLevels').then((m) => ({ default: m.AdminLevels })))
const AdminEvent = lazy(() => import('./admin/pages/AdminEvent').then((m) => ({ default: m.AdminEvent })))

import { UserAuth } from './auth/UserAuth'
import { captureReferralFromUrl } from './auth/referral'
import { DevelopersLayout } from './developers/DevelopersLayout'
import {
  DevAuthPage,
  DevBalancePage,
  DevErrorsPage,
  DevModelsChatPage,
  DevModelsConnectPage,
  DevModelsDecisionsPage,
  DevModelsMessagesPage,
  DevModelsOverviewPage,
  DevModelsResponsesPage,
  DevOverviewPage,
  DevRpmPage,
  DevSubscriptionPage,
} from './developers/pages'
import { isAdminConsoleHost } from '../shared/adminHosts'

function adminUiAllowed() {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname.toLowerCase()
  const path = window.location.pathname.toLowerCase()
  return (
    path.startsWith('/admin') ||
    host.startsWith('admin.') ||
    host.startsWith('dev-admin.') ||
    isAdminConsoleHost(host)
  )
}

function ReferralLandingRedirect() {
  const code = captureReferralFromUrl()
  return <Navigate to={code ? `/login?ref=${encodeURIComponent(code)}` : '/login'} replace />
}

export default function App() {
  const showAdmin = adminUiAllowed()

  return (
    <ToastProvider>
      <BrowserRouter>

        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/login" element={<UserAuth variant="page" initialMode="login" />} />
          <Route path="/register" element={<UserAuth variant="page" initialMode="register" />} />
          <Route path="/ref" element={<ReferralLandingRedirect />} />

          <Route path="/developers" element={<DevelopersLayout />}>
            {developerChildRoutes()}
          </Route>
          <Route path="/docs" element={<DevelopersLayout />}>
            {developerChildRoutes()}
          </Route>


          {/*
            One customer shell for all app tabs so Layout/sidebar does not remount
            when switching Overview → Models → Billing (no flash).
            Guests may still open /models; other app routes require login.
          */}
          <Route element={<CustomerShell loginPath="/login" />}>
            <Route path="overview" element={<Dashboard />} />
            <Route path="keys" element={<ApiKeys />} />
            <Route path="setup" element={<Docs />} />
            <Route path="usage" element={<Usage />} />
            <Route path="models" element={<Models />} />
            <Route path="subscriptions" element={<Subscriptions />} />
            <Route path="billing" element={<Billing />} />
            <Route path="rpm" element={<Rpm />} />
            <Route path="playground" element={<Playground />} />
            <Route path="status" element={<StatusPage />} />
          </Route>

          {showAdmin ? (
            <>
              <Route
                path="/admin/login"
                element={
                  <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                    <AdminAuthPage />
                  </Suspense>
                }
              />
              <Route
                path="/admin"
                element={
                  <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                    <AdminAuthLayout />
                  </Suspense>
                }
              >
                <Route
                  index
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminDashboard />
                    </Suspense>
                  }
                />
                <Route
                  path="users"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminUsers />
                    </Suspense>
                  }
                />
                <Route
                  path="api-keys"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminApiKeys />
                    </Suspense>
                  }
                />
                <Route
                  path="providers"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminProviders />
                    </Suspense>
                  }
                />
                <Route
                  path="models"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminModels />
                    </Suspense>
                  }
                />
                <Route
                  path="pricing"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminPricing />
                    </Suspense>
                  }
                />
                <Route
                  path="balances"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminBalances />
                    </Suspense>
                  }
                />
                <Route
                  path="promos"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminPromos />
                    </Suspense>
                  }
                />
                <Route
                  path="promo-event"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminEvent />
                    </Suspense>
                  }
                />
                <Route
                  path="levels"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminLevels />
                    </Suspense>
                  }
                />
                <Route
                  path="settings"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminSettings />
                    </Suspense>
                  }
                />
                <Route
                  path="rpm"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminRpm />
                    </Suspense>
                  }
                />
                <Route
                  path="subscriptions"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminSubscriptions />
                    </Suspense>
                  }
                />
                <Route
                  path="usage"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminUsage />
                    </Suspense>
                  }
                />
                <Route
                  path="statistics"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminStatistics />
                    </Suspense>
                  }
                />
                <Route
                  path="audit-logs"
                  element={
                    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
                      <AdminAuditLogs />
                    </Suspense>
                  }
                />
                <Route path="*" element={<Navigate to="/admin" replace />} />
              </Route>
            </>
          ) : (
            <Route path="/admin/*" element={<SessionHomeRedirect />} />
          )}

          <Route path="*" element={<SessionHomeRedirect />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  )
}

/** Unknown doc paths stay on the section the visitor opened. */
function DeveloperSectionHome() {
  const { pathname } = useLocation()
  return <Navigate to={pathname.startsWith('/docs') ? '/docs' : '/developers'} replace />
}

function developerChildRoutes() {
  return (
    <>
      <Route index element={<DevOverviewPage />} />
      <Route path="auth" element={<DevAuthPage />} />
      <Route path="balance" element={<DevBalancePage />} />
      <Route path="subscription" element={<DevSubscriptionPage />} />
      <Route path="rpm" element={<DevRpmPage />} />
      <Route path="errors" element={<DevErrorsPage />} />
      <Route path="models" element={<DevModelsOverviewPage />} />
      <Route path="models/chat" element={<DevModelsChatPage />} />
      <Route path="models/responses" element={<DevModelsResponsesPage />} />
      <Route path="models/messages" element={<DevModelsMessagesPage />} />
      <Route path="models/decisions" element={<DevModelsDecisionsPage />} />
      <Route path="models/connect" element={<DevModelsConnectPage />} />
      <Route path="*" element={<DeveloperSectionHome />} />
    </>
  )
}

function AdminAuthPage() {
  return (
    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
      <AdminAuth>{() => <Navigate to="/admin" replace />}</AdminAuth>
    </Suspense>
  )
}

function AdminAuthLayout() {
  return (
    <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
      <AdminAuth>
        {() => (
          <Suspense fallback={<div className="admin-loading" style={{ minHeight: '40vh' }} />}>
            <AdminLayout />
          </Suspense>
        )}
      </AdminAuth>
    </Suspense>
  )
}

/** Unknown routes + blocked /admin on public hosts: overview if logged in, else home. */
function SessionHomeRedirect() {
  const [target, setTarget] = useState<'loading' | '/overview' | '/'>('loading')

  useEffect(() => {
    let cancelled = false
    userApi
      .me()
      .then(() => {
        if (!cancelled) setTarget('/overview')
      })
      .catch(() => {
        if (!cancelled) setTarget('/')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (target === 'loading') {
    return <div className="admin-loading" style={{ minHeight: '40vh' }} />
  }
  return <Navigate to={target} replace />
}
