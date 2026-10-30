import { db } from './db.js'
import { TOKENS_PER_USD } from '../shared/billing.js'
import { getSolUsdPrice } from './solanaPrices.js'

const DAY_MS = 86_400_000

export type StatsPeriod = '7d' | '31d' | 'custom'

function isoAgo(ms: number, from = new Date()) {
  return new Date(from.getTime() - ms).toISOString()
}

function startOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function parseDay(value?: string | null): Date | null {
  const raw = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const d = new Date(`${raw}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function formatDayLabel(isoDay: string) {
  const [y, m, d] = isoDay.split('-')
  if (!y || !m || !d) return isoDay
  return `${d}.${m}.${y.slice(2)}`
}

function money(n: number) {
  const v = Number(n) || 0
  return Math.round(v * 100) / 100
}

function assetIsSol(asset: string | null | undefined) {
  const a = String(asset ?? '').trim().toUpperCase()
  return a === 'SOL' || a === 'SOLANA'
}

type PayAgg = {
  buys: number
  usd: number
  sol: number
  tokensSold?: number
}

function emptyPay(): PayAgg {
  return { buys: 0, usd: 0, sol: 0, tokensSold: 0 }
}

function payFromRow(row: {
  buys?: number
  usd?: number
  sol?: number
  tokens_sold?: number
}): PayAgg {
  return {
    buys: Number(row.buys) || 0,
    usd: money(Number(row.usd) || 0),
    sol: money(Number(row.sol) || 0),
    tokensSold: money(Number(row.tokens_sold) || 0),
  }
}

function tableColumns(table: string) {
  try {
    return new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
    )
  } catch {
    return new Set<string>()
  }
}

/** Aggregate paid rows with optional since/until filters on credited_at. */
function sumPaymentTable(
  table: 'crypto_payments' | 'subscription_payments' | 'rpm_payments',
  opts: {
    since?: string
    until?: string
    extraWhere?: string
    extraParams?: unknown[]
    groupByDay?: boolean
    groupByTier?: boolean
  } = {},
) {
  const cols = tableColumns(table)
  if (!cols.has('credited_at') || !cols.has('amount_cents')) {
    return opts.groupByDay || opts.groupByTier ? [] : emptyPay()
  }

  const where: string[] = ['credited_at IS NOT NULL']
  const params: unknown[] = []
  if (opts.since) {
    where.push('credited_at >= ?')
    params.push(opts.since)
  }
  if (opts.until) {
    where.push('credited_at < ?')
    params.push(opts.until)
  }
  if (opts.extraWhere) {
    where.push(`(${opts.extraWhere})`)
    if (opts.extraParams?.length) params.push(...opts.extraParams)
  }

  const assetExpr = cols.has('asset')
    ? cols.has('pay_currency')
      ? `COALESCE(asset, pay_currency, '')`
      : `COALESCE(asset, '')`
    : cols.has('pay_currency')
      ? `COALESCE(pay_currency, '')`
      : `''`
  // Normal path stores human units in pay_amount ("0.055" SOL).
  // Some rows only have expected_raw_amount in lamports / base units — convert those.
  // If pay_amount looks like raw (absurdly large for human units), scale it down.
  const hasRaw = cols.has('expected_raw_amount')
  const hasPay = cols.has('pay_amount')
  const solAmountExpr =
    hasRaw || hasPay
      ? `CASE
      WHEN ${hasRaw ? `CAST(COALESCE(expected_raw_amount, '0') AS REAL) > 0` : '0'}
        THEN ${hasRaw ? `CAST(COALESCE(expected_raw_amount, '0') AS REAL) / 1000000000.0` : '0'}
      WHEN ${hasPay ? `CAST(COALESCE(pay_amount, '0') AS REAL) >= 1000` : '0'}
        THEN ${hasPay ? `CAST(COALESCE(pay_amount, '0') AS REAL) / 1000000000.0` : '0'}
      ELSE ${hasPay ? `CAST(COALESCE(pay_amount, '0') AS REAL)` : '0'}
    END`
      : '0'

  const dayExpr = `substr(credited_at, 1, 10)`
  const selectBits = [
    opts.groupByDay ? `${dayExpr} AS day` : null,
    opts.groupByTier && cols.has('tier') ? `lower(tier) AS tier` : null,
    `COUNT(*) AS buys`,
    `COALESCE(SUM(COALESCE(amount_cents, 0)), 0) / 100.0 AS usd`,
    `COALESCE(SUM(CASE
        WHEN upper(${assetExpr}) IN ('SOL', 'SOLANA')
        THEN (${solAmountExpr})
        ELSE 0 END), 0) AS sol`,
  ]
  if (table === 'crypto_payments') {
    // Token top-ups: credit the actual credited amount (underpaid invoices
    // credit less than amount_cents). Legacy rows fall back to amount_cents.
    selectBits.push(
      `COALESCE(SUM(COALESCE(credited_usd_cents, amount_cents, 0)), 0) / 100.0 * ${TOKENS_PER_USD} AS tokens_sold`,
    )
  }

  const group: string[] = []
  if (opts.groupByDay) group.push('day')
  if (opts.groupByTier && cols.has('tier')) group.push('tier')

  const sql = `SELECT ${selectBits.filter(Boolean).join(', ')}
    FROM ${table}
    WHERE ${where.join(' AND ')}
    ${group.length ? `GROUP BY ${group.join(', ')}` : ''}`

  if (opts.groupByDay || opts.groupByTier) {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>
  }
  return db.prepare(sql).get(...params) as Record<string, unknown>
}

function countUsersSeen(sinceMs: number, now = new Date()) {
  return Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM users WHERE last_seen_at >= ?`)
        .get(isoAgo(sinceMs, now)) as { count?: number }
    )?.count ?? 0,
  )
}

function countUsersCreated(sinceMs: number, now = new Date()) {
  return Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM users WHERE created_at >= ?`)
        .get(isoAgo(sinceMs, now)) as { count?: number }
    )?.count ?? 0,
  )
}

function playgroundStats(now = new Date()) {
  const h1 = isoAgo(3_600_000, now)
  const d1 = isoAgo(DAY_MS, now)
  const d7 = isoAgo(7 * DAY_MS, now)
  const d31 = isoAgo(31 * DAY_MS, now)
  try {
    const row = db
      .prepare(
        `SELECT
           COUNT(DISTINCT CASE WHEN e.created_at >= ? THEN e.user_id END) AS users1h,
           COUNT(DISTINCT CASE WHEN e.created_at >= ? THEN e.user_id END) AS users24h,
           COUNT(DISTINCT CASE WHEN e.created_at >= ? THEN e.user_id END) AS users7d,
           COUNT(DISTINCT CASE WHEN e.created_at >= ? THEN e.user_id END) AS users31d,
           COUNT(DISTINCT e.user_id) AS usersTotal,
           SUM(CASE WHEN e.created_at >= ? THEN 1 ELSE 0 END) AS requests1h,
           SUM(CASE WHEN e.created_at >= ? THEN 1 ELSE 0 END) AS requests24h,
           SUM(CASE WHEN e.created_at >= ? THEN 1 ELSE 0 END) AS requests7d,
           SUM(CASE WHEN e.created_at >= ? THEN 1 ELSE 0 END) AS requests31d,
           COUNT(*) AS requestsTotal
         FROM usage_events e
         INNER JOIN api_keys k ON k.id = e.api_key_id
         WHERE k.name = '__playground' AND e.user_id IS NOT NULL`,
      )
      .get(h1, d1, d7, d31, h1, d1, d7, d31) as Record<string, number>
    return {
      users1h: Number(row.users1h) || 0,
      users24h: Number(row.users24h) || 0,
      users7d: Number(row.users7d) || 0,
      users31d: Number(row.users31d) || 0,
      usersTotal: Number(row.usersTotal) || 0,
      requests1h: Number(row.requests1h) || 0,
      requests24h: Number(row.requests24h) || 0,
      requests7d: Number(row.requests7d) || 0,
      requests31d: Number(row.requests31d) || 0,
      requestsTotal: Number(row.requestsTotal) || 0,
    }
  } catch {
    return {
      users1h: 0, users24h: 0, users7d: 0, users31d: 0, usersTotal: 0,
      requests1h: 0, requests24h: 0, requests7d: 0, requests31d: 0, requestsTotal: 0,
    }
  }
}

function apiUserWindows(now = new Date()) {
  const m1 = isoAgo(60_000, now)
  const m5 = isoAgo(300_000, now)
  const h1 = isoAgo(3_600_000, now)
  const d1 = isoAgo(DAY_MS, now)
  const d7 = isoAgo(7 * DAY_MS, now)
  const d31 = isoAgo(31 * DAY_MS, now)
  const row = db
    .prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN created_at >= ? THEN user_id END) AS current,
         COUNT(DISTINCT CASE WHEN created_at >= ? THEN user_id END) AS last5m,
         COUNT(DISTINCT CASE WHEN created_at >= ? THEN user_id END) AS last1h,
         COUNT(DISTINCT CASE WHEN created_at >= ? THEN user_id END) AS last24h,
         COUNT(DISTINCT CASE WHEN created_at >= ? THEN user_id END) AS last7d,
         COUNT(DISTINCT user_id) AS last31d
       FROM usage_events
       WHERE user_id IS NOT NULL AND created_at >= ?`,
    )
    .get(m1, m5, h1, d1, d7, d31) as Record<string, number>
  return {
    current: Number(row.current) || 0,
    last5m: Number(row.last5m) || 0,
    last1h: Number(row.last1h) || 0,
    last24h: Number(row.last24h) || 0,
    last7d: Number(row.last7d) || 0,
    last31d: Number(row.last31d) || 0,
  }
}

function formatAssetTotals(sol: number) {
  return {
    sol: sol > 0 ? money(sol) : 0,
    solLabel: sol > 0 ? `${money(sol)} SOL` : '—',
  }
}

function buildDashboardRow(
  label: string,
  since?: string,
  until?: string,
  opts?: { isDay?: boolean },
) {
  const tokens = payFromRow(
    sumPaymentTable('crypto_payments', { since, until }) as {
      buys?: number
      usd?: number
      sol?: number
      tokens_sold?: number
    },
  )

  const totalBuys = tokens.buys
  const totalSol = tokens.sol
  const totalUsd = tokens.usd

  const assets = formatAssetTotals(totalSol)
  return {
    period: label,
    isDay: Boolean(opts?.isDay),
    tokens: tokens.buys,
    totalBuys,
    totalSol: assets.solLabel,
    sol: assets.sol,
    usd: money(totalUsd),
    usdLabel: `$${money(totalUsd).toFixed(2)}`,
  }
}

function listDashboardDays(limitDays = 60) {
  const daySet = new Set<string>()
  const collect = (table: string) => {
    const rows = db
      .prepare(
        `SELECT substr(credited_at, 1, 10) AS day
         FROM ${table}
         WHERE credited_at IS NOT NULL
         GROUP BY day
         ORDER BY day DESC
         LIMIT ?`,
      )
      .all(limitDays) as Array<{ day: string }>
    for (const row of rows) if (row.day) daySet.add(row.day)
  }
  collect('crypto_payments')
  return [...daySet].sort((a, b) => (a < b ? 1 : -1)).slice(0, limitDays)
}

function eachUtcDay(from: Date, to: Date): string[] {
  const out: string[] = []
  let cur = startOfUtcDay(from)
  const end = startOfUtcDay(to)
  while (cur.getTime() <= end.getTime()) {
    out.push(cur.toISOString().slice(0, 10))
    cur = new Date(cur.getTime() + DAY_MS)
  }
  return out
}

function resolveChartRange(input: {
  period?: string
  from?: string
  to?: string
}) {
  const now = new Date()
  const period = (input.period === 'custom' || input.period === '7d' || input.period === '31d'
    ? input.period
    : '31d') as StatsPeriod

  if (period === 'custom') {
    const from = parseDay(input.from) ?? new Date(now.getTime() - 30 * DAY_MS)
    const to = parseDay(input.to) ?? startOfUtcDay(now)
    const fromDay = startOfUtcDay(from)
    const toDay = startOfUtcDay(to)
    if (fromDay.getTime() > toDay.getTime()) {
      return {
        period,
        fromIso: toDay.toISOString(),
        toIsoExclusive: new Date(fromDay.getTime() + DAY_MS).toISOString(),
        days: eachUtcDay(toDay, fromDay),
      }
    }
    return {
      period,
      fromIso: fromDay.toISOString(),
      toIsoExclusive: new Date(toDay.getTime() + DAY_MS).toISOString(),
      days: eachUtcDay(fromDay, toDay),
    }
  }

  const daysBack = period === '7d' ? 6 : 30
  const end = startOfUtcDay(now)
  const start = new Date(end.getTime() - daysBack * DAY_MS)
  return {
    period,
    fromIso: start.toISOString(),
    toIsoExclusive: new Date(end.getTime() + DAY_MS).toISOString(),
    days: eachUtcDay(start, end),
  }
}

function dayMapFromRows(rows: Array<{ day?: string; value?: number }>) {
  const map = new Map<string, number>()
  for (const row of rows) {
    const day = String(row.day ?? '')
    if (!day) continue
    map.set(day, money(Number(row.value) || 0))
  }
  return map
}

function buildSeries(
  days: string[],
  map: Map<string, number>,
  extras?: Map<string, Record<string, number>>,
) {
  return days.map((day) => ({
    day,
    label: formatDayLabel(day),
    value: map.get(day) ?? 0,
    ...(extras?.get(day) ?? {}),
  }))
}

function percentChange(values: number[]) {
  if (values.length < 2) return 0
  const last = values[values.length - 1] ?? 0
  const prev = values[values.length - 2] ?? 0
  if (prev === 0) return last === 0 ? 0 : 100
  return Math.round(((last - prev) / Math.abs(prev)) * 1000) / 10
}

const statsCache = new Map<string, { expiresAt: number; data: unknown }>()

export async function buildAdminStatistics(input: {
  q?: string
  period?: string
  from?: string
  to?: string
}) {
  const cacheKey = `${input.q ?? ''}:${input.period ?? ''}:${input.from ?? ''}:${input.to ?? ''}`
  const nowMs = Date.now()
  const cached = statsCache.get(cacheKey)
  if (cached && cached.expiresAt > nowMs) {
    return cached.data
  }

  const now = new Date()
  const range = resolveChartRange(input)

  let solUsd = 0
  let priceSource = 'unavailable'
  try {
    const sol = await getSolUsdPrice()
    solUsd = sol.usd
    priceSource = sol.source
  } catch {
    /* keep zeros — stored USD still works */
  }

  const totalUsers = Number(
    (db.prepare(`SELECT COUNT(*) AS count FROM users`).get() as { count?: number })?.count ?? 0,
  )

  const summaryRows = [
    buildDashboardRow('Last 24h', isoAgo(DAY_MS, now)),
    buildDashboardRow('Last 7 days', isoAgo(7 * DAY_MS, now)),
    buildDashboardRow('Last 30 days', isoAgo(30 * DAY_MS, now)),
    buildDashboardRow('All time'),
  ]

  const dashboardDays = listDashboardDays(45)
  const earliestDay = dashboardDays[dashboardDays.length - 1]
  const sinceEarliestIso = earliestDay ? `${earliestDay}T00:00:00.000Z` : undefined

  // Bulk query daily payment data once across all 45 days instead of 180 sequential queries
  const allTokensDays = (sumPaymentTable('crypto_payments', {
    since: sinceEarliestIso,
    groupByDay: true,
  }) as Array<{ day?: string; buys?: number; usd?: number; sol?: number }>) || []

  const tokensByDay = new Map(allTokensDays.map((r) => [r.day || '', payFromRow(r)]))

  const dayRows = dashboardDays.map((day) => {
    const tokens = tokensByDay.get(day) || emptyPay()

    const totalBuys = tokens.buys
    const totalSol = tokens.sol
    const totalUsd = tokens.usd

    const assets = formatAssetTotals(totalSol)
    return {
      period: formatDayLabel(day),
      isDay: true,
      tokens: tokens.buys,
      totalBuys,
      totalSol: assets.solLabel,
      sol: assets.sol,
      usd: money(totalUsd),
      usdLabel: `$${money(totalUsd).toFixed(2)}`,
    }
  })

  // Charts — daily series. Fast single-query aggregation with GROUP BY substr(created_at, 1, 10)
  const dailyUsers = (
    table: 'usage_events' | 'users',
    idColumn: 'user_id' | 'id',
    timestampColumn: 'created_at' = 'created_at',
  ) => {
    const rows = db.prepare(
      `SELECT substr(${timestampColumn}, 1, 10) AS day, COUNT(DISTINCT ${idColumn}) AS count
       FROM ${table}
       WHERE ${timestampColumn} >= ? AND ${timestampColumn} < ?
       GROUP BY day`,
    ).all(range.fromIso, range.toIsoExclusive) as Array<{ day?: string; count?: number }>
    const map = new Map(rows.map((r) => [String(r.day ?? ''), Number(r.count) || 0]))
    return range.days.map((day) => ({
      day,
      value: map.get(day) ?? 0,
    }))
  }
  const activeRows = dailyUsers('usage_events', 'user_id')
  const newUserRows = dailyUsers('users', 'id')

  const dailyAgg = (
    table: 'crypto_payments' | 'subscription_payments' | 'rpm_payments',
  ) =>
    sumPaymentTable(table, {
      since: range.fromIso,
      until: range.toIsoExclusive,
      groupByDay: true,
    }) as Array<{ day?: string; buys?: number; usd?: number; sol?: number; tokens_sold?: number }>

  const toMetricMaps = (
    rows: Array<{ day?: string; buys?: number; usd?: number; sol?: number; tokens_sold?: number }>,
    valueKey: 'usd' | 'buys' | 'tokens_sold' = 'usd',
  ) => {
    const valueMap = new Map<string, number>()
    const extra = new Map<string, Record<string, number>>()
    for (const row of rows) {
      const day = String(row.day ?? '')
      if (!day) continue
      const usd = money(Number(row.usd) || 0)
      const sol = money(Number(row.sol) || 0)
      const buys = Number(row.buys) || 0
      const tokensSold = money(Number(row.tokens_sold) || 0)
      const value =
        valueKey === 'buys' ? buys : valueKey === 'tokens_sold' ? tokensSold : usd
      valueMap.set(day, value)
      extra.set(day, { usd, sol, buys, tokensSold })
    }
    return { valueMap, extra }
  }

  const topUpsDaily = toMetricMaps(dailyAgg('crypto_payments'), 'usd')
  const subscriptionsDaily = toMetricMaps(dailyAgg('subscription_payments'), 'usd')
  const rpmDaily = toMetricMaps(dailyAgg('rpm_payments'), 'usd')

  const chartSeries = {
    subscriptionPurchases: buildSeries(range.days, subscriptionsDaily.valueMap, subscriptionsDaily.extra),
    activeUsers: buildSeries(range.days, dayMapFromRows(activeRows)),
    newUsers: buildSeries(range.days, dayMapFromRows(newUserRows)),
    topUps: buildSeries(range.days, topUpsDaily.valueMap, topUpsDaily.extra),
    tokenPurchases: buildSeries(range.days, topUpsDaily.valueMap, topUpsDaily.extra),
    rpmPurchases: buildSeries(range.days, rpmDaily.valueMap, rpmDaily.extra),
  }

  const chartMeta = Object.fromEntries(
    Object.entries(chartSeries).map(([key, points]) => {
      const values = points.map((p) => Number(p.value) || 0)
      const total = values.reduce((a, b) => a + b, 0)
      const last = values[values.length - 1] ?? 0
      return [
        key,
        {
          total: money(total),
          last: money(last),
          changePct: percentChange(values),
        },
      ]
    }),
  )

  const needle = String(input.q ?? '').trim()
  let referrals: unknown[] = []

  const formatRefIdentity = (row: {
    domain?: string | null
    email?: string | null
    name?: string | null
    userId?: number | string | null
  }) => row.domain || row.email || row.name || row.userId || '—'

  if (needle) {
    const like = `%${needle}%`
    const owner = db
      .prepare(
        `SELECT id, display_id AS userId, name, email
         FROM users
         WHERE email LIKE ? OR CAST(display_id AS TEXT) = ?
         LIMIT 1`,
      )
      .get(like, needle) as
      | {
          id?: string
          userId?: number
          name?: string | null
          email?: string | null
        }
      | undefined

    if (owner?.id) {
      const invited = db
        .prepare(
          `SELECT u.display_id AS referralId, u.name AS referralName, u.email AS referralEmail,
                  u.created_at AS date
           FROM users u
           WHERE u.referred_by = ?
           ORDER BY datetime(u.created_at) DESC`,
        )
        .all(owner.id) as Array<Record<string, unknown>>

      referrals = invited.map((row, index) => ({
        id: index + 1,
        referral: formatRefIdentity({
          email: row.referralEmail as string | null,
          name: row.referralName as string | null,
          userId: row.referralId as number | null,
        }),
        referer: formatRefIdentity({
          email: owner.email,
          name: owner.name,
          userId: owner.userId,
        }),
        date: row.date,
      }))
    }
  } else {
    // Full referral pairs list when no search filter.
    const pairs = db
      .prepare(
        `SELECT
           r.display_id AS referralId,
           r.name AS referralName,
           r.email AS referralEmail,
           r.created_at AS date,
           f.display_id AS refererId,
           f.name AS refererName,
           f.email AS refererEmail
         FROM users r
         JOIN users f ON f.id = r.referred_by
         WHERE r.referred_by IS NOT NULL AND r.referred_by != ''
         ORDER BY datetime(r.created_at) DESC
         LIMIT 500`,
      )
      .all() as Array<Record<string, unknown>>

    referrals = pairs.map((row, index) => ({
      id: index + 1,
      referral: formatRefIdentity({
        domain: row.referralDomain as string | null,
        email: row.referralEmail as string | null,
        name: row.referralName as string | null,
        userId: row.referralId as number | null,
      }),
      referer: formatRefIdentity({
        domain: row.refererDomain as string | null,
        email: row.refererEmail as string | null,
        name: row.refererName as string | null,
        userId: row.refererId as number | null,
      }),
      date: row.date,
    }))
  }

  const finalResult = {
    prices: {
      solUsd,
      source: priceSource,
    },
    statistics: {
      online: {
        current: countUsersSeen(60_000, now),
        last5m: countUsersSeen(300_000, now),
        last1h: countUsersSeen(3_600_000, now),
        last24h: countUsersSeen(DAY_MS, now),
        last7d: countUsersSeen(7 * DAY_MS, now),
        last31d: countUsersSeen(31 * DAY_MS, now),
      },
      apiUsers: apiUserWindows(now),
      users: {
        total: totalUsers,
        newToday: countUsersCreated(DAY_MS, now),
        newWeek: countUsersCreated(7 * DAY_MS, now),
        newMonth: countUsersCreated(30 * DAY_MS, now),
      },
      playground: playgroundStats(now),
    },
    dashboard: [...summaryRows, ...dayRows],
    charts: {
      period: range.period,
      from: range.days[0] ?? null,
      to: range.days[range.days.length - 1] ?? null,
      series: chartSeries,
      meta: chartMeta,
    },
    referrals,
  }

  statsCache.set(cacheKey, { expiresAt: Date.now() + 30_000, data: finalResult })
  return finalResult
}

// Keep helpers exported for unit-style reuse if needed later.
export const __adminStatsInternals = {
  assetIsSol,
  resolveChartRange,
  formatDayLabel,
}
