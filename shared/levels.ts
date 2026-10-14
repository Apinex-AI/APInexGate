/**
 * Account levels for free-model burn rate.
 *
 * Level 1 is granted on registration. Levels 2–5 each have their own top-up
 * goal. Overflow from one goal fills the next, so several payments can clear
 * one level and a single large payment can clear several.
 */

export type LevelConfig = {
  level: number
  /** USD required to reach this level from the previous one. Level 1 is 0. */
  topupUsd: number
  weight: number
}

export const MAX_ACCOUNT_LEVEL = 5

export const DEFAULT_LEVELS: LevelConfig[] = [
  { level: 1, topupUsd: 0, weight: 3 },
  { level: 2, topupUsd: 20, weight: 2.5 },
  { level: 3, topupUsd: 50, weight: 2 },
  { level: 4, topupUsd: 100, weight: 1.5 },
  { level: 5, topupUsd: 200, weight: 1 },
]

export type LevelProgress = {
  level: number
  weight: number
  /** USD already counted toward the next level. Null at max level. */
  progressUsd: number | null
  /** USD still needed for the next level. Null at max level. */
  remainingUsd: number | null
  nextLevel: number | null
  nextWeight: number | null
  nextTopupUsd: number | null
  maxLevel: number
}

export function normalizeLevels(input: unknown): LevelConfig[] {
  const rows = Array.isArray(input) ? input : []
  return DEFAULT_LEVELS.map((fallback) => {
    const stored = rows.find((row) => Number((row as { level?: unknown })?.level) === fallback.level) as
      | { topupUsd?: unknown; weight?: unknown }
      | undefined
    const weight = Number(stored?.weight)
    const topup = Number(stored?.topupUsd)
    return {
      level: fallback.level,
      topupUsd: fallback.level === 1 ? 0 : Math.max(0.01, Number.isFinite(topup) ? roundUsd(topup) : fallback.topupUsd),
      weight: Number.isFinite(weight) && weight > 0 ? roundWeight(weight) : fallback.weight,
    }
  })
}

export function roundUsd(value: number) {
  return Math.round(value * 100) / 100
}

export function roundWeight(value: number) {
  return Math.round(value * 1000) / 1000
}

export function levelConfig(levels: LevelConfig[], level: number) {
  return levels.find((row) => row.level === level) ?? levels[0]
}

export function progressTowardNext(level: number, progressCents: number, levels: LevelConfig[]): LevelProgress {
  const current = Math.min(MAX_ACCOUNT_LEVEL, Math.max(1, Math.floor(level) || 1))
  const weight = levelConfig(levels, current).weight
  const next = levels.find((row) => row.level === current + 1)
  if (!next) {
    return {
      level: current,
      weight,
      progressUsd: null,
      remainingUsd: null,
      nextLevel: null,
      nextWeight: null,
      nextTopupUsd: null,
      maxLevel: MAX_ACCOUNT_LEVEL,
    }
  }
  const needCents = Math.round(next.topupUsd * 100)
  const held = Math.max(0, Math.min(needCents, Math.floor(progressCents)))
  return {
    level: current,
    weight,
    progressUsd: roundUsd(held / 100),
    remainingUsd: roundUsd((needCents - held) / 100),
    nextLevel: next.level,
    nextWeight: next.weight,
    nextTopupUsd: next.topupUsd,
    maxLevel: MAX_ACCOUNT_LEVEL,
  }
}

/**
 * Apply a top-up to the current level. Overflow continues into the next goals
 * so $70 at level 1 becomes level 3 with $0 progress if the goals are $20 then $50.
 */
export function applyLevelTopup(
  level: number,
  progressCents: number,
  addedCents: number,
  levels: LevelConfig[],
) {
  let nextLevel = Math.min(MAX_ACCOUNT_LEVEL, Math.max(1, Math.floor(level) || 1))
  let nextProgress = Math.max(0, Math.floor(progressCents) || 0)
  let left = Math.max(0, Math.floor(addedCents) || 0)
  const started = nextLevel

  while (left > 0 && nextLevel < MAX_ACCOUNT_LEVEL) {
    const goal = levels.find((row) => row.level === nextLevel + 1)
    if (!goal) break
    const need = Math.max(1, Math.round(goal.topupUsd * 100))
    const missing = Math.max(0, need - nextProgress)
    if (left < missing) {
      nextProgress += left
      left = 0
      break
    }
    left -= missing
    nextLevel += 1
    nextProgress = 0
  }

  return {
    level: nextLevel,
    progressCents: nextProgress,
    leveledUp: nextLevel > started,
    previousLevel: started,
  }
}

export function formatMultiplier(weight: number) {
  const rounded = roundWeight(weight)
  return `x${Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded)}`
}
