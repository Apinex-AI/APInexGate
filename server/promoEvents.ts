import { db, nowIso } from './db.js'

const EVENT_ID = 'current'
const COOLDOWN_MS = Math.max(1_000, Number(process.env.PROMO_EVENT_COOLDOWN_MS || 120_000))

export type PromoPhase = 'off' | 'upcoming' | 'live' | 'cooldown' | 'ended'

type EventRow = {
  id: string
  starts_at: string
  ends_at: string
  token_limit: number
  tokens_used: number
  min_topup_cents: number
  cooldown_until: string | null
  created_at: string
  updated_at: string
}

export type PromoModelInput = { modelId: string; discountPct: number }

let ready = false

export function ensurePromoEventTables() {
  if (ready || process.env.STATS_WORKER === '1') return
  db.exec(`
    CREATE TABLE IF NOT EXISTS promo_events (
      id TEXT PRIMARY KEY,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      token_limit INTEGER NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      min_topup_cents INTEGER NOT NULL,
      cooldown_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS promo_event_models (
      event_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      discount_pct INTEGER NOT NULL,
      PRIMARY KEY (event_id, model_id)
    );
    CREATE TABLE IF NOT EXISTS promo_event_qualifications (
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      topup_cents INTEGER NOT NULL,
      qualified_at TEXT NOT NULL,
      PRIMARY KEY (event_id, user_id)
    );
  `)
  ready = true
}

function loadEvent() {
  ensurePromoEventTables()
  return db.prepare(`SELECT * FROM promo_events WHERE id = ?`).get(EVENT_ID) as EventRow | undefined
}

function loadModels(eventId: string) {
  return db
    .prepare(
      `SELECT model_id, discount_pct FROM promo_event_models WHERE event_id = ? ORDER BY model_id ASC`,
    )
    .all(eventId) as Array<{ model_id: string; discount_pct: number }>
}

function modelAliases(modelId: string) {
  const id = modelId.trim()
  const alt = id.includes('/') ? id.replace('/', '-') : id.includes('-') ? id.replace('-', '/') : id
  return alt === id ? [id] : [id, alt]
}

function discountFor(modelId: string, models: Array<{ model_id: string; discount_pct: number }>) {
  const aliases = new Set(modelAliases(modelId))
  const row = models.find((item) => aliases.has(item.model_id) || modelAliases(item.model_id).some((alias) => aliases.has(alias)))
  if (!row) return null
  const pct = Math.round(Number(row.discount_pct))
  if (!Number.isFinite(pct) || pct <= 0) return null
  return Math.min(100, pct)
}

export function syncPromoPhase(row?: EventRow | null): PromoPhase {
  const event = row === undefined ? loadEvent() : row
  if (!event) return 'off'
  const now = Date.now()
  const start = Date.parse(event.starts_at)
  const end = Date.parse(event.ends_at)
  const cooldownUntil = event.cooldown_until ? Date.parse(event.cooldown_until) : NaN
  if (Number.isFinite(cooldownUntil) && cooldownUntil > now) return 'cooldown'
  if (Number.isFinite(cooldownUntil) && cooldownUntil <= now) return 'ended'
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'off'
  if (now < start) return 'upcoming'
  if (now >= end || event.tokens_used >= event.token_limit) {
    const until = new Date(now + COOLDOWN_MS).toISOString()
    db.prepare(`UPDATE promo_events SET cooldown_until = ?, updated_at = ? WHERE id = ? AND cooldown_until IS NULL`).run(
      until,
      nowIso(),
      event.id,
    )
    event.cooldown_until = until
    return 'cooldown'
  }
  return 'live'
}

function qualified(userId: string, eventId: string) {
  const row = db
    .prepare(`SELECT 1 AS ok FROM promo_event_qualifications WHERE event_id = ? AND user_id = ?`)
    .get(eventId, userId) as { ok: number } | undefined
  return Boolean(row)
}

export function noteQualifyingTopup(userId: string) {
  const event = loadEvent()
  if (!event || !userId) return
  if (syncPromoPhase(event) !== 'live') return
  const sum = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS cents
       FROM balance_transactions
       WHERE user_id = ?
         AND type = 'top_up'
         AND status = 'completed'
         AND amount_cents > 0
         AND created_at >= ?
         AND created_at < ?`,
    )
    .get(userId, event.starts_at, event.ends_at) as { cents: number }
  const cents = Math.max(0, Math.round(Number(sum?.cents ?? 0)))
  if (cents < event.min_topup_cents) return
  db.prepare(
    `INSERT INTO promo_event_qualifications (event_id, user_id, topup_cents, qualified_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id, user_id) DO UPDATE SET topup_cents = excluded.topup_cents`,
  ).run(event.id, userId, cents, nowIso())
}

export function discountedTokenCost(fullCost: number, discountPct: number) {
  const full = Math.max(0, Math.floor(fullCost))
  if (full <= 0) return 0
  const pct = Math.min(100, Math.max(0, Math.round(discountPct)))
  if (pct >= 100) return 0
  if (pct <= 0) return full
  return Math.max(0, Math.ceil((full * (100 - pct)) / 100))
}

export function promoBillingPlan(userId: string, modelId: string, inputUsd: number, outputUsd = inputUsd) {
  const event = loadEvent()
  if (!event) return { discountPct: 0 as const }
  const models = loadModels(event.id)
  const pct = discountFor(modelId, models)
  const phase = syncPromoPhase(event)
  if (pct == null) return { discountPct: 0 as const }
  if (phase === 'cooldown') {
    const input = Number.isFinite(inputUsd) && inputUsd > 0 ? inputUsd : 0
    const output = Number.isFinite(outputUsd) && outputUsd > 0 ? outputUsd : input
    const price = input > 0 || output > 0
      ? input === output
        ? `$${input.toFixed(2)}`
        : `$${input.toFixed(2)} input / $${output.toFixed(2)} output`
      : 'the regular price'
    const leftMs = Math.max(0, Date.parse(event.cooldown_until || '') - Date.now())
    const total = Math.max(1, Math.ceil(leftMs / 1000))
    const mins = Math.floor(total / 60)
    const secs = total % 60
    const wait = mins > 0 ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${secs}s`
    return {
      discountPct: 0 as const,
      block: `This limited-time discount has ended. Prices have changed. You can use this model again in ${wait} at the regular price of ${price} per 1M tokens.`,
    }
  }
  if (phase !== 'live' || !qualified(userId, event.id)) return { discountPct: 0 as const }
  return { discountPct: pct }
}

/** Discount the dollar charge. The shared pool counts raw input + output tokens, with no weight. */
export function applySettledPromoCost(userId: string, modelId: string, fullCost: number, rawTokens = fullCost) {
  const full = Math.max(0, Math.floor(fullCost))
  const raw = Math.max(0, Math.floor(rawTokens))
  const event = loadEvent()
  if (!event) return full
  const pct = discountFor(modelId, loadModels(event.id))
  if (pct == null) return full
  if (syncPromoPhase(event) !== 'live') return full
  if (!qualified(userId, event.id)) return full
  const charge = discountedTokenCost(full, pct)
  if (raw <= 0) return charge
  const tx = db.transaction(() => {
    const fresh = loadEvent()
    if (!fresh || syncPromoPhase(fresh) !== 'live') return full
    db.prepare(
      `UPDATE promo_events
       SET tokens_used = MIN(token_limit, tokens_used + ?), updated_at = ?
       WHERE id = ?`,
    ).run(raw, nowIso(), fresh.id)
    const after = loadEvent()
    if (after && after.tokens_used >= after.token_limit && !after.cooldown_until) {
      syncPromoPhase(after)
    }
    return charge
  })
  return tx()
}

export type PublicPromoModel = {
  id: string
  name: string
  discountPct: number
  priceUsd: number
  outputPriceUsd: number
  discountedPriceUsd: number
  discountedOutputPriceUsd: number
}

export function getPublicPromoEvent() {
  const event = loadEvent()
  if (!event) {
    return { phase: 'off' as const }
  }
  const phase = syncPromoPhase(event)
  const models = loadModels(event.id).map((row) => {
    const catalog = db
      .prepare(`SELECT id, name, provider, COALESCE(input_price_micros, 0) AS input_price_micros, COALESCE(output_price_micros, 0) AS output_price_micros FROM model_catalog WHERE id = ?`)
      .get(row.model_id) as { id: string; name: string; provider: string; input_price_micros: number; output_price_micros: number } | undefined
    const free = !catalog || catalog.provider === 'Free' || catalog.id.startsWith('free/')
    const input = free ? 0 : Math.max(0, Number(catalog.input_price_micros) || 0) / 1_000_000
    const storedOutput = free ? 0 : Math.max(0, Number(catalog.output_price_micros) || 0) / 1_000_000
    const output = storedOutput > 0 ? storedOutput : input
    const pct = Math.min(100, Math.max(0, Math.round(row.discount_pct)))
    const discount = (price: number) => (pct >= 100 ? 0 : Math.round(price * (100 - pct)) / 100)
    return {
      id: row.model_id,
      name: catalog?.name || row.model_id,
      discountPct: pct,
      priceUsd: input,
      outputPriceUsd: output,
      discountedPriceUsd: discount(input),
      discountedOutputPriceUsd: discount(output),
    }
  })
  return {
    phase,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    cooldownUntil: event.cooldown_until,
    tokenLimit: event.token_limit,
    tokensUsed: event.tokens_used,
    remainingTokens: Math.max(0, event.token_limit - event.tokens_used),
    minTopupUsd: event.min_topup_cents / 100,
    models,
  }
}

export function liveDiscountMap(userId?: string | null) {
  const event = loadEvent()
  const map = new Map<string, number>()
  if (!event || syncPromoPhase(event) !== 'live') return map
  if (!userId || !qualified(userId, event.id)) return map
  for (const row of loadModels(event.id)) {
    const pct = Math.min(100, Math.max(1, Math.round(row.discount_pct)))
    for (const alias of modelAliases(row.model_id)) map.set(alias, pct)
  }
  return map
}

export function grantPromoAccess(email: string) {
  ensurePromoEventTables()
  const event = loadEvent()
  if (!event) throw new Error('Save an event first')
  const normalized = email.trim().toLowerCase()
  if (!normalized.includes('@')) throw new Error('Enter a user email')
  const user = db.prepare(`SELECT id, email FROM users WHERE lower(email) = ?`).get(normalized) as
    | { id: string; email: string }
    | undefined
  if (!user) throw new Error('No user with that email')
  db.prepare(
    `INSERT INTO promo_event_qualifications (event_id, user_id, topup_cents, qualified_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id, user_id) DO UPDATE SET
       topup_cents = MAX(topup_cents, excluded.topup_cents),
       qualified_at = excluded.qualified_at`,
  ).run(event.id, user.id, event.min_topup_cents, nowIso())
  return { ok: true as const, email: user.email }
}

export function getAdminPromoEvent() {
  const event = loadEvent()
  const catalog = db
    .prepare(
      `SELECT id, name, provider FROM model_catalog WHERE status = 'active' ORDER BY name ASC`,
    )
    .all() as Array<{ id: string; name: string; provider: string }>
  if (!event) {
    return {
      event: null,
      phase: 'off' as PromoPhase,
      catalog,
    }
  }
  return {
    phase: syncPromoPhase(event),
    catalog,
    event: {
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      tokenLimit: event.token_limit,
      tokensUsed: event.tokens_used,
      minTopupUsd: event.min_topup_cents / 100,
      cooldownUntil: event.cooldown_until,
      models: loadModels(event.id).map((row) => ({ modelId: row.model_id, discountPct: row.discount_pct })),
    },
  }
}

function parseUtc(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

export function saveAdminPromoEvent(body: {
  startsAt?: unknown
  endsAt?: unknown
  tokenLimit?: unknown
  tokensUsed?: unknown
  minTopupUsd?: unknown
  models?: unknown
}) {
  ensurePromoEventTables()
  const startsAt = parseUtc(body.startsAt)
  const endsAt = parseUtc(body.endsAt)
  if (!startsAt || !endsAt) throw new Error('Start and end must be valid UTC times')
  if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error('End time must be after the start time')
  const tokenLimit = Math.round(Number(body.tokenLimit))
  if (!Number.isFinite(tokenLimit) || tokenLimit <= 0) throw new Error('Token pool must be a positive number')
  let tokensUsed = Math.round(Number(body.tokensUsed ?? 0))
  if (!Number.isFinite(tokensUsed) || tokensUsed < 0) throw new Error('Used tokens cannot be negative')
  if (tokensUsed > tokenLimit) tokensUsed = tokenLimit
  const minTopupUsd = Number(body.minTopupUsd)
  if (!Number.isFinite(minTopupUsd) || minTopupUsd < 0.01) throw new Error('Minimum top-up must be at least $0.01')
  const minTopupCents = Math.round(minTopupUsd * 100)
  if (!Array.isArray(body.models) || body.models.length === 0) throw new Error('Add at least one model')
  const models: PromoModelInput[] = []
  const seen = new Set<string>()
  for (const raw of body.models) {
    const row = raw as { modelId?: unknown; discountPct?: unknown }
    const modelId = typeof row.modelId === 'string' ? row.modelId.trim() : ''
    const discountPct = Math.round(Number(row.discountPct))
    if (!modelId) throw new Error('Every row needs a model')
    if (seen.has(modelId)) throw new Error('Each model can only be added once')
    const exists = db.prepare(`SELECT id FROM model_catalog WHERE id = ? AND status = 'active'`).get(modelId) as
      | { id: string }
      | undefined
    if (!exists) throw new Error(`Unknown model: ${modelId}`)
    if (!Number.isFinite(discountPct) || discountPct < 1 || discountPct > 100) {
      throw new Error('Discount must be from 1 to 100')
    }
    seen.add(modelId)
    models.push({ modelId, discountPct })
  }

  const when = nowIso()
  const existing = loadEvent()
  const stillOpen = Date.parse(endsAt) > Date.now() && tokensUsed < tokenLimit && Date.parse(startsAt) <= Date.now()
  const upcoming = Date.parse(startsAt) > Date.now()
  const cooldownUntil = stillOpen || upcoming ? null : existing?.cooldown_until ?? null

  const tx = db.transaction(() => {
    if (!existing) {
      db.prepare(
        `INSERT INTO promo_events
          (id, starts_at, ends_at, token_limit, tokens_used, min_topup_cents, cooldown_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(EVENT_ID, startsAt, endsAt, tokenLimit, tokensUsed, minTopupCents, cooldownUntil, when, when)
    } else {
      db.prepare(
        `UPDATE promo_events
         SET starts_at = ?, ends_at = ?, token_limit = ?, tokens_used = ?, min_topup_cents = ?,
             cooldown_until = ?, updated_at = ?
         WHERE id = ?`,
      ).run(startsAt, endsAt, tokenLimit, tokensUsed, minTopupCents, cooldownUntil, when, EVENT_ID)
    }
    db.prepare(`DELETE FROM promo_event_models WHERE event_id = ?`).run(EVENT_ID)
    const insert = db.prepare(
      `INSERT INTO promo_event_models (event_id, model_id, discount_pct) VALUES (?, ?, ?)`,
    )
    for (const model of models) insert.run(EVENT_ID, model.modelId, model.discountPct)
    if (existing && existing.starts_at !== startsAt) {
      db.prepare(`DELETE FROM promo_event_qualifications WHERE event_id = ?`).run(EVENT_ID)
    }
  })
  tx()
  return getAdminPromoEvent()
}
