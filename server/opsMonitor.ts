import { pickProviderSecrets } from './providerKeys.js'

const CHECK_EVERY_MS = 60_000
const FAIL_STREAK_ALERT = 2

let timer: ReturnType<typeof setInterval> | null = null
let healthFailStreak = 0
let lastPoolAlertAt = 0

async function checkLocalHealth() {
  const port = Number(process.env.PORT ?? 8787)
  const host = process.env.HOST === '0.0.0.0' ? '127.0.0.1' : (process.env.HOST ?? '127.0.0.1')
  const started = Date.now()
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    })
    const latencyMs = Date.now() - started
    if (!response.ok) {
      healthFailStreak += 1
      if (healthFailStreak >= FAIL_STREAK_ALERT) {
              }
      return
    }
    if (latencyMs > 3_000) {
          }
    healthFailStreak = 0
  } catch (reason) {
    healthFailStreak += 1
    if (healthFailStreak >= FAIL_STREAK_ALERT) {
          }
  }
}

function checkProviderPools() {
  const now = Date.now()
  // Don't spam more than once / 10 min for pool exhaustion.
  if (now - lastPoolAlertAt < 10 * 60_000) return
  const critical = ['apinex'] as const
  const empty = critical.filter((provider) => pickProviderSecrets(provider).length === 0)
  if (empty.length === 0) return
  lastPoolAlertAt = now
  }

export function startOpsMonitor() {
  if (timer) return
  setTimeout(() => {
    void checkLocalHealth()
    checkProviderPools()
  }, 15_000).unref?.()
  timer = setInterval(() => {
    void checkLocalHealth()
    checkProviderPools()
  }, CHECK_EVERY_MS)
  timer.unref?.()
}
