import { useEffect, useMemo, useState } from 'react'
import { adminApi } from '../api'
import type { ApiKeyRecord } from '../types'
import {
  AdminPageHeader,
  ConfirmModal,
  EmptyState,
  formatDate,
  SearchField,
  StatusBadge,
  useAdminMutation,
} from '../AdminShared'
// formatTokens
import { IconKey } from '../Icons'
import './AdminPages.css'

export function AdminApiKeys() {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([])
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<ApiKeyRecord | null>(null)

  const refresh = () => {
    adminApi.apiKeys().then((data) => setKeys(data.keys)).catch(() => undefined)
  }
  useEffect(refresh, [])
  const { run, busy } = useAdminMutation(refresh)

  const filtered = useMemo(
    () =>
      keys.filter((key) =>
        `${key.name} ${key.email} ${key.prefix} ${key.status}`.toLowerCase().includes(query.toLowerCase().trim()),
      ),
    [keys, query],
  )

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="API Keys"
        description="Review and revoke active customer keys. Full secrets are never shown here."
        actions={<SearchField value={query} onChange={setQuery} placeholder="Search keys…" />}
      />

      <div className="admin-card admin-table-wrap">
        {filtered.length === 0 ? (
          <EmptyState
            title="No API keys yet"
            description="Keys will appear after customers create them in the user dashboard."
          />
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Owner</th>
                <th>Spend</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((key) => (
                <tr key={key.id}>
                  <td>
                    <div className="table-person">
                      <span className="provider-logo">
                        <IconKey size={15} />
                      </span>
                      <div>
                        <strong>{key.name}</strong>
                        <code className="table-code">{key.prefix}</code>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div>
                      <strong>{key.email}</strong>
                      <small>{key.user_id}</small>
                    </div>
                  </td>
                  <td>
                    <div>
                      <strong>{(key.spent_tokens ?? 0).toLocaleString()} tok</strong>
                      <small>
                        {key.spend_limit_tokens == null
                          ? 'No limit'
                          : `of ${(key.spend_limit_tokens).toLocaleString()} tok`}
                      </small>
                    </div>
                  </td>
                  <td>{formatDate(key.created_at)}</td>
                  <td>{formatDate(key.last_used_at)}</td>
                  <td>
                    <StatusBadge value={key.status} />
                  </td>
                  <td className="table-actions">
                    <button
                      className="btn btn-danger btn-sm"
                      type="button"
                      disabled={busy || key.status === 'revoked'}
                      onClick={() => setTarget(key)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {target ? (
        <ConfirmModal
          title="Revoke API key?"
          description={`${target.name} · ${target.prefix} will stop working immediately.`}
          onClose={() => setTarget(null)}
          onConfirm={() => {
            const key = target
            setTarget(null)
            void run(() => adminApi.updateKey(key.id, { status: 'revoked' }), 'API key revoked')
          }}
        />
      ) : null}
    </div>
  )
}
