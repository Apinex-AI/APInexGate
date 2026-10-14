import { useEffect, useState } from 'react'
import { Modal } from '../../components/Modal'
import { adminApi } from '../api'
import type { ProviderKey, ProviderKeysPayload } from '../types'
import {
  AdminPageHeader,
  ConfirmModal,
  EmptyState,
  StatusBadge,
  useAdminMutation,
} from '../AdminShared'
import { IconPlus, IconRefresh } from '../Icons'
import './AdminPages.css'

function formatUsdCents(cents: number) {
  const dollars = Math.max(0, cents) / 100
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatSubscription(key: ProviderKey) {
  const subParts: string[] = []
  if (key.subscriptionPlan) {
    subParts.push(key.subscriptionPlan)
  } else if (key.subscriptionMode) {
    subParts.push(key.subscriptionMode)
  }
  if (key.subscriptionTokensRemaining != null) {
    const tokens = key.subscriptionTokensRemaining
    if (tokens >= 1_000_000_000) {
      const remB = (Math.floor(tokens / 10_000_000) / 100).toFixed(2)
      subParts.push(`${remB}B tok`)
    } else {
      const remM = (tokens / 1_000_000).toFixed(1)
      subParts.push(`${remM}M tok`)
    }
  }
  return subParts.length > 0 ? subParts.join(' · ') : '—'
}

function formatBalance(key: ProviderKey) {
  const usd = key.balanceUsd != null ? `$${Number(key.balanceUsd).toFixed(2)}` : formatUsdCents(key.balanceUsdCents ?? 0)
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{usd}</div>
      {key.remainingUsd != null ? (
        <div className="table-muted" style={{ fontSize: '0.75rem' }}>
          Limit: ${Number(key.remainingUsd).toFixed(2)}
        </div>
      ) : null}
    </div>
  )
}

function formatRpm(key: ProviderKey) {
  const rpm = key.rpm ?? 5
  const plan = key.rpmPlan ? ` (${key.rpmPlan})` : ''
  return `${rpm} RPM${plan}`
}

export function AdminProviders() {
  const [data, setData] = useState<ProviderKeysPayload | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProviderKey | null>(null)
  const [provider, setProvider] = useState('apinex')
  const [email, setEmail] = useState('')
  const [secret, setSecret] = useState('')

  const refresh = () => {
    adminApi.providers().then(setData).catch(() => undefined)
  }
  useEffect(refresh, [])
  const { run, busy } = useAdminMutation(refresh)

  const keys = data?.keys ?? []

  const activeKeyIdByProvider = new Map<string, string>()
  for (const key of keys) {
    if (!['healthy', 'active', 'pending'].includes(key.status)) continue
    if (!activeKeyIdByProvider.has(key.provider)) activeKeyIdByProvider.set(key.provider, key.id)
  }

  const filtered = keys

  async function addKey() {
    const ok = await run(
      () =>
        adminApi.addProviderKey({
          provider,
          email: email.trim(),
          secret: secret.trim(),
        }),
      'Key added',
    )
    if (!ok) return
    setCreateOpen(false)
    setEmail('')
    setSecret('')
    setProvider('apinex')
  }

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="APInex Provider"
        actions={
          keys.length === 0 ? (
            <button className="btn btn-primary" type="button" onClick={() => setCreateOpen(true)}>
              <IconPlus size={15} />
              Add APInex key
            </button>
          ) : undefined
        }
      />

      <div className="admin-card admin-table-wrap">
        {filtered.length === 0 ? (
          <EmptyState
            title={keys.length === 0 ? 'No keys yet' : 'No matches'}
            description={
              keys.length === 0
                ? 'Add your APInex API key. Models are published from the admin catalog, not seeded automatically.'
                : 'Try another search.'
            }
            action={
              keys.length === 0 ? (
                <button className="btn btn-primary btn-sm" type="button" onClick={() => setCreateOpen(true)}>
                  Add key
                </button>
              ) : undefined
            }
          />
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th aria-label="Active key" />
                <th>Provider</th>
                <th>Label / Email</th>
                <th>Key</th>
                <th>Balance</th>
                <th>Subscription</th>
                <th>RPM</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((key) => (
                <tr key={key.id}>
                  <td className="provider-key-order-cell">
                    <span className={`provider-active-dot ${activeKeyIdByProvider.get(key.provider) === key.id ? 'is-active' : ''}`} title={activeKeyIdByProvider.get(key.provider) === key.id ? 'Currently selected key' : 'Available key'} />
                  </td>
                  <td>
                    <strong>{key.providerLabel || key.provider}</strong>
                  </td>
                  <td>
                    <strong>{key.email && key.email !== 'admin@apinex.bond' ? key.email : '—'}</strong>
                  </td>
                  <td>
                    <code className="table-code">
                      {key.secretHint}
                    </code>
                  </td>
                  <td className="mono">
                    {formatBalance(key)}
                  </td>
                  <td className="mono">
                    <span className="table-muted" style={{ fontSize: '0.85rem' }}>
                      {formatSubscription(key)}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: '0.85rem' }}>
                    {formatRpm(key)}
                  </td>
                  <td>
                    <StatusBadge value={key.status} />
                    {key.lastError ? (
                      <div className="table-muted" title={key.lastError}>
                        {key.lastError.slice(0, 48)}
                        {key.lastError.length > 48 ? '…' : ''}
                      </div>
                    ) : null}
                  </td>
                  <td className="table-actions">
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      disabled={busy}
                      title="Sync Balance & Subscription"
                      onClick={() =>
                        void run(() => adminApi.syncProviderKey(key.id).then(() => undefined), 'Synced')
                      }
                    >
                      <IconRefresh size={14} />
                      Sync
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      type="button"
                      disabled={busy}
                      onClick={() => setDeleteTarget(key)}
                    >
                      Delete
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
        onClose={() => !busy && setCreateOpen(false)}
        title="Add provider key"
        footer={
          <>
            <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={
                busy ||
                !secret.trim()
              }
              onClick={() => void addKey()}
            >
              {busy ? 'Adding…' : 'Add APInex key'}
            </button>
          </>
        }
      >
        <div className="form-stack">
          <div className="field">
            <label htmlFor="provider-type">Provider</label>
            <input
              id="provider-type"
              className="input"
              value="APInex (api.apinex.bond/v1)"
              disabled
            />
          </div>
          <div className="field">
            <label htmlFor="provider-email">
              Label / Email (optional)
            </label>
            <input
              id="provider-email"
              className="input"
              type="text"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="e.g. main-key or your apinex account"
            />
          </div>
          <div className="field">
            <label htmlFor="provider-secret">APInex API key</label>
            <input
              id="provider-secret"
              className="input mono"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="sk-apinex-…"
              autoFocus
              required
            />
            <small className="table-muted">
              API key from <code>https://apinex.bond/keys</code>
            </small>
          </div>
        </div>
      </Modal>

      {deleteTarget ? (
        <ConfirmModal
          title="Delete key?"
          description={`${deleteTarget.providerLabel} · ${deleteTarget.email} · ${deleteTarget.secretHint}`}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget
            setDeleteTarget(null)
            void run(() => adminApi.deleteProviderKey(target.id), 'Key deleted')
          }}
        />
      ) : null}
    </div>
  )
}
