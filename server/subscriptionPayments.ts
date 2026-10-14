import { db, id, nowIso } from './db.js'
import { claimPaymentSignatureOrThrow } from './paymentSignatures.js'
import { activateSubscription, getSubscriptionPlan } from './subscriptions.js'
import { applyOfferCents, getActiveSubscriptionOffer } from './subscriptionOffers.js'
import { tryGrantReferralReward } from './referrals.js'
import { levelSourceRef, recordLevelSpend } from './accountLevels.js'
import { type SubscriptionPlanKey } from '../shared/subscriptions.js'

type ExtraTokenPaymentRow = {
  id: string
  user_id: string
  plan_key: string
  amount_cents: number
  asset: string
  status: string
  order_id: string
  payment_id: string | null
  payer_wallet: string | null
  expected_raw_amount: string | null
  token_mint: string | null
  price_usd: number | null
  treasury: string | null
  pay_amount: string | null
  credited_at: string | null
  subscription_id: string | null
  raw_status: string | null
  provider: string | null
  plan_days: number | null
  plan_kind: string | null
  plan_token_limit: number | null
  invoice_url: string | null
  created_at: string
  updated_at: string
}

export function subscriptionPayMethods(): string[] {
  return []
}

export function subscriptionSolanaPayConfigured() {
  return false
}


function getPayment(paymentId: string): ExtraTokenPaymentRow | undefined {
  return db.prepare(`SELECT * FROM subscription_payments WHERE id = ?`).get(paymentId) as
    | ExtraTokenPaymentRow
    | undefined
}

function getPaymentByOrder(orderId: string): ExtraTokenPaymentRow | undefined {
  return db.prepare(`SELECT * FROM subscription_payments WHERE order_id = ?`).get(orderId) as
    | ExtraTokenPaymentRow
    | undefined
}

function resolvePlan(planKey: SubscriptionPlanKey, userId?: string, _customTokens?: number) {
  if (planKey === 'custom') throw new Error('Choose a subscription plan')
  const plan = getSubscriptionPlan(planKey)
  if (!plan) throw new Error('Unknown subscription plan')
  if (!plan.enabled) throw new Error('This plan is unavailable')
  const listCents = Math.max(0, Math.round(plan.priceCents))
  const offer = userId ? getActiveSubscriptionOffer(userId) : null
  const amountCents = applyOfferCents(listCents, offer)
  if (amountCents < 1) throw new Error('Invalid plan price')
  return { plan, amountCents, amountUsd: Number((amountCents / 100).toFixed(2)), listCents, offer }
}

export async function quoteSubscription(input: {
  planKey: SubscriptionPlanKey
  asset?: string
  userId?: string
  tokens?: number
}) {
  const { plan, amountCents, amountUsd } = resolvePlan(input.planKey, input.userId, input.tokens)

  const base = {
    planKey: plan.key,
    planLabel: plan.label,
    days: plan.days,
    kind: plan.kind,
    tokenLimit: plan.kind === 'unlimited' ? null : plan.tokenLimit,
    amountCents,
    amountUsd,
  }

  throw new Error('Crypto payments are currently disabled')
}

export function creditSubscriptionPayment(
  payment: ExtraTokenPaymentRow,
  externalRef: string,
  options: { claimSignature?: boolean } = {},
) {
  return db.transaction(() => {
    const fresh = getPayment(payment.id)
    if (!fresh) throw new Error('Payment missing')
    if (fresh.credited_at) {
      return {
        already: true as const,
        userId: fresh.user_id,
        amountCents: fresh.amount_cents,
        paymentId: fresh.id,
        orderId: fresh.order_id,
        provider: fresh.provider,
        asset: fresh.asset,
        payAmount: fresh.pay_amount,
        treasury: fresh.treasury,
        buyer: fresh.payer_wallet,
        subscriptionId: fresh.subscription_id,
        planKey: fresh.plan_key as SubscriptionPlanKey,
        extended: false,
        planLabel: '',
        kind: 'custom' as const,
        tokenLimit: 0,
        expiresAt: '',
      }
    }

    if (options.claimSignature) {
      claimPaymentSignatureOrThrow({
        signature: externalRef,
        flow: 'subscription',
        paymentId: fresh.id,
        userId: fresh.user_id,
      })
    }

    const activated = activateSubscription({
      userId: fresh.user_id,
      planKey: fresh.plan_key,
      source: 'purchase',
      sourceRef: `pay:${fresh.id}`,
      priceCents: fresh.amount_cents,
      grantedDays: fresh.plan_days,
      grantedKind: fresh.plan_kind,
      grantedTokenLimit: fresh.plan_token_limit,
    })

    const when = nowIso()
    db.prepare(
      `UPDATE subscription_payments
       SET status = 'finished', credited_at = ?, subscription_id = ?,
           payment_id = COALESCE(payment_id, ?), raw_status = 'finished', updated_at = ?
       WHERE id = ? AND credited_at IS NULL`,
    ).run(when, activated.subscription.id, externalRef, when, fresh.id)

    try {
      db.prepare(
        `UPDATE extra_token_payments
         SET status = 'finished', credited_at = ?, payment_id = COALESCE(payment_id, ?),
             raw_status = 'finished', updated_at = ?
         WHERE id = ? AND credited_at IS NULL`,
      ).run(when, externalRef, when, fresh.id)
    } catch {}

    return {
      already: false as const,
      userId: fresh.user_id,
      amountCents: fresh.amount_cents,
      paymentId: fresh.id,
      orderId: fresh.order_id,
      provider: fresh.provider,
      asset: fresh.asset,
      payAmount: fresh.pay_amount,
      treasury: fresh.treasury,
      buyer: fresh.payer_wallet,
      subscriptionId: activated.subscription.id,
      planKey: activated.subscription.planKey as SubscriptionPlanKey,
      extended: activated.extended,
      planLabel: activated.subscription.planLabel,
      kind: activated.subscription.kind,
      tokenLimit: activated.subscription.tokenLimit,
      expiresAt: '',
    }
  })()
}

function afterCredit(result: ReturnType<typeof creditSubscriptionPayment>) {
  if (result.already) return

  const user = db
    .prepare(`SELECT email, solana_wallet FROM users WHERE id = ?`)
    .get(result.userId) as
    | { email: string | null; solana_wallet: string | null }
    | undefined

  
  try {
    tryGrantReferralReward({
      userId: result.userId,
      paymentId: result.paymentId ?? result.orderId ?? result.subscriptionId ?? '',
      amountCents: result.amountCents,
    })
  } catch (error) {
    console.error('[referral] grant on token purchase credit failed', error)
  }
  try {
    recordLevelSpend({
      userId: result.userId,
      amountCents: result.amountCents,
      sourceRef: levelSourceRef('tokens', result.paymentId || result.orderId),
    })
  } catch (error) {
    console.error('[levels] extra token purchase credit failed', error)
  }
}

export async function createSubscriptionCryptoPurchase(_input: {
  userId: string
  planKey: SubscriptionPlanKey
  successUrl?: string
  cancelUrl?: string
  tokens?: number
}) {
  throw new Error('Crypto payments are currently disabled')
}

export function creditSubscriptionCryptoOrder(orderId: string, npPaymentId?: string | null) {
  const payment = getPaymentByOrder(orderId)
  if (!payment) return null
  if (payment.credited_at) {
    return {
      ok: true as const,
      already: true as const,
      subscriptionId: payment.subscription_id,
      userId: payment.user_id,
      planKey: payment.plan_key,
      planLabel: '',
    }
  }

  const credited = creditSubscriptionPayment(payment, npPaymentId || payment.order_id, {
    claimSignature: true,
  })
  afterCredit(credited)
  return {
    ok: true as const,
    already: false as const,
    subscriptionId: credited.subscriptionId,
    userId: credited.userId,
    planKey: credited.planKey,
    planLabel: credited.planLabel,
  }
}

export async function submitSubscriptionPurchase(_input: {
  paymentId: string
  signedTransaction?: string
  signature?: string
}) {
  throw new Error('Direct blockchain submission is disabled')
}

export async function verifyAndCreditSubscriptionPayment(paymentId: string) {
  const payment = getPayment(paymentId)
  if (!payment) return { credited: false as const, error: 'Payment not found' }
  if (payment.credited_at) {
    return {
      credited: true as const,
      already: true as const,
      signature: payment.payment_id,
      subscriptionId: payment.subscription_id,
    }
  }
  if (payment.provider === 'crypto') {
    return {
      credited: false as const,
      confirming: true as const,
      provider: 'crypto' as const,
      invoiceUrl: payment.invoice_url,
      status: payment.status,
    }
  }
  return { credited: false as const, error: 'Payment not found' }
}

export function getSubscriptionPaymentPublic(paymentId: string, userId: string) {
  const payment = getPayment(paymentId)
  if (!payment || payment.user_id !== userId) return null
  return {
    id: payment.id,
    orderId: payment.order_id,
    planKey: payment.plan_key,
    amountCents: payment.amount_cents,
    asset: payment.asset,
    status: payment.status,
    credited: Boolean(payment.credited_at),
    provider: payment.provider,
    invoiceUrl: payment.invoice_url,
    createdAt: payment.created_at,
  }
}
