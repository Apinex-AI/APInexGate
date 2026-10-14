import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chargeTokens,
  chargeUsdMicros,
  formatRetailPrice,
  isFreeWeight,
  tokensFromUsd,
  tokensFromUsdCents,
  TOKENS_PER_USD,
  usdFromTokens,
} from '../shared/billing.ts'
import { paymentStatusLabel, normalizePaymentUiStatus } from '../shared/paymentStatus.ts'

test('chargeTokens applies weight and never returns free for positive usage', () => {
  assert.equal(chargeTokens(0, 0, 1), 0)
  assert.equal(chargeTokens(100, 0, 1), 100)
  assert.equal(chargeTokens(100, 50, 2), 300)
  assert.equal(chargeTokens(1, 0, 0.4), 1)
})

test('weight 0 is a free allowance and paid charges use $/1M', () => {
  assert.equal(isFreeWeight(0), true)
  assert.equal(isFreeWeight(0.4), false)
  assert.equal(chargeTokens(100, 50, 0), 0)
  assert.equal(formatRetailPrice(0), 'free')
  assert.equal(chargeTokens(10, 0, -1), 10)
  assert.equal(chargeUsdMicros(1_000_000, 0, 2), 2_000_000)
  assert.equal(chargeUsdMicros(500, 500, 0.5), 500)
  assert.equal(chargeUsdMicros(1, 0, 0), 0)
})

test('paid charges split input and output prices', () => {
  // 1M input at $0.40 + 1M output at $2.00 = $2.40
  assert.equal(chargeUsdMicros(1_000_000, 1_000_000, 0.4, 2), 2_400_000)
  // output-only when input price is unused
  assert.equal(chargeUsdMicros(0, 500_000, 0.4, 2), 1_000_000)
  // omitted output price keeps the old shared rate
  assert.equal(chargeUsdMicros(1_000_000, 1_000_000, 0.5), 1_000_000)
  assert.equal(chargeUsdMicros(0, 1_000_000, 1, 0), 0)
})

test('usd ledger is one dollar per dollar', () => {
  assert.equal(TOKENS_PER_USD, 1_000_000)
  assert.equal(tokensFromUsd(1), 1_000_000)
  assert.equal(tokensFromUsdCents(100), 1_000_000)
  assert.equal(usdFromTokens(1_000_000), 1)
  assert.equal(usdFromTokens(250_000), 0.25)
})

test('payment status labels are human-readable', () => {
  assert.equal(normalizePaymentUiStatus('waiting'), 'pending')
  assert.equal(normalizePaymentUiStatus('confirming'), 'confirming')
  assert.equal(normalizePaymentUiStatus('finished'), 'credited')
  assert.equal(paymentStatusLabel('waiting'), 'Pending payment')
  assert.equal(paymentStatusLabel('confirming'), 'Waiting blockchain confirmations')
  assert.equal(paymentStatusLabel('finished'), 'Credited')
  assert.equal(paymentStatusLabel('expired'), 'Expired')
  assert.equal(paymentStatusLabel('failed'), 'Failed')
})

test('USD wallet formatters show dollars only', async () => {
  const { formatUsdBalance, formatUsdExact, formatBalanceWithUsd } = await import('../shared/billing.ts')
  assert.equal(formatUsdBalance(1_000_000), '$1.00')
  assert.equal(formatUsdBalance(24_170_000), '$24.17')
  assert.equal(formatUsdBalance(0), '$0.00')
  assert.equal(formatBalanceWithUsd(500_000), '$0.50')
  assert.equal(formatUsdExact(1.05), '$1.05')
  assert.equal(formatUsdExact(0.005), '$0.005')
})

test('pass top-up bonus converts to exact USD credit', async () => {
  const { tokensFromUsd } = await import('../shared/billing.ts')
  // $1 top-up with a +5% pass -> $1.05 credit (5% of the base token amount)
  const base = tokensFromUsd(1)
  const bonusTokens = Math.round((base * 5) / 100)
  const totalTokens = base + bonusTokens
  const { usdFromTokens } = await import('../shared/billing.ts')
  assert.equal(usdFromTokens(totalTokens), 1.05)
})
