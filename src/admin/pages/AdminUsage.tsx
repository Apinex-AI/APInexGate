import { useEffect, useMemo, useState } from 'react'
import { adminApi } from '../api'
import type { UsageEvent } from '../types'
import { AdminPageHeader, CopyText, EmptyState, formatDate, formatTokens, SearchField, StatusBadge } from '../AdminShared'
import { formatTokenCount, formatUsdBalance } from '../../../shared/billing'
import './AdminPages.css'

export function AdminUsage() {
  const [activeTab, setActiveTab] = useState<'all' | 'user'>('all')
  const [events, setEvents] = useState<UsageEvent[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [loading, setLoading] = useState(false)

  // User-specific state
  const [userQuery, setUserQuery] = useState('')
  const [userEvents, setUserEvents] = useState<UsageEvent[]>([])
  const [userLoading, setUserLoading] = useState(false)
  const [userSearched, setUserSearched] = useState(false)
  const [userNotFound, setUserNotFound] = useState(false)

  useEffect(() => {
    setLoading(true)
    adminApi
      .usage()
      .then((data) => setEvents(data.events))
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])

  async function handleUserLookup(e?: React.FormEvent) {
    if (e) e.preventDefault()
    const target = userQuery.trim()
    if (!target) return
    setUserLoading(true)
    setUserNotFound(false)
    setUserSearched(true)
    try {
      const data = await adminApi.usage(target)
      setUserEvents(data.events || [])
      setUserNotFound(Boolean(data.userNotFound))
    } catch {
      setUserEvents([])
    } finally {
      setUserLoading(false)
    }
  }

  const currentEvents = activeTab === 'all' ? events : userEvents
  const isCurrentLoading = activeTab === 'all' ? loading : userLoading

  const filtered = useMemo(
    () =>
      currentEvents.filter(
        (event) =>
          `${event.user_name ?? ''} ${event.email ?? ''} ${event.model_id ?? ''} ${event.provider}`
            .toLowerCase()
            .includes(query.toLowerCase().trim()) &&
          (status === 'all' || event.status === status),
      ),
    [currentEvents, query, status],
  )

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Usage"
        description="Request-level telemetry for cost, latency and gateway health."
        actions={<SearchField value={query} onChange={setQuery} placeholder="Filter displayed events…" />}
      />

      {/* Top Tabs */}
      <div className="admin-toolbar" style={{ marginBottom: 12 }}>
        <div className="admin-tabs" role="tablist">
          <button
            className={activeTab === 'all' ? 'is-active' : ''}
            type="button"
            role="tab"
            aria-selected={activeTab === 'all'}
            onClick={() => setActiveTab('all')}
          >
            All usage
          </button>
          <button
            className={activeTab === 'user' ? 'is-active' : ''}
            type="button"
            role="tab"
            aria-selected={activeTab === 'user'}
            onClick={() => setActiveTab('user')}
          >
            User usage
          </button>
        </div>
      </div>

      {/* User lookup bar when User usage tab is active */}
      {activeTab === 'user' ? (
        <section className="admin-card" style={{ marginBottom: 16, padding: '14px 18px' }}>
          <form
            onSubmit={handleUserLookup}
            style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}
          >
            <input
              className="input"
              style={{ minWidth: 280, flex: '1 1 320px' }}
              placeholder="user@email.com or user ID..."
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
            />
            <button
              className="btn btn-primary"
              type="submit"
              disabled={userLoading || !userQuery.trim()}
            >
              {userLoading ? 'Loading...' : 'Look'}
            </button>
          </form>
          {userNotFound ? (
            <p className="admin-hint" style={{ color: '#ef4444', marginTop: 8, marginBottom: 0 }}>
              User not found. Check the email or user ID.
            </p>
          ) : userSearched && !userLoading ? (
            <p className="admin-hint" style={{ marginTop: 8, marginBottom: 0 }}>
              Showing latest {userEvents.length} request(s) for <strong>{userQuery.trim()}</strong>
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="admin-toolbar">
        <div className="admin-tabs">
          <button className={status === 'all' ? 'is-active' : ''} type="button" onClick={() => setStatus('all')}>
            All
          </button>
          <button className={status === 'ok' ? 'is-active' : ''} type="button" onClick={() => setStatus('ok')}>
            Successful
          </button>
          <button className={status === 'error' ? 'is-active' : ''} type="button" onClick={() => setStatus('error')}>
            Errors
          </button>
        </div>
        <span className="admin-result-count">
          {isCurrentLoading ? 'Loading…' : `${filtered.length} events`}
        </span>
      </div>

      <div className="admin-card admin-table-wrap">
        {filtered.length === 0 ? (
          <EmptyState
            title={
              isCurrentLoading
                ? 'Loading usage events…'
                : activeTab === 'user' && !userSearched
                  ? 'Enter a user to inspect'
                  : 'No usage events'
            }
            description={
              activeTab === 'user' && !userSearched
                ? 'Enter email or user ID above and click Look to see their latest 500 requests.'
                : 'Once the API gateway processes requests, every call will show up here with tokens, cost and latency.'
            }
          />
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Request</th>
                <th>Model</th>
                <th>Tokens</th>
                <th>Charged</th>
                <th>Latency</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((event) => (
                <tr key={event.id}>
                  <td>
                    <div>
                      <small className="usage-request-line">
                        <strong>{event.usage_plan_label ?? 'FREE'}</strong>
                        {' • '}
                        {event.usage_tokens_limit != null
                          ? `${(event.usage_tokens_used ?? 0).toLocaleString('en-US')} / ${formatTokenCount(event.usage_tokens_limit)}`
                          : `${(event.usage_tokens_used ?? 0).toLocaleString('en-US')} / ∞`}
                      </small>
                      {event.email ? (
                        <CopyText value={event.email} label="Email" className="admin-email-copy">
                          <span className="admin-wallet-email">{event.email}</span>
                        </CopyText>
                      ) : (
                        <small>—</small>
                      )}
                    </div>
                  </td>
                  <td>
                    <div>
                      <strong>{event.model_id ?? 'Unknown'}</strong>
                      <small>{event.provider}</small>
                    </div>
                  </td>
                  <td className="mono">
                    {event.input_tokens.toLocaleString()} / {event.output_tokens.toLocaleString()}
                  </td>
                  <td className="mono">
                    {event.cost_tokens > 0 ? (
                      formatUsdBalance(event.cost_tokens)
                    ) : event.provider.toLowerCase() === 'free' || (event.model_id ?? '').startsWith('free/') ? (
                      <>
                        {formatTokens(
                          Math.ceil((event.input_tokens + event.output_tokens) * (event.model_weight || 1)),
                        )}
                        <span className="admin-muted"> · free</span>
                      </>
                    ) : (
                      <span className="admin-muted">$0.00</span>
                    )}
                  </td>
                  <td className="mono">{event.latency_ms} ms</td>
                  <td>
                    <StatusBadge value={event.status} />
                  </td>
                  <td>{formatDate(event.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
