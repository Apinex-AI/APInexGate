type CachedPrice = { usd: number; fetchedAt: number; source: string }

const CACHE_MS = 30_000
const cache = new Map<string, CachedPrice>()

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    throw new Error(`Price fetch failed (${response.status}) for ${url}`)
  }
  return response.json()
}

export async function getSolUsdPrice(): Promise<CachedPrice> {
  const hit = cache.get('SOL')
  if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return hit

  try {
    const data = (await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT')) as {
      price?: string
    }
    const usd = Number(data.price)
    if (!Number.isFinite(usd) || usd <= 0) throw new Error('Invalid SOL price')
    const row = { usd, fetchedAt: Date.now(), source: 'binance' }
    cache.set('SOL', row)
    return row
  } catch (primary) {
    // CoinGecko fallback
    try {
      const data = (await fetchJson(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      )) as { solana?: { usd?: number } }
      const usd = Number(data.solana?.usd)
      if (!Number.isFinite(usd) || usd <= 0) throw primary
      const row = { usd, fetchedAt: Date.now(), source: 'coingecko' }
      cache.set('SOL', row)
      return row
    } catch {
      if (hit) return hit
      throw primary instanceof Error ? primary : new Error('Could not fetch SOL price')
    }
  }
}

/** Convert USD → raw token units (integer). Rounds UP so user never underpays for the USD package. */
export function usdToRawAmount(usd: number, priceUsd: number, decimals: number): bigint {
  if (!(usd > 0) || !(priceUsd > 0)) throw new Error('Invalid amount or price')
  const scale = 10n ** BigInt(decimals)
  // amount_tokens = ceil(usd / price * 10^decimals)
  // use high-precision via integer math: ceil(usd * 1e8 / price * scale / 1e8)
  const usdMicros = BigInt(Math.ceil(usd * 1_000_000)) // 1e-6 USD
  const priceMicros = BigInt(Math.max(1, Math.round(priceUsd * 1_000_000)))
  // raw = ceil(usdMicros * scale / priceMicros)
  const numer = usdMicros * scale
  const raw = (numer + priceMicros - 1n) / priceMicros
  if (raw <= 0n) throw new Error('Computed pay amount is too small')
  return raw
}

export function formatRawAmount(raw: bigint, decimals: number, maxFrac = 6): string {
  const neg = raw < 0n
  const v = neg ? -raw : raw
  const scale = 10n ** BigInt(decimals)
  const whole = v / scale
  let frac = (v % scale).toString().padStart(decimals, '0')
  if (maxFrac < decimals) frac = frac.slice(0, maxFrac)
  frac = frac.replace(/0+$/, '')
  const body = frac ? `${whole.toString()}.${frac}` : whole.toString()
  return neg ? `-${body}` : body
}
