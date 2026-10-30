import { db, getSetting, setSetting } from './db.js'
import { getSolUsdPrice } from './solanaPrices.js'

type Product = 'API tokens' | 'Subscriptions'
type Asset = 'SOL' | 'CARD' | 'USD' | 'CRYPTO'
type RevenueRow = { product: Product; asset: Asset; amount: number }

/** SOL payment rows historically store raw lamports in pay_amount. */
function normalizeSolPayAmount(raw: unknown, expectedRaw: unknown) {
  const amount = Number(raw)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const expected = Number(expectedRaw)
  // A raw lamport amount is normally an integer and matches expected_raw_amount.
  // Human SOL amounts are fractional (e.g. 0.052652) and must not be rescaled.
  if (Number.isFinite(expected) && expected > 0 && Math.abs(amount - expected) < 0.5) {
    return amount / 1_000_000_000
  }
  return amount >= 1_000_000 ? amount / 1_000_000_000 : amount
}

const REPORTS: Array<{ name: 'daily' | 'night'; hour: number; startHour: number; title: string }> = [
  { name: 'daily', hour: 19, startHour: 19, title: 'Daily revenue report' },
  { name: 'night', hour: 5, startHour: 19, title: 'Night report' },
]

let timer: ReturnType<typeof setTimeout> | null = null

function utcIso(date: Date) {
  return date.toISOString()
}

function atUtc(date: Date, hour: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, 0, 0, 0))
}

function reportWindow(now: Date, config: (typeof REPORTS)[number]) {
  const end = atUtc(now, config.hour)
  if (config.name === 'daily') {
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - 1)
    return { start, end }
  }
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 1)
  start.setUTCHours(config.startHour)
  return { start, end }
}

function nextRunAt(now: Date) {
  const candidates = REPORTS.map((config) => {
    const target = atUtc(now, config.hour)
    if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1)
    return target
  })
  return candidates.sort((a, b) => a.getTime() - b.getTime())[0]
}

function formatAmount(value: number, maxFractionDigits = 6) {
  return value.toLocaleString('en-US', { maximumFractionDigits: maxFractionDigits })
}

function formatUsd(value: number) {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function readRevenue(start: Date, end: Date): RevenueRow[] {
  type RawRevenueRow = { product: Product; asset: Asset; amount: number; expected_raw_amount: number | null }
  const tableExists = (name: string) =>
    Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name))

  const parts: string[] = []
  const params: unknown[] = []

  if (tableExists('crypto_payments')) {
    parts.push(`
      SELECT 'API tokens' AS product,
             CASE WHEN lower(provider) = 'crypto' THEN 'CRYPTO'
                  ELSE UPPER(COALESCE(pay_currency, currency)) END AS asset,
             CASE WHEN lower(provider) = 'crypto' THEN COALESCE(credited_usd_cents, amount_cents) / 100.0
                  ELSE CAST(COALESCE(pay_amount, amount_cents / 100.0) AS REAL) END AS amount,
             NULL AS expected_raw_amount
      FROM crypto_payments
      WHERE credited_at IS NOT NULL AND credited_at >= ? AND credited_at < ?
        AND lower(status) IN ('finished', 'confirmed', 'partially_paid')
    `)
    params.push(utcIso(start), utcIso(end))
  }



  if (tableExists('subscription_payments')) {
    parts.push(`
      SELECT 'Subscriptions' AS product,
             CASE WHEN lower(provider) = 'crypto' THEN 'CRYPTO' ELSE UPPER(asset) END AS asset,
             CASE WHEN lower(provider) = 'crypto' THEN amount_cents / 100.0
                  ELSE CAST(COALESCE(pay_amount, amount_cents / 100.0) AS REAL) END AS amount,
             expected_raw_amount
      FROM subscription_payments
      WHERE credited_at IS NOT NULL AND credited_at >= ? AND credited_at < ?
        AND lower(status) IN ('finished', 'confirmed', 'partially_paid')
    `)
    params.push(utcIso(start), utcIso(end))
  }

  if (parts.length === 0) return []

  const raw = db
    .prepare(
      `SELECT product, asset, amount, expected_raw_amount
       FROM (
         ${parts.join(' UNION ALL ')}
       )
       WHERE asset IN ('SOL', 'CARD', 'USD', 'CRYPTO') AND amount > 0`,
    )
    .all(...params) as RawRevenueRow[]

  const totals = new Map<string, RevenueRow>()
  for (const row of raw) {
    const amount =
      row.asset === 'SOL'
        ? normalizeSolPayAmount(row.amount, row.expected_raw_amount)
        : Number(row.amount)
    if (!(amount > 0)) continue
    const key = `${row.product}:${row.asset}`
    const current = totals.get(key)
    totals.set(key, { product: row.product, asset: row.asset, amount: (current?.amount ?? 0) + amount })
  }
  const productRank: Record<Product, number> = {
    'API tokens': 1,
    Subscriptions: 2,
  }
  return [...totals.values()].sort((a, b) => productRank[a.product] - productRank[b.product] || a.asset.localeCompare(b.asset))
}

async function sendReport(config: (typeof REPORTS)[number], now: Date) {
  const { start, end } = reportWindow(now, config)
  const reportKey = `revenue_report_sent:${config.name}:${utcIso(end)}`
  if (getSetting(reportKey)) return

  const rows = readRevenue(start, end).filter((row) => Number(row.amount) > 0)
  const byProduct = new Map<Product, RevenueRow[]>()
  for (const row of rows) byProduct.set(row.product, [...(byProduct.get(row.product) ?? []), row])

  const _lines = [...byProduct.entries()].map(([product, productRows]) => {
    const amounts = productRows.map((row) =>
      row.asset === 'CRYPTO' || row.asset === 'CARD' || row.asset === 'USD' ? formatUsd(row.amount) : `${formatAmount(row.amount)} ${row.asset}`,
    )
    return `• <b>${product}</b> — ${amounts.join(' · ')}`
  })

  const totalSol = rows.filter((row) => row.asset === 'SOL').reduce((sum, row) => sum + Number(row.amount), 0)
  const totalCard = rows
    .filter((row) => row.asset === 'CRYPTO' || row.asset === 'CARD' || row.asset === 'USD')
    .reduce((sum, row) => sum + Number(row.amount), 0)
  const totals: string[] = []
  if (totalSol > 0) totals.push(`☀️ SOL: <b>${formatAmount(totalSol)} SOL</b>`)
  if (totalCard > 0) totals.push(`💳 Card: <b>${formatUsd(totalCard)}</b>`)

  let cryptoUsd = 0
  if (totalSol > 0) {
    try {
      const sol = await getSolUsdPrice()
      cryptoUsd = totalSol * sol.usd
      totals.push(`💵 SOL equivalent: <b>${formatUsd(cryptoUsd)}</b>`)
    } catch (error) {
      console.warn('[revenue-report] could not fetch USD prices', error)
    }
  }

  const totalRevenueUsd = totalCard + cryptoUsd
  if (totalRevenueUsd > 0) {
    totals.push(`📈 <b>Total revenue: ${formatUsd(totalRevenueUsd)}</b>`)
  } else if (totals.length === 0) {
    totals.push('No completed revenue in this period.')
  }

    setSetting(reportKey, utcIso(now))
}

export async function generateAndSendRevenueReport(
  configName: 'daily' | 'night' = 'daily',
  targetEndUtc = new Date(Date.UTC(2026, 8, 18, 19, 0, 0, 0)),
  ignoreAlreadySent = false,
) {
  const config = REPORTS.find((item) => item.name === configName) || REPORTS[0]
  const { start, end } = reportWindow(targetEndUtc, config)
  const reportKey = `revenue_report_sent:${config.name}:${utcIso(end)}`
  if (!ignoreAlreadySent && getSetting(reportKey)) return false

  const rows = readRevenue(start, end).filter((row) => Number(row.amount) > 0)
  const byProduct = new Map<Product, RevenueRow[]>()
  for (const row of rows) byProduct.set(row.product, [...(byProduct.get(row.product) ?? []), row])

  const _lines = [...byProduct.entries()].map(([product, productRows]) => {
    const amounts = productRows.map((row) =>
      row.asset === 'CRYPTO' || row.asset === 'CARD' || row.asset === 'USD' ? formatUsd(row.amount) : `${formatAmount(row.amount)} ${row.asset}`,
    )
    return `• <b>${product}</b> — ${amounts.join(' · ')}`
  })

  const totalSol = rows.filter((row) => row.asset === 'SOL').reduce((sum, row) => sum + Number(row.amount), 0)
  const totalCard = rows
    .filter((row) => row.asset === 'CRYPTO' || row.asset === 'CARD' || row.asset === 'USD')
    .reduce((sum, row) => sum + Number(row.amount), 0)
  const totals: string[] = []
  if (totalSol > 0) totals.push(`☀️ SOL: <b>${formatAmount(totalSol)} SOL</b>`)
  if (totalCard > 0) totals.push(`💳 Card: <b>${formatUsd(totalCard)}</b>`)

  let cryptoUsd = 0
  if (totalSol > 0) {
    try {
      const sol = await getSolUsdPrice()
      cryptoUsd = totalSol * sol.usd
      totals.push(`💵 SOL equivalent: <b>${formatUsd(cryptoUsd)}</b>`)
    } catch (error) {
      console.warn('[revenue-report] could not fetch USD prices', error)
    }
  }

  const totalRevenueUsd = totalCard + cryptoUsd
  if (totalRevenueUsd > 0) {
    totals.push(`📈 <b>Total revenue: ${formatUsd(totalRevenueUsd)}</b>`)
  } else if (totals.length === 0) {
    totals.push('No completed revenue in this period.')
  }

    setSetting(reportKey, utcIso(new Date()))
  return true
}

export function getDonationsRevenueUsd(start: Date, end: Date): number {
  const tableExists = (name: string) =>
    Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name))

  const parts: string[] = []
  const params: unknown[] = []

  // 1. API tokens (crypto_payments)
  if (tableExists('crypto_payments')) {
    parts.push(`
      SELECT COALESCE(credited_usd_cents, amount_cents, 0) AS cents
      FROM crypto_payments
      WHERE credited_at IS NOT NULL AND credited_at >= ? AND credited_at < ?
        AND lower(status) IN ('finished', 'confirmed', 'partially_paid')
    `)
    params.push(utcIso(start), utcIso(end))
  }

  // 2. Passes (nft_payments)
  // 3. Subscriptions (subscription_payments)
  if (tableExists('subscription_payments')) {
    parts.push(`
      SELECT COALESCE(amount_cents, 0) AS cents
      FROM subscription_payments
      WHERE credited_at IS NOT NULL AND credited_at >= ? AND credited_at < ?
        AND lower(status) IN ('finished', 'confirmed', 'partially_paid')
    `)
    params.push(utcIso(start), utcIso(end))
  }

  if (parts.length === 0) return 0

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cents), 0) AS total_cents
       FROM (
         ${parts.join(' UNION ALL ')}
       )`,
    )
    .get(...params) as { total_cents: number } | undefined

  return Math.round(row?.total_cents ?? 0) / 100.0
}

let cachedDailyRevenue: {
  data: {
    totalRevenueUsd: number
    sinceIso: string
    sol?: number
    cardUsd?: number
  }
  timestamp: number
} | null = null

export async function getRevenueSinceLastDailyReport(): Promise<{
  totalRevenueUsd: number
  sinceIso: string
}> {
  if (cachedDailyRevenue && Date.now() - cachedDailyRevenue.timestamp < 15_000) {
    return cachedDailyRevenue.data
  }

  const now = new Date()
  const lastDaily = atUtc(now, 19)
  if (now.getTime() < lastDaily.getTime()) {
    lastDaily.setUTCDate(lastDaily.getUTCDate() - 1)
  }
  const start = lastDaily
  const end = now

  const totalRevenueUsd = getDonationsRevenueUsd(start, end)
  const result = {
    totalRevenueUsd,
    sinceIso: start.toISOString(),
  }
  cachedDailyRevenue = { data: result, timestamp: Date.now() }
  return result
}

export function startRevenueReportJob() {
  if (timer || process.env.REVENUE_REPORTS_ENABLED === '0') return
  const schedule = () => {
    const now = new Date()
    const target = nextRunAt(now)
    timer = setTimeout(() => {
      timer = null
      const firedAt = new Date()
      const config = REPORTS.find((item) => item.hour === firedAt.getUTCHours())
      if (config) void sendReport(config, firedAt).catch((error) => console.error('[revenue-report] failed', error))
      schedule()
    }, Math.max(1_000, target.getTime() - now.getTime() + 500))
    timer.unref?.()
  }
  schedule()
}
