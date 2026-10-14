import { getSetting, setSetting } from './db.js'

/**
 * Admin-configurable gateway fairness settings, stored in app_settings so they
 * apply immediately without a restart. Two knobs:
 *  - rpmFree / rpmSubscription: per-account request rate limit (60s window).
 *    An active subscription upgrades that account's limit to rpmSubscription.
 *    Extra API keys and egress IPs do not raise it.
 *  - subscriberPriority: when true, requests from users with an active
 *    subscription skip the fairness queue ahead of free users. Requests already
 *    dispatched upstream are never interrupted; priority applies only while
 *    waiting for a dispatch slot.
 */

export type GatewayFairnessSettings = {
  /** Legacy alias of the free RPM plan. Kept so existing callers keep compiling. */
  rpmFree: number
  /** Legacy alias of the first paid RPM plan. Account RPM now comes from rpmPlans. */
  rpmSubscription: number
  subscriberPriority: boolean
}

export const DEFAULT_FAIRNESS: GatewayFairnessSettings = {
  rpmFree: 5,
  rpmSubscription: 30,
  subscriberPriority: true,
}

const MIN_RPM = 1
const MAX_RPM = 600

function clampRpm(value: unknown, fallback: number) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_RPM, Math.max(MIN_RPM, n))
}

export function getGatewayFairnessSettings(): GatewayFairnessSettings {
  return {
    rpmFree: clampRpm(getSetting('gateway_rpm_free', String(DEFAULT_FAIRNESS.rpmFree)), DEFAULT_FAIRNESS.rpmFree),
    rpmSubscription: clampRpm(
      getSetting('gateway_rpm_subscription', String(DEFAULT_FAIRNESS.rpmSubscription)),
      DEFAULT_FAIRNESS.rpmSubscription,
    ),
    subscriberPriority: getSetting('gateway_subscriber_priority', '1') === '1',
  }
}

export function setGatewayFairnessSettings(input: Partial<GatewayFairnessSettings>): GatewayFairnessSettings {
  const current = getGatewayFairnessSettings()
  const next: GatewayFairnessSettings = {
    rpmFree: input.rpmFree !== undefined ? clampRpm(input.rpmFree, current.rpmFree) : current.rpmFree,
    rpmSubscription:
      input.rpmSubscription !== undefined
        ? clampRpm(input.rpmSubscription, current.rpmSubscription)
        : current.rpmSubscription,
    subscriberPriority:
      input.subscriberPriority !== undefined ? Boolean(input.subscriberPriority) : current.subscriberPriority,
  }
  // Subscription RPM must never be lower than the free tier limit.
  next.rpmSubscription = Math.max(next.rpmSubscription, next.rpmFree)
  setSetting('gateway_rpm_free', String(next.rpmFree))
  setSetting('gateway_rpm_subscription', String(next.rpmSubscription))
  setSetting('gateway_subscriber_priority', next.subscriberPriority ? '1' : '0')
  return next
}
