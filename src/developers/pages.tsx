import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Callout,
  CodeBlock,
  EndpointBadge,
  PageHeader,
  ParamTable,
  Section,
  type ParamRow,
} from './DevBlocks'
import { apiBase, apiOrigin, brandSlug, siteHost, siteName } from '../lib/brand'

const AUTH_HEADER = 'Authorization: Bearer sk-…'
const API_BASE = apiBase
const API_ORIGIN = apiOrigin
const SITE_HOST = siteHost

export function DevOverviewPage() {
  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="API reference"
        title="Ship against one endpoint"
        lead={`A single secret covers every chat model on ${siteName()}. These pages list the live HTTP surface: paths, fields, and the shapes you get back. IDE wiring lives in the dashboard setup flow.`}
      />

      <Section title="Where requests go">
        <CodeBlock title="API root" code={API_BASE()} language="text" />
        <p>
          Model calls share the <code className="ref-inline">/v1</code> prefix. There is no separate tools host and no wallet login.
        </p>
      </Section>

      <Section title="Where to start">
        <div className="ref-tiles">
          <Link className="ref-tile" to="/docs/models">
            <em>Models</em>
            <strong>Chat, Responses, Messages &amp; Decisions</strong>
            <span>Drop-in routes for OpenAI clients, Codex, Claude Code, and Jev Group Decision models.</span>
          </Link>
          <Link className="ref-tile" to="/docs/balance">
            <em>Wallet</em>
            <strong>GET /v1/balance</strong>
            <span>Spendable USD balance, in-flight holds, and API key spend limits.</span>
          </Link>
          <Link className="ref-tile" to="/docs/subscription">
            <em>Quota</em>
            <strong>GET /v1/subscription</strong>
            <span>Active subscription token pool or daily free-tier allowance for free/* models.</span>
          </Link>
          <Link className="ref-tile" to="/docs/rpm">
            <em>Throughput</em>
            <strong>GET /v1/rpm</strong>
            <span>Account requests-per-minute (RPM) limit, active tier, and rate-limit headers.</span>
          </Link>
        </div>
      </Section>

      <Section title="First call">
        <ol className="ref-steps">
          <li>
            Mint a key under <a href="/keys">API Keys</a>. It looks like <code className="ref-inline">sk-…</code>.
          </li>
          <li>Copy a model id from the catalog. Paid and zero-price ids use the same path.</li>
          <li>POST JSON. Successful replies carry usage so you can reconcile spend.</li>
          <li>Check wallet balance (<code className="ref-inline">/v1/balance</code>), subscription quota (<code className="ref-inline">/v1/subscription</code>), or RPM limit (<code className="ref-inline">/v1/rpm</code>) anytime.</li>
        </ol>
        <CodeBlock
          title="Chat Completions"
          code={`curl ${API_BASE()}/chat/completions \\
  -H "${AUTH_HEADER}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "free/glm-5.3-flash",
    "messages": [{"role": "user", "content": "Hello from ${siteName()}"}]
  }'`}
        />
        <CodeBlock
          title="Balance, Subscription & RPM"
          code={`curl ${API_ORIGIN()}/v1/balance -H "${AUTH_HEADER}"
curl ${API_ORIGIN()}/v1/subscription -H "${AUTH_HEADER}"
curl ${API_ORIGIN()}/v1/rpm -H "${AUTH_HEADER}"`}
        />
      </Section>

      <Section title="Three dedicated status endpoints">
        <p>
          Your prepaid USD wallet covers paid catalog models at their published input and output rate per million tokens (<code className="ref-inline">GET /v1/balance</code>).
          A separate subscription or daily free allowance covers zero-price (<code className="ref-inline">free/*</code>) models (<code className="ref-inline">GET /v1/subscription</code>).
          Your account's requests-per-minute throughput ceiling is reported on <code className="ref-inline">GET /v1/rpm</code>.
        </p>
      </Section>

      <Callout title="This site vs the setup wizard" tone="info">
        <p>
          <a href="/setup">Dashboard setup</a> fills Cursor, OpenCode, Hermes, Codex, and Claude with your real key.
          The pages under <strong>/docs</strong> and <strong>/developers</strong> are the HTTP contract those clients speak.
        </p>
      </Callout>
    </div>
  )
}

export function DevAuthPage() {
  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Start"
        title="Authentication"
        lead="Model routes accept only a dashboard API key. The secret starts with sk-. Email and Google sessions do not authorize /v1."
      />

      <Section title="Headers">
        <p>OpenAI clients should send Bearer. Anthropic clients can send the same secret in x-api-key.</p>
        <CodeBlock
          title="Bearer (recommended)"
          language="http"
          code={`Authorization: Bearer sk-your_key_here
Content-Type: application/json`}
        />
        <CodeBlock
          title="x-api-key (also supported)"
          language="http"
          code={`x-api-key: sk-your_key_here
Content-Type: application/json`}
        />
      </Section>

      <Section title="Where to get a key">
        <ol className="ref-steps">
          <li>
            Sign in at <a href="/login">{SITE_HOST()}/login</a>
          </li>
          <li>
            Open <a href="/keys">API Keys</a> and create a key
          </li>
          <li>Copy the full secret once — it is not shown again</li>
        </ol>
        <Callout title="Never expose keys in browsers" tone="warn">
          <p>
            Call {siteName()} from your backend, CLI, or IDE config. Do not ship secrets in client-side frontend bundles.
          </p>
        </Callout>
      </Section>

      <Section title="What the key can spend">
        <p>
          A paid model holds an estimate of its cost before the request leaves for the provider, then settles to actual usage.
          Two in-flight calls cannot draw the same dollars. Zero-price models skip the wallet and draw the subscription remainder instead.
          Read both from <Link to="/docs/balance">Balance</Link>.
        </p>
      </Section>
    </div>
  )
}

export function DevBalancePage() {
  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Start"
        title="Balance"
        lead="Retrieve your spendable prepaid USD wallet balance, active in-flight holds, and the calling API key's spend limits."
      />
      <EndpointBadge method="GET" path="/v1/balance" />

      <Section title="Request">
        <p>
          Authenticate with the same API key used for model calls, as <code className="ref-inline">Authorization: Bearer sk-…</code> or <code className="ref-inline">x-api-key</code>.
          For subscription/free-tier quotas use <Link to="/docs/subscription">GET /v1/subscription</Link>, and for rate limits use <Link to="/docs/rpm">GET /v1/rpm</Link>.
        </p>
        <CodeBlock
          title="Read the USD wallet"
          code={`curl ${API_ORIGIN()}/v1/balance \\
  -H "${AUTH_HEADER}"`}
        />
      </Section>

      <Section title="Response">
        <CodeBlock
          title="200 OK"
          language="json"
          code={`{
  "object": "balance",
  "balance_usd": 12.5,
  "reserved_usd": 0.001024,
  "api_key": {
    "id": "key_…",
    "spend_limit_usd": 5,
    "spent_usd": 0.84,
    "reserved_usd": 0.001024,
    "remaining_usd": 4.158976,
    "limit_reached": false
  }
}`}
        />
      </Section>

      <Section title="Holds">
        <p>
          A paid request estimates a ceiling from the prompt plus the requested output bound, then locks that amount before the provider is contacted.
          The lock is already absent from <code className="ref-inline">balance_usd</code>. <code className="ref-inline">reserved_usd</code> is only the held figure, shown so you can see why the wallet dipped.
        </p>
        <ol className="ref-steps">
          <li>If the wallet or the key cap cannot cover the lock, the call stops with <code className="ref-inline">402</code> and never reaches a provider.</li>
          <li>A successful reply charges real usage and returns the unused part of the lock.</li>
          <li>An upstream failure or a broken stream returns the whole lock.</li>
          <li>A lock that never settles expires after 15 minutes, so a crashed client cannot pin funds forever.</li>
        </ol>
        <Callout title="Do not subtract the hold twice" tone="info">
          <p>
            <code className="ref-inline">balance_usd</code> is what the next request can spend.
            <code className="ref-inline">reserved_usd</code> is already outside that number.
          </p>
        </Callout>
      </Section>

      <Section title="Fields">
        <ParamTable
          showRequirements={false}
          rows={[
            { name: 'balance_usd', type: 'number', description: 'Dollars the next paid request can spend. Open holds are already removed.' },
            { name: 'reserved_usd', type: 'number', description: 'Dollars locked by requests that have not settled yet. Unused amounts return on settle, failure, or after 15 minutes.' },
            { name: 'api_key.id', type: 'string', description: 'Id of the key that authenticated this read.' },
            { name: 'api_key.spend_limit_usd', type: 'number | null', description: 'Lifetime cap configured on this key, or null when the key is uncapped.' },
            { name: 'api_key.spent_usd', type: 'number', description: 'Dollars already settled against this key.' },
            { name: 'api_key.reserved_usd', type: 'number', description: 'Dollars currently locked by in-flight calls on this key.' },
            { name: 'api_key.remaining_usd', type: 'number | null', description: 'Room left under the cap after settled and locked amounts. Null when the key has no cap.' },
            { name: 'api_key.limit_reached', type: 'boolean', description: 'True when settled plus locked spend has used up the key cap.' },
          ]}
        />
      </Section>
    </div>
  )
}

export function DevSubscriptionPage() {
  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Start"
        title="Subscription"
        lead="Check the active subscription token pool or daily free-tier token allowance for zero-price (free/*) models."
      />
      <EndpointBadge method="GET" path="/v1/subscription" />

      <Section title="Request">
        <p>
          Authenticate with your API key via <code className="ref-inline">Authorization: Bearer sk-…</code> or <code className="ref-inline">x-api-key</code>.
          Zero-price models (<code className="ref-inline">free/*</code>) never touch your USD wallet — they draw from this quota instead.
        </p>
        <CodeBlock
          title="Read subscription & free quota"
          code={`curl ${API_ORIGIN()}/v1/subscription \\
  -H "${AUTH_HEADER}"`}
        />
      </Section>

      <Section title="Response (Active Subscription)">
        <CodeBlock
          title="200 OK"
          language="json"
          code={`{
  "object": "subscription",
  "mode": "subscription",
  "active": true,
  "plan": "30_days",
  "plan_label": "30 days",
  "unlimited": false,
  "token_limit": 500000000,
  "tokens_used": 1240000,
  "tokens_remaining": 498760000,
  "expires_at_utc": "2026-11-16T12:00:00.000Z",
  "resets_at_utc": null,
  "allowed": true
}`}
        />
      </Section>

      <Section title="Response (Daily Free Tier)">
        <CodeBlock
          title="200 OK"
          language="json"
          code={`{
  "object": "subscription",
  "mode": "free",
  "active": false,
  "plan": null,
  "plan_label": "FREE",
  "unlimited": false,
  "token_limit": 10000000,
  "tokens_used": 250000,
  "tokens_remaining": 9750000,
  "expires_at_utc": null,
  "resets_at_utc": "2026-10-18T00:00:00.000Z",
  "allowed": true
}`}
        />
      </Section>

      <Section title="Fields">
        <ParamTable
          showRequirements={false}
          rows={[
            { name: 'mode', type: '"subscription" | "free"', description: '"subscription" when a paid/promo subscription is active, or "free" when using the daily free allowance.' },
            { name: 'active', type: 'boolean', description: 'True when an active subscription is running; false when on the daily free tier.' },
            { name: 'plan', type: 'string | null', description: 'Normalized subscription plan key (e.g. "3_days", "10_days", "30_days"), or null on the daily free tier.' },
            { name: 'plan_label', type: 'string', description: 'Human-readable plan name (e.g. "30 days") or "FREE".' },
            { name: 'unlimited', type: 'boolean', description: 'True if the active subscription has no token cap.' },
            { name: 'token_limit', type: 'number | null', description: 'Total token allowance for the active subscription or daily free bucket (null when unlimited).' },
            { name: 'tokens_used', type: 'number', description: 'Tokens consumed so far in the current subscription period or UTC day.' },
            { name: 'tokens_remaining', type: 'number | null', description: 'Remaining tokens available for free/* models (null when unlimited).' },
            { name: 'expires_at_utc', type: 'string | null', description: 'ISO 8601 UTC timestamp when the active subscription ends, or null on the daily free tier.' },
            { name: 'resets_at_utc', type: 'string | null', description: 'Next 00:00 UTC reset timestamp for the daily free bucket, or null while a subscription is active.' },
            { name: 'allowed', type: 'boolean', description: 'Whether another free/* model request is permitted right now.' },
          ]}
        />
      </Section>
    </div>
  )
}

type PublicRpmPlan = {
  key: 'free' | 'standard' | 'high' | 'custom'
  rpm: number
  priceCents: number
  priceUsd: number
  enabled: boolean
  custom: boolean
  label: string
}

type PublicRateLimits = {
  plans?: PublicRpmPlan[]
  supportUrl?: string
  rpmFree: number
  rpmSubscription: number
  subscriberPriority: boolean
}

const DEFAULT_RPM_PLANS: PublicRpmPlan[] = [
  { key: 'free', rpm: 5, priceCents: 0, priceUsd: 0, enabled: true, custom: false, label: '5 RPM' },
  { key: 'standard', rpm: 30, priceCents: 1000, priceUsd: 10, enabled: true, custom: false, label: '30 RPM' },
  { key: 'high', rpm: 60, priceCents: 2000, priceUsd: 20, enabled: true, custom: false, label: '60 RPM' },
  { key: 'custom', rpm: 0, priceCents: 0, priceUsd: 0, enabled: true, custom: true, label: 'Custom' },
]

const DEFAULT_RATE_LIMITS: PublicRateLimits = {
  plans: DEFAULT_RPM_PLANS,
  supportUrl: '',
  rpmFree: 5,
  rpmSubscription: 30,
  subscriberPriority: true,
}

function money(cents: number) {
  const dollars = cents / 100
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
}

export function DevRpmPage() {
  const [limits, setLimits] = useState<PublicRateLimits>(DEFAULT_RATE_LIMITS)

  useEffect(() => {
    let cancelled = false
    fetch('/api/public/rate-limits')
      .then(async (res) => {
        if (!res.ok) return
        const data = (await res.json()) as Partial<PublicRateLimits>
        if (!cancelled && Array.isArray(data.plans) && data.plans.length > 0) {
          setLimits({
            plans: data.plans,
            supportUrl: data.supportUrl || '',
            rpmFree: data.plans.find((plan) => plan.key === 'free')?.rpm ?? data.rpmFree ?? 5,
            rpmSubscription: data.plans.find((plan) => plan.key === 'standard')?.rpm ?? data.rpmSubscription ?? 30,
            subscriberPriority: Boolean(data.subscriberPriority),
          })
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const rpmPlans = limits.plans?.length ? limits.plans : DEFAULT_RPM_PLANS
  const supportUrl = limits.supportUrl || ''

  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Start"
        title="RPM (Rate Limits)"
        lead="Inspect your account's active requests-per-minute (RPM) limit, plan tier, and response rate-limit headers."
      />
      <EndpointBadge method="GET" path="/v1/rpm" />

      <Section title="Request">
        <p>
          Authenticate with your API key via <code className="ref-inline">Authorization: Bearer sk-…</code> or <code className="ref-inline">x-api-key</code>.
        </p>
        <CodeBlock
          title="Read account RPM"
          code={`curl ${API_ORIGIN()}/v1/rpm \\
  -H "${AUTH_HEADER}"`}
        />
      </Section>

      <Section title="Response">
        <CodeBlock
          title="200 OK"
          language="json"
          code={`{
  "object": "rpm",
  "rpm": 30,
  "plan": "standard",
  "label": "30 RPM",
  "source": "plan",
  "expires_at_utc": "2026-11-16T12:00:00.000Z"
}`}
        />
        <ParamTable
          showRequirements={false}
          rows={[
            { name: 'rpm', type: 'number', description: 'Active requests-per-minute ceiling for this account across all models.' },
            { name: 'plan', type: '"free" | "standard" | "high" | "custom"', description: 'Active RPM plan key on the account.' },
            { name: 'label', type: 'string', description: 'Human-readable RPM tier label (e.g. "5 RPM", "30 RPM", "Custom · 120 RPM").' },
            { name: 'source', type: '"free" | "plan" | "grant"', description: 'Where the active RPM limit comes from: default free tier, purchased plan, or admin grant.' },
            { name: 'expires_at_utc', type: 'string | null', description: 'ISO 8601 UTC timestamp when the RPM plan or grant expires, or null on the default free tier.' },
          ]}
        />
      </Section>

      <Section title="Available RPM plans">
        <p>
          Chat, responses, messages, and decisions share one rolling 60-second budget per account. Extra keys do not multiply it.
        </p>

        <div className="ref-table-wrap">
          <table className="ref-table">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Ceiling</th>
                <th>Price</th>
                <th>How to get it</th>
              </tr>
            </thead>
            <tbody>
              {rpmPlans.map((plan) => (
                <tr key={plan.key}>
                  <td>
                    <strong>{plan.custom ? 'Custom' : plan.label}</strong>
                  </td>
                  <td>
                    <strong className="ref-figure">{plan.custom ? 'Agreed' : `${plan.rpm} RPM`}</strong> per account
                  </td>
                  <td>{plan.custom ? 'Quoted in support' : plan.priceCents <= 0 ? 'Free' : money(plan.priceCents)}</td>
                  <td>
                    {plan.custom ? (
                      supportUrl ? <a href={supportUrl}>Write support</a> : 'Write support'
                    ) : plan.priceCents <= 0 ? (
                      'Included on every account'
                    ) : (
                      <Link to="/rpm">Upgrade on the RPM page</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>Rate-limit headers</h3>
        <p>Every gateway response includes these headers, and <code className="ref-inline">429</code> responses add <code className="ref-inline">Retry-After</code>:</p>
        <ul>
          <li>
            <code>X-RateLimit-Limit</code> — the ceiling that applied (your account plan).
          </li>
          <li>
            <code>X-RateLimit-Remaining</code> — calls left in the current window.
          </li>
          <li>
            <code>X-RateLimit-Reset</code> — unix seconds when the window rolls.
          </li>
          <li>
            <code>Retry-After</code> — seconds to wait before the next attempt, present on 429.
          </li>
        </ul>
      </Section>
    </div>
  )
}

export function DevErrorsPage() {
  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Start"
        title="Errors"
        lead="Failures keep the envelope of the route family you called: OpenAI-shaped on chat, responses, and decisions, Anthropic-shaped on messages."
      />

      <Section title="Status codes you will actually see">
        <div className="ref-status">
          <div>
            <strong>401</strong>
            <span>No secret, or the secret is revoked or unknown.</span>
          </div>
          <div>
            <strong>402</strong>
            <span>The wallet or the key cap cannot cover the hold, or the subscription remainder is too small for a zero-price model. Add dollars, buy subscription tokens, lower max output, or wait for open holds to settle.</span>
          </div>
          <div>
            <strong>400</strong>
            <span>The JSON is missing a required field or calls a model on the wrong route (for example calling a Jev Group Decision model on /v1/chat/completions instead of /v1/decisions).</span>
          </div>
          <div>
            <strong>429</strong>
            <span>This account already used its requests-per-minute budget. Check <Link to="/docs/rpm">GET /v1/rpm</Link>.</span>
          </div>
          <div>
            <strong>502 / 503</strong>
            <span>The provider side failed. Retry with backoff; a failed call returns its hold.</span>
          </div>
        </div>
      </Section>

      <Section title="Error body (OpenAI-style)">
        <CodeBlock
          language="json"
          title="Example"
          code={`{
  "error": {
    "message": "Missing API key (Bearer or x-api-key)",
    "type": "authentication_error",
    "param": null,
    "code": null
  }
}`}
        />
      </Section>
    </div>
  )
}

type LiveModelPrice = {
  id: string
  provider: string
  name: string
  contextWindow: string
  weight: number
  dollarsPer1M: number
  inputDollarsPer1M?: number
  outputDollarsPer1M?: number
}

export function DevModelsOverviewPage() {
  const [models, setModels] = useState<LiveModelPrice[]>([])
  const [loaded, setLoaded] = useState(false)
  const [limits, setLimits] = useState<PublicRateLimits>(DEFAULT_RATE_LIMITS)

  useEffect(() => {
    let cancelled = false
    fetch('/api/public/rate-limits')
      .then(async (res) => {
        if (!res.ok) return
        const data = (await res.json()) as Partial<PublicRateLimits>
        if (!cancelled && Array.isArray(data.plans)) {
          setLimits({
            plans: data.plans,
            supportUrl: data.supportUrl,
            rpmFree: data.plans.find((plan) => plan.key === 'free')?.rpm ?? 5,
            rpmSubscription: data.plans.find((plan) => plan.key === 'standard')?.rpm ?? 30,
            subscriberPriority: Boolean(data.subscriberPriority),
          })
        }
      })
      .catch(() => undefined)
    fetch('/api/public/models')
      .then(async (res) => {
        if (!res.ok) return
        const data = (await res.json()) as { models?: LiveModelPrice[] }
        if (!cancelled) setModels(Array.isArray(data.models) ? data.models : [])
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const priceLines = useMemo(() => {
    if (models.length === 0) return []
    const fmt = (n: number) => (Math.round(n * 1000) % 10 !== 0 ? n.toFixed(3) : n.toFixed(2))
    return models.map((model) => {
      const free = model.provider === 'Free' || model.id.startsWith('free/') || Number(model.dollarsPer1M) <= 0
      const input = Number(model.inputDollarsPer1M ?? model.dollarsPer1M)
      const isJev = model.provider === 'Jev Group' || /jev-|drex|subq|decision/i.test(model.id)
      const output = model.outputDollarsPer1M !== undefined ? Number(model.outputDollarsPer1M) : isJev ? 0 : input
      return free
        ? `${model.id.padEnd(28)} free  ${model.provider} · ${model.name}`
        : `${model.id.padEnd(28)} $${fmt(input)} in / $${fmt(output)} out  ${model.provider} · ${model.name}`
    })
  }, [models])

  const aiPromptExample = useMemo(() => {
    const sample = models.slice(0, 12)
    const fmt = (n: number) => (Math.round(n * 1000) % 10 !== 0 ? n.toFixed(3) : n.toFixed(2))
    const table =
      sample.length > 0
        ? sample
            .map((m) => {
              const free = m.provider === 'Free' || m.id.startsWith('free/') || Number(m.dollarsPer1M) <= 0
              const input = Number(m.inputDollarsPer1M ?? m.dollarsPer1M)
              const isJev = m.provider === 'Jev Group' || /jev-|drex|subq|decision/i.test(m.id)
              const output = m.outputDollarsPer1M !== undefined ? Number(m.outputDollarsPer1M) : isJev ? 0 : input
              return free
                ? `- ${m.id}: free (${m.name})`
                : `- ${m.id}: $${fmt(input)} input / $${fmt(output)} output per 1M (${m.name})`
            })
            .join('\n')
        : '- (fetch live table from this page or GET /api/public/models)'
    return `You are helping me pick an ${siteName()} model.
Base URL: ${API_BASE()}
Auth: Authorization: Bearer sk-…
Billing: prepaid USD wallet for priced models. Zero-price (free/*) models draw subscription tokens, not the wallet.

Current retail prices (live):
${table}

Task: recommend a model for [describe workload], estimate cost for ~N input + M output tokens, and give a ready curl example.`
  }, [models])

  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Models"
        title="Model APIs"
        lead="Chat Completions, Responses, Messages, and Decisions sit on one base URL. The model id in the body decides which family you reach."
      />

      <Callout title="Live throughput" tone="info">
        Every account starts at <strong>{limits.rpmFree} RPM</strong>. Paid RPM plans raise that same account ceiling — currently <strong>{(limits.plans ?? []).filter((plan) => !plan.custom && plan.priceCents > 0).map((plan) => `${plan.rpm} RPM`).join(' or ') || `${limits.rpmSubscription} RPM`}</strong>. <Link to="/rpm">Raise RPM</Link> · <Link to="/docs/errors">Plans and headers</Link>
      </Callout>

      <Section title="Endpoints">
        <div className="ref-tiles">
          <Link className="ref-tile" to="/docs/models/chat">
            <em>POST</em>
            <strong>/v1/chat/completions</strong>
            <span>Cursor, OpenCode, OpenAI SDK, most agents</span>
          </Link>
          <Link className="ref-tile" to="/docs/models/responses">
            <em>POST</em>
            <strong>/v1/responses</strong>
            <span>Codex and OpenAI Responses clients</span>
          </Link>
          <Link className="ref-tile" to="/docs/models/messages">
            <em>POST</em>
            <strong>/v1/messages</strong>
            <span>Claude Code / Anthropic Messages</span>
          </Link>
          <Link className="ref-tile" to="/docs/models/decisions">
            <em>POST</em>
            <strong>/v1/decisions</strong>
            <span>Jev Group typed classification, moderation &amp; scoring</span>
          </Link>
          <Link className="ref-tile" to="/docs/models/connect">
            <em>Setup</em>
            <strong>IDE &amp; SDK</strong>
            <span>Base URL + key wiring for popular clients</span>
          </Link>
        </div>
      </Section>

      <Section title="How billing works">
        <p>
          Priced models bill your USD wallet directly using their published input and output rates per 1M tokens:
        </p>
        <CodeBlock
          code={`cost_usd = (input_tokens / 1_000_000) * input_price_per_1M
         + (output_tokens / 1_000_000) * output_price_per_1M`}
        />
        <p>
          Free models (<code className="ref-inline">free/*</code>) never charge your USD wallet — they deduct <code className="ref-inline">input_tokens + output_tokens</code> from your active subscription token pool or daily free allowance.
          Jev Group Decision models (<code className="ref-inline">/v1/decisions</code>) charge only for input tokens (<code className="ref-inline">$0.00</code> output token cost).
        </p>
      </Section>

      <Section title="List models">
        <EndpointBadge method="GET" path="/v1/models" />
        <CodeBlock
          code={`curl ${API_BASE()}/models \\
  -H "${AUTH_HEADER}"`}
        />
        <p>
          Authenticated catalog. Public live prices (no key) are also on{' '}
          <code className="ref-inline">GET /api/public/models</code> and the table below.
        </p>
      </Section>

      <Section title="Live model prices">
        <p>
          Retail $/1M updates with the catalog. Paste this page or the table into an assistant so it can recommend models
          and estimate spend for your workload.
        </p>
        {!loaded ? (
          <p className="ref-muted">Loading live prices…</p>
        ) : models.length === 0 ? (
          <p className="ref-muted">Catalog unavailable right now — try again shortly or open the dashboard Models page.</p>
        ) : (
          <>
            <div className="ref-table-wrap">
              <table className="ref-table">
                <thead>
                  <tr>
                    <th>Model id</th>
                    <th>Provider</th>
                    <th>Name</th>
                    <th>Context</th>
                    <th>Input / 1M</th>
                    <th>Output / 1M</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((model) => {
                    const isFree = model.provider === 'Free' || model.id.startsWith('free/') || Number(model.dollarsPer1M) <= 0
                    const isJev = model.provider === 'Jev Group' || /jev-|drex|subq|decision/i.test(model.id)
                    const inPrice = Number(model.inputDollarsPer1M ?? model.dollarsPer1M) || 0
                    const outPrice =
                      model.outputDollarsPer1M !== undefined && (Number(model.outputDollarsPer1M) > 0 || isJev)
                        ? Number(model.outputDollarsPer1M)
                        : isJev
                          ? 0
                          : inPrice
                    const fmt = (n: number) => (Math.round(n * 1000) % 10 !== 0 ? n.toFixed(3) : n.toFixed(2))
                    return (
                      <tr key={model.id}>
                        <td>
                          <code>{model.id}</code>
                        </td>
                        <td>{model.provider}</td>
                        <td>{model.name}</td>
                        <td>{model.contextWindow || '—'}</td>
                        <td>
                          <strong>{isFree ? 'free' : `$${fmt(inPrice)}`}</strong>
                        </td>
                        <td>
                          <strong>{isFree ? 'free' : `$${fmt(outPrice)}`}</strong>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <CodeBlock
              title="Copy-paste for agents (text)"
              language="text"
              code={[`# ${siteName()} live model prices (${models.length} models)`, ...priceLines].join('\n')}
            />
            <CodeBlock title="Example prompt to give your AI" language="text" code={aiPromptExample} />
            <CodeBlock
              title="Fetch live JSON"
              code={`curl https://${SITE_HOST()}/api/public/models`}
            />
          </>
        )}
        <p className="ref-muted">
          Wallet spend is prepaid. A priced model bills input and output at the dollars-per-million figure above. A free row does not debit the wallet; it draws subscription tokens, visible on GET /v1/balance.
        </p>
      </Section>
    </div>
  )
}

const chatBodyRows: ParamRow[] = [
  {
    name: 'model',
    type: 'string',
    required: true,
    description: 'Catalog id from GET /v1/models (for example free/glm-5.3-flash). Slash and dash forms of the same id both resolve.',
  },
  {
    name: 'messages',
    type: 'array<object>',
    required: true,
    description: (
      <>
        Chat messages. Each item: <code>role</code> (<code>system</code> | <code>user</code> | <code>assistant</code> |
        …) and <code>content</code> (string or content parts).
      </>
    ),
  },
  {
    name: 'stream',
    type: 'boolean',
    default: 'false',
    description: 'When true, the body is an OpenAI-style server-sent event stream instead of one JSON object.',
  },
  {
    name: 'temperature',
    type: 'number',
    description: 'Sampling temperature. Ignored when the selected model does not expose it.',
  },
  {
    name: 'max_tokens',
    type: 'integer',
    description: 'Cap on generated tokens. This value is part of the pre-call hold, so a huge cap can fail with 402 even if the final reply would have been short.',
  },
  {
    name: 'tools / tool_choice',
    type: 'object | array',
    description: 'Function tools in the OpenAI shape, forwarded when that model can call them.',
  },
  {
    name: 'reasoning_effort',
    type: 'string',
    description: 'Thinking depth for models that expose it: "low", "medium", or "high".',
  },
]

const decisionTypeSafeRows: ParamRow[] = [
  {
    name: 'model',
    type: 'string',
    required: true,
    description: 'Jev Group model ID: jev-1.13, drex-v2.0, subq-snap-preview, gpt-6-luna-decisions, or free/jev-1.13.',
  },
  {
    name: 'state',
    type: 'string | object | array',
    required: true,
    description: 'The text or structured data payload to evaluate.',
  },
  {
    name: 'questions',
    type: 'Record<string, DecisionQuestion>',
    required: true,
    description: 'Named map of typed questions (noul, choice, or score) to evaluate in a single pass.',
  },
  {
    name: 'images',
    type: 'array<DecisionImage>',
    description: 'Up to 4 inline base64 images ({ mediaType: "image/png" | "image/jpeg" | "image/webp", base64: "..." }) for vision decision models such as subq-snap-preview and gpt-6-luna-decisions.',
  },
]

const decisionOpenAiRows: ParamRow[] = [
  {
    name: 'model',
    type: 'string',
    required: true,
    description: 'Jev Group model ID: jev-1.13, drex-v2.0, subq-snap-preview, gpt-6-luna-decisions, or free/jev-1.13.',
  },
  {
    name: 'input',
    type: 'string | array<Message>',
    required: true,
    description: 'Text string or array of user messages containing input_text and input_image blocks.',
  },
  {
    name: 'questions',
    type: 'array<Question>',
    required: true,
    description: 'List of 1 to 100 typed questions using predicate, choice, or score.',
  },
]

export function DevModelsDecisionsPage() {
  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Models · Jev Group"
        title="Decisions API"
        lead="Ask specialized Jev Group decision models typed questions about text or images and receive calibrated probabilities, confidence scores, and structured classifications in ~300ms."
      />
      <EndpointBadge method="POST" path="/v1/decisions" />

      <Section title="Available Jev Group models">
        <p>
          Decision models return calibrated probabilities across your defined answer space in a single non-streaming pass, billing only for input tokens ($0.00 output token cost). Free decision models (<code className="ref-inline">free/jev-1.13</code>) draw from your subscription or daily free allowance and also use <code className="ref-inline">POST /v1/decisions</code>.
        </p>
        <div className="ref-table-wrap">
          <table className="ref-table">
            <thead>
              <tr>
                <th>Model ID</th>
                <th>Group</th>
                <th>Name</th>
                <th>Modalities</th>
                <th>Context</th>
                <th>Input / 1M</th>
                <th>Output / 1M</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>free/jev-1.13</code></td>
                <td>Free</td>
                <td>Jev 1.13</td>
                <td>Text → Decision</td>
                <td>64K</td>
                <td><strong>free</strong></td>
                <td><strong>free</strong></td>
              </tr>
              <tr>
                <td><code>drex-v2.0</code></td>
                <td>Jev Group</td>
                <td>Drex 2.0</td>
                <td>Text → Decision</td>
                <td>131K</td>
                <td><strong>$0.040</strong></td>
                <td><strong>$0.00</strong></td>
              </tr>
              <tr>
                <td><code>jev-1.13</code></td>
                <td>Jev Group</td>
                <td>Jev 1.13</td>
                <td>Text → Decision</td>
                <td>64K</td>
                <td><strong>$0.042</strong></td>
                <td><strong>$0.00</strong></td>
              </tr>
              <tr>
                <td><code>subq-snap-preview</code></td>
                <td>Jev Group</td>
                <td>SubQ Snap (Preview)</td>
                <td>Text + Vision → Decision</td>
                <td>313K</td>
                <td><strong>$0.050</strong></td>
                <td><strong>$0.00</strong></td>
              </tr>
              <tr>
                <td><code>gpt-6-luna-decisions</code></td>
                <td>Jev Group</td>
                <td>GPT-6 Luna (Decisions)</td>
                <td>Text + Vision → Decision</td>
                <td>1M</td>
                <td><strong>$0.100</strong></td>
                <td><strong>$0.00</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
        <Callout title="Dedicated endpoint" tone="info">
          <p>
            Decision models only accept <code className="ref-inline">POST /v1/decisions</code>. Calling a decision model on <code className="ref-inline">/v1/chat/completions</code>, <code className="ref-inline">/v1/responses</code>, or <code className="ref-inline">/v1/messages</code> returns a <code className="ref-inline">400 invalid_request_error</code>.
          </p>
        </Callout>
      </Section>

      <Section title="Shape 1: TypeSafe / SubQ format (state + questions map)">
        <p>
          Pass content in <code className="ref-inline">state</code> and a dictionary of named questions in <code className="ref-inline">questions</code>. Supported question types:
        </p>
        <ul>
          <li><strong>noul</strong> — Binary yes/no predicate returning a probability from 0.0 to 1.0.</li>
          <li><strong>choice</strong> — Multi-class selection requiring a <code className="ref-inline">criteria</code> object mapping each option key to its description.</li>
          <li><strong>score</strong> — Ordered grading scale requiring a <code className="ref-inline">criteria</code> array of at least 2 ordered level labels.</li>
        </ul>
        <ParamTable rows={decisionTypeSafeRows} />
        <CodeBlock
          title="TypeSafe / SubQ shape request"
          code={`curl ${API_BASE()}/decisions \\
  -H "${AUTH_HEADER}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "jev-1.13",
    "state": "User asked: Can you help me write a Python script to backup my PostgreSQL database every night using cron?",
    "questions": {
      "is_safe": {
        "type": "noul",
        "instructions": "Is this user request safe and benign to fulfill?"
      },
      "category": {
        "type": "choice",
        "instructions": "Which domain best describes this request?",
        "criteria": {
          "coding": "Software development, scripting, or DevOps",
          "creative": "Creative writing or storytelling",
          "math": "Mathematics or formal logic"
        }
      },
      "complexity": {
        "type": "score",
        "instructions": "How complex is the task requested?",
        "criteria": ["trivial", "easy", "moderate", "hard", "expert"]
      }
    }
  }'`}
        />
        <CodeBlock
          title="Response (200 OK)"
          language="json"
          code={`{
  "object": "decision",
  "model": "jev-1.13",
  "answers": {
    "is_safe": {
      "type": "noul",
      "noul": 0.98
    },
    "category": {
      "type": "choice",
      "choice": "coding",
      "confidence": 1.0,
      "probabilities": {
        "coding": 1.0,
        "creative": 0.0,
        "math": 0.0
      }
    },
    "complexity": {
      "type": "score",
      "score": 1.38,
      "confidence": 0.68,
      "legend": {
        "0": "trivial",
        "1": "easy",
        "2": "moderate",
        "3": "hard",
        "4": "expert"
      },
      "probabilities": {
        "0": 0.0,
        "1": 0.62,
        "2": 0.38,
        "3": 0.0,
        "4": 0.0
      }
    }
  },
  "usage": {
    "prompt_tokens": 436,
    "completion_tokens": 71,
    "total_tokens": 507
  }
}`}
        />
      </Section>

      <Section title="Shape 2: OpenAI Decisions SDK format (input + questions list)">
        <p>
          Compatible with <code className="ref-inline">client.decisions.create</code> in OpenAI-style SDKs. Pass <code className="ref-inline">input</code> and an array of <code className="ref-inline">questions</code> (<code className="ref-inline">predicate</code>, <code className="ref-inline">choice</code>, or <code className="ref-inline">score</code>).
        </p>
        <ParamTable rows={decisionOpenAiRows} />
        <CodeBlock
          title="OpenAI Decisions shape request"
          code={`curl ${API_BASE()}/decisions \\
  -H "${AUTH_HEADER}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "subq-snap-preview",
    "input": "I was charged twice for my subscription this month and I need an immediate refund!",
    "questions": [
      {
        "type": "predicate",
        "name": "urgent_billing_issue",
        "instructions": "Does the message report a duplicate charge or billing error requiring refund?"
      },
      {
        "type": "choice",
        "name": "sentiment",
        "instructions": "What is the customer sentiment?",
        "choices": [
          { "value": "positive", "description": "Happy or satisfied" },
          { "value": "neutral", "description": "Matter-of-fact inquiry" },
          { "value": "frustrated", "description": "Upset or demanding urgent resolution" }
        ]
      },
      {
        "type": "score",
        "name": "urgency",
        "instructions": "Rate the urgency of this ticket",
        "levels": [
          { "label": "low", "description": "Low urgency" },
          { "label": "medium", "description": "Medium urgency" },
          { "label": "high", "description": "High urgency" }
        ]
      }
    ]
  }'`}
        />
      </Section>

      <Section title="Vision decisions (SubQ Snap & GPT-6 Luna)">
        <p>
          Attach up to 4 inline base64 images (<code className="ref-inline">image/png</code>, <code className="ref-inline">image/jpeg</code>, or <code className="ref-inline">image/webp</code>) to classify screenshots, receipts, UI states, or moderation targets.
        </p>
        <CodeBlock
          title="Image + state decision example"
          code={`curl ${API_BASE()}/decisions \\
  -H "${AUTH_HEADER}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "subq-snap-preview",
    "state": "Verify this user-uploaded image before publishing.",
    "images": [
      {
        "mediaType": "image/png",
        "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
      }
    ],
    "questions": {
      "is_safe_for_work": {
        "type": "noul",
        "instructions": "Is the attached image safe for work?"
      }
    }
  }'`}
        />
      </Section>
    </div>
  )
}

export function DevModelsChatPage() {
  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Models"
        title="Chat Completions"
        lead={`The OpenAI chat path. Point an SDK, Cursor, or OpenCode at the ${siteName()} base URL and keep the request body you already send.`}
      />
      <EndpointBadge method="POST" path="/v1/chat/completions" />

      <Section title="Request body">
        <ParamTable rows={chatBodyRows} />
        <Callout title="Extra fields" tone="ok">
          <p>
            Undocumented OpenAI keys are passed through when the upstream accepts them. Prefer the fields in this table if the client has to stay portable.
          </p>
        </Callout>
      </Section>

      <Section title="Example">
        <CodeBlock
          code={`curl ${API_BASE()}/chat/completions \\
  -H "${AUTH_HEADER}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "free/glm-5.3-flash",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Summarize ${siteName()} in one sentence."}
    ],
    "temperature": 0.4
  }'`}
        />
      </Section>

      <Section title="Python (OpenAI SDK)">
        <CodeBlock
          language="python"
          code={`from openai import OpenAI

client = OpenAI(
    api_key="sk-…",
    base_url="${API_BASE()}",
)

r = client.chat.completions.create(
    model="free/glm-5.3-flash",
    messages=[{"role": "user", "content": "Hello from ${siteName()}"}],
)
print(r.choices[0].message.content)`}
        />
      </Section>

      <Section title="Thinking">
        <p>
          Models that reason expose the effort knob and return the thought text beside the final answer. Reasoning units are billed as output, not as a separate meter.
        </p>
        <div className="ref-tiles" style={{ marginBottom: 20 }}>
          <div className="ref-tile">
            <em>Parameter</em>
            <strong><code>reasoning_effort</code></strong>
            <span>
              Body field. <code>"low"</code>, <code>"medium"</code>, or <code>"high"</code> changes how long the model thinks before it answers.
            </span>
          </div>
          <div className="ref-tile">
            <em>Streaming</em>
            <strong><code>reasoning_content</code></strong>
            <span>
              With <code>stream: true</code>, thoughts arrive live on <code>delta.reasoning_content</code>.
            </span>
          </div>
          <div className="ref-tile">
            <em>Non-Streaming</em>
            <strong><code>message.reasoning_content</code></strong>
            <span>
              A non-streaming reply puts the full thought trace on <code>message.reasoning_content</code>, next to <code>content</code>.
            </span>
          </div>
        </div>
        <CodeBlock
          title="Reasoning request example"
          code={`curl ${API_BASE()}/chat/completions \\
  -H "${AUTH_HEADER}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "deepseek/deepseek-v4-flash-0731",
    "messages": [
      {"role": "user", "content": "Solve this logic problem step by step..."}
    ],
    "reasoning_effort": "medium"
  }'`}
        />
      </Section>

      <Section title="What each family accepts">
        <p>
          A snapshot of input types and tool support. The catalog is the source of truth if a row changes.
        </p>
        <div className="ref-table-wrap" style={{ marginBottom: 24 }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: '18%' }}>Model Family</th>
                <th style={{ width: '22%' }}>Examples</th>
                <th style={{ width: '18%' }}>Input Modalities</th>
                <th style={{ width: '26%' }}>Reasoning / Thinking</th>
                <th style={{ width: '16%' }}>Tools</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>DeepSeek V4</strong></td>
                <td><code>deepseek-v4-flash</code><br /><code>deepseek-v4-pro</code></td>
                <td>Text</td>
                <td>Supported (<code>reasoning_effort</code>)</td>
                <td>Yes</td>
              </tr>
              <tr>
                <td><strong>Gemini 3.8 / 3.1</strong></td>
                <td><code>gemini-3.8-flash</code><br /><code>gemini-3.1-pro</code></td>
                <td>Text, Images (<code>image_url</code>)</td>
                <td>Configurable</td>
                <td>Yes</td>
              </tr>
              <tr>
                <td><strong>Claude 5 / Sonnet / Opus</strong></td>
                <td><code>claude-sonnet-5</code><br /><code>claude-opus-5</code></td>
                <td>Text, Images (<code>image_url</code>)</td>
                <td>Extended thinking</td>
                <td>Yes</td>
              </tr>
              <tr>
                <td><strong>GPT-6</strong></td>
                <td><code>gpt-6-luna</code><br /><code>gpt-6-astra</code><br /><code>gpt-6.1-sol</code></td>
                <td>OpenAI GPT-6 frontier models.</td>
                <td>Built-in</td>
                <td>Yes</td>
              </tr>
              <tr>
                <td><strong>GLM 5.3</strong></td>
                <td><code>glm-5.3-flash</code><br /><code>glm-5.3</code></td>
                <td>Text</td>
                <td>Always on (<code>reasoning_content</code>)</td>
                <td>Yes</td>
              </tr>
              <tr>
                <td><strong>Grok 4.6</strong></td>
                <td><code>grok-4.6</code></td>
                <td>Text</td>
                <td>Supported</td>
                <td>Yes</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Images">
        <p>
          When the catalog model accepts images, send <code className="ref-inline">content</code> as parts instead of a string:
        </p>
        <CodeBlock
          code={`curl ${API_BASE()}/chat/completions \\
  -H "${AUTH_HEADER}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gemini/3.8-flash",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "What is in this image?"},
          {"type": "image_url", "image_url": {"url": "https://example.com/sample.jpg"}}
        ]
      }
    ]
  }'`}
        />
      </Section>

      <Section title="What comes back">
        <p>
          The body matches OpenAI chat: read <code className="ref-inline">choices[].message.content</code>.
          <code className="ref-inline">usage</code> reports prompt and completion totals. The wallet debit is the catalog dollar rate applied to those totals.
        </p>
      </Section>
    </div>
  )
}

const responsesRows: ParamRow[] = [
  {
    name: 'model',
    type: 'string',
    required: true,
    description: 'Catalog id. Codex should use the same id you set in config.toml.',
  },
  {
    name: 'input',
    type: 'string | array',
    required: true,
    description: 'The turn to run. A string is enough; structured input items are accepted when the client sends them.',
  },
  {
    name: 'stream',
    type: 'boolean',
    default: 'false',
    description: 'Set true when the client reads a Responses event stream.',
  },
  {
    name: 'instructions',
    type: 'string',
    description: 'Standing instructions for this run, separate from the user input.',
  },
]

export function DevModelsResponsesPage() {
  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Models"
        title="Responses"
        lead="The OpenAI Responses path. Codex reaches it when wire_api is responses. Other Responses clients can call it directly."
      />
      <EndpointBadge method="POST" path="/v1/responses" />

      <Section title="Request body">
        <ParamTable rows={responsesRows} />
      </Section>

      <Section title="Example">
        <CodeBlock
          code={`curl ${API_BASE()}/responses \\
  -H "${AUTH_HEADER}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "free/glm-5.3-flash",
    "input": "Write a two-line haiku about APIs."
  }'`}
        />
      </Section>

      <Section title="Codex">
        <p>
          The filled-in version is on <Link to="/docs/models/connect">IDE and SDK setup</Link> and in dashboard{' '}
          <a href="/setup">Setup</a>.
        </p>
        <CodeBlock
          language="toml"
          title="~/.codex/config.toml"
          code={`model = "free/glm-5.3-flash"
model_provider = "${brandSlug()}"

[model_providers.${brandSlug()}]
name = "${siteName()}"
base_url = "${API_BASE()}"
wire_api = "responses"
requires_openai_auth = true`}
        />
      </Section>
    </div>
  )
}

const messagesRows: ParamRow[] = [
  {
    name: 'model',
    type: 'string',
    required: true,
    description: 'Any catalog id. Claude Code maps its opus / sonnet / haiku slots onto the ids you set in settings.',
  },
  {
    name: 'messages',
    type: 'array<object>',
    required: true,
    description: 'Turns in the Anthropic shape: role plus a string or content blocks.',
  },
  {
    name: 'max_tokens',
    type: 'integer',
    required: true,
    description: 'Anthropic requires this cap. It also sizes the pre-call hold on priced models.',
  },
  {
    name: 'system',
    type: 'string | array',
    description: 'System prompt, as a string or as Anthropic text blocks.',
  },
  {
    name: 'stream',
    type: 'boolean',
    default: 'false',
    description: 'When true, the reply is an Anthropic event stream.',
  },
]

export function DevModelsMessagesPage() {
  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Models"
        title="Messages"
        lead="Anthropic Messages shape for Claude Code and any client that already speaks /v1/messages."
      />
      <EndpointBadge method="POST" path="/v1/messages" />

      <Section title="Headers">
        <CodeBlock
          language="http"
          code={`x-api-key: sk-…
anthropic-version: 2023-06-01
Content-Type: application/json`}
        />
        <p>
          Claude Code appends <code className="ref-inline">/v1/messages</code> itself, so its base URL is the origin without <code className="ref-inline">/v1</code>. Bearer works if you are not using that client.
        </p>
      </Section>

      <Section title="Request body">
        <ParamTable rows={messagesRows} />
      </Section>

      <Section title="Example">
        <CodeBlock
          code={`curl ${API_BASE()}/messages \\
  -H "x-api-key: sk-…" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "free/glm-5.3-flash",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello from ${siteName()}"}]
  }'`}
        />
      </Section>
    </div>
  )
}

export function DevModelsConnectPage() {
  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Models"
        title="Wire a client"
        lead="The shortest config for each client. Signed-in setup in the dashboard pastes your real secret into these same files."
      />

      <Section title="Values every client needs">
        <div className="ref-status">
          <div>
            <strong>Base URL</strong>
            <span>
              <code className="ref-inline">{API_BASE()}</code>
            </span>
          </div>
          <div>
            <strong>API key</strong>
            <span>
              <code className="ref-inline">sk-…</code> from the dashboard
            </span>
          </div>
          <div>
            <strong>Model id</strong>
            <span>
              Copy from <a href="/models">Models & Pricing</a>
            </span>
          </div>
        </div>
      </Section>

      <Section title="Kimi Code CLI">
        <p style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/brand/moonshot.png" alt="" width={28} height={28} style={{ borderRadius: 6 }} />
          Kimi Code CLI uses {siteName()} as an OpenAI-style provider. Install the CLI, then either run the script or drop the file below in place.
        </p>
        <p>
          macOS and Linux store it at <code className="ref-inline">~/.kimi-code/config.toml</code>. Windows uses{' '}
          <code className="ref-inline">%USERPROFILE%\.kimi-code\config.toml</code>. The script copies the previous file to{' '}
          <code className="ref-inline">config.toml.{brandSlug()}.bak</code> before it writes.
        </p>
        <p>Models written into the file:</p>
        <ul>
          <li><code className="ref-inline">free/kimi-k3</code></li>
          <li><code className="ref-inline">free/kimi-k3</code> (default)</li>
          <li><code className="ref-inline">gpt-6-sol</code></li>
          <li><code className="ref-inline">claude-opus-5.5</code></li>
          <li><code className="ref-inline">grok-4.7</code></li>
        </ul>

        <CodeBlock
          language="bash"
          title="macOS and Linux"
          code={`bash <(curl -fsSL "https://${SITE_HOST()}/i?tool=kimi") <YOUR_API_KEY>`}
        />
        <CodeBlock
          language="powershell"
          title="Windows (PowerShell)"
          code={`$env:API_KEY="<YOUR_API_KEY>"; irm "https://${SITE_HOST()}/i?os=windows&tool=kimi" | iex`}
        />
        <CodeBlock
          language="toml"
          title="Manual config.toml — same file on every OS"
          code={`default_model = "${brandSlug()}/free/kimi-k3"

[providers.${brandSlug()}]
type = "openai"
base_url = "${API_BASE()}"
api_key = "sk-..."

[models."${brandSlug()}/free/kimi-k3"]
provider = "${brandSlug()}"
model = "free/kimi-k3"
max_context_size = 1000000
capabilities = ["tool_use", "thinking"]

[models."${brandSlug()}/gpt-6-sol"]
provider = "${brandSlug()}"
model = "gpt-6-sol"
max_context_size = 1000000
capabilities = ["tool_use", "thinking"]

[models."${brandSlug()}/claude-opus-5.5"]
provider = "${brandSlug()}"
model = "claude-opus-5.5"
max_context_size = 1000000
capabilities = ["tool_use", "thinking"]

[models."${brandSlug()}/grok-4.7"]
provider = "${brandSlug()}"
model = "grok-4.7"
max_context_size = 500000
capabilities = ["tool_use", "thinking"]`}
        />
        <p>
          Check it with <code className="ref-inline">kimi doctor</code>, then{' '}
          <code className="ref-inline">kimi -p "Reply with the single word pong" -m {brandSlug()}/gpt-6-sol</code>. Switch models with <code className="ref-inline">-m {brandSlug()}/claude-opus-5.5</code>, <code className="ref-inline">{brandSlug()}/grok-4.7</code>, or <code className="ref-inline">{brandSlug()}/free/kimi-k3</code>.
        </p>
      </Section>

      <Section title="Cursor">
        <ol className="ref-steps">
          <li>Open Settings, then Models, and turn on <strong>Override OpenAI Base URL</strong>.</li>
          <li>Set that URL to <code className="ref-inline">{API_BASE()}</code>.</li>
          <li>Put the {siteName()} secret in <strong>OpenAI API Key</strong>.</li>
          <li>Add a catalog id such as <code className="ref-inline">free/glm-5.3-flash</code> and press Verify.</li>
        </ol>
      </Section>

      <Section title="OpenCode">
        <p>
          One shell command writes the global file. You can also create it by hand if you would rather not run a remote script.
        </p>

        <CodeBlock
          language="bash"
          title="macOS / Linux: one-line setup"
          code={`bash <(curl -fsSL "https://${SITE_HOST()}/i?tool=opencode") <YOUR_API_KEY>`}
        />

        <CodeBlock
          language="powershell"
          title="Windows: one-line setup (PowerShell)"
          code={`$env:API_KEY="<YOUR_API_KEY>"; irm "https://${SITE_HOST()}/i?os=windows&tool=opencode" | iex`}
        />

        <p style={{ marginTop: '12px' }}>
          <strong>Where the file lives:</strong>
        </p>
        <ul>
          <li>
            <strong>Windows:</strong> <code className="ref-inline">%USERPROFILE%\.config\opencode\opencode.json</code> (PowerShell: <code className="ref-inline">$HOME\.config\opencode\opencode.json</code>)
          </li>
          <li>
            <strong>macOS / Linux:</strong> <code className="ref-inline">~/.config/opencode/opencode.json</code>
          </li>
          <li>
            <strong>Per-project (any OS):</strong> <code className="ref-inline">./opencode.json</code> in your project root
          </li>
        </ul>

        <CodeBlock
          language="json"
          title="opencode.json"
          code={`{
  "$schema": "https://opencode.ai/config.json",
  "model": "${brandSlug()}/free/glm-5.3-flash",
  "provider": {
    "${brandSlug()}": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "${siteName()}",
      "options": {
        "baseURL": "${API_BASE()}",
        "apiKey": "sk-…"
      },
      "models": {
        "free/glm-5.3-flash": { "name": "GLM 5.3 Flash (Free)" }
      }
    }
  }
}`}
        />
      </Section>


      <Section title="Hermes">
        <p>
          Hermes speaks Chat Completions. Quit it fully before editing files, or the background gateway keeps the old endpoint.
        </p>

        <CodeBlock
          language="bash"
          title="macOS / Linux: one-line setup"
          code={`bash <(curl -fsSL "https://${SITE_HOST()}/i?tool=hermes") <YOUR_API_KEY>`}
        />

        <CodeBlock
          language="powershell"
          title="Windows: one-line setup (PowerShell)"
          code={`$env:API_KEY="<YOUR_API_KEY>"; irm "https://${SITE_HOST()}/i?os=windows&tool=hermes" | iex`}
        />

        <p style={{ marginTop: '12px' }}>
          <strong>By hand:</strong>
        </p>
        <ol className="ref-steps">
          <li>Quit Hermes (Quit or Cmd+Q). Closing the window leaves the gateway running.</li>
          <li>
            Open <code className="ref-inline">~/.hermes</code> (Windows: <code className="ref-inline">%USERPROFILE%\.hermes</code>).
          </li>
          <li>
            Replace <code className="ref-inline">config.yaml</code>:
          </li>
        </ol>

        <CodeBlock
          language="yaml"
          title="config.yaml (~/.hermes/config.yaml)"
          code={`custom_providers:
  - name: "${siteName()}"
    base_url: "${API_BASE()}"
    key_env: "OPENAI_API_KEY"
    api_mode: "chat_completions"
    discover_models: false
    models:
      - "free/glm-5.3-flash"
      - "free/deepseek-v4.1-flash"
      - "free/gemini-3.8-flash"
model:
  default: "free/glm-5.3-flash"
  provider: "custom:${brandSlug()}"
  base_url: "${API_BASE()}"
  context_length: 1000000`}
        />

        <ol className="ref-steps">
          <li>
            Replace <code className="ref-inline">.env</code>. Both lines are required — without <code className="ref-inline">OPENAI_BASE_URL</code> Hermes still calls OpenAI.
          </li>
        </ol>

        <CodeBlock
          language="bash"
          title=".env (~/.hermes/.env)"
          code={`OPENAI_API_KEY=sk-…
OPENAI_BASE_URL=${API_BASE()}`}
        />

        <ol className="ref-steps">
          <li>
            Delete <code className="ref-inline">auth.json</code> if it is there. It caches the old endpoint and blocks the new <code className="ref-inline">.env</code>.
          </li>
          <li>
            Launch Hermes again. The first message should hit {siteName()}.
          </li>
        </ol>
      </Section>

      <Section title="Codex">
        <CodeBlock
          language="bash"
          title="macOS / Linux: one-line setup"
          code={`bash <(curl -fsSL "https://${SITE_HOST()}/i?tool=codex") <YOUR_API_KEY>`}
        />
        <CodeBlock
          language="powershell"
          title="Windows: one-line setup (PowerShell)"
          code={`$env:API_KEY="<YOUR_API_KEY>"; irm "https://${SITE_HOST()}/i?os=windows&tool=codex" | iex`}
        />
        <CodeBlock
          language="toml"
          title="config.toml (~/.codex/config.toml)"
          code={`model = "free/glm-5.3-flash"
model_provider = "${brandSlug()}"

[model_providers.${brandSlug()}]
name = "${siteName()}"
base_url = "${API_BASE()}"
wire_api = "responses"
requires_openai_auth = true`}
        />
        <CodeBlock
          language="json"
          title="auth.json (~/.codex/auth.json)"
          code={`{
  "auth_mode": "apikey",
  "OPENAI_API_KEY": "sk-…"
}`}
        />
      </Section>

      <Section title="Claude Code">
        <p>
          Do not put <code className="ref-inline">/v1</code> in <code className="ref-inline">ANTHROPIC_BASE_URL</code>. Claude Code adds <code className="ref-inline">/v1/messages</code> on its own, and a doubled prefix 404s.
        </p>
        <CodeBlock
          language="bash"
          title="macOS / Linux: one-line setup"
          code={`bash <(curl -fsSL "https://${SITE_HOST()}/i?tool=claude") <YOUR_API_KEY>`}
        />
        <CodeBlock
          language="powershell"
          title="Windows: one-line setup (PowerShell)"
          code={`$env:API_KEY="<YOUR_API_KEY>"; irm "https://${SITE_HOST()}/i?os=windows&tool=claude" | iex`}
        />
        <CodeBlock
          language="json"
          title="settings.json (~/.claude/settings.json)"
          code={`{
  "hasCompletedOnboarding": true,
  "env": {
    "ANTHROPIC_BASE_URL": "${API_ORIGIN()}",
    "ANTHROPIC_AUTH_TOKEN": "sk-…",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude/opus-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude/sonnet-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek/v4-flash"
  }
}`}
        />
      </Section>

      <Callout title="Prefer the wizard once you are signed in" tone="info">
        <p>
          <a href="/setup">Setup</a> writes the same files with the secret already filled from your newest active key.
        </p>
      </Callout>
    </div>
  )
}
