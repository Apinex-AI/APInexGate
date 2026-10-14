import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getGatewayFairnessSettings,
  setGatewayFairnessSettings,
  DEFAULT_FAIRNESS,
} from '../server/gatewayFairness.ts'

test('fairness settings: defaults when nothing is stored', () => {
  const settings = getGatewayFairnessSettings()
  assert.equal(settings.rpmFree, DEFAULT_FAIRNESS.rpmFree)
  assert.equal(settings.rpmSubscription, DEFAULT_FAIRNESS.rpmSubscription)
  assert.equal(settings.subscriberPriority, DEFAULT_FAIRNESS.subscriberPriority)
})

test('fairness settings: values round-trip and clamping holds', () => {
  const updated = setGatewayFairnessSettings({ rpmFree: 12, rpmSubscription: 40, subscriberPriority: false })
  assert.deepEqual(updated, { rpmFree: 12, rpmSubscription: 40, subscriberPriority: false })
  assert.deepEqual(getGatewayFairnessSettings(), { rpmFree: 12, rpmSubscription: 40, subscriberPriority: false })

  // Out-of-range values clamp instead of corrupting the setting.
  setGatewayFairnessSettings({ rpmFree: 0, rpmSubscription: 999_999 })
  const clamped = getGatewayFairnessSettings()
  assert.ok(clamped.rpmFree >= 1, 'rpmFree clamped to minimum')
  assert.ok(clamped.rpmSubscription <= 600, 'rpmSubscription clamped to maximum')

  // Subscription RPM can never drop below free RPM.
  setGatewayFairnessSettings({ rpmFree: 50, rpmSubscription: 10 })
  const floor = getGatewayFairnessSettings()
  assert.ok(floor.rpmSubscription >= floor.rpmFree, 'subscription rpm floored to free rpm')

  // Restore defaults for other tests/deploy.
  setGatewayFairnessSettings({
    rpmFree: DEFAULT_FAIRNESS.rpmFree,
    rpmSubscription: DEFAULT_FAIRNESS.rpmSubscription,
    subscriberPriority: DEFAULT_FAIRNESS.subscriberPriority,
  })
})

test('gateway RPM honors fairness settings (unit)', async () => {
  // The RPM logic lives in enforceGatewayRateLimit (not exported). The e2e test
  // fairness.e2e.test.ts covers the wired behavior against a live dev server;
  // here we verify the settings module the gateway reads from reacts correctly.
  setGatewayFairnessSettings({ rpmFree: 3 })
  assert.equal(getGatewayFairnessSettings().rpmFree, 3)
  setGatewayFairnessSettings({ rpmFree: DEFAULT_FAIRNESS.rpmFree })
})
