import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { adminApi } from '../api'
import { AdminPageHeader, EmptyState } from '../AdminShared'
import { ModelUsagePanel } from './ModelUsagePanel'
import './AdminPages.css'

const CHART_UP = '#b388ff'
const CHART_DOWN = '#E87979'
const CHART_FLAT = '#8BA3B7'
const CHART_PADDING = { top: 18, right: 18, bottom: 28, left: 12 } as const

type Tab =
  | 'statistics'
  | 'models'
  | 'dashboard'
  | 'charts'
  | 'referrals'

type Row = Record<string, any>
type ChartPeriod = '7d' | '31d' | 'custom'
type ChartPoint = {
  day: string
  label: string
  value: number
  usd?: number
  sol?: number
  buys?: number
  tokensSold?: number
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'statistics', label: 'Statistics' },
  { id: 'models', label: 'Model Requests' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'charts', label: 'Charts' },
  { id: 'referrals', label: 'Referrals' },
]

const DASHBOARD_COLUMNS = [
  'period',
  'tokens',
  'totalBuys',
  'totalSol',
  'usdLabel',
] as const

const COLUMN_LABELS: Record<string, string> = {
  period: 'Period / day',
  tokens: 'Tokens',
  totalBuys: 'Total buys',
  totalSol: 'Total SOL',
  usdLabel: '~USD',
  id: 'Id',
  referral: 'Referral',
  referer: 'Referer',
  date: 'Date',
  userId: 'User',
  name: 'Name',
  email: 'Email',
  wallet: 'Wallet',
}

const asArray = (value: any): Row[] => (Array.isArray(value) ? value : [])

const display = (value: any) => {
  if (value == null || value === '') return '—'
  if (typeof value === 'number') return value.toLocaleString('en-US')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

const label = (key: string) =>
  COLUMN_LABELS[key] ||
  key.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase())

const money = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(Number(n) || 0)

const formatCompact = (n: number) => {
  const v = Number(n) || 0
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  if (Number.isInteger(v)) return v.toLocaleString('en-US')
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function DataTable({
  rows,
  emptyTitle,
  columns,
}: {
  rows: Row[]
  emptyTitle: string
  columns?: string[]
}) {
  const fields = columns?.length
    ? columns
    : Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 10)
  if (!rows.length) return <EmptyState title={emptyTitle} description="No records are available yet." />

  return (
    <div className="admin-statistics-table-scroll">
      <table className="admin-table admin-statistics-table">
        <thead>
          <tr>
            {fields.map((field) => (
              <th key={field}>{label(field)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row.id ?? row.userId ?? row.email ?? row.period ?? index}
              className={
                row.isDay === false ||
                String(row.period || '').startsWith('Last') ||
                row.period === 'All time'
                  ? 'admin-stats-tr--summary'
                  : undefined
              }
            >
              {fields.map((field) => (
                <td
                  key={field}
                  className={field === 'period' ? 'admin-stats-td-label' : undefined}
                >
                  {display(row[field])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatListCard({
  title,
  rows,
}: {
  title: string
  rows: Array<{ label: string; value: string | number }>
}) {
  return (
    <article className="admin-stat-card">
      <div className="admin-stat-label">
        <span>{title}</span>
      </div>
      <dl className="admin-stat-list">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{display(row.value)}</dd>
          </div>
        ))}
      </dl>
    </article>
  )
}

type Pt = { x: number; y: number }

/** Control points for Catmull-Rom → cubic bezier segment i → i+1 */
function cubicControls(points: Pt[], i: number) {
  const p0 = points[i === 0 ? 0 : i - 1]!
  const p1 = points[i]!
  const p2 = points[i + 1]!
  const p3 = points[i + 2 < points.length ? i + 2 : i + 1]!
  return {
    cp1x: p1.x + (p2.x - p0.x) / 6,
    cp1y: p1.y + (p2.y - p0.y) / 6,
    cp2x: p2.x - (p3.x - p1.x) / 6,
    cp2y: p2.y - (p3.y - p1.y) / 6,
    p1,
    p2,
  }
}

function smoothLinePath(points: Pt[]) {
  if (!points.length) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`
  }
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const { cp1x, cp1y, cp2x, cp2y, p2 } = cubicControls(points, i)
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
  }
  return d
}

function segmentPath(points: Pt[], i: number) {
  if (points.length < 2 || i < 0 || i >= points.length - 1) return ''
  if (points.length === 2) {
    return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} L ${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`
  }
  const { cp1x, cp1y, cp2x, cp2y, p1, p2 } = cubicControls(points, i)
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
}

function segmentTone(from: number, to: number): 'up' | 'down' | 'flat' {
  const delta = to - from
  const scale = Math.max(Math.abs(from), Math.abs(to), 1)
  if (Math.abs(delta) / scale < 0.015 || Math.abs(delta) < 1e-9) return 'flat'
  return delta > 0 ? 'up' : 'down'
}

function toneColor(tone: 'up' | 'down' | 'flat') {
  if (tone === 'up') return CHART_UP
  if (tone === 'down') return CHART_DOWN
  return CHART_FLAT
}

function toneFill(tone: 'up' | 'down' | 'flat') {
  if (tone === 'up') return 'rgba(179, 136, 255, 0.26)'
  if (tone === 'down') return 'rgba(232, 121, 121, 0.2)'
  return 'rgba(139, 163, 183, 0.2)'
}

type SoftChartProps = {
  title: string
  unit: string
  points: ChartPoint[]
  moneyMode?: boolean
}

function SoftChart({ title, unit, points, moneyMode }: SoftChartProps) {
  const plotRef = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const animRef = useRef<number | null>(null)
  const [dot, setDot] = useState<{ x: number; y: number; index: number; color: string } | null>(
    null,
  )

  const width = 920
  const height = 220
  const padding = CHART_PADDING
  const chartWidth = width - CHART_PADDING.left - CHART_PADDING.right
  const chartHeight = height - CHART_PADDING.top - CHART_PADDING.bottom

  const values = points.map((p) => Number(p.value) || 0)
  const minValue = values.length ? Math.min(...values) : 0
  const maxValue = values.length ? Math.max(...values, 1) : 1
  const valueRange = Math.max(maxValue - minValue, 1e-9)

  const mapped = useMemo(() => {
    if (!points.length) return [] as Array<ChartPoint & { x: number; y: number }>
    if (points.length === 1) {
      const value = Number(points[0].value) || 0
      return [
        {
          ...points[0],
          x: CHART_PADDING.left + chartWidth / 2,
          y:
            CHART_PADDING.top +
            chartHeight -
            ((value - minValue) / valueRange) * (chartHeight * 0.78) -
            chartHeight * 0.1,
        },
      ]
    }
    return points.map((point, index) => {
      const value = Number(point.value) || 0
      const x = CHART_PADDING.left + (chartWidth * index) / (points.length - 1)
      const y =
        CHART_PADDING.top +
        chartHeight -
        ((value - minValue) / valueRange) * (chartHeight * 0.78) -
        chartHeight * 0.1
      return { ...point, x, y }
    })
  }, [points, chartWidth, chartHeight, minValue, valueRange])

  const segments = useMemo(() => {
    if (mapped.length < 2) return [] as Array<{ d: string; tone: 'up' | 'down' | 'flat' }>
    return mapped.slice(0, -1).map((_, i) => ({
      d: segmentPath(mapped, i),
      tone: segmentTone(Number(mapped[i]!.value) || 0, Number(mapped[i + 1]!.value) || 0),
    }))
  }, [mapped])

  const linePath = smoothLinePath(mapped)
  const areaPath =
    mapped.length > 0
      ? `${linePath} L ${mapped[mapped.length - 1]!.x.toFixed(2)} ${height - padding.bottom} L ${mapped[0]!.x.toFixed(2)} ${height - padding.bottom} Z`
      : ''

  const slug = title.replace(/\W+/g, '-').toLowerCase()
  const gradFill = `soft-fill-${slug}`
  const gradStroke = `soft-stroke-${slug}`

  const activeIndex = hover != null ? hover : mapped.length ? mapped.length - 1 : 0
  const active = mapped[activeIndex]
  const activeColor = (() => {
    if (!mapped.length) return CHART_FLAT
    if (activeIndex <= 0) {
      if (mapped.length < 2) return CHART_FLAT
      return toneColor(
        segmentTone(Number(mapped[0]!.value) || 0, Number(mapped[1]!.value) || 0),
      )
    }
    return toneColor(
      segmentTone(
        Number(mapped[activeIndex - 1]!.value) || 0,
        Number(mapped[activeIndex]!.value) || 0,
      ),
    )
  })()

  useEffect(() => {
    if (!active) {
      setDot(null)
      return
    }
    const target = { x: active.x, y: active.y, index: activeIndex, color: activeColor }
    if (!dot) {
      setDot(target)
      return
    }
    if (animRef.current) cancelAnimationFrame(animRef.current)
    const from = { ...dot }
    const started = performance.now()
    const duration = 200
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / duration)
      const ease = 1 - Math.pow(1 - t, 3)
      setDot({
        x: from.x + (target.x - from.x) * ease,
        y: from.y + (target.y - from.y) * ease,
        index: target.index,
        color: target.color,
      })
      if (t < 1) animRef.current = requestAnimationFrame(step)
    }
    animRef.current = requestAnimationFrame(step)
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, active?.x, active?.y, activeColor])

  function onMove(event: MouseEvent<HTMLDivElement>) {
    if (!plotRef.current || !mapped.length) return
    const rect = plotRef.current.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / Math.max(rect.width, 1)
    const idx = Math.round(ratio * (mapped.length - 1))
    setHover(Math.max(0, Math.min(mapped.length - 1, idx)))
  }

  const footerExtra = active
    ? [
        active.buys != null ? `${formatCompact(active.buys)} buys` : null,
        active.sol ? `${formatCompact(active.sol)} SOL` : null,
        active.tokensSold ? `${formatCompact(active.tokensSold)} tokens` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <article className="soft-chart-card">
      <div className="soft-chart-head">
        <h3>{title}</h3>
        <span className="soft-chart-unit">{unit}</span>
      </div>

      <div
        className="soft-chart-plot"
        ref={plotRef}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {mapped.length ? (
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id={gradFill} x1="0" y1="0" x2="1" y2="0">
                {mapped.length === 1 ? (
                  <stop offset="0%" stopColor={toneFill('flat')} />
                ) : (
                  mapped.map((point, index) => {
                    const tone =
                      index === 0
                        ? segmentTone(
                            Number(mapped[0]!.value) || 0,
                            Number(mapped[1]!.value) || 0,
                          )
                        : segmentTone(
                            Number(mapped[index - 1]!.value) || 0,
                            Number(point.value) || 0,
                          )
                    const offset =
                      mapped.length === 1 ? 0 : (index / (mapped.length - 1)) * 100
                    return (
                      <stop
                        key={`${point.day}-fill`}
                        offset={`${offset}%`}
                        stopColor={toneFill(tone)}
                      />
                    )
                  })
                )}
              </linearGradient>
              <linearGradient id={`${gradFill}-fade`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="white" stopOpacity="0.9" />
                <stop offset="100%" stopColor="white" stopOpacity="0" />
              </linearGradient>
              <mask id={`${gradFill}-mask`}>
                <rect x="0" y="0" width={width} height={height} fill={`url(#${gradFill}-fade)`} />
              </mask>
              {/* Stroke gradient with smooth color blend along x */}
              <linearGradient id={gradStroke} x1="0" y1="0" x2="1" y2="0">
                {mapped.length < 2 ? (
                  <stop offset="0%" stopColor={CHART_FLAT} />
                ) : (
                  mapped.map((point, index) => {
                    const tone =
                      index === 0
                        ? segmentTone(
                            Number(mapped[0]!.value) || 0,
                            Number(mapped[1]!.value) || 0,
                          )
                        : segmentTone(
                            Number(mapped[index - 1]!.value) || 0,
                            Number(point.value) || 0,
                          )
                    const offset = (index / (mapped.length - 1)) * 100
                    return (
                      <stop
                        key={`${point.day}-stroke`}
                        offset={`${offset}%`}
                        stopColor={toneColor(tone)}
                      />
                    )
                  })
                )}
              </linearGradient>
            </defs>

            {[0, 1, 2, 3].map((index) => {
              const y = padding.top + (chartHeight * index) / 3
              return (
                <line
                  key={index}
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={y}
                  y2={y}
                  className="soft-chart-grid"
                />
              )
            })}

            <path
              d={areaPath}
              fill={`url(#${gradFill})`}
              mask={`url(#${gradFill}-mask)`}
              className="soft-chart-area"
            />

            {/* Soft blended full stroke under segments for smooth color transitions */}
            <path
              d={linePath}
              fill="none"
              stroke={`url(#${gradStroke})`}
              className="soft-chart-line"
              strokeOpacity={0.55}
            />

            {segments.map((seg, i) => (
              <path
                key={`seg-${i}`}
                d={seg.d}
                fill="none"
                stroke={toneColor(seg.tone)}
                className={`soft-chart-seg is-${seg.tone}`}
              />
            ))}

            {mapped.map((point, index) =>
              index === 0 ||
              index === mapped.length - 1 ||
              index === Math.floor(mapped.length / 2) ? (
                <text
                  key={point.day}
                  x={point.x}
                  y={height - 8}
                  textAnchor={
                    index === 0 ? 'start' : index === mapped.length - 1 ? 'end' : 'middle'
                  }
                  className="soft-chart-label"
                >
                  {point.label}
                </text>
              ) : null,
            )}

            {dot ? (
              <>
                <line
                  x1={dot.x}
                  x2={dot.x}
                  y1={padding.top}
                  y2={height - padding.bottom}
                  className="soft-chart-guide"
                />
                <circle
                  cx={dot.x}
                  cy={dot.y}
                  r={6}
                  className="soft-chart-dot-ring"
                  stroke={dot.color}
                />
                <circle cx={dot.x} cy={dot.y} r={3.5} className="soft-chart-dot" fill={dot.color} />
              </>
            ) : null}
          </svg>
        ) : (
          <div className="soft-chart-empty">No data for this range</div>
        )}

        {active ? (
          <div
            className="soft-chart-tooltip"
            style={{
              left: `${(active.x / width) * 100}%`,
              top: `${(active.y / height) * 100}%`,
            }}
          >
            <span>{active.label}</span>
            <strong>
              {moneyMode ? money(active.value) : `${formatCompact(active.value)} ${unit}`}
            </strong>
            {footerExtra ? <small>{footerExtra}</small> : null}
          </div>
        ) : null}
      </div>
    </article>
  )
}

export function AdminStatistics() {
  const [data, setData] = useState<any>(null)
  const [tab, setTab] = useState<Tab>('statistics')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [period, setPeriod] = useState<ChartPeriod>('31d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  async function load(opts?: {
    search?: string
    period?: ChartPeriod
    from?: string
    to?: string
  }) {
    setLoading(true)
    setError('')
    try {
      const nextPeriod = opts?.period ?? period
      const response = await (adminApi as any).statistics({
        q: opts?.search?.trim() || undefined,
        period: nextPeriod,
        from: opts?.from ?? (nextPeriod === 'custom' ? customFrom : undefined),
        to: opts?.to ?? (nextPeriod === 'custom' ? customTo : undefined),
      })
      setData(response)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to load statistics')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dashboardRows = useMemo(() => asArray(data?.dashboard), [data])
  const referrals = asArray(data?.referrals)
  const summary = data?.statistics ?? {}
  const charts = data?.charts?.series ?? {}
  const prices = data?.prices ?? {}

  function changePeriod(next: ChartPeriod) {
    setPeriod(next)
    if (next !== 'custom') void load({ period: next })
  }

  function applyCustom() {
    if (!customFrom || !customTo) {
      setError('Pick both custom dates')
      return
    }
    setPeriod('custom')
    void load({ period: 'custom', from: customFrom, to: customTo })
  }

  function renderContent() {
    if (tab === 'models') {
      return <ModelUsagePanel />
    }

    if (loading && !data) {
      return (
        <EmptyState title="Loading statistics…" description="Retrieving the latest admin metrics." />
      )
    }
    if (error && !data) {
      return <EmptyState title="Statistics unavailable" description={error} />
    }

    switch (tab) {

      case 'dashboard':
        return (
          <section className="admin-card admin-statistics-panel">
            <div className="admin-card-header">
              <div>
                <h2>Earnings dashboard</h2>
                <p>
                  Real purchases by product. Live market: SOL ${display(prices.solUsd)}
                  {prices.source ? ` (${prices.source})` : ''}.
                </p>
              </div>
            </div>
            <DataTable
              rows={dashboardRows}
              emptyTitle="No earnings data"
              columns={[...DASHBOARD_COLUMNS]}
            />
          </section>
        )

      case 'charts': {
        const chartDefs: Array<{
          key: string
          title: string
          unit: string
          moneyMode?: boolean
        }> = [
          { key: 'activeUsers', title: 'Active Users (DAU)', unit: 'users' },
          { key: 'newUsers', title: 'New Users', unit: 'users' },
          { key: 'subscriptionPurchases', title: 'Subscription Purchases', unit: 'USD', moneyMode: true },
          { key: 'topUps', title: 'Top Ups', unit: 'USD', moneyMode: true },
          { key: 'rpmPurchases', title: 'RPM Purchases', unit: 'USD', moneyMode: true },
        ]

        return (
          <section className="admin-statistics-charts">
            <div className="admin-statistics-charts-toolbar">
              <div>
                <h2>Charts</h2>
                <p>
                  {data?.charts?.from ?? '—'} → {data?.charts?.to ?? '—'} · revenue tooltips show
                  SOL when paid on-chain
                </p>
              </div>
              <div className="soft-chart-period-bar">
                {(['7d', '31d', 'custom'] as ChartPeriod[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={period === item ? 'is-active' : ''}
                    onClick={() => changePeriod(item)}
                  >
                    {item === 'custom' ? 'Custom' : item}
                  </button>
                ))}
              </div>
            </div>

            {period === 'custom' ? (
              <div className="soft-chart-custom-range">
                <input
                  className="input"
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
                <span>to</span>
                <input
                  className="input"
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
                <button className="btn btn-secondary btn-sm" type="button" onClick={applyCustom}>
                  Apply
                </button>
              </div>
            ) : null}

            <div className="admin-statistics-charts-grid">
              {chartDefs.map((def) => (
                <SoftChart
                  key={def.key}
                  title={def.title}
                  unit={def.unit}
                  moneyMode={def.moneyMode}
                  points={asArray(charts[def.key]) as ChartPoint[]}
                />
              ))}
            </div>
          </section>
        )
      }

      case 'referrals':
        return (
          <section className="admin-card admin-statistics-panel">
            <div className="admin-card-header">
              <div>
                <h2>Referrals</h2>
                <p>
                  Full referral list by default. Search by referrer email or ID to
                  filter who they invited.
                </p>
              </div>
            </div>
            <div className="admin-statistics-referral-form">
              <input
                className="input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && void load({ search: query })}
                placeholder="Referrer email or user ID…"
              />
              <button
                className="btn btn-primary"
                type="button"
                disabled={loading}
                onClick={() => void load({ search: query })}
              >
                {loading ? 'Searching…' : 'Search'}
              </button>
            </div>
            <DataTable
              rows={referrals}
              emptyTitle="No referral results"
              columns={['id', 'referral', 'referer', 'date']}
            />
          </section>
        )

      default: {
        const online = summary.online ?? {}
        const apiUsers = summary.apiUsers ?? {}
        const users = summary.users ?? {}
        const playground = summary.playground ?? {}
          return (
            <section className="admin-statistics-summary">
              <StatListCard
                title="Online"
                rows={[
                  { label: 'Current (~1 min)', value: online.current ?? 0 },
                  { label: 'Last 5 min', value: online.last5m ?? 0 },
                  { label: 'Last 1h', value: online.last1h ?? 0 },
                  { label: 'Last 24h', value: online.last24h ?? 0 },
                  { label: 'Last 7d', value: online.last7d ?? 0 },
                  { label: 'Last 31d', value: online.last31d ?? 0 },
                ]}
              />
              <StatListCard
                title="Playground"
                rows={[
                  { label: 'Users · 1h', value: playground.users1h ?? 0 },
                  { label: 'Users · 24h', value: playground.users24h ?? 0 },
                  { label: 'Users · 7d', value: playground.users7d ?? 0 },
                  { label: 'Users · 31d', value: playground.users31d ?? 0 },
                  { label: 'Users · all time', value: playground.usersTotal ?? 0 },
                  { label: 'Requests · 1h', value: playground.requests1h ?? 0 },
                  { label: 'Requests · 24h', value: playground.requests24h ?? 0 },
                  { label: 'Requests · 7d', value: playground.requests7d ?? 0 },
                  { label: 'Requests · 31d', value: playground.requests31d ?? 0 },
                  { label: 'Requests · all time', value: playground.requestsTotal ?? 0 },
                ]}
              />
              <StatListCard
                title="API users"
                rows={[
                  { label: 'Current (~1 min)', value: apiUsers.current ?? 0 },
                  { label: 'Last 5 min', value: apiUsers.last5m ?? 0 },
                  { label: 'Last 1h', value: apiUsers.last1h ?? 0 },
                  { label: 'Last 24h', value: apiUsers.last24h ?? 0 },
                  { label: 'Last 7d', value: apiUsers.last7d ?? 0 },
                  { label: 'Last 31d', value: apiUsers.last31d ?? 0 },
                ]}
              />
              <StatListCard
                title="Users"
                rows={[
                  { label: 'Total users', value: users.total ?? 0 },
                  { label: 'New today', value: users.newToday ?? 0 },
                  { label: 'New week', value: users.newWeek ?? 0 },
                  { label: 'New month', value: users.newMonth ?? 0 },
                ]}
              />
            </section>
          )
      }
    }
  }

  return (
    <div className="admin-page admin-statistics-page">
      <AdminPageHeader
        title="Statistics"
        description="Platform health, earnings, charts, referrals, and leaderboards."
        actions={
          <button
            className="btn btn-secondary"
            type="button"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />
      <div className="admin-toolbar">
        <div className="admin-tabs admin-statistics-tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? 'is-active' : ''}
              type="button"
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {error && data ? <span className="admin-statistics-error">{error}</span> : null}
      </div>
      {renderContent()}
    </div>
  )
}
