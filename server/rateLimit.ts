import type { FastifyReply } from 'fastify'

type Bucket = {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 50_000

let lastCleanup = 0

function cleanup(now: number) {
  if (now - lastCleanup < 60_000 && buckets.size < MAX_BUCKETS) return
  lastCleanup = now
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
  // Emergency trim if something floods unique keys.
  if (buckets.size > MAX_BUCKETS) {
    const overflow = buckets.size - Math.floor(MAX_BUCKETS * 0.8)
    let removed = 0
    for (const key of buckets.keys()) {
      buckets.delete(key)
      if (++removed >= overflow) break
    }
  }
}

export type RateLimitResult =
  | { ok: true; remaining: number; resetAt: number }
  | { ok: false; retryAfterSec: number; resetAt: number }

/** Fixed-window counter. Key should already include scope (route + ip/user/key). */
export function consumeRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  cleanup(now)

  let bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs }
    buckets.set(key, bucket)
  }

  if (bucket.count >= limit) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      resetAt: bucket.resetAt,
    }
  }

  bucket.count += 1
  return {
    ok: true,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
  }
}

export function setRateLimitHeaders(
  reply: FastifyReply,
  input: { limit: number; remaining: number; resetAt: number; retryAfterSec?: number },
) {
  reply.header('X-RateLimit-Limit', String(input.limit))
  reply.header('X-RateLimit-Remaining', String(Math.max(0, input.remaining)))
  reply.header('X-RateLimit-Reset', String(Math.ceil(input.resetAt / 1000)))
  if (input.retryAfterSec) reply.header('Retry-After', String(input.retryAfterSec))
}

/** Returns false and sends 429 when limited. */
export function enforceRateLimit(
  reply: FastifyReply,
  key: string,
  limit: number,
  windowMs: number,
  message = 'Too many requests. Try again later.',
): boolean {
  const result = consumeRateLimit(key, limit, windowMs)
  if (result.ok) {
    setRateLimitHeaders(reply, {
      limit,
      remaining: result.remaining,
      resetAt: result.resetAt,
    })
    return true
  }

  setRateLimitHeaders(reply, {
    limit,
    remaining: 0,
    resetAt: result.resetAt,
    retryAfterSec: result.retryAfterSec,
  })
  reply.code(429).send({ error: message, retryAfterSec: result.retryAfterSec })
  return false
}

export function rateLimitKey(parts: Array<string | null | undefined>) {
  return parts.map((part) => (part && part.trim() ? part.trim() : 'unknown')).join(':')
}

/** Presets — short windows (≤90s). Tighter counts, quick unlock. */
const SHORT = 90_000

export const RL = {
  adminLoginIp: { limit: 4, windowMs: SHORT },
  /** Browser polls /api/auth/login/status every ~2s while waiting for Telegram. */
  adminLoginStatusIp: { limit: 80, windowMs: SHORT },
  loginIp: { limit: 5, windowMs: SHORT },
  loginEmail: { limit: 4, windowMs: SHORT },
  registerIp: { limit: 4, windowMs: SHORT },
  registerEmail: { limit: 3, windowMs: SHORT },
  forgotIp: { limit: 4, windowMs: SHORT },
  resendIp: { limit: 4, windowMs: SHORT },
  verifyIp: { limit: 6, windowMs: SHORT },
  resetIp: { limit: 5, windowMs: SHORT },
  googleStartIp: { limit: 5, windowMs: SHORT },
  challengeIp: { limit: 40, windowMs: SHORT },
  logoutIp: { limit: 8, windowMs: SHORT },
  keysCreateUser: { limit: 4, windowMs: SHORT },
  /** Telegram deep-link minting: 6 / min per user. */
  telegramLinkUser: { limit: 6, windowMs: 60_000 },
  /** Promo redeem attempts: 8 / 90s per user. */
  promoRedeemUser: { limit: 8, windowMs: SHORT },
  /** Voucher redeem attempts: anti-bruteforce protection for G2G codes. */
  voucherRedeemIp: { limit: 10, windowMs: 60_000 },
  voucherRedeemUser: { limit: 10, windowMs: 60_000 },
  /** Invoice creation: at most 7 invoices per user in a rolling 15-minute window. */
  topupUserBurst: { limit: 7, windowMs: 15 * 60_000 },
  /**
   * LLM gateway inference RPM is the admin tier limit, counted per IP.
   * This key ceiling is only a fallback for non-inference routes.
   */
  gatewayKey: { limit: 30, windowMs: 60_000 },
  gatewayIp: { limit: 90, windowMs: 60_000 },
  modelsKey: { limit: 60, windowMs: 60_000 },
  /** Tools (search/contents): higher than LLM — still protected. */
  toolsKey: { limit: 60, windowMs: 60_000 },
  toolsIp: { limit: 180, windowMs: 60_000 },
  /** Research is heavier; keep tighter. */
  toolsResearchKey: { limit: 12, windowMs: 60_000 },
  /** Twitter tools: higher throughput than LLM, still per-key capped. */
  toolsTwitterKey: { limit: 120, windowMs: 60_000 },
  toolsTwitterIp: { limit: 300, windowMs: 60_000 },
  /** Solana RPC: upstream-safe aggregate caps; heavy calls have an additional stricter cap. */
  toolsSolanaIp: { limit: 300, windowMs: 60_000 },
  toolsSolanaHeavyIp: { limit: 60, windowMs: 60_000 },
  /** Voice STT/TTS: heavier upstream work. */
  toolsVoiceKey: { limit: 30, windowMs: 60_000 },
  toolsVoiceIp: { limit: 90, windowMs: 60_000 },
  /** Captcha solving: slow upstream work; poll loops run server-side. */
  toolsCaptchaKey: { limit: 30, windowMs: 60_000 },
  toolsCaptchaIp: { limit: 90, windowMs: 60_000 },
  installIp: { limit: 20, windowMs: SHORT },
  /** Public status endpoint — cheap JSON, still bound to stop scrapers. */
  publicStatusIp: { limit: 30, windowMs: 60_000 },
} as const
