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

      <Section title="Three places to start">
        <div className="ref-tiles">
          <Link className="ref-tile" to="/docs/models">
            <em>Models</em>
            <strong>Chat, Responses, Messages</strong>
            <span>Drop-in routes for OpenAI clients, Codex, and Claude Code.</span>
          </Link>
          <Link className="ref-tile" to="/docs/auth">
            <em>Auth</em>
            <strong>Dashboard keys</strong>
            <span>Send the secret as Bearer or x-api-key. Keys are minted in the dashboard.</span>
          </Link>
          <Link className="ref-tile" to="/docs/balance">
            <em>Wallet</em>
            <strong>Balance in one call</strong>
            <span>USD left to spend, in-flight holds, the key cap, and remaining subscription tokens.</span>
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
          <li>Read wallet dollars and the subscription remainder from the balance route before a long run.</li>
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
          title="Wallet and subscription tokens"
          code={`curl ${API_ORIGIN()}/v1/balance \\
  -H "${AUTH_HEADER}"`}
        />
      </Section>

      <Section title="Two buckets, one key">
        <p>
          Crypto checkout adds dollars to a prepaid wallet. Those dollars pay catalog models at the published rate per million tokens.
          A separate subscription allowance covers zero-price models: the daily free allowance until you buy a subscription, then the subscription itself.
          Both figures come back from <code className="ref-inline">GET /v1/balance</code>. There is no second account endpoint.
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
        lead="One authenticated read returns the prepaid wallet, open holds, the calling key's cap, and the subscription tokens left for zero-price models."
      />
      <EndpointBadge method="GET" path="/v1/balance" />

      <Section title="Request">
        <p>
          The same secret used for chat works here, as Bearer or <code className="ref-inline">x-api-key</code>. No body.
          There is no separate tokens or subscription route on the key API.
        </p>
        <CodeBlock
          title="Read the wallet"
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
  },
  "subscription": {
    "active": true,
    "label": "30 days",
    "unlimited": false,
    "limit": 500000000,
    "used": 1240000,
    "remaining": 498760000,
    "expires_at": null,
    "resets_at": null,
    "allowed": true
  }
}`}
        />
      </Section>

      <Section title="Wallet versus subscription tokens">
        <p>
          Top-ups land as dollars. A $5 payment is $5 of spendable balance. Pay-as-you-go models never convert that wallet into a token price — <code className="ref-inline">balance_usd</code> is the figure to bill against.
        </p>
        <p>
          Zero-price catalog models do not touch that wallet. They draw <code className="ref-inline">subscription</code>.
          Without a subscription, that object is the daily free allowance and <code className="ref-inline">resets_at</code> is the next 00:00 UTC.
          After a pack is purchased on <Link to="/subscriptions">Subscriptions</Link>, <code className="ref-inline">active</code> is true and the remainder is the subscription, not the daily bucket.
        </p>
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
            { name: 'subscription.active', type: 'boolean', description: 'True when a purchased subscription is the live allowance. False means the daily free bucket.' },
            { name: 'subscription.label', type: 'string', description: 'Pack name, or FREE while the daily bucket is in effect.' },
            { name: 'subscription.unlimited', type: 'boolean', description: 'True only if the live subscription has no ceiling.' },
            { name: 'subscription.limit', type: 'number | null', description: 'Size of the live subscription or the daily free bucket. Null when unlimited.' },
            { name: 'subscription.used', type: 'number', description: 'Units already drawn from that pack or from today\'s free bucket.' },
            { name: 'subscription.remaining', type: 'number | null', description: 'Units still available for zero-price models. Null when unlimited.' },
            { name: 'subscription.expires_at', type: 'string | null', description: 'ISO time when a dated subscription ends. Null for the daily bucket and for subscriptions that do not expire.' },
            { name: 'subscription.resets_at', type: 'string | null', description: 'Next 00:00 UTC refresh of the daily free bucket. Null while a subscription is active.' },
            { name: 'subscription.allowed', type: 'boolean', description: 'Whether another zero-price model call can still be metered right now.' },
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

export function DevErrorsPage() {
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
        title="Errors and throughput"
        lead="Failures keep the envelope of the route family you called: OpenAI-shaped on chat and responses, Anthropic-shaped on messages."
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
            <span>The JSON is missing a required field or uses a type the route rejects.</span>
          </div>
          <div>
            <strong>429</strong>
            <span>This account already used its requests-per-minute budget.</span>
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

      <Section title="How fast you can call">
        <p>
          Chat, responses, and messages share one rolling 60-second budget per account. Extra keys do not multiply it. The ceiling is the RPM plan on the account, not the model price. The free plan is on every account until you raise it.
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
                      'Crypto checkout on the RPM page'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Callout title="Raise the account ceiling" tone="ok">
          <p>
            RPM is separate from subscription tokens and from the dollar wallet. Open <Link to="/rpm">RPM</Link> to move from the free plan to a paid ceiling. Paid plans currently check out with crypto. Card checkout is not available for RPM yet. A ceiling that is not listed is arranged in support.
          </p>
          <p>
            <Link className="btn btn-primary btn-sm" to="/rpm">
              Open RPM
            </Link>
          </p>
        </Callout>

        <h3>What a 429 looks like</h3>
        <p>The body type is <code className="ref-inline">rate_limit_error</code>. These headers ride along:</p>
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
        <p>Agents should back off with jitter instead of retrying on a fixed interval.</p>
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
    return models.map((model) => {
      const free = Number.isFinite(model.weight) && model.weight === 0
      const input = Number(model.inputDollarsPer1M ?? model.dollarsPer1M)
      const output = Number(model.outputDollarsPer1M ?? model.dollarsPer1M)
      return free
        ? `${model.id.padEnd(28)} free  ${model.provider} · ${model.name}`
        : `${model.id.padEnd(28)} $${input.toFixed(2)} in / $${(output || input).toFixed(2)} out  ${model.provider} · ${model.name}`
    })
  }, [models])

  const aiPromptExample = useMemo(() => {
    const sample = models.slice(0, 12)
    const table =
      sample.length > 0
        ? sample
            .map((m) =>
              Number.isFinite(m.weight) && m.weight === 0
                ? `- ${m.id}: free (${m.name})`
                : `- ${m.id}: $${Number(m.inputDollarsPer1M ?? m.dollarsPer1M).toFixed(2)} input / $${Number(m.outputDollarsPer1M ?? m.dollarsPer1M).toFixed(2)} output per 1M (${m.name})`,
            )
            .join('\n')
        : '- (fetch live table from this page or GET /api/public/models)'
    return `You are helping me pick an ${siteName()} model.
Base URL: ${API_BASE()}
Auth: Authorization: Bearer sk-…
Billing: prepaid USD wallet for priced models. Zero-price models draw subscription tokens, not the wallet.

Current retail prices (live):
${table}

Task: recommend a model for [describe workload], estimate cost for ~N input + M output tokens, and give a ready curl example.`
  }, [models])

  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Models"
        title="Model APIs"
        lead="Chat Completions, Responses, and Messages sit on one base URL. The model id in the body decides which family you reach."
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
          <Link className="ref-tile" to="/docs/models/billing">
            <em>Guide</em>
            <strong>Dollar billing</strong>
            <span>Input, output, and reasoning, charged in USD</span>
          </Link>
          <Link className="ref-tile" to="/docs/models/connect">
            <em>Setup</em>
            <strong>IDE & SDK</strong>
            <span>Base URL + key wiring for popular clients</span>
          </Link>
        </div>
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
                  {models.map((model) => (
                    <tr key={model.id}>
                      <td>
                        <code>{model.id}</code>
                      </td>
                      <td>{model.provider}</td>
                      <td>{model.name}</td>
                      <td>{model.contextWindow || '—'}</td>
                      <td>
                        <strong>
                          {Number.isFinite(model.weight) && model.weight === 0
                            ? 'free'
                            : `$${Number(model.inputDollarsPer1M ?? model.dollarsPer1M).toFixed(2)}`}
                        </strong>
                      </td>
                      <td>
                        <strong>
                          {Number.isFinite(model.weight) && model.weight === 0
                            ? 'free'
                            : `$${Number(model.outputDollarsPer1M ?? model.dollarsPer1M).toFixed(2)}`}
                        </strong>
                      </td>
                    </tr>
                  ))}
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

export function DevModelsBillingPage() {
  return (
    <div className="ref-page">
      <PageHeader
        eyebrow="Models"
        title="How to lower FREE Token Weight"
        lead="Paid models charge dollars. Free models never touch the wallet. They draw the free-token allowance at x1."
      />

      <Section title="The ledger">
        <p>
          A priced model publishes separate <strong>input and output dollar rates per 1M tokens</strong>. That dollar amount leaves the wallet.
        </p>
        <CodeBlock
          code={`cost_usd = input_tokens / 1_000_000 * input_price_per_1M
         + output_tokens / 1_000_000 * output_price_per_1M`}
        />
        <p>
          A <code className="ref-inline">free/</code> model spends subscription tokens instead, always at x1:
        </p>
        <CodeBlock
          code={`allowance_tokens = ceil((input_tokens + output_tokens) * level_multiplier)`}
        />
      </Section>

      <Section id="levels" title="Account levels">
        <p>
          Level 1 is granted when the account is created. Every later level has its own fresh top-up goal. A $20 payment does not carry into the $50 goal. Overflow from one payment does: $70 at Level 1 reaches Level 3 with $0 progress.
        </p>
        <div className="ref-table-wrap">
          <table className="ref-table">
            <thead>
              <tr>
                <th>Level</th>
                <th>How you get it</th>
                <th>FREE Token Weight</th>
              </tr>
            </thead>
            <tbody>
              <tr><td><strong>1</strong></td><td>Signup</td><td>x3</td></tr>
              <tr><td><strong>2</strong></td><td>Fresh $20 after Level 1</td><td>x2.5</td></tr>
              <tr><td><strong>3</strong></td><td>Fresh $50 after Level 2</td><td>x2</td></tr>
              <tr><td><strong>4</strong></td><td>Fresh $100 after Level 3</td><td>x1.5</td></tr>
              <tr><td><strong>5</strong></td><td>Fresh $200 after Level 4</td><td>x1</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          Reaching Level 5 takes $370 in counted purchases: $20 + $50 + $100 + $200. At x1, 50,000 input tokens plus 1,000 output tokens spend 51,000 subscription tokens. At x3 the same call spends 153,000. The wallet stays at $0 either way.
        </p>
      </Section>

      <Section title="Purchases that count">
        <div className="ref-table-wrap">
          <table className="ref-table">
            <thead>
              <tr>
                <th>Purchase</th>
                <th>Counts toward the next level</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Balance top-up</td><td>Yes. Card and crypto. The credited amount, not a card fee.</td></tr>
              <tr><td>Subscriptions</td><td>Yes. Card, crypto, or paid from the wallet.</td></tr>
              <tr><td>RPM plan</td><td>Yes. Card, crypto, or paid from the wallet.</td></tr>
              <tr><td>Several invoices</td><td>Yes. $7 then $13 clears a $20 goal.</td></tr>
              <tr><td>Spending the credited balance</td><td>Not required. The payment itself counts.</td></tr>
              <tr><td>Promo, referral, Telegram bonus</td><td>No. Those are not purchases.</td></tr>
            </tbody>
          </table>
        </div>
        <Callout title="Where to watch it" tone="info">
          <p>
            Signed-in accounts show the level in the top bar. Open it for the ladder, the dollars left to the next level, and the purchase list. Live goals are also on <code className="ref-inline">GET /api/public/levels</code>.
          </p>
        </Callout>
      </Section>

      <Section title="How token types are counted">
        <div className="ref-table-wrap">
          <table className="ref-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>What it includes</th>
                <th>Reported as</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Input</strong></td>
                <td>Prompt messages, system instructions, and tool definitions.</td>
                <td><code>prompt_tokens</code> or <code>input_tokens</code></td>
              </tr>
              <tr>
                <td><strong>Output</strong></td>
                <td>Generated text, assistant content, and tool calls.</td>
                <td><code>completion_tokens</code> or <code>output_tokens</code></td>
              </tr>
              <tr>
                <td><strong>Reasoning</strong></td>
                <td>Chain-of-thought tokens. They are already inside output and billed as output.</td>
                <td><code>completion_tokens_details.reasoning_tokens</code></td>
              </tr>
              <tr>
                <td><strong>Rates</strong></td>
                <td>Input and output have separate catalog rates. Cache counters are not billed and are not returned.</td>
                <td><code>$ / 1M</code> input and output</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Standard Usage Response Example">
        <p>
          OpenAI SDK, LangChain, Claude Code, Cursor, and curl all get the same usage counts. Those counts are model tokens, not a wallet denomination:
        </p>
        <CodeBlock
          code={`{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "free/glm-5.3-flash",
  "choices": [...],
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 450,
    "total_tokens": 1650,
    "completion_tokens_details": {
      "reasoning_tokens": 150
    }
  }
}`}
        />
        <p>
          With <code className="ref-inline">free/glm-5.3-flash</code> the wallet is not charged. At Level 1 the same usage spends subscription tokens at x3:
        </p>
        <CodeBlock
          code={`raw_tokens = 1,200 + 450 = 1,650
allowance_tokens = ceil(1,650 * 3) = 4,950
wallet_charge = $0.00`}
        />
      </Section>

      <Section title="Parallel calls cannot double-spend">
        <ol className="ref-steps">
          <li>
            <strong>Lock first.</strong> The gateway estimates input plus the requested output ceiling and holds that amount before the provider sees the call.
          </li>
          <li>
            <strong>Settle to usage.</strong> On success the real dollar cost stays debited and the unused lock returns at once.
          </li>
          <li>
            <strong>Give it back on failure.</strong> An abort or an upstream error returns the entire hold. A hold that never finishes expires after 15 minutes.
          </li>
        </ol>
        <p>
          Read the live wallet and the subscription remainder together with <code className="ref-inline">GET /v1/balance</code>.
        </p>
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
