import { useCallback, useEffect, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { userApi, type CustomerApiKey } from '../auth/userApi'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'

import './ApiKeys.css'

export function ApiKeys() {
  const [searchParams] = useSearchParams()
  const tab = searchParams.get('tab')

  if (tab === 'setup') {
    return <Navigate to="/setup" replace />
  }
  if (tab === 'usage') {
    return <Navigate to="/usage" replace />
  }

  return (
    <div className="page keys-page">
      <div className="page-header">
        <div>
          <h1>API Keys</h1>
          <p>Create and manage API keys for your applications, CLI tools, and agent workflows.</p>
        </div>
      </div>

      <KeysPanel />
    </div>
  )
}

function KeysPanel() {
  const { toast } = useToast()
  const [keys, setKeys] = useState<CustomerApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CustomerApiKey | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const data = await userApi.keys()
    setKeys(data.keys)
  }, [])

  useEffect(() => {
    refresh()
      .catch(() => toast('Could not load API keys', 'error'))
      .finally(() => setLoading(false))
  }, [refresh, toast])

  async function createKey() {
    setBusy(true)
    try {
      const data = await userApi.createKey({
        name: name.trim() || 'Untitled key',
      })
      const newKeyWithSecret = { ...data.key, secret: data.secret }
      setKeys((prev) => [newKeyWithSecret, ...prev])
      setCreateOpen(false)
      setName('')
      void navigator.clipboard?.writeText(data.secret)
      toast('API key created & copied to clipboard!')
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Could not create key', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function deleteKey() {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await userApi.revokeKey(deleteTarget.id)
      setKeys((prev) => prev.filter((key) => key.id !== deleteTarget.id))
      setDeleteTarget(null)
      toast('Key deleted', 'info')
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'Could not delete key', 'error')
    } finally {
      setBusy(false)
    }
  }

  function handleCopyKey(key: CustomerApiKey) {
    if (!key.secret) {
      // If secret is not available from current session, copy prefix
      void navigator.clipboard?.writeText(key.prefix)
      setCopiedKeyId(key.id)
      setTimeout(() => setCopiedKeyId((cur) => (cur === key.id ? null : cur)), 1800)
      toast('Prefix copied — create a new key if you lost the secret', 'info')
      return
    }
    void navigator.clipboard?.writeText(key.secret)
    setCopiedKeyId(key.id)
    setTimeout(() => setCopiedKeyId((cur) => (cur === key.id ? null : cur)), 1800)
    toast('API key copied')
  }

  return (
    <>
      <div className="keys-panel-toolbar">
        <div className="keys-panel-meta">
          <span className="keys-live-dot" aria-hidden="true" />
          <span>{keys.length} active key{keys.length === 1 ? '' : 's'}</span>
        </div>
      <button className="btn btn-primary btn-sm keys-create-btn" type="button" onClick={() => setCreateOpen(true)}>
          <PlusIcon />
          <span>Create key</span>
        </button>
      </div>

      <div className="keys-deck-container">
        {loading ? (
          <div className="card keys-empty">Loading keys…</div>
        ) : keys.length === 0 ? (
          <div className="card keys-empty">
            <div className="keys-empty-icon" aria-hidden="true">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="15" r="4.25" />
                <path d="M11.2 11.8 20 3" />
                <path d="M16.5 6.5 18.5 8.5" />
                <path d="M18.5 3.5 20.5 5.5" />
              </svg>
            </div>
            <strong>No API keys created yet</strong>
            <p>Generate your first secret key to integrate with Cursor, CLI agents, and custom SDKs.</p>
          </div>
        ) : (
          <div className="keys-strip-list" role="list" aria-label="API keys">
            {keys.map((key) => (
              <article key={key.id} className="card key-strip-card" role="listitem">
                <div className="key-strip-main">
                  <div className="key-strip-icon-box" aria-hidden="true">
                    <RealKeyIcon />
                  </div>
                  <div className="key-strip-info">
                    <div className="key-strip-name-row">
                      <strong>{key.name}</strong>
                      <span className="key-status-chip">Active</span>
                    </div>
                    <div className="key-prefix-wrap">
                      <code className="mono key-prefix-code">{key.prefix}</code>
                    </div>
                  </div>
                </div>

                <div className="key-strip-meta">
                  <div className="key-meta-col">
                    <span className="key-meta-label">Created</span>
                    <time dateTime={key.createdAt}>{formatDate(key.createdAt)}</time>
                  </div>
                  <div className="key-meta-col">
                    <span className="key-meta-label">Last used</span>
                    <time>{key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}</time>
                  </div>
                </div>

                <div className="key-strip-actions">
                  <button
                    className="btn btn-secondary btn-sm key-action-copy"
                    type="button"
                    onClick={() => handleCopyKey(key)}
                    title="Copy API key"
                  >
                    {copiedKeyId === key.id ? (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm key-action-delete"
                    type="button"
                    disabled={busy}
                    onClick={() => setDeleteTarget(key)}
                    title="Delete key"
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={createOpen}
        onClose={() => !busy && setCreateOpen(false)}
        title="Create API Key"
        description="Name this key to organize your apps and integrations."
        panelClassName="key-modal-panel"
        footer={
          <>
            <button
              className="btn btn-secondary btn-sm key-modal-cancel"
              type="button"
              disabled={busy}
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </button>
            <button className="btn btn-primary btn-sm key-modal-submit" type="button" disabled={busy} onClick={() => void createKey()}>
              {busy ? 'Creating…' : 'Create key'}
            </button>
          </>
        }
      >
        <div className="form-stack key-modal-form">
          <div className="field">
            <label htmlFor="key-name">Key Name</label>
            <input
              id="key-name"
              className="input key-modal-input"
              placeholder="e.g. Production Backend, Cursor IDE"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <span className="field-hint">You will be able to copy the secret immediately after creation.</span>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => !busy && setDeleteTarget(null)}
        title="Delete API key?"
        description={
          deleteTarget ? `“${deleteTarget.name}” will be permanently deleted.` : undefined
        }
        panelClassName="key-modal-panel key-delete-modal-panel"
        footer={
          <>
            <button
              className="btn btn-secondary btn-sm key-modal-cancel"
              type="button"
              disabled={busy}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </button>
            <button className="btn btn-danger btn-sm key-modal-delete" type="button" disabled={busy} onClick={() => void deleteKey()}>
              {busy ? 'Deleting…' : 'Delete key'}
            </button>
          </>
        }
      >
        <div className="key-delete-modal-body">
          <div className="key-delete-warning-box">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <p>
              Applications and tools using this key will immediately receive <code className="mono">401 Unauthorized</code> errors. This action cannot be undone.
            </p>
          </div>
        </div>
      </Modal>
    </>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function RealKeyIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r="1.5" fill="currentColor" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  )
}
