import assert from 'node:assert/strict'
import test from 'node:test'
import { formatRawAmount, usdToRawAmount } from '../server/solanaPrices.js'

test('usdToRawAmount rounds up so user never underpays package', () => {
  // $5 at $100/SOL → 0.05 SOL = 50_000_000 lamports
  const raw = usdToRawAmount(5, 100, 9)
  assert.equal(raw, 50_000_000n)
  assert.equal(formatRawAmount(raw, 9, 6), '0.05')

  // Uneven division must ceil
  const raw2 = usdToRawAmount(1, 3, 9) // 1/3 SOL
  const exact = Number(raw2) / 1e9
  assert.ok(exact * 3 >= 1 - 1e-12)
  assert.ok(raw2 > 333_333_333n) // ceil above floor
})

test('token 6 decimals quote', () => {
  const raw = usdToRawAmount(5, 0.01, 6)
  assert.equal(raw, 500_000_000n)
  assert.equal(formatRawAmount(raw, 6, 4), '500')
})
