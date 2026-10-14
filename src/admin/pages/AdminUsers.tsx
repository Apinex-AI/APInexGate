import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '../../components/Modal'
import { adminApi } from '../api'
import type { AdminUserRecord } from '../types'
import {
  AdminPageHeader,
  ConfirmModal,
  CopyText,
  EmptyState,
  formatDateParts,
  formatNumber,

  SearchField,
  SortTh,
  StatusBadge,
  useAdminMutation,
  type SortDir,
} from '../AdminShared'
import { IconPlus } from '../Icons'
import { formatUsdExact, usdFromTokens } from '../../../shared/billing'
import './AdminPages.css'

type SortKey =
  | 'listNo'
  | 'balance_tokens'
  | 'requests'
  | 'allowance'

/** Highlight the figure once a free allowance is nearly gone. */
const ALLOWANCE_DANGER_PERCENT = 95




export function AdminUsers() {
  const [users, setUsers] = useState<AdminUserRecord[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<AdminUserRecord | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [balance, setBalance] = useState('0')
  const [sortKey, setSortKey] = useState<SortKey>('listNo')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadVersion = useRef(0)

  const loadUsers = (reset: boolean, search = query) => {
    const version = ++loadVersion.current
    const offset = reset ? 0 : users.length
    if (!reset) setLoadingMore(true)
    return adminApi.users({ limit: 100, offset, q: search, sort: sortKey, dir: sortDir }).then((data) => {
      if (version !== loadVersion.current) return
      setUsers((current) => reset ? data.users : [...current, ...data.users])
      setTotal(data.total)
      setHasMore(data.hasMore)
    }).catch(() => undefined).finally(() => { if (version === loadVersion.current) setLoadingMore(false) })
  }

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => { void loadUsers(true, query) }, 180)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [query, sortKey, sortDir])

  useEffect(() => {
    const onScroll = () => {
      if (hasMore && !loadingMore && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 400) {
        void loadUsers(false)
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [hasMore, loadingMore, users.length, query, sortKey, sortDir])

  const refresh = () => loadUsers(true)
  const { run, busy } = useAdminMutation(refresh)

  const listNo = useMemo(() => {
    const numbers = new Map<string, number>()
    users.forEach((user) => numbers.set(user.id, user.displayId ?? 0))
    return numbers
  }, [users])

  const filtered = users

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDir('desc')
  }

  async function createUser() {
    const balanceUsd = Number(balance || 0)
    const ok = await run(
      () => adminApi.createUser({ email: email.trim(), balanceUsd }),
      'User created',
    )
    if (!ok) return
    setCreateOpen(false)
    setEmail('')
    setBalance('0')
  }

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Users"
        description={`${total.toLocaleString()} customer accounts · loaded ${users.length}`}
        actions={
          <>
            <SearchField value={query} onChange={setQuery} placeholder="Search users or promo code…" />
            <button className="btn btn-primary" type="button" onClick={() => setCreateOpen(true)}>
              <IconPlus size={15} />
              Create user
            </button>
          </>
        }
      />

      <div className="admin-card admin-table-wrap">
        {filtered.length === 0 ? (
          <EmptyState
            title={users.length === 0 ? 'No users yet' : 'No users match your search'}
            description={
              users.length === 0
                ? 'Create the first customer account.'
                : 'Try a different search query.'
            }
            action={
              users.length === 0 ? (
                <button className="btn btn-primary btn-sm" type="button" onClick={() => setCreateOpen(true)}>
                  Create user
                </button>
              ) : undefined
            }
          />
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <SortTh
                  label="ID"
                  active={sortKey === 'listNo'}
                  dir={sortDir}
                  onClick={() => toggleSort('listNo')}
                />
                <th>Email</th>

                <th>TG Username</th>
                <SortTh
                  label="Balance"
                  active={sortKey === 'balance_tokens'}
                  dir={sortDir}
                  onClick={() => toggleSort('balance_tokens')}
                />
                <SortTh
                  label="Requests"
                  active={sortKey === 'requests'}
                  dir={sortDir}
                  onClick={() => toggleSort('requests')}
                />
                <th>Limits</th>
                <th>Last seen</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((user) => (
                <tr key={user.id}>
                  <td className="mono">{listNo.get(user.id) ?? '—'}</td>
                  <td>
                    <CopyText value={user.email} label="Email" className="admin-email-copy">
                      {user.email}
                    </CopyText>
                    {user.promo_codes && user.promo_codes.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                        {user.promo_codes.map((code) => (
                          <span
                            key={code}
                            className="admin-badge admin-badge-purple"
                            style={{
                              fontSize: 10,
                              padding: '1px 6px',
                              fontWeight: 650,
                              letterSpacing: '0.02em',
                              borderRadius: 4,
                            }}
                            title={`Used promo: ${code}`}
                          >
                            🏷 {code}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </td>

                  <td className="mono">
                    {user.telegram_username ? (
                      <CopyText value={user.telegram_username} label="Telegram">
                        {user.telegram_username}
                      </CopyText>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="mono">{formatUsdExact(usdFromTokens(user.balance_tokens))}</td>
                  <td className="mono">{user.requests.toLocaleString()}</td>
                  <td className="mono">
                    {user.allowance_unlimited ? (
                      <span className="admin-muted">∞</span>
                    ) : (
                      (() => {
                        const used = Number(user.allowance_used) || 0
                        const limit = Number(user.allowance_limit) || 0
                        const percent = Number(user.allowance_percent) || 0
                        const danger = percent >= ALLOWANCE_DANGER_PERCENT
                        return (
                          <span
                            className={danger ? 'admin-allowance-danger' : undefined}
                            title={`${formatNumber(used)} of ${formatNumber(limit)} tokens used (${percent.toFixed(1)}%)`}
                          >
                            {formatNumber(used)}
                            <span className="admin-muted"> / </span>
                            {formatNumber(limit)}
                          </span>
                        )
                      })()
                    )}
                  </td>
                  <td className="admin-last-seen">
                    {(() => {
                      const parts = formatDateParts(user.last_seen_at)
                      if (!parts) return <span className="admin-muted">—</span>
                      return (
                        <div className="admin-last-seen-stack" title={`${parts.date} · ${parts.time}`}>
                          <span>{parts.date}</span>
                          <span>{parts.time}</span>
                        </div>
                      )
                    })()}
                  </td>
                  <td>
                    <StatusBadge value={user.status} />
                  </td>
                  <td className="table-actions">
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      disabled={busy}
                      onClick={() => setSelected(user)}
                    >
                      {user.status === 'suspended' ? 'Activate' : 'Suspend'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      </div>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create user"
        description="Email and optional starting USD balance."
        footer={
          <>
            <button className="btn btn-secondary" type="button" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || !email.trim()}
              onClick={() => void createUser()}
            >
              Create user
            </button>
          </>
        }
      >
        <div className="form-stack">
          <div className="field">
            <label htmlFor="user-email">Email</label>
            <input
              id="user-email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="user-balance">Initial balance (USD)</label>
            <input
              id="user-balance"
              className="input"
              inputMode="decimal"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
            />
          </div>
        </div>
      </Modal>

      {selected ? (
        <ConfirmModal
          title={`${selected.status === 'suspended' ? 'Activate' : 'Suspend'} ${selected.email}?`}
          description={`Set status to ${selected.status === 'suspended' ? 'active' : 'suspended'}.`}
          onClose={() => setSelected(null)}
          onConfirm={() => {
            setSelected(null)
            void run(
              () =>
                adminApi.updateUser(selected.id, {
                  status: selected.status === 'suspended' ? 'active' : 'suspended',
                }),
              selected.status === 'suspended' ? 'User activated' : 'User suspended',
            )
          }}
        />
      ) : null}
    </div>
  )
}
