/**
 * Trial-window helpers for upstream provider keys.
 *
 * Operators read these timestamps at a glance, so they are always rendered in
 * UTC+2 (the team's working offset) with minute precision and no timezone
 * suffix, independent of the server's own timezone.
 */

const DISPLAY_OFFSET_MINUTES = 120

/** `YYYY-MM-DD HH:MM` in UTC+2. Returns an empty string for unusable input. */
export function formatTrialDeadline(epochSeconds: number | null | undefined) {
  const seconds = Number(epochSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const shifted = new Date((seconds + DISPLAY_OFFSET_MINUTES * 60) * 1000)
  if (Number.isNaN(shifted.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  )
}

/** Whole milliseconds until the deadline; negative once it has passed. */
export function trialMsRemaining(
  epochSeconds: number | null | undefined,
  nowMs = Date.now(),
) {
  const seconds = Number(epochSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return seconds * 1000 - nowMs
}

export const TRIAL_ENDING_SOON_MS = 2 * 60 * 60 * 1000

/**
 * Alert only while credit is still unspent: an exhausted trial needs no warning,
 * and an already-expired window cannot be salvaged.
 */
export function shouldWarnTrialEndingSoon(input: {
  trialEndsAt: number | null | undefined
  balanceUsdCents: number
  alreadyNotified: boolean
  nowMs?: number
}) {
  if (input.alreadyNotified) return false
  if (input.balanceUsdCents <= 0) return false
  const remaining = trialMsRemaining(input.trialEndsAt, input.nowMs ?? Date.now())
  if (remaining === null) return false
  return remaining > 0 && remaining <= TRIAL_ENDING_SOON_MS
}
