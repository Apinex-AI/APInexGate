import { useEffect, useMemo, useState } from 'react'
import { adminApi } from '../api'
import type { AuditLog } from '../types'
import { AdminPageHeader, EmptyState, formatDate, SearchField } from '../AdminShared'
import { IconShield } from '../Icons'
import './AdminPages.css'

export function AdminAuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    adminApi.audit().then((data) => setLogs(data.logs)).catch(() => undefined)
  }, [])

  const filtered = useMemo(
    () =>
      logs.filter((log) =>
        `${log.actor_email} ${log.action} ${log.target} ${log.metadata_json}`
          .toLowerCase()
          .includes(query.toLowerCase().trim()),
      ),
    [logs, query],
  )

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Audit Logs"
        description="Every privileged admin action is recorded with actor, target and timestamp."
        actions={<SearchField value={query} onChange={setQuery} placeholder="Search audit logs…" />}
      />

      <div className="admin-card admin-table-wrap">
        {filtered.length === 0 ? (
          <EmptyState
            title="No audit events yet"
            description="Login, logout, user changes, pricing updates and balance adjustments will appear here."
          />
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Actor</th>
                <th>Target</th>
                <th>Metadata</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((log) => (
                <tr key={log.id}>
                  <td>
                    <span className="audit-action">
                      <IconShield size={14} />
                      {log.action}
                    </span>
                  </td>
                  <td>{log.actor_email}</td>
                  <td>
                    <code className="mono">{log.target}</code>
                  </td>
                  <td>
                    <code className="table-code">{log.metadata_json}</code>
                  </td>
                  <td>{formatDate(log.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
