import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { userApi, type CustomerApiKey } from '../auth/userApi'
import { ProviderIcon } from './ProviderIcon'
import { apiBase } from '../lib/brand'
import '../pages/Landing.css'
import '../pages/Status.css'
import './ModelPreview.css'

const EXAMPLE_PROMPT = 'Explain the difference between concurrency and parallelism.'

type HourState = 'up' | 'load' | 'partial' | 'down' | 'none'
type ModelState = 'operational' | 'degraded' | 'partial' | 'outage' | 'unknown'

type StatusModel = {
  id: string
  name: string
  provider: string
  state: ModelState
  uptimePct: number | null
  hours: Array<{ at: string; state: HourState }>
}

let statusModelsCache: StatusModel[] | null = null
let statusFetchPromise: Promise<StatusModel[] | null> | null = null

export function setStatusModelsCache(models: StatusModel[]) {
  statusModelsCache = models
}

function fetchStatusModelsCached(): Promise<StatusModel[] | null> {
  if (statusModelsCache) return Promise.resolve(statusModelsCache)
  if (!statusFetchPromise) {
    statusFetchPromise = fetch('/api/public/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.models) {
          statusModelsCache = data.models
          return data.models
        }
        return null
      })
      .catch(() => null)
      .finally(() => {
        statusFetchPromise = null
      })
  }
  return statusFetchPromise
}

function findStatusModel(models: StatusModel[] | null, target: { id: string; catalogId?: string; name: string }) {
  if (!models) return null
  return (
    models.find(
      (m: StatusModel) =>
        m.id === target.catalogId ||
        m.id === target.id ||
        m.name.toLowerCase() === target.name.toLowerCase() ||
        m.id.replace('/', '-') === target.id,
    ) ?? null
  )
}

const STATE_LABEL: Record<ModelState, string> = {
  operational: 'Operational',
  degraded: 'High load',
  partial: 'Partial outage',
  outage: 'Outage',
  unknown: 'Operational',
}

const HOUR_LABEL: Record<HourState, string> = {
  up: 'operational',
  load: 'high load',
  partial: 'partial outage',
  down: 'outage',
  none: 'operational',
}

function formatHour(iso: string) {
  const date = new Date(iso)
  const day = String(date.getUTCDate()).padStart(2, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  return `${day}.${month}, ${hour}:00 UTC`
}

function uptimeLabel(value: number | null) {
  if (value == null) return '100.0%'
  return `${value.toFixed(1)}%`
}

type ChatModel = {
  kind: 'chat'
  id: string
  catalogId: string
  name: string
  provider: string
  dollarsPer1M: number
  outputDollarsPer1M?: number
  eventDiscountPct?: number | null
  isFree: boolean
  healthLabel: string
  healthStatus: string
}

export type PreviewModel = ChatModel

type CodeLang = 'curl' | 'python' | 'node'

export function ModelPreviewModal({
  model,
  onClose,
  onCopy,
}: {
  model: PreviewModel | null
  onClose: () => void
  onCopy: (text: string) => void
}) {
  useEffect(() => {
    if (!model) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [model, onClose])

  if (!model) return null

  return createPortal(
    <div className="mp-root" role="presentation">
      <button className="mp-backdrop" type="button" aria-label="Close dialog" onClick={onClose} />
      <div className="mp-panel" role="dialog" aria-modal="true" aria-labelledby="model-preview-title">
        <button className="mp-close" type="button" onClick={onClose} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>

        <header className="mp-head">
          <div className="mp-head-left">
            <h2 id="model-preview-title">{model.name}</h2>
          </div>
        </header>

        <ChatBody model={model} onCopy={onCopy} />
      </div>
    </div>,
    document.body,
  )
}

function isDecisionPreviewModel(model: ChatModel) {
  const lowerId = model.id.trim().toLowerCase()
  const lowerCat = model.catalogId.trim().toLowerCase()
  const lowerProv = model.provider.trim().toLowerCase()
  return (
    lowerProv === 'jev group' ||
    lowerProv === 'jev' ||
    lowerProv === 'decisions' ||
    lowerId.includes('jev-') ||
    lowerCat.includes('jev-') ||
    lowerId.includes('drex') ||
    lowerCat.includes('drex') ||
    lowerId.includes('subq') ||
    lowerCat.includes('subq') ||
    lowerId.includes('decision') ||
    lowerCat.includes('decision')
  )
}

function ChatBody({ model, onCopy }: { model: ChatModel; onCopy: (text: string) => void }) {
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [lang, setLang] = useState<CodeLang>('curl')
  const [copiedCode, setCopiedCode] = useState(false)
  const [statusModel, setStatusModel] = useState<StatusModel | null>(() => findStatusModel(statusModelsCache, model))
  const isDecision = isDecisionPreviewModel(model)

  useEffect(() => {
    let cancelled = false
    userApi
      .keys()
      .then((data) => {
        if (cancelled) return
        setApiKey(pickKey(data.keys))
      })
      .catch(() => {
        if (!cancelled) setApiKey(null)
      })

    void fetchStatusModelsCached().then((models) => {
      if (cancelled || !models) return
      const match = findStatusModel(models, model)
      if (match) setStatusModel(match)
    })
    return () => {
      cancelled = true
    }
  }, [model])

  function getCodeText() {
    if (lang === 'python') return pythonSnippet(model.id, apiKey, isDecision)
    if (lang === 'node') return nodeSnippet(model.id, apiKey, isDecision)
    return curlText(model.id, apiKey, isDecision)
  }

  return (
    <div className="mp-body mp-body-chat">
      {/* 1. Live Status & 7-Day Uptime Bar for this model */}
      <section className="mp-status-container" aria-label="Model Operational Status">
        {statusModel ? (
          <article className="status-row mp-model-status-row">
            <div className="mp-status-header-line">
              <div className="status-row-id">
                <ProviderIcon provider={model.provider} modelId={model.catalogId} size={18} />
                <div>
                  <strong>{model.name}</strong>
                </div>
              </div>
              <div className="status-row-meta mp-status-meta-stack">
                <span className={`status-state is-${statusModel.state}`}>{STATE_LABEL[statusModel.state]}</span>
                <div className="mp-status-digits">
                  <strong>{uptimeLabel(statusModel.uptimePct)}</strong>
                  <small>7d uptime</small>
                </div>
              </div>
            </div>
            <div
              className="status-bars"
              role="img"
              aria-label={`${model.name}: ${STATE_LABEL[statusModel.state]}`}
            >
              {statusModel.hours.map((hour) => (
                <span
                  key={hour.at}
                  className={`status-bar is-${hour.state}`}
                  title={`${formatHour(hour.at)} — ${HOUR_LABEL[hour.state]}`}
                />
              ))}
            </div>
          </article>
        ) : (
          <article className="status-row mp-model-status-row">
            <div className="mp-status-header-line">
              <div className="status-row-id">
                <ProviderIcon provider={model.provider} modelId={model.catalogId} size={18} />
                <div>
                  <strong>{model.name}</strong>
                </div>
              </div>
              <div className="status-row-meta mp-status-meta-stack">
                <span className="status-state is-operational">Operational</span>
                <div className="mp-status-digits">
                  <strong>100.0%</strong>
                  <small>7d uptime</small>
                </div>
              </div>
            </div>
            <div className="status-bars" role="img" aria-label={`${model.name}: Operational`}>
              {Array.from({ length: 168 }).map((_, i) => (
                <span key={i} className="status-bar is-up" title="Operational" />
              ))}
            </div>
          </article>
        )}
      </section>

      {/* 2. Interactive Integration Code Sandbox */}
      <section className="mp-try" aria-label="Try via API">
        <div className="mp-sandbox-header">
          <div className="mp-sandbox-title">
            <span>API Playground & Integration</span>
          </div>

          <div className="mp-sandbox-controls">
            <div className="mp-lang-tabs" role="tablist">
              <button
                type="button"
                className={`mp-lang-tab ${lang === 'curl' ? 'is-active' : ''}`}
                onClick={() => setLang('curl')}
              >
                cURL
              </button>
              <button
                type="button"
                className={`mp-lang-tab ${lang === 'python' ? 'is-active' : ''}`}
                onClick={() => setLang('python')}
              >
                Python
              </button>
              <button
                type="button"
                className={`mp-lang-tab ${lang === 'node' ? 'is-active' : ''}`}
                onClick={() => setLang('node')}
              >
                Node.js
              </button>
            </div>

            <button
              className="mp-btn-copy-code"
              type="button"
              onClick={() => {
                onCopy(getCodeText())
                setCopiedCode(true)
                setTimeout(() => setCopiedCode(false), 1800)
              }}
              aria-label="Copy code"
            >
              {copiedCode ? (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.8">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span style={{ color: '#34d399' }}>Copied!</span>
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span>Copy snippet</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div className="mp-terminal-box">
          <div className="mp-terminal-topbar">
            <div className="mp-mac-dots" aria-hidden>
              <span />
              <span />
              <span />
            </div>
            <span className="mp-terminal-endpoint">POST {apiBase()}/{isDecision ? 'decisions' : 'chat/completions'}</span>
            <span className="mp-terminal-target">{model.id}</span>
          </div>
          <pre className="mp-code-pre">
            <code>{getCodeText()}</code>
          </pre>
        </div>
      </section>
    </div>
  )
}

function pythonSnippet(modelId: string, apiKey: string | null, isDecision = false) {
  const token = apiKey?.trim() || '$API_KEY'
  if (isDecision) {
    return `import requests

response = requests.post(
    "${apiBase()}/decisions",
    headers={"Authorization": "Bearer ${token}"},
    json={
        "model": "${modelId}",
        "state": "User wants to deploy a Node.js app with Nginx.",
        "questions": {
            "is_safe": {
                "type": "noul",
                "instructions": "Is this request safe and benign?"
            }
        }
    },
)
print(response.json()["answers"])`
  }
  return `from openai import OpenAI

client = OpenAI(
    api_key="${token}",
    base_url="${apiBase()}",
)

response = client.chat.completions.create(
    model="${modelId}",
    messages=[{"role": "user", "content": "${EXAMPLE_PROMPT}"}],
)
print(response.choices[0].message.content)`
}

function nodeSnippet(modelId: string, apiKey: string | null, isDecision = false) {
  const token = apiKey?.trim() || '$API_KEY'
  if (isDecision) {
    return `const response = await fetch("${apiBase()}/decisions", {
  method: "POST",
  headers: {
    Authorization: "Bearer ${token}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "${modelId}",
    state: "User wants to deploy a Node.js app with Nginx.",
    questions: {
      is_safe: {
        type: "noul",
        instructions: "Is this request safe and benign?",
      },
    },
  }),
});

const data = await response.json();
console.log(data.answers);`
  }
  return `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "${token}",
  baseURL: "${apiBase()}",
});

const response = await client.chat.completions.create({
  model: "${modelId}",
  messages: [{ role: "user", content: "${EXAMPLE_PROMPT}" }],
});

console.log(response.choices[0].message.content);`
}

function pickKey(keys: CustomerApiKey[]) {
  const usable = keys.filter((key) => key.status === 'active' && Boolean(key.secret?.trim()))
  if (usable.length === 0) return null
  return usable.slice().sort((a, b) => {
    const aUsed = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0
    const bUsed = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0
    if (aUsed !== bUsed) return bUsed - aUsed
    return Date.parse(b.createdAt) - Date.parse(a.createdAt)
  })[0].secret
}

function curlText(modelId: string, apiKey: string | null, isDecision = false) {
  const token = apiKey?.trim() || '$API_KEY'
  if (isDecision) {
    return [
      `curl ${apiBase()}/decisions \\`,
      `  -H "Authorization: Bearer ${token}" \\`,
      '  -H "Content-Type: application/json" \\',
      `  -d '{"model":"${modelId}","state":"User wants to deploy a Node.js app with Nginx.","questions":{"is_safe":{"type":"noul","instructions":"Is this request safe?"}}}'`,
    ].join('\n')
  }
  return [
    `curl ${apiBase()}/chat/completions \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model":"${modelId}","messages":[{"role":"user","content":"${EXAMPLE_PROMPT}"}]}'`,
  ].join('\n')
}
