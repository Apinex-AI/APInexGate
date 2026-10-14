/** Wallet ledger. $1 is $1 — there is no token equivalent of a dollar. */

/**
 * Internal ledger units per dollar. 1 unit = $0.000001.
 * A priced model debits `ceil(raw_tokens * dollars_per_1M)` of these units.
 * This is not a customer-facing token price.
 */
export const TOKENS_PER_USD = 1_000_000

/** @deprecated Paid models no longer have a shared $ / 1M rate. Kept so old imports compile. */
export const USD_PER_1M_AT_WEIGHT_1 = 0

export function tokensFromUsd(dollars: number) {
  if (!Number.isFinite(dollars) || dollars === 0) return 0
  return Math.round(dollars * TOKENS_PER_USD)
}

export function tokensFromUsdCents(cents: number) {
  if (!Number.isFinite(cents) || cents === 0) return 0
  return Math.round((cents / 100) * TOKENS_PER_USD)
}

export function usdFromTokens(tokens: number) {
  if (!Number.isFinite(tokens) || tokens === 0) return 0
  return tokens / TOKENS_PER_USD
}

/** Explicit 0 weight is free. Invalid / missing weights still fall back to paid (1). */
export function isFreeWeight(weight: number) {
  return Number.isFinite(weight) && weight === 0
}

export function formatRetailPrice(dollars: number) {
  if (!Number.isFinite(dollars)) return '—'
  if (dollars <= 0) return 'free'
  return dollars.toFixed(2)
}

/**
 * Wallet units charged for a priced model.
 * Input and output each have their own dollars-per-1M rate.
 * If output price is omitted, it matches the input price (older single-rate callers).
 */
export function chargeUsdMicros(
  inputTokens: number,
  outputTokens: number,
  inputDollarsPer1M: number,
  outputDollarsPer1M = inputDollarsPer1M,
) {
  const inputPrice = Number(inputDollarsPer1M)
  const outputPrice = Number(outputDollarsPer1M)
  const input = Number.isFinite(inputPrice) && inputPrice > 0 ? Math.max(0, inputTokens) * inputPrice : 0
  const output = Number.isFinite(outputPrice) && outputPrice > 0 ? Math.max(0, outputTokens) * outputPrice : 0
  if (input + output <= 0) return 0
  return Math.max(1, Math.ceil(((input + output) / 1_000_000) * TOKENS_PER_USD))
}

/**
 * Free-allowance meter only. Weight is not a price and is never applied to paid models.
 * Explicit 0 consumes nothing.
 */
export function chargeTokens(inputTokens: number, outputTokens: number, weight: number) {
  if (isFreeWeight(weight)) return 0
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1
  const raw = Math.max(0, inputTokens) + Math.max(0, outputTokens)
  if (raw <= 0) return 0
  return Math.max(1, Math.ceil(raw * w))
}

export function formatTokenCount(tokens: number) {
  const n = Math.max(0, Math.round(tokens))
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n % 1_000_000_000 === 0 ? 0 : 2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`
  return n.toLocaleString('en-US')
}

/** Full token amount with grouping, e.g. 207,970,000 */
export function formatFullTokenCount(tokens: number) {
  return Math.max(0, Math.round(tokens)).toLocaleString('en-US')
}

/** Round pool figures as 5B / 2M / 10K. Anything else stays a full grouped number. */
export function formatEventTokenLabel(tokens: number) {
  const n = Math.max(0, Math.round(tokens))
  if (n >= 1_000_000_000 && n % 1_000_000_000 === 0) return `${n / 1_000_000_000}B`
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}K`
  return n.toLocaleString('en-US')
}

/** Balance charge small enough that two decimals would print $0.00. */
export function formatUsdFromTokens(tokens: number) {
  const usd = usdFromTokens(tokens)
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  if (usd >= 0.01) return formatUsdExact(usd)
  const decimals = Math.min(8, Math.max(2, -Math.floor(Math.log10(usd)) + 1))
  return `$${usd.toFixed(decimals)}`
}

export function formatUsdExact(usd: number) {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  if (usd < 0.01) {
    const trimmed = usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
    return `$${trimmed}`
  }
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Exact wallet figure, e.g. $24.17 */
export function formatUsdBalance(tokens: number) {
  return formatUsdExact(usdFromTokens(tokens))
}

export function formatUsdApprox(tokens: number) {
  const usd = usdFromTokens(tokens)
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 1) {
    if (usd < 0.01) return formatUsdExact(usd)
    return `$${usd.toFixed(2)}`
  }
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString('en-US')}`
}

export function formatBalanceWithUsd(tokens: number) {
  return formatUsdBalance(tokens)
}
