import { useEffect, useMemo, useState } from 'react'
import { adminApi } from '../api'
import type { ModelUsagePayload, ModelUsageRow, ModelUsageTotals } from '../types'
import { EmptyState } from '../AdminShared'

const WINDOWS: Array<{ id: '24h' | '7d' | '30d' | 'all'; label: string }> = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'all', label: 'All time' },
]

const KINDS: Array<{ id: 'all' | 'free' | 'paid' | 'tool'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'free', label: 'Free' },
  { id: 'paid', label: 'Paid' },
  { id: 'tool', label: 'Tools' },
]

type SortKey =
  | 'requests'
  | 'errorRatePct'
  | 'users'
  | 'totalTokens'
  | 'costUsd'
  | 'medianLatencyMs'

const COLUMNS: Array<{ key: SortKey | 'model' | 'share'; label: string; sortable?: SortKey }> = [
  { key: 'model', label: 'Model' },
  { key: 'requests', label: 'Requests', sortable: 'requests' },
  { key: 'share', label: 'Share' },
  { key: 'errorRatePct', label: 'Errors', sortable: 'errorRatePct' },
  { key: 'users', label: 'Users', sortable: 'users' },
  { key: 'totalTokens', label: 'Tokens', sortable: 'totalTokens' },
  { key: 'costUsd', label: 'Cost', sortable: 'costUsd' },
  { key: 'medianLatencyMs', label: 'Latency (med / avg)', sortable: 'medianLatencyMs' },
]

const int = (n: number) => (Number(n) || 0).toLocaleString('en-US')

const compact = (n: number) => {
  const v = Number(n) || 0
  if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return int(v)
}

const usd = (n: number) => {
  const v = Number(n) || 0
  if (v === 0) return '$0'
  if (v < 0.01) return '<$0.01'
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const ms = (n: number) => {
  const v = Math.round(Number(n) || 0)
  if (v <= 0) return '—'
  if (v < 1000) return `${v}ms`
  return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)}s`
}

const relative = (iso: string | null) => {
  if (!iso) return '—'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '—'
  const diff = Date.now() - then
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function TotalsCard({
  title,
  tone,
  totals,
  shareOf,
}: {
  title: string
  tone: 'all' | 'free' | 'paid' | 'tool'
  totals: ModelUsageTotals
  shareOf?: number
}) {
  const share =
    shareOf && shareOf > 0 ? Math.round((totals.requests / shareOf) * 1000) / 10 : null
  return (
    <article className={`admin-stat-card model-usage-card model-usage-card--${tone}`}>
      <div className="admin-stat-label">
        <span>{title}</span>
        {share !== null ? <em className="model-usage-card-share">{share}%</em> : null}
      </div>
      <strong className="model-usage-card-value">{int(totals.requests)}</strong>
      <span className="model-usage-card-unit">requests · {totals.models} models</span>
      <dl className="admin-stat-list model-usage-card-list">
        <div>
          <dt>Errors</dt>
          <dd>
            {int(totals.errorRequests)}
            {totals.requests > 0 ? ` (${totals.errorRatePct}%)` : ''}
          </dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{compact(totals.totalTokens)}</dd>
        </div>
        <div>
          <dt>Revenue</dt>
          <dd>{usd(totals.costUsd)}</dd>
        </div>
      </dl>
    </article>
  )
}

/** Stacked daily bars: free vs paid vs tools requests. */
function DailyBars({ points }: { points: ModelUsagePayload['daily'] }) {
  if (!points.length) return null
  const max = Math.max(...points.map((p) => p.requests), 1)
  return (
    <div className="model-usage-bars" role="img" aria-label="Daily requests by tier">
      {points.map((point) => {
        const height = Math.max(2, Math.round((point.requests / max) * 100))
        const freePct = point.requests > 0 ? (point.free / point.requests) * 100 : 0
        const paidPct = point.requests > 0 ? (point.paid / point.requests) * 100 : 0
        const toolPct = point.requests > 0 ? (point.tool / point.requests) * 100 : 0
        return (
          <div
            key={point.day}
            className="model-usage-bar"
            title={`${point.day} · ${int(point.requests)} req · free ${int(point.free)} · paid ${int(
              point.paid,
            )} · tools ${int(point.tool)} · errors ${int(point.errors)} · ${usd(point.costUsd)}`}
          >
            <div className="model-usage-bar-track" style={{ height: `${height}%` }}>
              <span className="model-usage-bar-seg is-free" style={{ height: `${freePct}%` }} />
              <span className="model-usage-bar-seg is-paid" style={{ height: `${paidPct}%` }} />
              <span className="model-usage-bar-seg is-tool" style={{ height: `${toolPct}%` }} />
            </div>
            <em>{point.label}</em>
          </div>
        )
      })}
    </div>
  )
}

export function ModelUsagePanel() {
  const [data, setData] = useState<ModelUsagePayload | null>(null)
  const [window, setWindow] = useState<'24h' | '7d' | '30d' | 'all'>('7d')
  const [kind, setKind] = useState<'all' | 'free' | 'paid' | 'tool'>('all')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('requests')
  const [sortDesc, setSortDesc] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function load(next?: '24h' | '7d' | '30d' | 'all') {
    const target = next ?? window
    setLoading(true)
    setError('')
    try {
      setData(await adminApi.modelUsage(target))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load model usage')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function changeWindow(next: '24h' | '7d' | '30d' | 'all') {
    setWindow(next)
    void load(next)
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDesc((prev) => !prev)
      return
    }
    setSortKey(key)
    setSortDesc(true)
  }

  const rows = useMemo(() => {
    const all = data?.models ?? []
    const needle = query.trim().toLowerCase()
    const filtered = all.filter((row) => {
      if (kind !== 'all' && row.kind !== kind) return false
      if (!needle) return true
      return (
        row.modelId.toLowerCase().includes(needle) ||
        row.name.toLowerCase().includes(needle) ||
        row.provider.toLowerCase().includes(needle)
      )
    })
    const sorted = [...filtered].sort((a, b) => {
      const av = Number(a[sortKey]) || 0
      const bv = Number(b[sortKey]) || 0
      if (av === bv) return b.requests - a.requests
      return sortDesc ? bv - av : av - bv
    })
    return sorted
  }, [data, kind, query, sortKey, sortDesc])

  if (loading && !data) {
    return <EmptyState title="Loading model usage…" description="Aggregating gateway requests." />
  }
  if (error && !data) {
    return <EmptyState title="Model usage unavailable" description={error} />
  }

  const totals = data?.totals
  const maxRequests = rows.length ? Math.max(...rows.map((row) => row.requests), 1) : 1

  return (
    <section className="model-usage">
      <div className="admin-statistics-charts-toolbar">
        <div>
          <h2>Model requests</h2>
          <p>
            Every gateway call, free and paid. Revenue is what users actually spent, so free
            models always read $0.
            {data?.generatedAt ? ` Updated ${relative(data.generatedAt)}.` : ''}
          </p>
        </div>
        <div className="soft-chart-period-bar">
          {WINDOWS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={window === item.id ? 'is-active' : ''}
              disabled={loading}
              onClick={() => changeWindow(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {totals ? (
        <div className="model-usage-totals">
          <TotalsCard title="All requests" tone="all" totals={totals.all} />
          <TotalsCard title="Free models" tone="free" totals={totals.free} shareOf={totals.all.requests} />
          <TotalsCard title="Paid models" tone="paid" totals={totals.paid} shareOf={totals.all.requests} />
          <TotalsCard title="Tools" tone="tool" totals={totals.tools} shareOf={totals.all.requests} />
        </div>
      ) : null}

      {data?.daily?.length ? (
        <section className="admin-card model-usage-chart-card">
          <div className="admin-card-header">
            <div>
              <h2>Requests per day</h2>
              <p>Stacked by tier — hover a bar for the exact split.</p>
            </div>
            <div className="model-usage-legend">
              <span className="is-free">Free</span>
              <span className="is-paid">Paid</span>
              <span className="is-tool">Tools</span>
            </div>
          </div>
          <DailyBars points={data.daily} />
        </section>
      ) : null}

      <section className="admin-card admin-statistics-panel">
        <div className="admin-card-header">
          <div>
            <h2>Per-model breakdown</h2>
            <p>Sorted by requests. Click a numeric header to re-sort.</p>
          </div>
        </div>

        <div className="model-usage-filters">
          <div className="admin-tabs model-usage-kind-tabs">
            {KINDS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={kind === item.id ? 'is-active' : ''}
                onClick={() => setKind(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by model id, name, or provider…"
          />
        </div>

        {rows.length === 0 ? (
          <EmptyState title="No model requests" description="Nothing matched this window or filter." />
        ) : (
          <div className="admin-statistics-table-scroll">
            <table className="admin-table admin-statistics-table model-usage-table">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      className={column.sortable ? 'is-sortable' : undefined}
                      onClick={column.sortable ? () => toggleSort(column.sortable!) : undefined}
                    >
                      {column.label}
                      {column.sortable === sortKey ? <span>{sortDesc ? ' ↓' : ' ↑'}</span> : null}
                    </th>
                  ))}
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <ModelRow key={`${row.modelId}|${row.provider}`} row={row} maxRequests={maxRequests} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data?.topUsers?.length ? (
        <section className="admin-card admin-statistics-panel">
          <div className="admin-card-header">
            <div>
              <h2>Heaviest users</h2>
              <p>Top consumers in this window across all models.</p>
            </div>
          </div>
          <div className="admin-statistics-table-scroll">
            <table className="admin-table admin-statistics-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Requests</th>
                  <th>Errors</th>
                  <th>Models</th>
                  <th>Tokens</th>
                  <th>Spent</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {data.topUsers.map((user, index) => (
                  <tr key={`${user.userId ?? user.email ?? index}`}>
                    <td>
                      <strong>{user.email || user.name || '—'}</strong>
                      {user.userId ? <div className="table-muted">#{user.userId}</div> : null}
                    </td>
                    <td className="mono">{int(user.requests)}</td>
                    <td className="mono">{int(user.errors)}</td>
                    <td className="mono">{int(user.models)}</td>
                    <td className="mono">{compact(user.totalTokens)}</td>
                    <td className="mono">{usd(user.costUsd)}</td>
                    <td className="table-muted">{relative(user.lastUsedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </section>
  )
}

function ModelRow({ row, maxRequests }: { row: ModelUsageRow; maxRequests: number }) {
  const width = Math.max(2, Math.round((row.requests / maxRequests) * 100))
  return (
    <tr>
      <td>
        <div className="model-usage-model">
          <span className={`model-usage-kind model-usage-kind--${row.kind}`}>{row.kind}</span>
          <div>
            <strong>{row.name}</strong>
            <code className="table-code">{row.modelId}</code>
            <div className="table-muted">
              {row.provider}
              {row.upstreamProvider ? ` · ${row.upstreamProvider}` : ''}
              {row.inCatalog ? '' : ' · removed from catalog'}
            </div>
          </div>
        </div>
      </td>
      <td className="mono">
        <div className="model-usage-requests">
          <span>{int(row.requests)}</span>
          <i style={{ width: `${width}%` }} />
        </div>
      </td>
      <td className="mono">{row.sharePct}%</td>
      <td className="mono">
        {row.errorRequests > 0 ? (
          <span className={row.errorRatePct >= 5 ? 'model-usage-error-hot' : undefined}>
            {int(row.errorRequests)} · {row.errorRatePct}%
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className="mono">{int(row.users)}</td>
      <td className="mono" title={`in ${int(row.inputTokens)} · out ${int(row.outputTokens)}`}>
        {compact(row.totalTokens)}
      </td>
      <td className="mono">{row.kind === 'free' ? 'free' : usd(row.costUsd)}</td>
      <td className="mono" title={`max ${ms(row.maxLatencyMs)}`}>
        {ms(row.medianLatencyMs)} / {ms(row.avgLatencyMs)}
      </td>
      <td className="table-muted">{relative(row.lastUsedAt)}</td>
    </tr>
  )
}
