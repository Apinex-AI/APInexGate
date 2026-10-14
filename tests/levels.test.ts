import assert from 'node:assert/strict'
import test from 'node:test'
import { applyLevelTopup, DEFAULT_LEVELS, progressTowardNext } from '../shared/levels.ts'

test('overflow fills the next level instead of stacking one lifetime total', () => {
  const first = applyLevelTopup(1, 0, 700, DEFAULT_LEVELS)
  assert.equal(first.level, 1)
  assert.equal(first.progressCents, 700)

  const second = applyLevelTopup(first.level, first.progressCents, 1500, DEFAULT_LEVELS)
  assert.equal(second.level, 2)
  assert.equal(second.progressCents, 200)
  assert.equal(second.leveledUp, true)
})

test('one payment can cross several fresh goals', () => {
  const result = applyLevelTopup(1, 0, 37_000, DEFAULT_LEVELS)
  assert.equal(result.level, 5)
  assert.equal(result.progressCents, 0)
})

test('progress is per next goal, not cumulative lifetime spend', () => {
  const view = progressTowardNext(3, 2500, DEFAULT_LEVELS)
  assert.equal(view.weight, 2)
  assert.equal(view.nextLevel, 4)
  assert.equal(view.nextTopupUsd, 100)
  assert.equal(view.progressUsd, 25)
  assert.equal(view.remainingUsd, 75)
})

test('one dollar short of level 2 plus $20 becomes level 2 with $19 of $50', () => {
  const almost = applyLevelTopup(1, 1900, 0, DEFAULT_LEVELS)
  const next = applyLevelTopup(almost.level, almost.progressCents, 2000, DEFAULT_LEVELS)
  assert.equal(next.level, 2)
  assert.equal(next.progressCents, 1900)
})

test('$370 from level 1 reaches level 5 and extra money is not counted', () => {
  const result = applyLevelTopup(1, 0, 40_000, DEFAULT_LEVELS)
  assert.equal(result.level, 5)
  assert.equal(result.progressCents, 0)
})

test('max level has no further goal', () => {
  const view = progressTowardNext(5, 999, DEFAULT_LEVELS)
  assert.equal(view.weight, 1)
  assert.equal(view.nextLevel, null)
  assert.equal(view.remainingUsd, null)
})
