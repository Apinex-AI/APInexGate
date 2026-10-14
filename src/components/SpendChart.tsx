import { useEffect, useMemo, useRef, useState } from 'react'
import { fillLast7Days } from '../lib/fillLast7Days'
import { formatTokenCount } from '../../shared/billing'
import './SpendChart.css'

export type SpendChartPoint = {
  day: string
  spend_tokens: number
  requests: number
  free_tokens?: number
  paid_tokens?: number
}

type SpendChartProps = {
  points: SpendChartPoint[]
  emptyTitle?: string
  emptyDescription?: string
  tone?: 'customer' | 'admin'
}

const WIDTH = 640
const HEIGHT = 200
const PAD = { top: 22, right: 14, bottom: 30, left: 14 }
const ZERO_LIFT = 8

function formatDay(day: string) {
  const date = new Date(`${day}T12:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return day.slice(5)
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date)
}

function smoothPath(coords: Array<{ x: number; y: number }>) {
  if (coords.length === 0) return ''
  if (coords.length === 1) return `M ${coords[0].x} ${coords[0].y}`

  let path = `M ${coords[0].x} ${coords[0].y}`
  for (let i = 0; i < coords.length - 1; i += 1) {
    const p0 = coords[i - 1] ?? coords[i]
    const p1 = coords[i]
    const p2 = coords[i + 1]
    const p3 = coords[i + 2] ?? p2
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`
  }
  return path
}

export function SpendChart({
  points,
  emptyTitle = 'No usage yet',
  emptyDescription = 'Spend will appear here after the first API requests.',
  tone = 'customer',
}: SpendChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(WIDTH)
  const [active, setActive] = useState<number | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0) {
        setContainerWidth(Math.round(rect.width))
      }
    }
    update()
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry?.contentRect.width && entry.contentRect.width > 0) {
        setContainerWidth(Math.round(entry.contentRect.width))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const series = useMemo(() => fillLast7Days(points), [points])
  const hasData = series.some((point) => point.spend_tokens > 0 || point.requests > 0)

  const { linePath, areaPath, coords } = useMemo(() => {
    const max = Math.max(...series.map((point) => point.spend_tokens), 1)
    const plotW = containerWidth - PAD.left - PAD.right
    const plotH = HEIGHT - PAD.top - PAD.bottom - ZERO_LIFT
    const mapped = series.map((point, index) => {
      const x = PAD.left + (index / Math.max(series.length - 1, 1)) * plotW
      const y = PAD.top + plotH - (point.spend_tokens / max) * plotH
      return { x, y }
    })
    const line = smoothPath(mapped)
    const baseline = HEIGHT - PAD.bottom
    const area =
      mapped.length === 0
        ? ''
        : `${line} L ${mapped[mapped.length - 1].x} ${baseline} L ${mapped[0].x} ${baseline} Z`
    return { linePath: line, areaPath: area, coords: mapped }
  }, [series, containerWidth])

  if (!hasData) {
    return (
      <div className={`spend-chart-empty spend-chart-${tone}`}>
        <div className="spend-chart-empty-orb" aria-hidden />
        <strong>{emptyTitle}</strong>
        <p>{emptyDescription}</p>
      </div>
    )
  }

  const tip = active == null ? null : series[active]
  const tipCoord = active == null ? null : coords[active]
  const step = (containerWidth - PAD.left - PAD.right) / Math.max(series.length - 1, 1)

  return (
    <div
      ref={containerRef}
      className={`spend-chart spend-chart-${tone}`}
      onMouseLeave={() => setActive(null)}
    >
      <svg className="spend-chart-svg" viewBox={`0 0 ${containerWidth} ${HEIGHT}`} role="img" aria-label="Spend chart">
        <defs>
          <linearGradient id={`spend-fill-${tone}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--spend-accent)" stopOpacity="0.42" />
            <stop offset="70%" stopColor="var(--spend-accent)" stopOpacity="0.08" />
            <stop offset="100%" stopColor="var(--spend-accent)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`spend-stroke-${tone}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--spend-accent-soft)" />
            <stop offset="55%" stopColor="var(--spend-accent)" />
            <stop offset="100%" stopColor="var(--spend-accent-end)" />
          </linearGradient>
          <filter id={`spend-glow-${tone}`} x="-20%" y="-40%" width="140%" height="180%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {[0.25, 0.5, 0.75].map((ratio) => {
          const y = PAD.top + (HEIGHT - PAD.top - PAD.bottom - ZERO_LIFT) * ratio
          return (
            <line
              key={ratio}
              className="spend-grid"
              x1={PAD.left}
              x2={containerWidth - PAD.right}
              y1={y}
              y2={y}
            />
          )
        })}

        <path className="spend-area" d={areaPath} fill={`url(#spend-fill-${tone})`} />
        <path
          className="spend-line"
          d={linePath}
          stroke={`url(#spend-stroke-${tone})`}
          filter={`url(#spend-glow-${tone})`}
        />

        {coords.map((coord, index) => (
          <g key={series[index].day}>
            <circle
              className={`spend-dot ${active === index ? 'is-active' : ''}`}
              cx={coord.x}
              cy={coord.y}
              r={active === index ? 6 : 4.5}
            />
            <rect
              className="spend-hit"
              x={coord.x - step / 2}
              y={PAD.top - 8}
              width={step}
              height={HEIGHT - PAD.top - PAD.bottom + 24}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
            />
            <text className="spend-label" x={coord.x} y={HEIGHT - 12} textAnchor="middle">
              {series[index].day.slice(5)}
            </text>
          </g>
        ))}

        {tip && tipCoord ? (
          <g className="spend-tooltip" style={{ pointerEvents: 'none' }}>
            <line
              className="spend-guide"
              x1={tipCoord.x}
              x2={tipCoord.x}
              y1={PAD.top}
              y2={HEIGHT - PAD.bottom}
            />
            <foreignObject
              x={Math.min(Math.max(tipCoord.x - 86, 8), containerWidth - 180)}
              y={Math.max(tipCoord.y - (tip.free_tokens !== undefined || tip.paid_tokens !== undefined ? 92 : 78), 8)}
              width="172"
              height={tip.free_tokens !== undefined || tip.paid_tokens !== undefined ? 88 : 70}
            >
              <div className="spend-tip">
                <strong>{formatDay(tip.day)}</strong>
                <span>{formatTokenCount(tip.spend_tokens)} tok</span>
                {(tip.free_tokens !== undefined || tip.paid_tokens !== undefined) && (
                  <div className="spend-tip-split">
                    <span>Free: {formatTokenCount(tip.free_tokens ?? 0)}</span>
                    <span>Paid: {formatTokenCount(tip.paid_tokens ?? 0)}</span>
                  </div>
                )}
                <small>
                  {tip.requests} request{tip.requests === 1 ? '' : 's'}
                </small>
              </div>
            </foreignObject>
          </g>
        ) : null}
      </svg>
    </div>
  )
}
