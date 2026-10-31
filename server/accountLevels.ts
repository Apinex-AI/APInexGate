import { db, getSetting, id, nowIso, setSetting } from './db.js'
import {
  DEFAULT_LEVELS,
  applyLevelTopup,
  normalizeLevels,
  progressTowardNext,
  type LevelConfig,
  type LevelProgress,
} from '../shared/levels.js'

const SETTINGS_KEY = 'account_level_settings'

export type AccountLevelState = LevelProgress & {
  progressCents: number
  celebrateLevel: number | null
}

type ProgressRow = {
  user_id: string
  level: number
  progress_cents: number
  seen_level: number
}

export function getLevelSettings(): LevelConfig[] {
  const raw = getSetting(SETTINGS_KEY, '')
  if (!raw) return DEFAULT_LEVELS.map((row) => ({ ...row }))
  try {
    return normalizeLevels(JSON.parse(raw))
  } catch {
    return DEFAULT_LEVELS.map((row) => ({ ...row }))
  }
}

export function saveLevelSettings(input: unknown): LevelConfig[] {
  const levels = normalizeLevels(input)
  for (const row of levels) {
    if (row.level > 1 && (!Number.isFinite(row.topupUsd) || row.topupUsd < 0.01)) {
      throw new Error(`Level ${row.level} needs a top-up of at least $0.01`)
    }
    if (!Number.isFinite(row.weight) || row.weight <= 0 || row.weight > 100) {
      throw new Error(`Level ${row.level} multiplier must be between 0 and 100`)
    }
  }
  setSetting(SETTINGS_KEY, JSON.stringify(levels))
  return levels
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_level_progress (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      level INTEGER NOT NULL DEFAULT 1,
      progress_cents INTEGER NOT NULL DEFAULT 0,
      seen_level INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS level_spend_credits (
      source_ref TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
}

ensureSchema()

function loadRow(userId: string): ProgressRow {
  const select = db.prepare(
    `SELECT user_id, level, progress_cents, seen_level FROM user_level_progress WHERE user_id = ?`,
  )
  const row = select.get(userId) as ProgressRow | undefined
  if (row) return row

  db.prepare(
    `INSERT OR IGNORE INTO user_level_progress (user_id, level, progress_cents, seen_level, updated_at)
     VALUES (?, 1, 0, 1, ?)`,
  ).run(userId, nowIso())

  return (select.get(userId) as ProgressRow) ?? { user_id: userId, level: 1, progress_cents: 0, seen_level: 1 }
}

function toState(row: ProgressRow, levels = getLevelSettings()): AccountLevelState {
  const progress = progressTowardNext(row.level, row.progress_cents, levels)
  const celebrate = row.level > row.seen_level && row.level > 1 ? row.level : null
  return {
    ...progress,
    progressCents: row.progress_cents,
    celebrateLevel: celebrate,
  }
}

export function getAccountLevel(userId: string): AccountLevelState {
  return toState(loadRow(userId))
}

export function freeModelWeightForUser(userId: string) {
  return getAccountLevel(userId).weight
}

/**
 * Count a real payment toward the next level. `sourceRef` must be stable so
 * retries and webhook replays do not double-count. Balance spend of an earlier
 * top-up is a separate purchase and should use its own source ref.
 */
export function recordLevelSpend(input: { userId: string; amountCents: number; sourceRef: string }) {
  const userId = String(input.userId || '').trim()
  const sourceRef = String(input.sourceRef || '').trim()
  const amountCents = Math.round(Number(input.amountCents) || 0)
  if (!userId || !sourceRef || amountCents < 1) return getAccountLevel(userId || 'missing')

  const applied = db.transaction(() => {
    const existing = db
      .prepare(`SELECT source_ref FROM level_spend_credits WHERE source_ref = ?`)
      .get(sourceRef) as { source_ref: string } | undefined
    if (existing) return null

    const current = loadRow(userId)
    const next = applyLevelTopup(current.level, current.progress_cents, amountCents, getLevelSettings())
    db.prepare(
      `INSERT INTO level_spend_credits (source_ref, user_id, amount_cents, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(sourceRef, userId, amountCents, nowIso())
    db.prepare(
      `UPDATE user_level_progress
       SET level = ?, progress_cents = ?, updated_at = ?
       WHERE user_id = ?`,
    ).run(next.level, next.progressCents, nowIso(), userId)
    return next
  })()

  if (!applied) return getAccountLevel(userId)
  return getAccountLevel(userId)
}

export function ackLevelCelebration(userId: string) {
  const row = loadRow(userId)
  if (row.seen_level < row.level) {
    db.prepare(`UPDATE user_level_progress SET seen_level = ?, updated_at = ? WHERE user_id = ?`).run(
      row.level,
      nowIso(),
      userId,
    )
  }
  return getAccountLevel(userId)
}

/** Test/admin helper. Not used by customer checkout. */
export function setAccountLevelForTests(userId: string, level: number, progressCents = 0) {
  loadRow(userId)
  db.prepare(
    `UPDATE user_level_progress SET level = ?, progress_cents = ?, seen_level = ?, updated_at = ? WHERE user_id = ?`,
  ).run(level, progressCents, level, nowIso(), userId)
  return getAccountLevel(userId)
}

export function levelSourceRef(prefix: string, paymentId: string) {
  return `${prefix}:${paymentId || id('lvl')}`
}
