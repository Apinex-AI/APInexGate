/** Base58 Solana address: 32–44 chars typical. */
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function isSolanaAddress(value: string | null | undefined): value is string {
  const v = String(value ?? '').trim()
  return SOLANA_ADDRESS_RE.test(v)
}

/** first6…last6 — UI label for wallet accounts (email field substitute). */
export function maskWalletAddress(address: string, head = 6, tail = 6) {
  const a = address.trim()
  if (a.length <= head + tail + 1) return a
  return `${a.slice(0, head)}…${a.slice(-tail)}`
}

export function shortenWalletName(address: string) {
  return maskWalletAddress(address, 4, 4)
}

/** Detect wallet-backed accounts stored with the address as email or solana_wallet set. */
export function isWalletAccountEmail(email: string | null | undefined) {
  return isSolanaAddress(email)
}
