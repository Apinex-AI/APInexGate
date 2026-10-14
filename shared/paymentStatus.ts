/** Human-readable crypto payment statuses for customer UI. */

export type PaymentUiStatus =
  | 'pending'
  | 'confirming'
  | 'credited'
  | 'expired'
  | 'failed'
  | 'unknown'

export function normalizePaymentUiStatus(raw: string | null | undefined): PaymentUiStatus {
  const s = String(raw ?? '').toLowerCase().trim()
  if (!s) return 'unknown'
  if (s === 'finished' || s === 'confirmed' || s === 'credited') return 'credited'
  if (s === 'confirming' || s === 'sending' || s === 'partially_paid') return 'confirming'
  if (s === 'waiting' || s === 'created' || s === 'pending') return 'pending'
  if (s === 'expired') return 'expired'
  if (s === 'failed' || s === 'refunded' || s === 'cancelled' || s === 'canceled' || s === 'rejected') {
    return 'failed'
  }
  return 'unknown'
}

export function paymentStatusLabel(raw: string | null | undefined): string {
  switch (normalizePaymentUiStatus(raw)) {
    case 'pending':
      return 'Pending payment'
    case 'confirming':
      return 'Waiting blockchain confirmations'
    case 'credited':
      return 'Credited'
    case 'expired':
      return 'Expired'
    case 'failed':
      return 'Failed'
    default:
      return 'Processing'
  }
}

export function isOpenPaymentStatus(raw: string | null | undefined): boolean {
  const ui = normalizePaymentUiStatus(raw)
  return ui === 'pending' || ui === 'confirming'
}
