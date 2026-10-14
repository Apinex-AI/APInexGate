import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatTrialDeadline,
  shouldWarnTrialEndingSoon,
  TRIAL_ENDING_SOON_MS,
  trialMsRemaining,
} from '../shared/trialClock.ts'

// 1788275146 = 2026-09-01 15:05:46 UTC → 2026-09-01 17:05 at UTC+2.
const TRIAL_END = 1_788_275_146

test('renders the deadline in UTC+2 with minute precision and no suffix', () => {
  assert.equal(formatTrialDeadline(TRIAL_END), '2026-09-01 17:05')
})

test('pads single-digit months, days, hours, and minutes', () => {
  // 2026-01-02 03:04 UTC → 05:04 at UTC+2.
  assert.equal(formatTrialDeadline(Date.UTC(2026, 0, 2, 3, 4) / 1000), '2026-01-02 05:04')
})

test('unusable input renders as an empty string', () => {
  assert.equal(formatTrialDeadline(0), '')
  assert.equal(formatTrialDeadline(null), '')
  assert.equal(formatTrialDeadline(undefined), '')
  assert.equal(formatTrialDeadline(Number.NaN), '')
})

test('remaining time is positive before the deadline and negative after', () => {
  assert.equal(trialMsRemaining(TRIAL_END, TRIAL_END * 1000 - 60_000), 60_000)
  assert.equal(trialMsRemaining(TRIAL_END, TRIAL_END * 1000 + 60_000), -60_000)
  assert.equal(trialMsRemaining(null, Date.now()), null)
})

test('warns once inside the two-hour window while credit is unspent', () => {
  const base = {
    trialEndsAt: TRIAL_END,
    balanceUsdCents: 9089,
    alreadyNotified: false,
  }
  assert.equal(
    shouldWarnTrialEndingSoon({ ...base, nowMs: TRIAL_END * 1000 - TRIAL_ENDING_SOON_MS + 1_000 }),
    true,
  )
  assert.equal(shouldWarnTrialEndingSoon({ ...base, nowMs: TRIAL_END * 1000 - 60_000 }), true)
})

test('stays silent outside the window, when spent, after expiry, or already sent', () => {
  const now = TRIAL_END * 1000 - 60_000
  // More than two hours left.
  assert.equal(
    shouldWarnTrialEndingSoon({
      trialEndsAt: TRIAL_END,
      balanceUsdCents: 9089,
      alreadyNotified: false,
      nowMs: TRIAL_END * 1000 - TRIAL_ENDING_SOON_MS - 1_000,
    }),
    false,
  )
  // Fully spent trials need no warning.
  assert.equal(
    shouldWarnTrialEndingSoon({ trialEndsAt: TRIAL_END, balanceUsdCents: 0, alreadyNotified: false, nowMs: now }),
    false,
  )
  // Already expired.
  assert.equal(
    shouldWarnTrialEndingSoon({
      trialEndsAt: TRIAL_END,
      balanceUsdCents: 9089,
      alreadyNotified: false,
      nowMs: TRIAL_END * 1000 + 1_000,
    }),
    false,
  )
  // One-shot marker present.
  assert.equal(
    shouldWarnTrialEndingSoon({ trialEndsAt: TRIAL_END, balanceUsdCents: 9089, alreadyNotified: true, nowMs: now }),
    false,
  )
  // No trial window at all.
  assert.equal(
    shouldWarnTrialEndingSoon({ trialEndsAt: null, balanceUsdCents: 9089, alreadyNotified: false, nowMs: now }),
    false,
  )
})
