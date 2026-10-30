import { db, getSetting, id, nowIso, setSetting, tableExists } from './db.js'
import { levelSourceRef, recordLevelSpend } from './accountLevels.js'
import { tryGrantReferralReward } from './referrals.js'
import { getSiteLinks } from './siteLinks.js'
import {
  DEFAULT_RPM_CATALOG,
  MAX_RPM,
  MIN_RPM,
  RPM_PLAN_DAYS,
  isPaidRpmKey,
  type RpmCatalogPlan,
  type RpmPlanKey,
} from '../shared/rpm.js'

const CATALOG_KEY = 'rpm_catalog'

export type PublicRpmPlan = {
  key: RpmPlanKey
  rpm: number
  priceCents: number
  priceUsd: number
  enabled: boolean
  custom: boolean
  label: string
  termLabel: string | null
}

export type AccountRpm = {
  rpm: number
  planKey: RpmPlanKey
  label: string
  source: 'plan' | 'grant' | 'free'
  expiresAt: string | null
  termLabel: string | null
}

function clampRpm(value: unknown, fallback: number) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_RPM, Math.max(MIN_RPM, n))
}

function clampCents(value: unknown, fallback: number) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(1_000_000, n)
}

export function getRpmCatalog(): RpmCatalogPlan[] {
  const raw = getSetting(CATALOG_KEY, '')
  const byKey = new Map(DEFAULT_RPM_CATALOG.map((plan) => [plan.key, { ...plan }]))
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Array<Partial<RpmCatalogPlan>>
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          const key = row.key
          const current = key ? byKey.get(key) : undefined
          if (!current || !key) continue
          if (key === 'custom') {
            byKey.set(key, { ...current, enabled: row.enabled !== false, custom: true, priceCents: 0, rpm: 0 })
            continue
          }
          byKey.set(key, {
            ...current,
            rpm: clampRpm(row.rpm, current.rpm),
            priceCents: key === 'free' ? 0 : clampCents(row.priceCents, current.priceCents),
            enabled: row.enabled !== false,
            custom: false,
          })
        }
      }
    } catch {
      // keep defaults
    }
  }
  return DEFAULT_RPM_CATALOG.map((plan) => byKey.get(plan.key) ?? { ...plan })
}

export function saveRpmCatalog(input: Array<Partial<RpmCatalogPlan> & { key: RpmPlanKey }>): RpmCatalogPlan[] {
  const current = getRpmCatalog()
  const next = current.map((plan) => {
    const patch = input.find((row) => row.key === plan.key)
    if (!patch) return plan
    if (plan.key === 'custom') return { ...plan, enabled: patch.enabled !== false, custom: true, priceCents: 0, rpm: 0 }
    if (plan.key === 'free') {
      return { ...plan, rpm: clampRpm(patch.rpm, plan.rpm), priceCents: 0, enabled: true, custom: false }
    }
    const priceCents = patch.priceCents !== undefined ? clampCents(patch.priceCents, plan.priceCents) : plan.priceCents
    if (priceCents < 1) throw new Error(`${plan.key} price must be at least $0.01`)
    return {
      ...plan,
      rpm: clampRpm(patch.rpm, plan.rpm),
      priceCents,
      enabled: patch.enabled !== false,
      custom: false,
    }
  })
  setSetting(CATALOG_KEY, JSON.stringify(next))
  return next
}

function planTermLabel(plan: Pick<RpmCatalogPlan, 'key' | 'custom'>) {
  if (plan.custom || plan.key === 'custom') return 'Custom'
  if (plan.key === 'standard' || plan.key === 'high') return '30 Days'
  return null
}

export function publicRpmPlans(): PublicRpmPlan[] {
  return getRpmCatalog().map((plan) => ({
    key: plan.key,
    rpm: plan.rpm,
    priceCents: plan.priceCents,
    priceUsd: Number((plan.priceCents / 100).toFixed(2)),
    enabled: plan.enabled,
    custom: plan.custom,
    label: plan.custom ? 'Custom' : `${plan.rpm} RPM`,
    termLabel: planTermLabel(plan),
  }))
}

function addDaysIso(fromMs: number, days: number) {
  return new Date(fromMs + days * 24 * 60 * 60 * 1000).toISOString()
}

function extendExpiresAt(current: string | null | undefined, days = RPM_PLAN_DAYS) {
  const currentMs = current ? Date.parse(current) : NaN
  const base = Number.isFinite(currentMs) && currentMs > Date.now() ? currentMs : Date.now()
  return addDaysIso(base, days)
}

export function ensureRpmSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rpm_grants (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      rpm INTEGER NOT NULL,
      note TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rpm_payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_key TEXT NOT NULL,
      rpm INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      order_id TEXT NOT NULL UNIQUE,
      payment_id TEXT,
      pay_amount TEXT,
      invoice_url TEXT,
      raw_status TEXT,
      credited_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rpm_payments_user ON rpm_payments(user_id, created_at);
  `)

  if (tableExists('users')) {
    const cols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
    if (!cols.some((column) => column.name === 'rpm_plan')) {
      db.exec("ALTER TABLE users ADD COLUMN rpm_plan TEXT NOT NULL DEFAULT 'free'")
    }
    if (!cols.some((column) => column.name === 'rpm_expires_at')) {
      db.exec('ALTER TABLE users ADD COLUMN rpm_expires_at TEXT')
    }
  }
  if (tableExists('rpm_grants')) {
    const grantCols = db.prepare('PRAGMA table_info(rpm_grants)').all() as Array<{ name: string }>
    if (!grantCols.some((column) => column.name === 'expires_at')) {
      db.exec('ALTER TABLE rpm_grants ADD COLUMN expires_at TEXT')
    }
  }
}

ensureRpmSchema()

type RpmPaymentRow = {
  id: string
  user_id: string
  plan_key: string
  rpm: number
  amount_cents: number
  status: string
  order_id: string
  payment_id: string | null
  pay_amount: string | null
  invoice_url: string | null
  credited_at: string | null
}

function planLabel(plan: Pick<RpmCatalogPlan, 'key' | 'rpm' | 'custom'>) {
  return plan.custom || plan.key === 'custom' ? 'Custom' : `${plan.rpm} RPM`
}

export function getUserRpmPlanKey(userId: string): RpmPlanKey {
  if (!tableExists('users')) return 'free'
  const row = db.prepare(`SELECT rpm_plan FROM users WHERE id = ?`).get(userId) as { rpm_plan: string | null } | undefined
  const key = row?.rpm_plan
  if (key === 'standard' || key === 'high' || key === 'custom' || key === 'free') return key
  return 'free'
}

function expireRpmIfDue(userId: string) {
  if (!tableExists('users')) return
  const row = db.prepare(`SELECT rpm_plan, rpm_expires_at FROM users WHERE id = ?`).get(userId) as
    | { rpm_plan: string | null; rpm_expires_at: string | null }
    | undefined
  if (!row) return
  const expiresMs = row.rpm_expires_at ? Date.parse(row.rpm_expires_at) : NaN
  const planExpired =
    (row.rpm_plan === 'standard' || row.rpm_plan === 'high') &&
    Number.isFinite(expiresMs) &&
    expiresMs <= Date.now()
  if (planExpired) {
    db.prepare(`UPDATE users SET rpm_plan = 'free', rpm_expires_at = NULL WHERE id = ?`).run(userId)
  }
  if (!tableExists('rpm_grants')) return
  const grant = db.prepare(`SELECT expires_at FROM rpm_grants WHERE user_id = ?`).get(userId) as
    | { expires_at: string | null }
    | undefined
  const grantMs = grant?.expires_at ? Date.parse(grant.expires_at) : NaN
  if (grant && Number.isFinite(grantMs) && grantMs <= Date.now()) {
    db.prepare(`DELETE FROM rpm_grants WHERE user_id = ?`).run(userId)
  }
}

export function getAccountRpm(userId: string): AccountRpm {
  expireRpmIfDue(userId)
  const catalog = getRpmCatalog()
  const grant = tableExists('rpm_grants')
    ? (db.prepare(`SELECT rpm, expires_at FROM rpm_grants WHERE user_id = ?`).get(userId) as
        | { rpm: number; expires_at: string | null }
        | undefined)
    : undefined
  const user = tableExists('users')
    ? (db.prepare(`SELECT rpm_expires_at FROM users WHERE id = ?`).get(userId) as
        | { rpm_expires_at: string | null }
        | undefined)
    : undefined
  const planKey = getUserRpmPlanKey(userId)
  const plan = catalog.find((row) => row.key === planKey) ?? catalog[0]
  if (grant && Number.isFinite(grant.rpm) && grant.rpm > 0) {
    return {
      rpm: clampRpm(grant.rpm, plan?.rpm ?? 5),
      planKey,
      label: `Custom · ${clampRpm(grant.rpm, plan?.rpm ?? 5)} RPM`,
      source: 'grant',
      expiresAt: grant.expires_at,
      termLabel: 'Custom',
    }
  }
  if (!plan || plan.key === 'free' || plan.key === 'custom') {
    const free = catalog.find((row) => row.key === 'free') ?? catalog[0]
    return { rpm: free.rpm, planKey: 'free', label: `${free.rpm} RPM`, source: 'free', expiresAt: null, termLabel: null }
  }
  return {
    rpm: plan.rpm,
    planKey: plan.key,
    label: planLabel(plan),
    source: 'plan',
    expiresAt: user?.rpm_expires_at ?? null,
    termLabel: planTermLabel(plan),
  }
}

export function userRpmState(userId: string) {
  const account = getAccountRpm(userId)
  const grant = tableExists('rpm_grants')
    ? (db.prepare(`SELECT rpm, note, expires_at FROM rpm_grants WHERE user_id = ?`).get(userId) as
        | { rpm: number; note: string | null; expires_at: string | null }
        | undefined)
    : undefined
  return {
    ...account,
    supportUrl: getSiteLinks().telegramSupport,
    cryptoEnabled: false,
    grantRpm: grant?.rpm ?? null,
    grantExpiresAt: grant?.expires_at ?? null,
    plans: publicRpmPlans(),
  }
}

export function setUserRpmGrant(userId: string, rpm: number | null, note?: string | null) {
  if (rpm == null || rpm <= 0) {
    db.prepare(`DELETE FROM rpm_grants WHERE user_id = ?`).run(userId)
    return null
  }
  const next = clampRpm(rpm, 5)
  const now = nowIso()
  const current = db.prepare(`SELECT expires_at FROM rpm_grants WHERE user_id = ?`).get(userId) as
    | { expires_at: string | null }
    | undefined
  const expiresAt = extendExpiresAt(current?.expires_at)
  db.prepare(
    `INSERT INTO rpm_grants (user_id, rpm, note, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET rpm = excluded.rpm, note = excluded.note, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
  ).run(userId, next, note ?? null, now, expiresAt)
  return next
}

function activatePurchasedPlan(userId: string, planKey: RpmPlanKey) {
  const current = db.prepare(`SELECT rpm_plan, rpm_expires_at FROM users WHERE id = ?`).get(userId) as
    | { rpm_plan: string | null; rpm_expires_at: string | null }
    | undefined
  const extendFrom = current?.rpm_plan === planKey ? current.rpm_expires_at : null
  const expiresAt = extendExpiresAt(extendFrom)
  db.prepare(`UPDATE users SET rpm_plan = ?, rpm_expires_at = ? WHERE id = ?`).run(planKey, expiresAt, userId)
  db.prepare(`DELETE FROM rpm_grants WHERE user_id = ?`).run(userId)
}

export function upgradeUserRpm(
  userId: string,
  options: {
    rpm: number
    days?: number
    amountCents?: number
    provider?: string
    paymentId?: string
    orderId?: string
  },
) {
  const user = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(userId) as
    | { id: string; email: string | null }
    | undefined
  if (!user) throw new Error(`User not found: ${userId}`)

  const rpm = Number(options.rpm) >= 60 ? 60 : 30
  const planKey: RpmPlanKey = rpm >= 60 ? 'high' : 'standard'
  const days = options.days && options.days > 0 ? options.days : RPM_PLAN_DAYS
  const amountCents = options.amountCents ?? (rpm >= 60 ? 2120 : 1080)
  const now = nowIso()

  const current = db.prepare(`SELECT rpm_plan, rpm_expires_at FROM users WHERE id = ?`).get(userId) as
    | { rpm_plan: string | null; rpm_expires_at: string | null }
    | undefined
  const extendFrom = current?.rpm_plan === planKey ? current.rpm_expires_at : null
  const expiresAt = extendExpiresAt(extendFrom, days)

  db.transaction(() => {
    db.prepare(`UPDATE users SET rpm_plan = ?, rpm_expires_at = ? WHERE id = ?`).run(planKey, expiresAt, userId)
    db.prepare(`DELETE FROM rpm_grants WHERE user_id = ?`).run(userId)

    const paymentId = id('rpmpay')
    const orderId =
      options.orderId ||
      (options.paymentId ? `card_${options.paymentId}` : `rpm_card_${paymentId.slice(-12)}`)

    db.prepare(
      `INSERT INTO rpm_payments
        (id, user_id, plan_key, rpm, amount_cents, status, order_id, payment_id, pay_amount, invoice_url, raw_status, credited_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'finished', ?, ?, ?, NULL, 'succeeded', ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         status = 'finished',
         payment_id = COALESCE(excluded.payment_id, rpm_payments.payment_id),
         credited_at = COALESCE(rpm_payments.credited_at, excluded.credited_at),
         updated_at = excluded.updated_at`,
    ).run(
      paymentId,
      userId,
      planKey,
      rpm,
      amountCents,
      orderId,
      options.paymentId ?? null,
      (amountCents / 100).toFixed(2),
      now,
      now,
      now,
    )

    try {
      recordLevelSpend({
        userId,
        amountCents,
        sourceRef: levelSourceRef('rpm', paymentId),
      })
    } catch (err) {
      console.error('[levels] rpm card level spend failed:', err)
    }

    try {
      tryGrantReferralReward({
        userId,
        paymentId,
        amountCents,
      })
    } catch (err) {
      console.error('[referrals] rpm card reward failed:', err)
    }
  })()

  try {
      } catch {}

  
  return { ok: true, rpm, expiresAt, planKey }
}

export async function createRpmCryptoPurchase(_input: {
  userId: string
  planKey: string
}) {
  throw new Error('Crypto payments are currently disabled')
}

export type CreditRpmResult =
  | {
      ok: true
      already: true
      userId: string
      planKey: string
      rpm: number
      amountCents: number
      orderId: string
      label?: string
    }
  | {
      ok: true
      already: false
      userId: string
      planKey: string
      rpm: number
      amountCents: number
      label: string
      orderId: string
      payAmount: string | null
    }

export function creditRpmCryptoOrder(orderId: string, npPaymentId?: string | null): CreditRpmResult | null {
  if (!tableExists('rpm_payments')) return null
  const payment = db.prepare(`SELECT * FROM rpm_payments WHERE order_id = ?`).get(orderId) as RpmPaymentRow | undefined
  if (!payment) return null
  if (payment.credited_at) {
    return { ok: true as const, already: true as const, userId: payment.user_id, planKey: payment.plan_key, rpm: payment.rpm, amountCents: payment.amount_cents, orderId, label: `${payment.rpm} RPM` }
  }
  const planKey = payment.plan_key
  if (!isPaidRpmKey(planKey)) return null

  const now = nowIso()
  const credited = db.transaction(() => {
    const fresh = db.prepare(`SELECT credited_at FROM rpm_payments WHERE id = ?`).get(payment.id) as { credited_at: string | null }
    if (fresh.credited_at) return false
    activatePurchasedPlan(payment.user_id, planKey)
    db.prepare(
      `UPDATE rpm_payments
       SET status = 'finished', payment_id = COALESCE(?, payment_id), credited_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(npPaymentId ?? null, now, now, payment.id)
    return true
  })()

  if (credited) {
    try {
      recordLevelSpend({
        userId: payment.user_id,
        amountCents: payment.amount_cents,
        sourceRef: levelSourceRef('rpm', payment.id),
      })
    } catch (error) {
      console.error('[levels] rpm purchase credit failed', error)
    }

    try {
      tryGrantReferralReward({
        userId: payment.user_id,
        paymentId: payment.id,
        amountCents: payment.amount_cents,
      })
    } catch (error) {
      console.error('[referrals] rpm crypto reward failed', error)
    }
  }

  if (!credited) {
    return { ok: true as const, already: true as const, userId: payment.user_id, planKey: payment.plan_key, rpm: payment.rpm, amountCents: payment.amount_cents, orderId, label: `${payment.rpm} RPM` }
  }
  return {
    ok: true as const,
    already: false as const,
    userId: payment.user_id,
    planKey: payment.plan_key,
    rpm: payment.rpm,
    amountCents: payment.amount_cents,
    label: `${payment.rpm} RPM`,
    orderId: payment.order_id,
    payAmount: payment.pay_amount,
  }
}

export function getRpmPaymentPublic(paymentId: string, userId: string) {
  if (!tableExists('rpm_payments')) return null
  const payment = db.prepare(`SELECT * FROM rpm_payments WHERE id = ?`).get(paymentId) as RpmPaymentRow | undefined
  if (!payment || payment.user_id !== userId) return null
  return {
    id: payment.id,
    planKey: payment.plan_key,
    rpm: payment.rpm,
    amountCents: payment.amount_cents,
    status: payment.status,
    credited: Boolean(payment.credited_at),
    invoiceUrl: payment.invoice_url,
  }
}

export function adminRpmUser(userId: string) {
  const account = getAccountRpm(userId)
  const grant = tableExists('rpm_grants')
    ? (db.prepare(`SELECT rpm, note, updated_at, expires_at FROM rpm_grants WHERE user_id = ?`).get(userId) as
        | { rpm: number; note: string | null; updated_at: string; expires_at: string | null }
        | undefined)
    : undefined
  return {
    planKey: getUserRpmPlanKey(userId),
    rpm: account.rpm,
    label: account.label,
    expiresAt: account.expiresAt,
    grantRpm: grant?.rpm ?? null,
    grantNote: grant?.note ?? null,
    grantExpiresAt: grant?.expires_at ?? null,
  }
}
