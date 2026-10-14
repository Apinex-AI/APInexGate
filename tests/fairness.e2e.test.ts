import assert from 'node:assert/strict'
import test from 'node:test'

const BASE = process.env.DEV_BASE ?? 'http://localhost:8788'

// E2E tests need a live dev server and env credentials; skipped in local unit runs.
const E2E_READY = Boolean(process.env.ADMIN_PASSWORD) && Boolean(process.env.E2E)
const e2e = E2E_READY ? test : test.skip

type LoginResult = { token?: string; cookie: string }

/**
 * Admin login is rate-limited to a few attempts per minute per IP, so the
 * session cookie is cached on disk and reused across test runs. A fresh login
 * happens only when there is no cached cookie or the server rejects it (401).
 */
const COOKIE_CACHE = '/tmp/admin_session_cookie'

async function loginFresh(password: string, adminBase: string): Promise<string> {
  const response = await fetch(`${adminBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!response.ok) {
    throw new Error(`admin login failed: ${response.status} (wait ~60s if rate-limited)`)
  }
  const setCookie = response.headers.get('set-cookie') ?? ''
  assert.ok(setCookie.includes('admin_session'), 'admin session cookie missing')
  const cookie = setCookie.split(';')[0]
  try {
    const fs = await import('node:fs')
    fs.writeFileSync(COOKIE_CACHE, cookie)
  } catch {
    // Cache is best-effort; tests still work without it.
  }
  return cookie
}

async function adminLogin(): Promise<LoginResult> {
  const password = process.env.ADMIN_PASSWORD
  if (!password) throw new Error('ADMIN_PASSWORD is required for fairness e2e tests')
  const adminBase = (process.env.DEV_ADMIN_BASE ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
  try {
    const fs = await import('node:fs')
    if (fs.existsSync(COOKIE_CACHE)) {
      const cookie = fs.readFileSync(COOKIE_CACHE, 'utf8').trim()
      if (cookie) {
        const probe = await fetch(`${adminBase}/api/admin/settings`, { headers: { cookie } })
        if (probe.ok) return { cookie }
      }
    }
  } catch {
    // Fall through to a fresh login.
  }
  const cookie = await loginFresh(password, adminBase)
  return { cookie }
}

async function adminGet(cookie: string, path: string) {
  const adminBase = (process.env.DEV_ADMIN_BASE ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
  const response = await fetch(`${adminBase}${path}`, { headers: { cookie } })
  assert.equal(response.status, 200, `GET ${path} failed`)
  return response.json()
}

async function adminPatch(cookie: string, path: string, body: unknown, expectedStatus = 200) {
  const adminBase = (process.env.DEV_ADMIN_BASE ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
  const response = await fetch(`${adminBase}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, expectedStatus, `PATCH ${path} -> ${response.status}`)
  return response.json()
}

e2e('fairness settings round-trip and queue endpoint', async () => {
  const { cookie } = await adminLogin()

  const settings = await adminGet(cookie, '/api/admin/settings')
  assert.ok(settings.fairness, 'fairness section missing from /api/admin/settings')
  assert.equal(typeof settings.fairness.rpmFree, 'number')
  assert.equal(typeof settings.fairness.rpmSubscription, 'number')
  assert.equal(typeof settings.fairness.subscriberPriority, 'boolean')

  const queue = await adminGet(cookie, '/api/admin/fairness/queue')
  assert.equal(typeof queue.active, 'number')
  assert.equal(typeof queue.maxConcurrent, 'number')
  assert.equal(typeof queue.waiting, 'number')
  assert.equal(typeof queue.waitingPriority, 'number')
  assert.ok(queue.active <= queue.maxConcurrent, 'active slots must not exceed capacity')

  const updated = await adminPatch(cookie, '/api/admin/settings/fairness', {
    rpmFree: 5,
    rpmSubscription: 30,
    subscriberPriority: true,
  })
  assert.equal(updated.ok, true)
  assert.equal(updated.settings.rpmFree, 8)
  assert.equal(updated.settings.rpmSubscription, 30)
  assert.equal(updated.settings.subscriberPriority, true)
  assert.ok(updated.queue, 'queue stats returned on save')

  // Validation: out-of-range RPM rejected
  await adminPatch(cookie, '/api/admin/settings/fairness', { rpmFree: 0 }, 400)
  await adminPatch(cookie, '/api/admin/settings/fairness', { rpmFree: 601 }, 400)
  // Empty patch rejected
  await adminPatch(cookie, '/api/admin/settings/fairness', {}, 400)

  // Restore defaults
  await adminPatch(cookie, '/api/admin/settings/fairness', {
    rpmFree: 5,
    rpmSubscription: 30,
    subscriberPriority: true,
  })
})

e2e('gateway RPM applies to free users and is enforced per IP', async () => {
  const { cookie } = await adminLogin()
  // Temporarily drop free RPM to 3 so the limit is reachable quickly.
  await adminPatch(cookie, '/api/admin/settings/fairness', { rpmFree: 3 })

  const key = process.env.DEV_SMOKE_KEY
  if (!key) throw new Error('DEV_SMOKE_KEY is required (free-tier API key on dev)')

  const statuses: number[] = []
  for (let i = 0; i < 6; i += 1) {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'free/glm-5.3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    })
    statuses.push(response.status)
    await response.text().catch(() => '')
  }
  // First requests should pass (or fail with upstream errors 5xx/402 — not 429),
  // the rest must be 429 once the 3/min budget is spent.
  const firstThree = statuses.slice(0, 3)
  assert.ok(
    firstThree.every((status) => status !== 429),
    `first ${3} requests must not be rate-limited, got ${statuses}`,
  )
  assert.ok(
    statuses.slice(3).some((status) => status === 429),
    `expected at least one 429 after exceeding 3 rpm, got ${statuses}`,
  )

  await adminPatch(cookie, '/api/admin/settings/fairness', { rpmFree: 5 })
})
