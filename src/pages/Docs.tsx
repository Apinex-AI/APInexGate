import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useToast } from '../components/Toast'
import { userApi, type CustomerApiKey } from '../auth/userApi'
import { apiBase, apiOrigin, brandSlug, getBrand, siteName } from '../lib/brand'
import './Docs.css'

type ToolId = 'cursor' | 'opencode' | 'codex' | 'claude' | 'hermes' | 'kimi' | 'api'
type OsId = 'macos' | 'linux' | 'windows'

type InstallMeta = {
  baseUrl: string
  siteUrl: string
  defaultModel: string
  models: Array<{ id: string; name: string }>
}

const TOOLS: Array<{ id: ToolId; label: string; blurb: string; icon: string }> = [
  { id: 'codex', label: 'Codex', blurb: 'Codex App, CLI, Extension', icon: '/brand/codex.png' },
  { id: 'claude', label: 'Claude Code', blurb: 'Anthropic CLI · Messages API', icon: '/brand/claude.png' },
  { id: 'opencode', label: 'OpenCode', blurb: 'OpenCode AI · Terminal Agent', icon: '/brand/opencode.png' },
  { id: 'cursor', label: 'Cursor', blurb: 'OpenAI-compatible base URL + API key', icon: '/brand/cursor.png' },
  { id: 'hermes', label: 'Hermes', blurb: 'Hermes AI · Desktop & Terminal Agent', icon: '/brand/hermes.png' },
  { id: 'kimi', label: 'Kimi CLI', blurb: 'Kimi Code CLI · OpenAI-compatible', icon: '/brand/moonshot.png' },
  { id: 'api', label: 'API / SDK', blurb: 'curl, OpenAI SDK, custom apps', icon: '/brand/mark.png' },
]

const OS_OPTIONS: Array<{ id: OsId; label: string; desc: string }> = [
  { id: 'macos', label: 'macOS', desc: 'Apple Silicon & Intel · zsh / bash' },
  { id: 'linux', label: 'Linux', desc: 'Ubuntu, Debian, Arch, Fedora · bash' },
  { id: 'windows', label: 'Windows', desc: 'Windows 10/11 · PowerShell & WSL' },
]

/** Prefer recently used active keys; else newest created. */
function pickPreferredKey(keys: CustomerApiKey[]) {
  const usable = keys.filter((key) => key.status === 'active')
  if (usable.length === 0) return null
  return usable.slice().sort((a, b) => {
    const aUsed = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0
    const bUsed = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0
    if (aUsed !== bUsed) return bUsed - aUsed
    return Date.parse(b.createdAt) - Date.parse(a.createdAt)
  })[0]
}

export function Docs({ embedded = false }: { embedded?: boolean } = {}) {
  const location = useLocation()
  const { toast } = useToast()
  const [meta, setMeta] = useState<InstallMeta | null>(null)
  const [keys, setKeys] = useState<CustomerApiKey[]>([])
  const [loadingKeys, setLoadingKeys] = useState(true)
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward')
  const [tool, setTool] = useState<ToolId>('cursor')
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null)
  const [creatingKey, setCreatingKey] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [os, setOs] = useState<OsId>('macos')
  const [opencodeMode, setOpencodeMode] = useState<'manual' | 'script'>('script')
  const [codexMode, setCodexMode] = useState<'manual' | 'script'>('script')
  const [claudeMode, setClaudeMode] = useState<'manual' | 'script'>('script')
  const [hermesMode, setHermesMode] = useState<'manual' | 'script'>('script')
  const [kimiMode, setKimiMode] = useState<'manual' | 'script'>('script')

  function goToStep(next: 1 | 2 | 3 | 4) {
    if (next === step) return
    setDirection(next > step ? 'forward' : 'backward')
    setStep(next)
  }

  // Always reset to step 1 when the user navigates into Setup
  useEffect(() => {
    setStep(1)
    setDirection('forward')
  }, [location.key, location.pathname])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      fetch('/api/install/meta', { credentials: 'include' }).then(async (res) => {
        if (!res.ok) throw new Error('meta')
        return (await res.json()) as InstallMeta
      }),
      userApi.keys(),
    ])
      .then(([installMeta, keyData]) => {
        if (cancelled) return
        setMeta(installMeta)
        const active = keyData.keys.filter((key) => key.status === 'active')
        setKeys(active)
        setLoadingKeys(false)
        const preferred = pickPreferredKey(active)
        if (preferred) setSelectedKeyId(preferred.id)
      })
      .catch(() => {
        if (cancelled) return
        setMeta({
          baseUrl: apiBase(),
          siteUrl: getBrand().siteUrl || window.location.origin,
          defaultModel: 'free/glm-5.3-flash',
          models: [],
        })
        setLoadingKeys(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const baseUrl = meta?.baseUrl ?? apiBase()
  const site = meta?.siteUrl ?? window.location.origin
  const defaultModel = meta?.defaultModel ?? 'free/glm-5.3-flash'
  
  const chosenKey = keys.find((k) => k.id === selectedKeyId) || pickPreferredKey(keys)
  const fullKey = chosenKey?.prefix ? `${chosenKey.prefix}…` : '$APINEX_API_KEY'

  async function handleCreateNewKey(e: React.FormEvent) {
    e.preventDefault()
    const name = newKeyName.trim() || `${TOOLS.find((t) => t.id === tool)?.label ?? 'Client'} Key`
    setCreatingKey(true)
    try {
      const data = await userApi.createKey({ name })
      const createdKey = { ...data.key }
      setKeys((prev) => [createdKey, ...prev])
      setSelectedKeyId(createdKey.id)
      setNewKeyName('')
      toast('API key created and selected!')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create key', 'error')
    } finally {
      setCreatingKey(false)
    }
  }

  function copy(text: string, label = 'Copied') {
    if (!text.trim()) {
      toast('Nothing to copy', 'error')
      return
    }
    void navigator.clipboard?.writeText(text).then(
      () => toast(label),
      () => toast('Could not copy', 'error'),
    )
  }

  const selectedToolInfo = TOOLS.find((t) => t.id === tool)

  return (
    <div className={embedded ? 'docs-page docs-page-embedded' : 'page docs-page'}>
      {embedded ? null : (
        <div className="page-header docs-header-cockpit">
          <div>
            <h1>Setup &amp; Client Guides</h1>
            <p>Connect your preferred editor or agent to {siteName()} in 3 simple steps.</p>
          </div>
          <div className="docs-header-actions">
            <a className="btn btn-secondary btn-sm" href="/docs" target="_blank" rel="noreferrer">
              API Docs ↗
            </a>
            <Link className="btn btn-primary btn-sm" to="/keys">
              All Keys →
            </Link>
          </div>
        </div>
      )}

      {/* Stepper Navigation bar */}
      <nav className="setup-wizard-steps" aria-label="Setup progress">
        <button
          type="button"
          className={`setup-wizard-step-btn ${step === 1 ? 'is-active' : ''} ${step > 1 ? 'is-completed' : ''}`}
          onClick={() => goToStep(1)}
        >
          <span className="setup-step-bubble">1</span>
          <div className="setup-step-text">
            <span className="setup-step-sub">Step 1</span>
            <span className="setup-step-main">
              {step > 1 ? selectedToolInfo?.label ?? 'Choose IDE' : 'Choose IDE'}
            </span>
          </div>
        </button>

        <span className="setup-wizard-divider" aria-hidden="true" />

        <button
          type="button"
          className={`setup-wizard-step-btn ${step === 2 ? 'is-active' : ''} ${step > 2 ? 'is-completed' : ''}`}
          onClick={() => goToStep(2)}
        >
          <span className="setup-step-bubble">2</span>
          <div className="setup-step-text">
            <span className="setup-step-sub">Step 2</span>
            <span className="setup-step-main">
              {step > 2 ? (chosenKey ? chosenKey.name || 'API Key' : 'API Key') : 'Select Key'}
            </span>
          </div>
        </button>

        <span className="setup-wizard-divider" aria-hidden="true" />

        <button
          type="button"
          className={`setup-wizard-step-btn ${step === 3 ? 'is-active' : ''} ${step > 3 ? 'is-completed' : ''}`}
          onClick={() => goToStep(3)}
        >
          <span className="setup-step-bubble">3</span>
          <div className="setup-step-text">
            <span className="setup-step-sub">Step 3</span>
            <span className="setup-step-main">
              {step > 3 ? (OS_OPTIONS.find((o) => o.id === os)?.label || 'OS') : 'Select OS'}
            </span>
          </div>
        </button>

        <span className="setup-wizard-divider" aria-hidden="true" />

        <button
          type="button"
          className={`setup-wizard-step-btn ${step === 4 ? 'is-active' : ''}`}
          onClick={() => goToStep(4)}
        >
          <span className="setup-step-bubble">4</span>
          <div className="setup-step-text">
            <span className="setup-step-sub">Step 4</span>
            <span className="setup-step-main">Configuration</span>
          </div>
        </button>
      </nav>

      <div className="setup-stage-viewport">
        {/* STEP 1: Select IDE / Client */}
        {step === 1 && (
          <section className={`setup-view-step step-slide-${direction}`} aria-label="Step 1: Choose IDE">
            <div className="setup-step-header">
              <div>
                <h2>Select your IDE or Agent</h2>
                <p>Pick the client or coding assistant you want to connect.</p>
              </div>
            </div>

            <div className="setup-ide-grid">
              {TOOLS.map((item) => {
                const isSelected = tool === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`setup-ide-card ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => {
                      setTool(item.id)
                    }}
                  >
                    <div className="setup-ide-icon-wrap">
                      <img src={item.icon} alt="" width={34} height={34} draggable="false" />
                    </div>
                    <div className="setup-ide-meta">
                      <strong className="setup-ide-title">{item.label}</strong>
                      <span className="setup-ide-blurb">{item.blurb}</span>
                    </div>
                    <div className="setup-ide-check" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="setup-nav-footer">
              <div className="setup-nav-selection-hint">
                Selected client: <strong>{selectedToolInfo?.label}</strong>
              </div>
              <button
                type="button"
                className="btn btn-primary setup-next-btn"
                onClick={() => goToStep(2)}
              >
                <span>Continue to API Key</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </section>
        )}

        {/* STEP 2: Select or Create Key */}
        {step === 2 && (
          <section className={`setup-view-step step-slide-${direction}`} aria-label="Step 2: API Key Selection">
            <div className="setup-keys-stage">
              {/* Create new key card */}
              <form className="setup-create-key-card" onSubmit={handleCreateNewKey}>
                <div className="setup-create-key-info">
                  <strong>Create a new key</strong>
                  <p>Generate a dedicated key with full secret display.</p>
                </div>
                <div className="setup-create-key-inputs">
                  <input
                    type="text"
                    className="input setup-key-name-input"
                    placeholder={`${selectedToolInfo?.label ?? 'Client'} Key`}
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    disabled={creatingKey}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={creatingKey}
                  >
                    {creatingKey ? 'Creating…' : '+ Generate Key'}
                  </button>
                </div>
              </form>

              {/* List of existing keys */}
              <div className="setup-keys-list-container">
                <span className="setup-keys-list-title">Existing Keys</span>
                {loadingKeys ? (
                  <div className="setup-keys-empty">Loading active keys…</div>
                ) : keys.length === 0 ? (
                  <div className="setup-keys-empty">
                    No active keys found. Use the generator above to create one.
                  </div>
                ) : (
                  <div className="setup-keys-grid">
                    {keys.map((k) => {
                      const isSelected = (chosenKey?.id === k.id)
                      return (
                        <button
                          key={k.id}
                          type="button"
                          className={`setup-key-card ${isSelected ? 'is-selected' : ''}`}
                          onClick={() => setSelectedKeyId(k.id)}
                        >
                          <div className="setup-key-card-head">
                            <div className="setup-key-icon-wrap" aria-hidden="true">
                              <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="7.5" cy="15.5" r="4.5" />
                                <path d="m10.7 12.3 8.3-8.3M15.5 7.5l2 2M18 5l2 2" strokeLinecap="round" />
                              </svg>
                            </div>
                            <div className="setup-key-card-meta">
                              <strong>{k.name || 'API Key'}</strong>
                              <code className="mono">{k.prefix}…</code>
                            </div>
                            <div className="setup-key-radio" aria-hidden="true">
                              <div className="setup-key-radio-inner" />
                            </div>
                          </div>

                          <div className="setup-key-card-footer">
                            <span className="setup-key-badge is-masked">Secret hidden (prefix only)</span>
                            {k.lastUsedAt ? (
                              <small className="setup-key-lastused">
                                Active {new Date(k.lastUsedAt).toLocaleDateString()}
                              </small>
                            ) : null}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="setup-nav-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => goToStep(1)}
              >
                ← Back to IDEs
              </button>
              <button
                type="button"
                className="btn btn-primary setup-next-btn"
                onClick={() => {
                  if (!chosenKey) {
                    toast('Please create or choose an API key first', 'error')
                    return
                  }
                  goToStep(3)
                }}
              >
                <span>Continue to Operating System</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </section>
        )}

        {/* STEP 3: Select Operating System */}
        {step === 3 && (
          <section className={`setup-view-step step-slide-${direction}`} aria-label="Step 3: Operating System Selection">
            <div className="setup-step-header">
              <div>
                <h2>Select your Operating System</h2>
                <p>Choose your platform to customize commands, paths, and setup scripts.</p>
              </div>
            </div>

            <div className="setup-os-cards-grid">
              {OS_OPTIONS.map((item) => {
                const isSelected = os === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`setup-os-card ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => setOs(item.id)}
                  >
                    <div className="setup-os-card-icon" aria-hidden="true">
                      {item.id === 'macos' && (
                        <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                          <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.37c.58-.7.97-1.68.86-2.66-.84.03-1.85.56-2.45 1.26-.53.61-.99 1.6-.87 2.55.93.07 1.89-.45 2.46-1.15z" />
                        </svg>
                      )}
                      {item.id === 'linux' && (
                        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="4 17 10 11 4 5" />
                          <line x1="12" y1="19" x2="20" y2="19" />
                        </svg>
                      )}
                      {item.id === 'windows' && (
                        <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                          <path d="M3 5.479l7.377-1.016v7.127H3V5.48zm0 13.042l7.377 1.017v-7.04H3v6.023zm8.188 1.13l9.812 1.349V11.59h-9.812v8.061zm0-15.651v8.012H21V3.651l-9.812 1.349z" />
                        </svg>
                      )}
                    </div>
                    <div className="setup-os-card-meta">
                      <strong className="setup-os-card-title">{item.label}</strong>
                      <span className="setup-os-card-desc">{item.desc}</span>
                    </div>
                    <div className="setup-os-check" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="setup-nav-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => goToStep(2)}
              >
                ← Back to API Key
              </button>
              <button
                type="button"
                className="btn btn-primary setup-next-btn"
                onClick={() => goToStep(4)}
              >
                <span>Continue to Configuration</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </section>
        )}

        {/* STEP 4: Configuration (Script & Manual) */}
        {step === 4 && (
          <section className={`card docs-main docs-tone-${tool} step-slide-${direction}`} aria-label="Step 4: Configuration">
            <div className="docs-instructions-head setup-step3-head">
              <div className="setup-step3-info">
                <div className="setup-step3-badges">
                  <span className="setup-active-pill">
                    <img src={selectedToolInfo?.icon} alt="" width={15} height={15} />
                    <span>{selectedToolInfo?.label}</span>
                  </span>
                  <span className="setup-active-pill is-os">
                    <span>{OS_OPTIONS.find((item) => item.id === os)?.label}</span>
                  </span>
                </div>
                <h2>
                  Configuring {selectedToolInfo?.label}
                </h2>
                <p className="docs-inline-note docs-inline-note-tight">
                  Base URL: <code className="mono">{baseUrl}</code>
                </p>
              </div>

              <div className="setup-step3-top-actions">
                {tool === 'opencode' || tool === 'codex' || tool === 'claude' || tool === 'hermes' || tool === 'kimi' ? (
                  <div className="docs-tabs setup-mode-tabs">
                    <button
                      type="button"
                      className={
                        (tool === 'opencode'
                          ? opencodeMode
                          : tool === 'codex'
                            ? codexMode
                            : tool === 'claude'
                              ? claudeMode
                              : tool === 'kimi'
                                ? kimiMode
                                : hermesMode) === 'script'
                          ? 'is-active'
                          : ''
                      }
                      onClick={() => {
                        if (tool === 'opencode') setOpencodeMode('script')
                        else if (tool === 'codex') setCodexMode('script')
                        else if (tool === 'claude') setClaudeMode('script')
                        else if (tool === 'kimi') setKimiMode('script')
                        else setHermesMode('script')
                      }}
                    >
                      Script
                    </button>
                    <button
                      type="button"
                      className={
                        (tool === 'opencode'
                          ? opencodeMode
                          : tool === 'codex'
                            ? codexMode
                            : tool === 'claude'
                              ? claudeMode
                              : tool === 'kimi'
                                ? kimiMode
                                : hermesMode) === 'manual'
                          ? 'is-active'
                          : ''
                      }
                      onClick={() => {
                        if (tool === 'opencode') setOpencodeMode('manual')
                        else if (tool === 'codex') setCodexMode('manual')
                        else if (tool === 'claude') setClaudeMode('manual')
                        else if (tool === 'kimi') setKimiMode('manual')
                        else setHermesMode('manual')
                      }}
                    >
                      Manual
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            {chosenKey && (
              <div className="setup-secret-notice">
                <span>
                  Using key: <strong>{chosenKey.name}</strong> ({chosenKey.prefix ? `${chosenKey.prefix}…` : 'active'}).
                  Replace the placeholder with your secret key when running outside this guide.
                </span>
              </div>
            )}

            {tool === 'cursor' ? (
              <CursorManual
                baseUrl={baseUrl}
                apiKey={fullKey}
                defaultModel="free/glm-5.3-flash"
                onCopy={copy}
              />
            ) : null}
            {tool === 'opencode' ? (
              <OpenCodeGuide
                mode={opencodeMode}
                os={os}
                baseUrl={baseUrl}
                site={site}
                apiKey={fullKey}
                defaultModel={defaultModel}
                models={meta?.models ?? []}
                onCopy={copy}
              />
            ) : null}

            {tool === 'hermes' ? (
              <HermesGuide
                mode={hermesMode}
                os={os}
                baseUrl={baseUrl}
                site={site}
                apiKey={fullKey}
                defaultModel={defaultModel}
                models={meta?.models ?? []}
                onCopy={copy}
              />
            ) : null}
            {tool === 'kimi' ? (
              <KimiGuide mode={kimiMode} os={os} baseUrl={baseUrl} site={site} apiKey={fullKey} onCopy={copy} />
            ) : null}
            {tool === 'codex' ? (
              <CodexGuide
                mode={codexMode}
                os={os}
                baseUrl={baseUrl}
                site={site}
                apiKey={fullKey}
                defaultModel={defaultModel}
                onCopy={copy}
              />
            ) : null}
            {tool === 'claude' ? (
              <ClaudeGuide
                mode={claudeMode}
                os={os}
                baseUrl={baseUrl}
                site={site}
                apiKey={fullKey}
                onCopy={copy}
              />
            ) : null}
            {tool === 'api' ? (
              <ApiManual baseUrl={baseUrl} apiKey={fullKey} defaultModel={defaultModel} onCopy={copy} />
            ) : null}

            <div className="setup-step3-bottom-nav">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => goToStep(3)}
              >
                ← Back to Operating System
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => goToStep(1)}
              >
                Choose different IDE
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

function CopyBlock({ title, value, onCopy }: { title?: string; value: string; onCopy: (text: string, label?: string) => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="docs-copy-block">
      <div className="docs-command-header">
        <div className="docs-mac-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        {title ? <span className="docs-copy-title">{title}</span> : <span className="docs-copy-title">Terminal / Config</span>}
        <button
          className="docs-copy-btn"
          type="button"
          onClick={() => {
            onCopy(value, 'Copied')
            setCopied(true)
            setTimeout(() => setCopied(false), 1800)
          }}
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <div className="docs-command">
        <pre>
          <code>{value || '…'}</code>
        </pre>
      </div>
    </div>
  )
}

function ApiKeyBlock({ apiKey, onCopy }: { apiKey: string; onCopy: (text: string, label?: string) => void }) {
  if (!apiKey.trim()) {
    return (
      <div className="docs-key-missing">
        <Link className="btn btn-primary btn-sm" to="/keys">
          Create API key
        </Link>
      </div>
    )
  }
  return <CopyBlock value={apiKey} onCopy={onCopy} />
}


function KimiGuide({
  mode,
  os,
  baseUrl,
  site,
  apiKey,
  onCopy,
}: {
  mode: 'manual' | 'script'
  os: OsId
  baseUrl: string
  site: string
  apiKey: string
  onCopy: (text: string, label?: string) => void
}) {
  const configPath = os === 'windows' ? '%USERPROFILE%\\.kimi-code\\config.toml' : '~/.kimi-code/config.toml'
  const script =
    os === 'windows'
      ? `$env:API_KEY="${apiKey || 'sk-…'}"; irm "${site}/i?os=windows&tool=kimi" | iex`
      : `bash <(curl -fsSL "${site}/i?tool=kimi") ${apiKey || 'sk-…'}`
  const toml = `default_model = "${brandSlug()}/free/glm-5.3-flash"

[providers.${brandSlug()}]
type = "openai"
base_url = "${baseUrl}"
api_key = "${apiKey || 'sk-…'}"

[models."${brandSlug()}/free/glm-5.3-flash"]
provider = "${brandSlug()}"
model = "free/glm-5.3-flash"
max_context_size = 1000000
capabilities = ["tool_use", "thinking"]

[models."${brandSlug()}/gpt-6.1-sol"]
provider = "${brandSlug()}"
model = "gpt-6.1-sol"
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
capabilities = ["tool_use", "thinking"]

[models."${brandSlug()}/kimi-k3"]
provider = "${brandSlug()}"
model = "kimi-k3"
max_context_size = 1000000
capabilities = ["tool_use", "thinking"]

[models."${brandSlug()}/muse-spark-1.3"]
provider = "${brandSlug()}"
model = "muse-spark-1.3"
max_context_size = 500000
capabilities = ["tool_use", "thinking"]`

  if (mode === 'script') {
    return (
      <div className="docs-manual">
        <ol className="docs-steps">
          <li>Install Kimi Code CLI, then run the command below. It writes {configPath} and keeps a backup of the previous file.</li>
          <li>
            <CopyBlock title={os === 'windows' ? 'PowerShell' : 'Terminal'} value={script} onCopy={onCopy} />
          </li>
          <li>
            Check with <code className="mono">kimi doctor</code>, then{' '}
            <code className="mono">kimi -p "Reply with the single word pong" -m {brandSlug()}/free/glm-5.3-flash</code>.
          </li>
        </ol>
        <p className="field-hint">
          Model aliases: <code className="mono">{brandSlug()}/free/glm-5.3-flash</code>, <code className="mono">{brandSlug()}/gpt-6.1-sol</code>, <code className="mono">{brandSlug()}/claude-opus-5.5</code>, <code className="mono">{brandSlug()}/grok-4.7</code>, <code className="mono">{brandSlug()}/kimi-k3</code>, <code className="mono">{brandSlug()}/free/muse-spark-1.3</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="docs-manual">
      <ol className="docs-steps">
        <li>
          Create <code className="mono">{configPath}</code>.
        </li>
        <li>
          <CopyBlock title="config.toml" value={toml} onCopy={onCopy} />
        </li>
        <li>
          Run <code className="mono">kimi doctor</code>. The model id inside the file is <code className="mono">free/kimi-k3</code>.
        </li>
      </ol>
    </div>
  )
}

function CursorManual({
  baseUrl,
  apiKey,
  defaultModel,
  onCopy,
}: {
  baseUrl: string
  apiKey: string
  defaultModel: string
  onCopy: (text: string, label?: string) => void
}) {
  return (
    <div className="docs-manual">
      <ol className="docs-steps">
        <li>
          Open <strong>Cursor Settings</strong> → <strong>Models</strong> (
          <code className="mono">Cmd/Ctrl + Shift + J</code>)
        </li>
        <li>
          Enable <strong>Override OpenAI Base URL</strong> and paste:
          <CopyBlock value={baseUrl} onCopy={onCopy} />
        </li>
        <li>
          Paste into <strong>OpenAI API Key</strong>:
          <ApiKeyBlock apiKey={apiKey} onCopy={onCopy} />
        </li>
        <li>
          Add custom model ID(s), then click Verify:
          <CopyBlock title="Recommended model (Free)" value={defaultModel} onCopy={onCopy} />
          <p className="docs-substep-note" style={{ marginTop: '10px', marginBottom: '4px' }}>
            Popular models to add:
          </p>
          <div className="docs-copy-pills">
            {['free/glm-5.3-flash', 'gpt-6.1-sol', 'claude-opus-5.5', 'grok-4.7', 'kimi-k3', 'free/muse-spark-1.3'].map((m) => (
              <button
                key={m}
                type="button"
                className="docs-pill-btn"
                onClick={() => onCopy(m, `Model ${m}`)}
                title={`Click to copy ${m}`}
              >
                <code>{m}</code>
                <span className="docs-pill-copy">copy</span>
              </button>
            ))}
          </div>
        </li>
      </ol>
      <p className="field-hint">Cursor connects directly via OpenAI Chat Completions on the base URL.</p>
    </div>
  )
}

function OpenCodeGuide({
  mode,
  os,
  baseUrl,
  site,
  apiKey,
  defaultModel,
  models,
  onCopy,
}: {
  mode: 'manual' | 'script'
  os: OsId
  baseUrl: string
  site: string
  apiKey: string
  defaultModel: string
  models: Array<{ id: string; name: string }>
  onCopy: (text: string, label?: string) => void
}) {
  const fallbackModels = [
    { id: 'free/glm-5.3-flash', name: 'GLM 5.3 Flash (Free)' },
    { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol' },
    { id: 'claude-opus-5.5', name: 'Claude Opus 5.5' },
    { id: 'grok-4.7', name: 'Grok 4.7' },
    { id: 'kimi-k3', name: 'Kimi K3' },
    { id: 'free/muse-spark-1.3', name: 'Muse Spark 1.3' },
  ]
  const modelList = models.length > 0 ? models : fallbackModels
  const modelsJson = modelList
    .slice(0, 12)
    .map((model) => `        ${JSON.stringify(model.id)}: { "name": ${JSON.stringify(model.name)} }`)
    .join(',\n')
  const openCodeJson = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "${brandSlug()}/${defaultModel}",
  "provider": {
    "${brandSlug()}": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "${siteName()}",
      "options": {
        "baseURL": "${baseUrl}",
        "apiKey": "${apiKey || 'sk-…'}"
      },
      "models": {
${modelsJson}
      }
    }
  }
}`

  const configPath =
    os === 'windows' ? '%USERPROFILE%\\.config\\opencode\\opencode.json' : '~/.config/opencode/opencode.json'
  const script =
    os === 'windows'
      ? `$env:API_KEY="${apiKey || 'sk-…'}"; irm "${site}/i?os=windows&tool=opencode" | iex`
      : `bash <(curl -fsSL "${site}/i?tool=opencode") ${apiKey || 'sk-…'}`

  if (mode === 'script') {
    return (
      <div className="docs-manual">
        <ol className="docs-steps">
          <li>Close OpenCode if running</li>
          <li>
            Run one-line auto-configuration:
            {apiKey.trim() ? (
              <CopyBlock value={script} onCopy={onCopy} />
            ) : (
              <ApiKeyBlock apiKey={apiKey} onCopy={onCopy} />
            )}
          </li>
          <li>
            Start OpenCode in terminal:
            <CopyBlock value="opencode" onCopy={onCopy} />
          </li>
        </ol>
        <p className="field-hint">
          {os === 'windows'
            ? 'PowerShell command automatically writes UTF-8 configuration to %USERPROFILE%\\.config\\opencode\\opencode.json.'
            : 'Shell script writes configuration to ~/.config/opencode/opencode.json and sets the default model.'}
        </p>
      </div>
    )
  }

  return (
    <div className="docs-manual">
      <ol className="docs-steps">
        <li>
          Create or edit <code className="mono">{configPath}</code> (or in project root{' '}
          <code className="mono">opencode.json</code>):
          <CopyBlock value={openCodeJson} onCopy={onCopy} />
        </li>
        <li>
          Alternatively, inside OpenCode run <code className="mono">/connect</code> → Other / OpenAI-compatible, then paste:
          <div className="docs-inline-copy">
            <div>
              <strong>Base URL:</strong> <code className="mono">{baseUrl}</code>
            </div>
            <div>
              <strong>API Key:</strong> <code className="mono">{apiKey || 'sk-…'}</code>
            </div>
          </div>
        </li>
        <li>
          Select model <code className="mono">{brandSlug()}/{defaultModel}</code> and start your session
        </li>
      </ol>
      <p className="field-hint">
        {os === 'windows'
          ? 'On Windows, global OpenCode config is located at %USERPROFILE%\\.config\\opencode\\opencode.json (PowerShell: $HOME\\.config\\opencode\\opencode.json).'
          : 'On macOS and Linux, global OpenCode config is located at ~/.config/opencode/opencode.json.'}
      </p>
    </div>
  )
}


function HermesGuide({
  mode,
  os,
  baseUrl,
  site,
  apiKey,
  defaultModel,
  models,
  onCopy,
}: {
  mode: 'manual' | 'script'
  os: OsId
  baseUrl: string
  site: string
  apiKey: string
  defaultModel: string
  models: Array<{ id: string; name: string }>
  onCopy: (text: string, label?: string) => void
}) {
  const modelList = models.length > 0 ? models : [
    { id: 'free/glm-5.3-flash', name: 'GLM 5.3 Flash (Free)' },
    { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol' },
    { id: 'claude-opus-5.5', name: 'Claude Opus 5.5' },
    { id: 'grok-4.7', name: 'Grok 4.7' },
    { id: 'kimi-k3', name: 'Kimi K3' },
    { id: 'free/muse-spark-1.3', name: 'Muse Spark 1.3' },
  ]
  const modelsYaml = modelList
    .slice(0, 16)
    .map((m) => `      - "${m.id}"`)
    .join('\n')

  const effectiveDefault = defaultModel || 'free/glm-5.3-flash'

  const configYaml = `custom_providers:
  - name: "${siteName()}"
    base_url: "${baseUrl}"
    key_env: "OPENAI_API_KEY"
    api_mode: "chat_completions"
    discover_models: false
    models:
${modelsYaml}
model:
  default: "${effectiveDefault}"
  provider: "custom:${brandSlug()}"
  base_url: "${baseUrl}"
  context_length: 1000000`

  const envContent = `OPENAI_API_KEY=${apiKey || 'sk-…'}
OPENAI_BASE_URL=${baseUrl}`

  const configPath =
    os === 'windows' ? '%USERPROFILE%\\.hermes\\config.yaml' : '~/.hermes/config.yaml'
  const envPath =
    os === 'windows' ? '%USERPROFILE%\\.hermes\\.env' : '~/.hermes/.env'
  const authPath =
    os === 'windows' ? '%USERPROFILE%\\.hermes\\auth.json' : '~/.hermes/auth.json'
  const hermesDir =
    os === 'windows' ? '%USERPROFILE%\\.hermes' : '~/.hermes'

  const script =
    os === 'windows'
      ? `$env:API_KEY="${apiKey || 'sk-…'}"; irm "${site}/i?os=windows&tool=hermes" | iex`
      : `bash <(curl -fsSL "${site}/i?tool=hermes") ${apiKey || 'sk-…'}`

  if (mode === 'script') {
    return (
      <div className="docs-manual">
        <ol className="docs-steps">
          <li>
            Fully quit Hermes first — use Quit (Cmd+Q / from the menu), not just closing the window.
          </li>
          <li>
            Run one-line auto-configuration:
            {apiKey.trim() ? (
              <CopyBlock value={script} onCopy={onCopy} />
            ) : (
              <ApiKeyBlock apiKey={apiKey} onCopy={onCopy} />
            )}
          </li>
          <li>
            Open Hermes again. Done — send any message to test.
          </li>
        </ol>
        <p className="field-hint">
          {os === 'windows'
            ? 'PowerShell command automatically writes configuration to %USERPROFILE%\\.hermes\\config.yaml and %USERPROFILE%\\.hermes\\.env.'
            : 'Shell script writes configuration to ~/.hermes/config.yaml and ~/.hermes/.env and sets the default model.'}
        </p>
      </div>
    )
  }

  return (
    <div className="docs-manual">
      <ol className="docs-steps">
        <li>
          Fully quit Hermes first — use Quit (Cmd+Q / from the menu), not just closing the window. Its background gateway must stop, otherwise your changes won't apply.
        </li>
        <li>
          Open the <code className="mono">{hermesDir}</code> folder (create it if it doesn't exist).
        </li>
        <li>
          Create or fully replace the file <code className="mono">{configPath}</code> with the block below:
          <CopyBlock title={configPath} value={configYaml} onCopy={onCopy} />
        </li>
        <li>
          Create or fully replace the file <code className="mono">{envPath}</code> with the block below. Both lines are required — the OPENAI_BASE_URL line is what points Hermes at {siteName()}:
          <CopyBlock title={envPath} value={envContent} onCopy={onCopy} />
        </li>
        <li>
          Delete the file <code className="mono">{authPath}</code> if it exists. Hermes caches the endpoint there, so a leftover file keeps sending your key to OpenAI; Hermes rebuilds it from .env on the next start, nothing is lost.
        </li>
        <li>
          Open Hermes again. Done — send any message to test.
        </li>
      </ol>
      <p className="field-hint">
        The important line is OPENAI_BASE_URL in .env — it redirects Hermes to {siteName()}; without it Hermes calls OpenAI and rejects your key. One key and one endpoint serve every model — to switch models change only the default field (e.g. free/glm-5.3-flash, free/claude-sonnet-4.6, gpt-5.6-terra). Hermes reads its config only at startup, so always fully quit and reopen it after any change.
      </p>
    </div>
  )
}

function CodexGuide({
  mode,
  os,
  baseUrl,
  site,
  apiKey,
  defaultModel,
  onCopy,
}: {
  mode: 'manual' | 'script'
  os: OsId
  baseUrl: string
  site: string
  apiKey: string
  defaultModel: string
  onCopy: (text: string, label?: string) => void
}) {
  const configPath = os === 'windows' ? '%USERPROFILE%\\.codex\\config.toml' : '~/.codex/config.toml'
  const authPath = os === 'windows' ? '%USERPROFILE%\\.codex\\auth.json' : '~/.codex/auth.json'
  const toml = `model = "${defaultModel}"
model_provider = "${brandSlug()}"

[model_providers.${brandSlug()}]
name = "${siteName()}"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = true`
  const auth = `{
  "auth_mode": "apikey",
  "OPENAI_API_KEY": "${apiKey || 'sk-…'}"
}`
  const script =
    os === 'windows'
      ? `$env:API_KEY="${apiKey || 'sk-…'}"; irm "${site}/i?os=windows&tool=codex" | iex`
      : `bash <(curl -fsSL "${site}/i?tool=codex") ${apiKey || 'sk-…'}`

  if (mode === 'script') {
    return (
      <div className="docs-manual">
        <ol className="docs-steps">
          <li>Fully quit Codex</li>
          <li>
            Run:
            {apiKey.trim() ? <CopyBlock value={script} onCopy={onCopy} /> : <ApiKeyBlock apiKey={apiKey} onCopy={onCopy} />}
          </li>
          <li>Reopen Codex and start a new task</li>
        </ol>
      </div>
    )
  }

  return (
    <div className="docs-manual">
      <ol className="docs-steps">
        <li>
          Create <code className="mono">{configPath}</code>:
          <CopyBlock value={toml} onCopy={onCopy} />
        </li>
        <li>
          Create <code className="mono">{authPath}</code> with your full key:
          {apiKey.trim() ? <CopyBlock value={auth} onCopy={onCopy} /> : <ApiKeyBlock apiKey={apiKey} onCopy={onCopy} />}
        </li>
        <li>Restart Codex</li>
      </ol>
    </div>
  )
}

function ClaudeGuide({
  mode,
  os,
  baseUrl,
  site,
  apiKey,
  onCopy,
}: {
  mode: 'manual' | 'script'
  os: OsId
  baseUrl: string
  site: string
  apiKey: string
  onCopy: (text: string, label?: string) => void
}) {
  const settingsPath = os === 'windows' ? '%USERPROFILE%\\.claude\\settings.json' : '~/.claude/settings.json'
  // Claude Code appends /v1/messages itself — base must be the API origin, not .../v1
  const anthropicBase = baseUrl.replace(/\/v1\/?$/, '') || apiOrigin()
  const json = `{
  "hasCompletedOnboarding": true,
  "env": {
    "ANTHROPIC_BASE_URL": "${anthropicBase}",
    "ANTHROPIC_AUTH_TOKEN": "${apiKey || 'sk-…'}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude/opus-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude/sonnet-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek/v4-flash"
  }
}`
  const script =
    os === 'windows'
      ? `$env:API_KEY="${apiKey || 'sk-…'}"; irm "${site}/i?os=windows&tool=claude" | iex`
      : `bash <(curl -fsSL "${site}/i?tool=claude") ${apiKey || 'sk-…'}`

  if (mode === 'script') {
    return (
      <div className="docs-manual">
        <ol className="docs-steps">
          <li>Fully quit Claude Code</li>
          <li>
            Run:
            {apiKey.trim() ? <CopyBlock value={script} onCopy={onCopy} /> : <ApiKeyBlock apiKey={apiKey} onCopy={onCopy} />}
          </li>
          <li>Reopen Claude Code — it will call {siteName()} <code className="mono">/v1/messages</code></li>
        </ol>
      </div>
    )
  }

  return (
    <div className="docs-manual">
      <ol className="docs-steps">
        <li>
          Edit <code className="mono">{settingsPath}</code>:
          {apiKey.trim() ? <CopyBlock value={json} onCopy={onCopy} /> : <ApiKeyBlock apiKey={apiKey} onCopy={onCopy} />}
        </li>
        <li>Restart Claude Code</li>
      </ol>
      <p className="field-hint">
        Set <code className="mono">ANTHROPIC_BASE_URL</code> to{' '}
        <code className="mono">{anthropicBase}</code> (no <code className="mono">/v1</code>). Claude Code calls{' '}
        <code className="mono">{anthropicBase}/v1/messages</code>.
      </p>
    </div>
  )
}

function ApiManual({
  baseUrl,
  apiKey,
  defaultModel,
  onCopy,
}: {
  baseUrl: string
  apiKey: string
  defaultModel: string
  onCopy: (text: string, label?: string) => void
}) {
  const curl = `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${apiKey || 'sk-…'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${defaultModel}",
    "messages": [{"role": "user", "content": "Hello from ${siteName()}"}]
  }'`
  const messagesCurl = `curl ${baseUrl}/messages \\
  -H "x-api-key: ${apiKey || 'sk-…'}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${defaultModel}",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Hello from ${siteName()}"}]
  }'`
  const python = `from openai import OpenAI

client = OpenAI(
    api_key="${apiKey || 'sk-…'}",
    base_url="${baseUrl}",
)

r = client.chat.completions.create(
    model="${defaultModel}",
    messages=[{"role": "user", "content": "Hello from ${siteName()}"}],
)
print(r.choices[0].message.content)`

  return (
    <div className="docs-manual">
      <ol className="docs-steps">
        <li>
          Base URL:
          <CopyBlock value={baseUrl} onCopy={onCopy} />
        </li>
        <li>
          Recommended model IDs:
          <div className="docs-copy-pills">
            {['free/glm-5.3-flash', 'gpt-6.1-sol', 'claude-opus-5.5', 'grok-4.7', 'kimi-k3', 'free/muse-spark-1.3'].map((m) => (
              <button
                key={m}
                type="button"
                className="docs-pill-btn"
                onClick={() => onCopy(m, `Model ${m}`)}
                title={`Click to copy ${m}`}
              >
                <code>{m}</code>
                <span className="docs-pill-copy">copy</span>
              </button>
            ))}
          </div>
        </li>
        <li>
          Chat Completions (Cursor / OpenCode / SDKs):
          <CopyBlock value={curl} onCopy={onCopy} />
        </li>
        <li>
          Anthropic Messages (Claude Code):
          <CopyBlock value={messagesCurl} onCopy={onCopy} />
        </li>
        <li>
          Python (OpenAI SDK):
          <CopyBlock value={python} onCopy={onCopy} />
        </li>
        <li>
          Full field reference:{' '}
          <a href="/developers/models">/developers/models</a>
        </li>
      </ol>
    </div>
  )
}
