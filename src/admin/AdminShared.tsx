import { useMemo, useState, type ReactNode } from 'react'
import { formatUsdExact } from '../../shared/billing'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { IconSearch } from './Icons'

export function AdminPageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="admin-page-header">
      <div>
        <span className="eyebrow">Control plane</span>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="admin-page-actions">{actions}</div> : null}
    </div>
  )
}

export function SearchField({
  value,
  onChange,
  placeholder = 'Search…',
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <div className="admin-search">
      <IconSearch size={15} />
      <input
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}

export function StatusBadge({ value }: { value: string }) {
  const tone = ['active', 'healthy', 'completed', 'ok', 'live'].includes(value)
    ? 'green'
    : ['degraded', 'pending', 'trial', 'exhausted', 'partial'].includes(value)
      ? 'warn'
      : ['suspended', 'revoked', 'error', 'disabled', 'unavailable'].includes(value)
        ? 'danger'
        : 'muted'
  return <span className={`admin-badge admin-badge-${tone}`}>{value}</span>
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="admin-empty-state">
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function useAdminMutation(onRefresh: () => void) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true)
    try {
      await action()
      toast(message)
      onRefresh()
      return true
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Action failed', 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  return { run, busy }
}

export function useFiltered<T>(items: T[], predicate: (item: T, query: string) => boolean) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(
    () => items.filter((item) => predicate(item, query.toLowerCase().trim())),
    [items, predicate, query],
  )
  return { query, setQuery, filtered }
}

export function formatMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`
}

export { formatUsdExact }

export function formatTokens(tokens: number) {
  const n = Math.round(tokens)
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(abs % 1_000_000_000 === 0 ? 0 : 2)}B`
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(abs % 1_000_000 === 0 ? 0 : 2)}M`
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(abs % 1_000 === 0 ? 0 : 1)}K`
  return `${sign}${abs.toLocaleString('en-US')}`
}

export function formatNumber(value: number) {
  return value.toLocaleString('en-US')
}

export function formatDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(value))
    : '—'
}

/** Split date/time for compact two-line cells (e.g. Users · Last seen). */
export function formatDateParts(value: string | null): { date: string; time: string } | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return {
    date: new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(d),
    time: new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(d),
  }
}

export function useCopyToClipboard() {
  const { toast } = useToast()
  return async (value: string, label = 'Copied') => {
    const text = value.trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast(`${label} copied`, 'success')
    } catch {
      toast(`Could not copy ${label.toLowerCase()}`, 'error')
    }
  }
}

export function CopyText({
  value,
  label,
  children,
  className = '',
}: {
  value: string
  label: string
  children?: ReactNode
  className?: string
}) {
  const copy = useCopyToClipboard()
  if (!value) return <span className={className}>—</span>
  return (
    <button
      type="button"
      className={`admin-copy-btn ${className}`.trim()}
      title={`Click to copy ${label.toLowerCase()}`}
      onClick={() => void copy(value, label)}
    >
      {children ?? value}
    </button>
  )
}

export type SortDir = 'asc' | 'desc'

export function SortTh({
  label,
  active,
  dir,
  onClick,
}: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
}) {
  return (
    <th>
      <button type="button" className={`admin-sort-th ${active ? 'is-active' : ''}`} onClick={onClick}>
        <span>{label}</span>
        <span className="admin-sort-arrow" aria-hidden>
          {active ? (dir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  )
}

export function ConfirmModal({
  title,
  description,
  onClose,
  onConfirm,
  confirmLabel = 'Confirm',
}: {
  title: string
  description: string
  onClose: () => void
  onConfirm: () => void
  confirmLabel?: string
}) {
  return (
    <Modal
      open
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-danger" type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="confirm-copy">This cannot be undone from the UI.</p>
    </Modal>
  )
}
