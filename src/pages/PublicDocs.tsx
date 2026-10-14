import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'

import { apiBase } from '../lib/brand'

type PublicRpmPlan = {
  key: string
  rpm: number
  priceCents: number
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

const TOOLS = [
  ['01', 'Cursor', 'OpenAI-compatible provider. Paste the base URL and the key.'],
  ['02', 'OpenCode', 'One script, or a file at ~/.config/opencode/opencode.json.'],
  ['03', 'Hermes', 'Desktop and terminal. Config lives in ~/.hermes/config.yaml.'],
  ['04', 'Codex', 'Same origin, Responses wire. Config in ~/.codex/config.toml.'],
  ['05', 'Claude Code', 'Messages path. Base URL is the origin, without /v1.'],
]

export function PublicDocs() {
  const [limits, setLimits] = useState<PublicRateLimits>({
    rpmFree: 5,
    rpmSubscription: 30,
    subscriberPriority: true,
  })

  useEffect(() => {
    let cancelled = false
    fetch('/api/public/rate-limits')
      .then(async (res) => {
        if (!res.ok) return
        const data = (await res.json()) as Partial<PublicRateLimits>
        if (!cancelled && typeof data.rpmFree === 'number' && typeof data.rpmSubscription === 'number') {
          setLimits({
            plans: Array.isArray(data.plans) ? data.plans : undefined,
            supportUrl: data.supportUrl,
            rpmFree: data.rpmFree,
            rpmSubscription: data.rpmSubscription,
            subscriberPriority: Boolean(data.subscriberPriority),
          })
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <article className="pub-legal">
      <header className="pub-legal-head">
        <span className="pub-legal-kicker">Setup</span>
        <h1>Connect a client</h1>
        <p>One origin, one secret. After sign-in the wizard writes the real key into the file for you.</p>
      </header>

      <section className="pub-legal-block">
        <span className="pub-legal-num">URL</span>
        <div>
          <h2>Where requests go</h2>
          <p>
            <code className="mono">{apiBase()}</code>
          </p>
          <p>
            Header: <code className="mono">Authorization: Bearer sk-…</code>
          </p>
        </div>
      </section>

      {TOOLS.map(([n, title, body]) => (
        <section className="pub-legal-block" key={n}>
          <span className="pub-legal-num">{n}</span>
          <div>
            <h2>{title}</h2>
            <p>{body}</p>
          </div>
        </section>
      ))}

      <section className="pub-legal-block">
        <span className="pub-legal-num">RPM</span>
        <div>
          <h2>How fast you can call</h2>
          <p>
            Default throughput is <strong>{limits.rpmFree} requests per minute</strong> per account. Extra keys do not multiply it.
            You can raise your account limit on the <Link to="/rpm">RPM</Link> page
            {limits.plans && limits.plans.length > 0 ? (
              <> (available plans: {limits.plans.map((p) => p.custom ? 'Custom' : `${p.rpm} RPM`).join(', ')})</>
            ) : null}
            .
          </p>
          <p>
            <Link className="btn btn-secondary btn-sm" to="/rpm">
              RPM Plans
            </Link>{' '}
            <Link className="btn btn-ghost btn-sm" to="/developers/errors">
              Limit headers
            </Link>
          </p>
        </div>
      </section>

      <section className="pub-legal-block">
        <span className="pub-legal-num">→</span>
        <div>
          <h2>Next</h2>
          <p>
            Catalog: <Link to="/models">Models</Link>. HTTP contract: <Link to="/developers">Reference</Link>.
          </p>
          <p>
            <Link className="btn btn-primary btn-sm" to="/register">
              Create an account
            </Link>{' '}
            <Link className="btn btn-secondary btn-sm" to="/login">
              Sign in for the wizard
            </Link>
          </p>
        </div>
      </section>
    </article>
  )
}
