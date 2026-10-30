import { Link } from 'react-router-dom'
import { formatUsdExact, tokensFromUsd, usdFromTokens } from '../../shared/billing'

export type ShopPayMethod = 'crypto' | 'balance'

function canCoverWithBalance(balanceTokens: number, amountUsd: number) {
  const need = tokensFromUsd(amountUsd)
  return need > 0 && Math.floor(Number(balanceTokens) || 0) >= need
}

export function CheckoutPayMethods({
  method,
  onChange,
  amountUsd,
  balanceTokens,
  disabled,
  showCryptoHint = true,
}: {
  method: ShopPayMethod
  onChange: (method: ShopPayMethod) => void
  amountUsd: number
  balanceTokens: number
  disabled?: boolean
  /** Subscriptions hides the crypto line — its page copy already explains it. */
  showCryptoHint?: boolean
}) {
  const enough = canCoverWithBalance(balanceTokens, amountUsd)
  const walletUsd = usdFromTokens(balanceTokens)

  return (
    <>
      <div className="checkout-asset-switch checkout-pay-switch" role="group" aria-label="Pay with">
        <button
          type="button"
          className={method === 'crypto' ? 'is-active' : ''}
          disabled={true}
          title="Crypto payments are currently disabled"
          style={{ opacity: 0.5, cursor: 'not-allowed' }}
        >
          Crypto
        </button>
        <button
          type="button"
          className={`${method === 'balance' ? 'is-active' : ''} ${enough ? '' : 'is-locked'}`}
          disabled={disabled}
          onClick={() => onChange('balance')}
        >
          Balance
        </button>
      </div>
      {method === 'balance' ? (
        enough ? (
          <p className="checkout-balance-hint">
            Pay {formatUsdExact(amountUsd)} from your {formatUsdExact(walletUsd)} balance. Instant — no crypto
            transaction.
          </p>
        ) : (
          <p className="checkout-balance-hint">
            Not enough funds.{' '}
            <Link to="/billing" className="checkout-topup-link">
              Top up
            </Link>{' '}
            to unlock this payment method.
          </p>
        )
      ) : showCryptoHint ? (
        <p className="checkout-balance-hint">Pay with crypto. Unlocks automatically after confirmation.</p>
      ) : null}
    </>
  )
}
