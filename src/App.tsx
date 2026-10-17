import { useEffect, useState } from 'react'
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
import { AdminAuth } from './admin/AdminAuth'
import { AdminLayout } from './admin/AdminLayout'
import { AdminDashboard } from './admin/pages/AdminDashboard'
import { AdminUsers } from './admin/pages/AdminUsers'
import { AdminProviders } from './admin/pages/AdminProviders'
import { AdminModels } from './admin/pages/AdminModels'
import { AdminBalances } from './admin/pages/AdminBalances'
import { AdminPromos } from './admin/pages/AdminPromos'
import { AdminSettings } from './admin/pages/AdminSettings'
import { AdminSubscriptions } from './admin/pages/AdminSubscriptions'
import { AdminUsage } from './admin/pages/AdminUsage'
import { AdminStatistics } from './admin/pages/AdminStatistics'
import { AdminRpm } from './admin/pages/AdminRpm'
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
  return isAdminConsoleHost(window.location.hostname)
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
              <Route path="/admin/login" element={<AdminAuthPage />} />
              <Route path="/admin" element={<AdminAuthLayout />}>
                <Route index element={<AdminDashboard />} />
                <Route path="users" element={<AdminUsers />} />
                <Route path="providers" element={<AdminProviders />} />
                <Route path="models" element={<AdminModels />} />
                <Route path="balances" element={<AdminBalances />} />
                <Route path="promos" element={<AdminPromos />} />
                <Route path="settings" element={<AdminSettings />} />
                <Route path="rpm" element={<AdminRpm />} />
                <Route path="subscriptions" element={<AdminSubscriptions />} />
                <Route path="usage" element={<AdminUsage />} />
                <Route path="statistics" element={<AdminStatistics />} />
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
  return <AdminAuth>{() => <Navigate to="/admin" replace />}</AdminAuth>
}

function AdminAuthLayout() {
  return (
    <AdminAuth>
      {() => <AdminLayout />}
    </AdminAuth>
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
